const fetch = require('node-fetch');
const { flushXuidCache } = require('./db');

const sleep = ms => new Promise(r => setTimeout(r, ms));
// fetch with hard abort timeout — prevents Halo API hangs from blocking forever
function fetchT(url, opts, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
}

// --- Redis ---
const { createClient } = require('redis');
let _redisClient = null;
let _redisConnecting = false;
let _redisDisabledUntil = 0;       // epoch ms — don't retry before this time
const REDIS_COOLDOWN = 5 * 60 * 1000; // 5 min cooldown after giving up

async function getRedis() {
  if (_redisClient && _redisClient.isOpen) return _redisClient;
  if (_redisConnecting) return null;
  if (!process.env.REDIS_URL) return null;
  if (Date.now() < _redisDisabledUntil) return null; // cooling down

  _redisConnecting = true;
  let _retryCount = 0;

  try {
    const redisUrl = process.env.REDIS_URL;
    const isTLS = redisUrl.startsWith('rediss://');

    _redisClient = createClient({
      url: redisUrl,
      socket: {
        tls: isTLS,
        rejectUnauthorized: false,
        reconnectStrategy: retries => {
          _retryCount = retries;
          if (retries >= 4) {
            console.warn('[Redis] Max retries reached — disabling for 5 min, using in-memory cache');
            _redisDisabledUntil = Date.now() + REDIS_COOLDOWN;
            _redisClient = null;
            _redisConnecting = false;
            return new Error('Redis: max retries exceeded');
          }
          return Math.min(retries * 1000, 4000);
        }
      }
    });

    // Suppress per-reconnect error spam — only log unique messages
    let _lastErrMsg = '';
    _redisClient.on('error', err => {
      if (err.message === _lastErrMsg) return;
      _lastErrMsg = err.message;
      console.warn('[Redis] Error:', err.message);
    });
    _redisClient.on('connect', () => { _lastErrMsg = ''; console.log('[Redis] Connected'); });
    _redisClient.on('end', () => { _redisClient = null; _redisConnecting = false; });

    await _redisClient.connect();
    _redisConnecting = false;
    return _redisClient;
  } catch(e) {
    console.warn('[Redis] Failed to connect — falling back to in-memory:', e.message);
    _redisClient = null;
    _redisConnecting = false;
    _redisDisabledUntil = Date.now() + REDIS_COOLDOWN;
    return null;
  }
}

// --- In-memory caches ---
const xuidToGt = {};           // xuid -> gamertag
const xuidToGamerpic = {};     // xuid -> gamerpic URL
const _rivalGtBackoff = {};    // xuid -> timestamp; skip GT resolution for 30min after 429
const mapNameCache = {};        // assetId -> map name
const mapImageCache = {};       // assetId -> image URL
const emblemPathCache = {};     // xuid -> gamecms image path
const nameplatePathCache = {};  // xuid -> gamecms backdrop image path
const serviceTagCache = {};     // xuid -> service tag string (e.g. "HODL")
const emblemInFlight = {};      // xuid -> promise (dedup)
let emblemMapping = null;
let emblemMappingFetchedAt = 0;

// --- Gamertag resolution queue (single-runner, no concurrent API hammering) ---
const _gtQueue = new Set();  // pending xuids waiting to be resolved
let _gtRunning = false;      // is the resolver loop currently active

// --- Auth ---
let cachedClearance = null;
let clearanceFetchedAt = 0;
let clearanceInFlight = null;
let clearanceFailedAt = 0;      // timestamp of last all-attempts failure
let _lastClearanceXuid = null;  // last xuid used to successfully fetch clearance — reused on proactive refresh
const CLEARANCE_FAIL_COOLDOWN = 5 * 60 * 1000; // 5 minutes before retrying after total failure

// Shared backoff for the halostats /matches list endpoint. When it 429s or
// 403s persistently we suppress further match-list calls for a window so a
// thrash of refresh polls doesn't keep hammering. Callers can read
// `isMatchListBackoffActive()` to decide whether to fall back to cached data.
let matchListBackoffUntil = 0;
const MATCH_LIST_BACKOFF_MS = 60 * 1000; // 60s — enough to let a burst clear
function isMatchListBackoffActive() {
  return Date.now() < matchListBackoffUntil;
}
function matchListBackoffSecondsRemaining() {
  return Math.max(0, Math.ceil((matchListBackoffUntil - Date.now()) / 1000));
}
function isClearanceUnavailable() {
  // True when we don't have a cached clearance AND the failure cooldown is
  // still active. Callers use this to short-circuit refresh work that
  // requires clearance, returning cached data instead.
  return !cachedClearance && clearanceFailedAt > 0 && (Date.now() - clearanceFailedAt) < CLEARANCE_FAIL_COOLDOWN;
}

// Called by tokenRefresh after a new Spartan token is issued.
// We mark clearance as stale so it re-fetches on next use, but we do NOT null
// it out — the FlightConfigurationId UUID is long-lived and will keep working
// even across Spartan token rotations. If the re-fetch fails we fall back to
// the existing token rather than leaving everything clearance-less.
function resetClearanceCache() {
  clearanceFetchedAt = 0;   // mark stale — will re-fetch on next use
  clearanceInFlight = null;
  clearanceFailedAt = 0;    // allow retry immediately
  // Leave cachedClearance intact as fallback — it's a game config UUID, not an
  // auth credential, so it stays valid across Spartan token rotations.
  console.log('[Clearance] Marked stale after Spartan token refresh (existing token kept as fallback)');
  // Proactively re-fetch in the background using the last known xuid so
  // the fresh Spartan token is bound to clearance before any GT batches need it.
  if (_lastClearanceXuid) {
    fetchClearanceToken(_lastClearanceXuid).catch(() => {});
  }
}

// Match IDs that the skill API permanently 404s — skip on all future fetches
const _deadSkillMatchIds = new Set();
const DEAD_SKILL_MAX = 2000; // cap to prevent unbounded growth

function getAuthHeaders() {
  const h = {
    'x-343-authorization-spartan': process.env.SPARTAN_TOKEN || '',
    'Accept': 'application/json',
    'User-Agent': 'HaloTracker/1.0',
  };
  if (cachedClearance) h['343-clearance'] = cachedClearance;
  return h;
}

async function fetchClearanceToken(xuid) {
  if (cachedClearance && Date.now() - clearanceFetchedAt < 3600000) return cachedClearance;
  // If all attempts failed recently, don't spam — wait for cooldown
  if (!cachedClearance && clearanceFailedAt && Date.now() - clearanceFailedAt < CLEARANCE_FAIL_COOLDOWN) {
    return null;
  }
  if (clearanceInFlight) return clearanceInFlight;
  clearanceInFlight = (async () => {
    const baseHeaders = { 'x-343-authorization-spartan': process.env.SPARTAN_TOKEN || '', 'Accept': 'application/json' };
    // Try without build param first — works regardless of current game version.
    // Fall back to a known build in case the endpoint requires it.
    const urls = [
      `https://settings.svc.halowaypoint.com/oban/flight-configurations/titles/hi/audiences/RETAIL/players/xuid(${xuid})/active?sandbox=UNUSED`,
      `https://settings.svc.halowaypoint.com/oban/flight-configurations/titles/hi/audiences/RETAIL/players/xuid(${xuid})/active?sandbox=UNUSED&build=6.10022.18539`,
    ];
    for (const url of urls) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await fetchT(url, { headers: baseHeaders });
          if (res.ok) {
            const data = await res.json();
            const token = data.FlightConfigurationId || data.flightConfigurationId || null;
            if (token) {
              cachedClearance = token;
              clearanceFetchedAt = Date.now();
              clearanceFailedAt = 0;
              _lastClearanceXuid = xuid;
              getRedis().then(c => c && c.set('clearanceToken', JSON.stringify({ token: cachedClearance, fetchedAt: clearanceFetchedAt }))).catch(() => {});
              clearanceInFlight = null;
              return cachedClearance;
            }
          } else if (res.status === 403) {
            // 403 = build mismatch or token issue — try next URL
            if (attempt === 2) console.warn(`[Clearance] HTTP 403 on ${url.includes('build=') ? 'fallback' : 'primary'} URL`);
            break;
          } else {
            console.warn(`[Clearance] HTTP ${res.status} (attempt ${attempt}/2)`);
            if (attempt < 2) await sleep(1000);
          }
        } catch(e) {
          console.error(`[Clearance] attempt ${attempt} error:`, e.message);
          if (attempt < 2) await sleep(1000);
        }
      }
      if (cachedClearance) break;
    }
    if (!cachedClearance) {
      clearanceFailedAt = Date.now();
      console.warn(`[Clearance] All attempts failed — suppressing retries for ${CLEARANCE_FAIL_COOLDOWN/60000} min`);
    } else {
      // Re-fetch failed but we still have an existing token — extend its TTL so
      // we don't spam the endpoint on every request while it's 403ing.
      clearanceFetchedAt = Date.now();
      console.warn('[Clearance] Re-fetch failed, continuing with existing token');
    }
    clearanceInFlight = null;
    return cachedClearance;
  })();
  return clearanceInFlight;
}

// --- Startup: load persisted caches from Redis ---
async function loadCaches() {
  const c = await getRedis();
  if (!c) return;
  try {
    const [gtRaw, gpRaw, emblemRaw, npRaw, clearRaw, mapImgRaw] = await Promise.all([
      c.get('xuidToGt'), c.get('xuidToGamerpic'), c.get('emblemPathCache'), c.get('nameplatePathCache'), c.get('clearanceToken'), c.get('mapImageCache')
    ]);
    if (gtRaw) Object.assign(xuidToGt, JSON.parse(gtRaw));
    if (gpRaw) Object.assign(xuidToGamerpic, JSON.parse(gpRaw));
    if (emblemRaw) {
      const loaded = JSON.parse(emblemRaw) || {};
      for (const [xuid, p] of Object.entries(loaded)) {
        if (p && p !== '') emblemPathCache[xuid] = p;
      }
    }
    if (npRaw) {
      const loaded = JSON.parse(npRaw) || {};
      for (const [xuid, p] of Object.entries(loaded)) {
        if (p && p !== '') nameplatePathCache[xuid] = p;
      }
    }
    if (clearRaw) {
      const cl = JSON.parse(clearRaw);
      if (cl?.token) {
        cachedClearance = cl.token;
        clearanceFetchedAt = cl.fetchedAt;
        console.log('[Clearance] Loaded from Redis');
      }
    }
    if (mapImgRaw) {
      const loaded = JSON.parse(mapImgRaw) || {};
      let mapImgCount = 0;
      for (const [assetId, url] of Object.entries(loaded)) {
        if (assetId && url) { mapImageCache[assetId] = url; mapImgCount++; }
      }
      if (mapImgCount) console.log(`[Cache] Loaded ${mapImgCount} map image URLs from Redis`);
    }
    console.log(`[Cache] Loaded: ${Object.keys(xuidToGt).length} gamertags, ${Object.keys(emblemPathCache).length} emblems, ${Object.keys(nameplatePathCache).length} nameplates, ${Object.keys(mapImageCache).length} map images`);
  } catch(e) { console.error('[Cache] Load failed:', e.message); }
}
loadCaches();

// --- Utilities ---
async function resolveMapName(assetId, versionId, headers) {
  if (!assetId) return null;
  if (mapNameCache[assetId]) return mapNameCache[assetId];
  try {
    const res = await fetchT(`https://discovery-infiniteugc.svc.halowaypoint.com/hi/maps/${assetId}/versions/${versionId}`, { headers }, 15000);
    if (res.ok) {
      const data = await res.json();
      const rawName = data.PublicName || data.Name || null;
      if (rawName) {
        const name = rawName.replace(/\s*-\s*(Ranked|Competitive|Social|Arena|BTB|Big Team Battle)$/i, '').trim();
        mapNameCache[assetId] = name;
        // Extract thumbnail URL from Files prefix + paths
        const prefix = data.Files?.Prefix || '';
        const paths = data.Files?.FileRelativePaths || [];
        const thumb = paths.find(p => /thumbnail/i.test(p)) || paths.find(p => /screenshot/i.test(p)) || paths.find(p => /\.png$/i.test(p)) || paths.find(p => /\.jpg$/i.test(p));
        if (prefix && thumb) mapImageCache[assetId] = prefix + thumb;
        else if (prefix) mapImageCache[assetId] = prefix + 'images/thumbnail.png';
        // Persist new map image URL to Redis so it survives server restarts
        if (mapImageCache[assetId]) {
          getRedis().then(c => c && c.set('mapImageCache', JSON.stringify(mapImageCache))).catch(() => {});
        }
        return name;
      }
    }
  } catch(e) {}
  return null;
}

function getMapImageUrl(assetId) {
  return assetId ? (mapImageCache[assetId] || null) : null;
}

// Enqueue xuids for resolution and start the runner if idle.
// Callers should fire-and-forget: resolveGamertags([...xuids]).catch(()=>{})
function resolveGamertags(xuids) {
  const newXuids = xuids.filter(x => !xuidToGt[x]);
  if (newXuids.length > 0) {
    const caller = new Error().stack.split('\n').slice(1,4).join(' | ');
    console.log(`[GT] resolveGamertags called with ${newXuids.length} unknown xuids — caller: ${caller}`);
  }
  for (const x of xuids) { if (!xuidToGt[x]) _gtQueue.add(x); }
  if (!_gtRunning) _runGtResolver().catch(() => {});
  return Promise.resolve(); // always returns immediately
}

async function _runGtResolver() {
  if (_gtRunning) return;
  _gtRunning = true;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const BATCH_SIZE = 50;
  const INTER_BATCH_DELAY = 3000; // 3s between batches — gentle on the API

  try {
    while (_gtQueue.size > 0) {
      // Drain the queue into a local working list (re-filter already-resolved)
      const todo = [..._gtQueue].filter(x => !xuidToGt[x]);
      _gtQueue.clear();
      if (!todo.length) break;

      console.log(`[GT] Resolving ${todo.length} unknown xuids`);

      for (let i = 0; i < todo.length; i += BATCH_SIZE) {
        if (i > 0) await sleep(INTER_BATCH_DELAY);
        const batch = todo.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const url = 'https://profile.svc.halowaypoint.com/users?' + batch.map(x => `xuids=${x}`).join('&');
        // Refresh clearance + headers per-batch — ensures we have a valid 343-clearance
        // header even if the Spartan token was rotated mid-run (which nulls cachedClearance).
        try { await fetchClearanceToken(batch[0]); } catch(e) {}
        const headers = getAuthHeaders();

        let success = false;
        let backoff = 8000; // start at 8s — gives API more breathing room
        for (let attempt = 1; attempt <= 3 && !success; attempt++) {
          try {
            const r = await fetchT(url, { headers }, 15000);
            console.log(`[GT] Batch ${batchNum} attempt ${attempt}: ${r.status} (${batch.length} xuids)`);
            if (r.ok) {
              const data = await r.json();
              const users = Array.isArray(data) ? data : (data.users || data.Users || Object.values(data));
              const resolved = new Set();
              for (const user of users) {
                if (!user || typeof user !== 'object') continue;
                const xuid = String(user.xuid || user.Xuid || '').replace('xuid(','').replace(')','');
                const gt = user.gamertag || user.Gamertag || '';
                if (xuid && gt) { xuidToGt[xuid] = gt; resolved.add(xuid); }
                const gp = user.gamerpic?.medium || user.gamerpic?.large || null;
                if (xuid && gp && !xuidToGamerpic[xuid]) xuidToGamerpic[xuid] = gp;
              }
              success = true;
              // Retry individually any the batch missed (private/deleted accounts) — cap at 5
              const stillMissing = batch.filter(x => !resolved.has(x));
              if (stillMissing.length) console.log(`[GT] Batch ${batchNum} still missing: ${stillMissing.length}`);
              for (const xuid of stillMissing.slice(0, 5)) {
                try {
                  await sleep(500);
                  const r2 = await fetchT(`https://profile.svc.halowaypoint.com/users/xuid(${xuid})`, { headers }, 15000);
                  if (r2.ok) {
                    const d2 = await r2.json();
                    const gt2 = d2.gamertag || d2.Gamertag || d2.modernGamertag || '';
                    if (gt2) xuidToGt[xuid] = gt2;
                    const gp2 = d2.gamerpic?.medium || d2.gamerpic?.large || null;
                    if (gp2 && !xuidToGamerpic[xuid]) xuidToGamerpic[xuid] = gp2;
                  }
                } catch(e) {}
              }
            } else if (r.status === 429) {
              console.log(`[GT] Rate limited batch ${batchNum} — backing off ${backoff/1000}s (attempt ${attempt}/3)`);
              await sleep(backoff);
              backoff *= 2; // 8s → 16s → 32s
            } else if (r.status === 400) {
              // 400 = missing/invalid clearance — no point retrying, skip batch
              console.log(`[GT] Batch ${batchNum} got 400 (clearance unavailable) — skipping`);
              break;
            } else {
              console.log(`[GT] Batch ${batchNum} unexpected status ${r.status} — skipping`);
              break;
            }
          } catch(e) {
            console.error(`[GT] Batch ${batchNum} error:`, e.message);
            break;
          }
        }
        if (!success) console.log(`[GT] Batch ${batchNum} gave up after retries`);
      }

      // Flush newly resolved xuids to Postgres
      flushXuidCache(xuidToGt).catch(() => {});

      // If new xuids arrived while we were processing, loop again
      if (_gtQueue.size > 0) await sleep(2000);
    }
  } finally {
    _gtRunning = false;
  }
}

async function getEmblemMapping() {
  if (emblemMapping && Date.now() - emblemMappingFetchedAt < 86400000) return emblemMapping;
  try {
    const res = await fetchT('https://gamecms-hacs.svc.halowaypoint.com/hi/Waypoint/file/images/emblems/mapping.json', { headers: getAuthHeaders() }, 15000);
    if (res.ok) {
      emblemMapping = await res.json();
      emblemMappingFetchedAt = Date.now();
      console.log('[EmblemMapping] Loaded', Object.keys(emblemMapping).length, 'combos');
    }
  } catch(e) { console.log('[EmblemMapping] Failed:', e.message); }
  return emblemMapping || {};
}

// Resolve an emblem (and gamerpic) for a single xuid. Returns { gamerpicUrl, emblemPath }.
// emblemPath is a ';'-separated list of candidates the proxy can try, or '__none__' / null.
// Dedups in-flight requests via emblemInFlight so concurrent callers share one upstream call.
async function resolveEmblemForXuid(xuid) {
  if (emblemInFlight[String(xuid)]) return emblemInFlight[String(xuid)];
  emblemInFlight[String(xuid)] = (async () => {
    try {
      try { await fetchClearanceToken(xuid); } catch(e) {}
      const freshHeaders = getAuthHeaders();
      const [custRes, profileRes] = await Promise.all([
        fetchT(`https://economy.svc.halowaypoint.com/hi/players/xuid(${xuid})/customization?view=public`, { headers: freshHeaders }, 15000),
        fetchT(`https://profile.svc.halowaypoint.com/users/xuid(${xuid})`, { headers: freshHeaders }, 15000)
      ]);
      let gp = null, path = null;
      if (profileRes.ok) {
        const pd = await profileRes.json();
        gp = pd?.gamerpic?.medium || pd?.gamerpic?.large || null;
        if (gp) {
          xuidToGamerpic[String(xuid)] = gp;
          getRedis().then(c => c && c.set('xuidToGamerpic', JSON.stringify(xuidToGamerpic))).catch(() => {});
        }
      }
      if (custRes.ok) {
        const custData = await custRes.json();
        // Appearance debug logging removed (was too verbose)
        // Try to read nameplate/backdrop directly from Appearance before falling back to emblem mapping
        const appearance = custData?.Appearance || {};
        // Cache service tag
        if (appearance.ServiceTag && !serviceTagCache[String(xuid)]) {
          serviceTagCache[String(xuid)] = appearance.ServiceTag;
        }
        const rawNpPath = appearance.BackdropImagePath   // confirmed field name from API
          || appearance.NameplatePath || appearance.BackdropPath || appearance.SpartanBackdropPath
          || appearance.BackgroundPath || appearance.BackgroundImagePath
          || appearance.Nameplate?.NameplatePath || appearance.Backdrop?.BackdropPath || null;
        if (rawNpPath && !nameplatePathCache[String(xuid)]) {
          // BackdropImagePath points to a JSON manifest, not directly to an image.
          // Fetch the JSON to extract the real image path.
          if (rawNpPath.endsWith('.json')) {
            try {
              // Inventory/ paths use progression/file/ — same as emblem JSONs
              const npJsonUrl = `https://gamecms-hacs.svc.halowaypoint.com/hi/progression/file/${rawNpPath}`;
              const npJsonRes = await fetchT(npJsonUrl, { headers: freshHeaders }, 15000);
              if (npJsonRes.ok) {
                const npJson = await npJsonRes.json();
                // Backdrop JSON debug logging removed (was too verbose)
                // The backdrop JSON has two distinct images:
                // 1) CommonData.DisplayPath → the background/backdrop (gray V-shape)
                // 2) Nameplate-specific field → the colored overlay plate (blue nameplate)
                // Try nameplate overlay fields first, then fall back to backdrop
                const npOverlay = npJson?.NameplateOverlayPath || npJson?.NameplatePath
                  || npJson?.CommonData?.NameplateOverlayPath || npJson?.CommonData?.NameplatePath
                  || npJson?.OverlayPath || npJson?.CommonData?.OverlayPath || null;
                const dp = npJson?.CommonData?.DisplayPath;
                const mediaUrlPath = dp?.Media?.MediaUrl?.Path || '';
                const mediaFolderPath = dp?.Media?.FolderPath || dp?.FolderPath || '';
                const mediaFileName = dp?.Media?.FileName || dp?.FileName || '';
                let backdropPath = '';
                if (mediaUrlPath && /\.(png|jpg|webp)$/i.test(mediaUrlPath)) backdropPath = mediaUrlPath;
                else if (mediaFolderPath && mediaFileName) backdropPath = `${mediaFolderPath}/${mediaFileName}`;
                // Use overlay if available, otherwise use backdrop
                const displayPath = npOverlay || backdropPath;
                if (displayPath) {
                  const npCms = displayPath.startsWith('images/') ? `waypoint:${displayPath}`
                    : displayPath.startsWith('progression/') ? `images:${displayPath}`
                    : `images:progression/${displayPath}`;
                  nameplatePathCache[String(xuid)] = npCms;
                  // Also store the backdrop separately if we found both
                  if (npOverlay && backdropPath) {
                    const bdCms = backdropPath.startsWith('images/') ? `waypoint:${backdropPath}`
                      : backdropPath.startsWith('progression/') ? `images:${backdropPath}`
                      : `images:progression/${backdropPath}`;
                    console.log(`[Emblem] Nameplate overlay for ${xuid}: ${npCms} | backdrop: ${bdCms}`);
                  } else {
                    console.log(`[Emblem] Nameplate resolved for ${xuid}: ${npCms} (${npOverlay ? 'overlay' : 'backdrop only'})`);
                  }
                  getRedis().then(c => c && c.set('nameplatePathCache', JSON.stringify(nameplatePathCache))).catch(() => {});
                } else {
                  console.log(`[Emblem] Backdrop JSON no image path for ${xuid}:`, JSON.stringify(npJson).slice(0, 400));
                }
              } else {
                console.log(`[Emblem] Backdrop JSON ${npJsonRes.status} for ${xuid}`);
              }
            } catch(e) {
              console.log(`[Emblem] Backdrop JSON error for ${xuid}:`, e.message);
            }
          } else {
            const npCms = rawNpPath.startsWith('waypoint:') ? rawNpPath
              : rawNpPath.startsWith('progression/') ? `waypoint:${rawNpPath}`
              : `waypoint:progression/${rawNpPath}`;
            nameplatePathCache[String(xuid)] = npCms;
            console.log(`[Emblem] Nameplate direct path for ${xuid}: ${npCms}`);
            getRedis().then(c => c && c.set('nameplatePathCache', JSON.stringify(nameplatePathCache))).catch(() => {});
          }
        }
        const emblemData = custData?.Appearance?.Emblem;
        const emblemJsonPath = emblemData?.EmblemPath;
        const configurationId = emblemData?.ConfigurationId;
        if (emblemJsonPath) {
          const emblemId = emblemJsonPath.split('/').pop().replace(/\.json$/i, '');
          const mapping = await getEmblemMapping();
          const emblemEntry = mapping[emblemId];
          const candidates = [];
          // 1) Mapping hit (most reliable)
          if (emblemEntry) {
            const configKey = configurationId ? String(configurationId) : null;
            const configMatch = (configKey && emblemEntry[configKey]) ? emblemEntry[configKey] : Object.values(emblemEntry)[0];
            if (configMatch?.emblemCmsPath) candidates.push('waypoint:' + configMatch.emblemCmsPath);
          }
          // 2) Convention construct: images/emblems/<emblemId>_<configId>.png (negative configIds use 'n' prefix)
          if (configurationId !== undefined && configurationId !== null) {
            const configStr = configurationId < 0 ? `n${Math.abs(configurationId)}` : String(configurationId);
            const conv = `waypoint:images/emblems/${emblemId}_${configStr}.png`;
            if (!candidates.includes(conv)) candidates.push(conv);
          }
          // 3) Images-branch fallback for emblems missing from mapping.json or Waypoint convention
          try {
            const defRes = await fetchT(`https://gamecms-hacs.svc.halowaypoint.com/hi/progression/file/${emblemJsonPath}`, { headers: freshHeaders }, 15000);
            if (defRes.ok) {
              const emblemDef = await defRes.json();
              const dp = emblemDef?.CommonData?.DisplayPath;
              const mediaUrlPath = dp?.Media?.MediaUrl?.Path || '';
              const mediaFolderPath = dp?.Media?.FolderPath || dp?.FolderPath || '';
              const mediaFileName = dp?.Media?.FileName || dp?.FileName || '';
              let displayPath = '';
              if (mediaUrlPath && mediaUrlPath.includes('/') && /\.png$/i.test(mediaUrlPath)) displayPath = mediaUrlPath;
              else if (mediaFolderPath && mediaFileName) displayPath = `${mediaFolderPath}/${mediaFileName}`;
              else { const sw = emblemJsonPath.replace(/\.json$/i, '.png'); displayPath = sw.startsWith('progression/') ? sw : `progression/${sw}`; }
              if (displayPath) candidates.push(`images:${displayPath}`);
            }
          } catch(e) {}
          path = candidates.length ? candidates.join(';') : null;
          emblemPathCache[String(xuid)] = path || '__none__';
          getRedis().then(c => c && c.set('emblemPathCache', JSON.stringify(emblemPathCache))).catch(() => {});
        }
      }
      return { gamerpicUrl: gp, emblemPath: path };
    } finally { delete emblemInFlight[String(xuid)]; }
  })();
  return emblemInFlight[String(xuid)];
}

// Mark an emblem as unreachable so subsequent requests skip path resolution and fall to gamerpic.
function markEmblemMissing(xuid) {
  emblemPathCache[String(xuid)] = '__none__';
  getRedis().then(c => c && c.set('emblemPathCache', JSON.stringify(emblemPathCache))).catch(() => {});
}

const MODE_NAMES = {
  5:'Slayer',6:'Slayer',9:'Team Slayer',10:'Slayer',
  11:'Strongholds',12:'Oddball',13:'CTF',14:'King of the Hill',
  15:'CTF 3',16:'Infection',17:'Escalation Slayer',18:'Oddball',
  42:'CTF 5',
  19:'Tactical Slayer',20:'Land Grab',21:'Attrition',22:'Elimination',
  23:'Dodgeball',24:'Stockpile',25:'VIP',26:'Husky Raid',
  27:'Firefight',28:'Gruntpocalypse',29:'Extraction',30:'Grifball',
  31:'Minigame',32:'Fiesta',33:'Super Slayer'
};

function placementStr(rank) {
  if (!rank) return null;
  const s = ['th','st','nd','rd'], v = rank % 100;
  return rank + (s[(v-20)%10] || s[v] || s[0]);
}

async function fetchConcurrent(items, fn, limit = 5) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() { while (idx < items.length) { const i = idx++; out[i] = await fn(items[i]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// --- Main player fetch ---
async function fetchPlayerStats(gamertag) {
  const encoded = encodeURIComponent(gamertag);
  const headers = getAuthHeaders();

  // Resolve XUID
  let xuid = null;
  // Check caches first
  for (const [x, gt] of Object.entries(xuidToGt)) { if (gt.toLowerCase() === gamertag.toLowerCase()) { xuid = x; break; } }
  if (!xuid) {
    const xuidRes = await fetchT(`https://profile.svc.halowaypoint.com/users/gt(${encoded})`, { headers }, 12000);
    if (!xuidRes.ok) throw new Error(`Could not resolve gamertag: ${gamertag} (${xuidRes.status})`);
    const xuidData = await xuidRes.json();
    xuid = xuidData.xuid;
    const canonicalGt = xuidData.gamertag || xuidData.Gamertag || gamertag;
    xuidToGt[xuid] = canonicalGt;
    gamertag = canonicalGt; // use canonical casing going forward
    getRedis().then(c => c && c.set('xuidToGt', JSON.stringify(xuidToGt))).catch(() => {});
  }

  await fetchClearanceToken(xuid);
  const freshHeaders = getAuthHeaders();

  const RANKED_PLAYLISTS = {
    'Ranked Arena':   'edfef3ac-9cbe-4fa2-b949-8f29deafd483',
    'Ranked Slayer':  'f5580605-660c-43f9-ac69-4075c4a05c5d',
    'Ranked Slayer2': 'dcb2e24e-05fb-4390-8076-32a0cdb4326e',
    'Ranked Legacy':  'c94cb508-2fbd-450a-81db-bb74f7741d45',
    'Ranked Doubles': 'fa5aa2a3-2428-4912-a023-e1eeea7b877c',
  };

  const [statsRes, countRes, rankedStatsRes, ...csrResponses] = await Promise.all([
    fetchT(`https://halostats.svc.halowaypoint.com/hi/players/xuid(${xuid})/matchmade/servicerecord`, { headers: freshHeaders }, 15000),
    fetchT(`https://halostats.svc.halowaypoint.com/hi/players/xuid(${xuid})/matches/count`, { headers: freshHeaders }, 12000),
    fetchT(`https://halostats.svc.halowaypoint.com/hi/players/xuid(${xuid})/matchmade/servicerecord?isRanked=true`, { headers: freshHeaders }, 15000).catch(() => null),
    ...Object.entries(RANKED_PLAYLISTS).map(([, id]) =>
      fetchT(`https://skill.svc.halowaypoint.com/hi/playlist/${id}/csrs?players=xuid(${xuid})`, { headers: freshHeaders }, 10000).catch(() => null)
    ),
  ]);

  if (!statsRes.ok) throw new Error(`Stats fetch failed for ${gamertag} (${statsRes.status})`);
  const statsData = await statsRes.json();

  let matchesPlayed = 0;
  if (countRes.ok) {
    const countData = await countRes.json();
    matchesPlayed = countData.MatchmadeMatchesPlayedCount || countData.MatchesPlayedCount || 0;
  }

  // Process CSR
  const fmtCsr = c => !c?.Tier ? null : c.Tier === 'Onyx' ? 'Onyx ' + c.Value : c.Tier + ' ' + ((c.SubTier ?? 0) + 1);
  const csrResults = {};
  const playlistEntries = Object.entries(RANKED_PLAYLISTS);
  for (let i = 0; i < csrResponses.length; i++) {
    const [playlistName] = playlistEntries[i];
    try {
      if (!csrResponses[i]?.ok) continue;
      const csrData = await csrResponses[i].json();
      const entry = (csrData.Value || [])[0];
      const current = entry?.Result?.Current || entry?.Csr;
      const seasonMax = entry?.Result?.SeasonMax;
      const allTimeMax = entry?.Result?.AllTimeMax;
      if (current?.Tier) {
        const tier = current.Tier, subTier = (current.SubTier ?? 0) + 1, val = current.Value || 0;
        const tierStart = current.TierStart || 0, nextTierStart = current.NextTierStart || (tierStart + 50);
        const display = tier === 'Onyx' ? 'Onyx ' + val : tier + ' ' + subTier;
        const pct = nextTierStart > tierStart ? Math.min(100, Math.max(0, Math.round(((val - tierStart) / (nextTierStart - tierStart)) * 100))) : 0;
        const nextLabel = tier === 'Onyx' ? 'Max' : (current.NextTier || tier) + ' ' + ((current.NextSubTier ?? 0) + 1);
        const displayName = playlistName.replace(/\d+$/, '');
        if (!csrResults[displayName] || val > csrResults[displayName].value) {
          csrResults[displayName] = { tier, subTier, value: val, display, tierStart, nextTierStart, nextLabel, pct, seasonMax: fmtCsr(seasonMax), allTimeMax: fmtCsr(allTimeMax) };
        }
      }
    } catch(e) {}
  }

  // Career rank
  let finalCareerRank = null;
  try {
    const crRes = await fetchT(`https://halostats.svc.halowaypoint.com/hi/players/xuid(${xuid})/careerranks`, { headers: freshHeaders }, 12000);
    if (crRes.ok) {
      const crData = await crRes.json();
      const cr = crData?.RewardTracks?.[0]?.Result?.CurrentProgress || crData?.CurrentProgress || null;
      if (cr) {
        finalCareerRank = {
          rank: cr.Rank ?? cr.CurrentRank ?? 0,
          xp: cr.PartialProgress ?? cr.CurrentXP ?? null,
          xpToNext: cr.ProgressRequiredForNextRank ?? null,
          tier: cr.RankTier ?? cr.Tier ?? null,
          grade: cr.RankGrade ?? cr.Grade ?? null,
        };
      }
    }
  } catch(e) {}

  // All-modes service record (used for medals/damage/accuracy fallback only)
  const core = statsData.CoreStats || statsData.Summary?.CoreStats || statsData;

  // Ranked-only stats — use for all career figures if available
  let kills, deaths, assists, wins, losses, matches, rankedKd, rankedKda;
  try {
    if (rankedStatsRes?.ok) {
      const rd = await rankedStatsRes.json();
      const rc = rd.CoreStats || rd.Summary?.CoreStats || rd;
      kills   = rc.Kills   || 0;
      deaths  = rc.Deaths  || 0;
      assists = rc.Assists || 0;
      wins    = rd.Wins || rd.MatchesWon || 0;
      losses  = rd.Losses || rd.MatchesLost || 0;
      matches = rd.MatchesCompleted || rd.MatchesPlayed || (wins + losses) || 0;
      rankedKd  = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
      rankedKda = matches > 0
        ? ((kills - deaths + assists / 3) / matches).toFixed(2)
        : (kills - deaths + assists / 3).toFixed(2);
    }
  } catch(e) { console.error('[RankedStats]', e.message); }

  // Fallback to all-modes if ranked fetch failed
  if (kills === undefined)   kills   = core.Kills   || statsData.Kills   || 0;
  if (deaths === undefined)  deaths  = core.Deaths  || statsData.Deaths  || 0;
  if (assists === undefined) assists = core.Assists || statsData.Assists || 0;
  if (wins === undefined)    wins    = statsData.Wins || statsData.MatchesWon || 0;
  if (losses === undefined)  losses  = statsData.Losses || statsData.MatchesLost || 0;
  if (matches === undefined) matches = matchesPlayed || statsData.MatchesPlayed || (wins + losses) || 0;
  if (!rankedKd)  rankedKd  = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
  if (!rankedKda) rankedKda = matches > 0 ? ((kills - deaths + assists / 3) / matches).toFixed(2) : '0.00';

  // Medal meta
  let topMedals = [], allMedalsSlim = [];
  try {
    const rawMedals = statsData.Medals || statsData.CoreStats?.Medals || [];
    const medalMeta = global._medalMeta || {};
    allMedalsSlim = rawMedals.filter(m => m.Count > 0).map(m => ({ nameId: m.NameId, count: m.Count }));
    topMedals = rawMedals
      .filter(m => m.Count > 0)
      .sort((a, b) => b.Count - a.Count)
      .slice(0, 8)
      .map(m => {
        const meta = medalMeta[String(m.NameId)] || {};
        return { nameId: m.NameId, name: meta.name || String(m.NameId), count: m.Count, sprite: meta.sprite || null };
      });
  } catch(e) {}

  // Emblem + gamerpic + nameplate
  let emblemUrl = null, gamerpicUrl = null, nameplateUrl = null;
  try {
    let cachedPath = emblemPathCache[String(xuid)];
    // Migration: legacy cache entries are single-candidate (no ';images:' fallback). Treat as miss to re-resolve.
    if (cachedPath && cachedPath !== '__none__' && !cachedPath.includes('images:') && !cachedPath.includes(';')) {
      delete emblemPathCache[String(xuid)];
      cachedPath = undefined;
    }
    if (cachedPath && cachedPath !== '__none__') {
      emblemUrl = `/api/emblem-img?path=${encodeURIComponent(cachedPath)}&xuid=${xuid}`;
      const np = nameplatePathCache[String(xuid)];
      if (np) {
        nameplateUrl = `/api/emblem-img?path=${encodeURIComponent(np)}&xuid=${xuid}&type=nameplate`;
      } else {
        try {
          await resolveEmblemForXuid(xuid);
          const np2 = nameplatePathCache[String(xuid)];
          if (np2) nameplateUrl = `/api/emblem-img?path=${encodeURIComponent(np2)}&xuid=${xuid}&type=nameplate`;
        } catch(e) {}
      }
    } else if (!cachedPath) {
      const result = await resolveEmblemForXuid(xuid);
      gamerpicUrl = result?.gamerpicUrl || null;
      if (result?.emblemPath && result.emblemPath !== '__none__') {
        emblemUrl = `/api/emblem-img?path=${encodeURIComponent(result.emblemPath)}&xuid=${xuid}`;
      }
      const np = nameplatePathCache[String(xuid)];
      if (np) nameplateUrl = `/api/emblem-img?path=${encodeURIComponent(np)}&xuid=${xuid}&type=nameplate`;
    } else {
      // cachedPath === '__none__' — check nameplate independently
      const np = nameplatePathCache[String(xuid)];
      if (np) {
        nameplateUrl = `/api/emblem-img?path=${encodeURIComponent(np)}&xuid=${xuid}&type=nameplate`;
      } else {
        try {
          await resolveEmblemForXuid(xuid);
          const np2 = nameplatePathCache[String(xuid)];
          if (np2) nameplateUrl = `/api/emblem-img?path=${encodeURIComponent(np2)}&xuid=${xuid}&type=nameplate`;
        } catch(e) {}
      }
    }
    if (!gamerpicUrl && xuidToGamerpic[String(xuid)]) gamerpicUrl = xuidToGamerpic[String(xuid)];
  } catch(e) { console.log('[Emblem/Profile] failed for', gamertag, e.message); }

  const serviceTag = serviceTagCache[String(xuid)] || null;

  return {
    gamertag, xuid, emblemUrl, gamerpicUrl, nameplateUrl, serviceTag,
    csr: Object.keys(csrResults).length ? csrResults : null,
    careerRank: finalCareerRank,
    lastUpdated: new Date().toISOString(),
    stats: {
      matchesPlayed: matches, wins, losses,
      winRate: matches > 0 ? ((wins / matches) * 100).toFixed(1) : '0.0',
      kills, deaths, assists,
      kd: rankedKd,
      kda: rankedKda,
      accuracy: core.ShotAccuracy != null ? (core.ShotAccuracy * 100).toFixed(1) : (core.ShotsFired > 0 ? ((core.ShotsHit / core.ShotsFired) * 100).toFixed(1) : null),
      avgKillsPerGame: matches > 0 ? (kills / matches).toFixed(1) : '0.0',
      totalMedals: allMedalsSlim.reduce((s, m) => s + (m.count || 0), 0),
      topMedals, allMedals: allMedalsSlim,
      damageDealt: core.DamageDealt || 0,
      damageTaken: core.DamageTaken || 0,
    }
  };
}

// --- Match history: fetch in batches of 10 until 25 valid (non-custom) matches ---
async function fetchMatchHistory(xuid, gamertag, count = 100, onProgress = null, stopAtMatchId = null, _opts = {}) {
  // _opts.startOffset   — start scanning from this offset (for deep-scan continuation)
  // _opts.batchLimit    — stop after this many batches (1 batch = 25 matches)
  // _opts.lean          — skip rivals/DNA/advancedStats (faster, for background deep scan)
  // _opts.noRankedCap   — don't stop when RANKED_TARGET is reached (scan everything)
  const _startOffset  = _opts.startOffset  || 0;
  const _batchLimit   = _opts.batchLimit   || null;
  const _lean         = _opts.lean         || false;
  const _noRankedCap  = _opts.noRankedCap  || false;

  const RANKED_TARGET = _noRankedCap ? Infinity : 100; // deep-scan: no ranked cap — fetch entire history
  const TOTAL_TARGET  = _noRankedCap ? Infinity : 250; // scan cap for players with few ranked games
  const BATCH    = 25;   // matches per API call (API max is 25)
  const MAX_SCAN = _noRankedCap ? Infinity : 250;  // never scan more than 250 raw matches total

  const headers = getAuthHeaders();
  const rivalStats = {};   // keyed by rawXuid — resolved to gamertag later
  const results = [];
  const pendingTracking = [];

  // Collect up to 100 ranked games (or 250 total if player has few ranked).
  // render.js decides whether to USE ranked-only: if <40 ranked found → falls back
  // to all game types so quickplay-only players still get a Fragr Score.
  const _rankedCount = () => results.filter(r => r.isRanked).length;
  const _validCount  = () => results.filter(r => !r.isCustom).length;
  const _isDone      = () => _rankedCount() >= RANKED_TARGET || _validCount() >= TOTAL_TARGET;

  let start = _startOffset;
  let batchScanned = 0; // counts batches fetched this invocation (for _batchLimit)
  let stopReason = 'done'; // tracks why the loop exited
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Playlist ID constants hoisted out of the per-match loop — they never change
  // and re-declaring them as `const` inside the loop body allocates new arrays
  // on every iteration (one per match parsed).
  const _SLAYER_IDS      = ['f5580605-660c-43f9-ac69-4075c4a05c5d','dcb2e24e-05fb-4390-8076-32a0cdb4326e'];
  const _RANKED_ARENA_ID = 'edfef3ac-9cbe-4fa2-b949-8f29deafd483';
  const _RANKED_LEGACY_IDS = ['c94cb508-2fbd-450a-81db-bb74f7741d45'];
  const _RANKED_DOUBLES_ID = 'fa5aa2a3-2428-4912-a023-e1eeea7b877c';
  const _FFA_IDS         = ['a7d20ef6-ebdc-4c01-b96c-69b27afa88d7'];
  const _BTB_IDS         = ['2825d417-93e6-4366-98f9-839a2dc41fe4'];
  const _QUICK_PLAY_IDS  = ['1b1691dc-d8b9-4b1f-825d-cb1c065184c1','57f4f0c0-bce9-4a34-b1b0-6188ed0f0198'];

  // If the match-list endpoint is currently in shared backoff (recent 429/403
  // burst), bail out immediately so the caller can serve cached/stale data
  // instead of piling on more requests.
  if (isMatchListBackoffActive()) {
    console.warn(`[MatchFetch] Match list in backoff (${matchListBackoffSecondsRemaining()}s remaining) — skipping fetch for ${gamertag}`);
    return {
      matches: [], rivals: [], nemesisList: [], victimsList: [],
      advancedStats: {}, haloDNA: null,
      temporaryUnavailable: true, reason: 'match-list-backoff',
    };
  }

  while (!_isDone() && start < MAX_SCAN) {
    // Fetch match list with retry on 429
    let res;
    for (let attempt = 1; attempt <= 3; attempt++) {
      res = await fetchT(
        `https://halostats.svc.halowaypoint.com/hi/players/xuid(${xuid})/matches?count=${BATCH}&start=${start}`,
        { headers },
        15000
      );
      if (res.status !== 429) break;
      // Respect Retry-After header if present; fall back to 3s / 5s / 8s
      const retryAfterHdr = parseInt(res.headers.get('retry-after') || '0', 10);
      const backoffSec = retryAfterHdr > 0 ? Math.min(retryAfterHdr, 30) : [3, 5, 8][attempt - 1];
      console.warn(`[MatchFetch] 429 on match list at start=${start} for ${gamertag} — retrying in ${backoffSec}s (attempt ${attempt}/3)${retryAfterHdr > 0 ? ' [Retry-After header]' : ''}`);
      const validNow = results.filter(r => !r.isCustom).length;
      for (let sLeft = backoffSec; sLeft > 0; sLeft--) {
        if (onProgress) onProgress(validNow, start, RANKED_TARGET, { secondsLeft: sLeft, attempt, maxAttempts: 3 });
        await sleep(1000);
      }
    }
    if (!res.ok) {
      stopReason = `HTTP ${res.status}`;
      // 429 / 403 from the match list are the symptom of a thrash — arm a
      // shared cooldown so concurrent and follow-up refreshes serve cached
      // data instead of hammering. Other status codes (4xx/5xx) are likely
      // request-specific, so we don't backoff on them.
      if (res.status === 429 || res.status === 403) {
        matchListBackoffUntil = Date.now() + MATCH_LIST_BACKOFF_MS;
        console.warn(`[MatchFetch] Match list ${res.status} for ${gamertag} — arming shared backoff for ${MATCH_LIST_BACKOFF_MS/1000}s`);
      } else {
        console.warn(`[MatchFetch] Match list fetch failed at start=${start}: HTTP ${res.status} — stopping early for ${gamertag}`);
      }
      break;
    }
    const data = await res.json();
    const rawBatch = data.Results || [];
    if (!rawBatch.length) { stopReason = 'no more history'; break; }

    // Incremental fetch: trim batch at the known boundary match — skip fetching
    // details for matches we already have in cache. `hitStopNoop` distinguishes
    // "anchor was the very first match (nothing new)" from "anchor was later
    // in the batch (some new matches above it)" — the former is expected and
    // should NOT produce a scary "0 ranked / 0 total" warning at the bottom.
    let hitStop = false;
    let hitStopNoop = false;
    let batchToProcess = rawBatch;
    if (stopAtMatchId) {
      const stopIdx = rawBatch.findIndex(m => m.MatchId === stopAtMatchId);
      if (stopIdx !== -1) {
        batchToProcess = rawBatch.slice(0, stopIdx); // only the new ones
        hitStop = true;
        hitStopNoop = stopIdx === 0;
      }
    }

    const fetchedDetails = await fetchConcurrent(batchToProcess, async (m) => {
      try {
        const r = await fetchT(`https://halostats.svc.halowaypoint.com/hi/matches/${m.MatchId}/stats`, { headers }, 15000);
        const md = r.ok ? await r.json() : null;
        // Piggyback clearance from match data — every match response contains the
        // ClearanceId (FlightConfigurationId) that was active, saving us a settings.svc call.
        if (md?.MatchInfo?.ClearanceId && md.MatchInfo.ClearanceId !== cachedClearance) {
          cachedClearance = md.MatchInfo.ClearanceId;
          clearanceFetchedAt = Date.now();
          clearanceFailedAt = 0;
          getRedis().then(c => c && c.set('clearanceToken', JSON.stringify({ token: cachedClearance, fetchedAt: clearanceFetchedAt }))).catch(() => {});
        }
        return { m, md, skillData: null };
      } catch(e) { return { m, md: null, skillData: null }; }
    }, 6);

    start += BATCH;
    batchScanned++;
    // Brief pause between batches to avoid bursting halostats rate limit
    if (!_isDone() && start < MAX_SCAN && !hitStop) {
      await sleep(200);
    }

    // Process ALL matches in this batch BEFORE checking batchLimit so results
    // are always populated — moving this check above the for-loop caused every
    // deep-scan batch to return 0 ranked / 0 total (matches fetched but never parsed).
    for (const { m, md, skillData: prefetchedSkill } of fetchedDetails) {
      if (_isDone()) break;
    try {
      let kills = 0, deaths = 0, assists = 0, gameMode = null, teams = [];
      let placement = null, score = 0, damageDealt = 0, damageTaken = 0, accuracy = null;
      let weaponStats = [], mmr = null, oppMmr = null, expectedKills = null, expectedDeaths = null, objStats = null;
      let mapName = null, mapImageUrl = null, isRanked = false, csrAfter = null, csrBefore = null, csrDelta = null, matchOutcome = 0;
        let matchTopMedals = [];
      // Hoisted so they remain in scope after the `if (md)` block closes — the
      // results.push at the bottom references them. Declaring inside the block
      // (as const) caused a ReferenceError that fell into the per-match catch,
      // dropping isRanked and producing `ranked=0/N` for true ranked matches.
      let matchPlaylistId = null, playlistKind = null;
      let isRankedSlayer = false, isRankedArena = false, isRankedLegacy = false;

      if (md) {
        const lifecycleMode = md.MatchInfo?.LifecycleMode;
        const playlistExp = md.MatchInfo?.PlaylistExperience;
        if (lifecycleMode === 1 && !playlistExp) {
          results.push({ matchId: m.MatchId, isCustom: true, gameMode: 'Custom Game', kills: 0, deaths: 0, assists: 0, damageDealt: 0, damageTaken: 0 });
          continue;
        }
        const catNum = md.MatchInfo?.GameVariantCategory;
        const gameplayInteraction = md.MatchInfo?.GameplayInteraction;
        if (gameplayInteraction === 2 || [27,28,29,21,31].includes(catNum)) {
          results.push({ matchId: m.MatchId, isCustom: true, gameMode: 'Firefight', kills: 0, deaths: 0, assists: 0, damageDealt: 0, damageTaken: 0 });
          continue;
        }

        matchPlaylistId = md.MatchInfo?.Playlist?.AssetId || null;
        const isFFA = _FFA_IDS.includes(matchPlaylistId) || md.MatchInfo?.TeamsEnabled === false;
        const isBTB = _BTB_IDS.includes(matchPlaylistId);
        const isQuickPlay = _QUICK_PLAY_IDS.includes(matchPlaylistId);
        isRankedSlayer = _SLAYER_IDS.includes(matchPlaylistId);
        isRankedArena = matchPlaylistId === _RANKED_ARENA_ID;
        isRankedLegacy = _RANKED_LEGACY_IDS.includes(matchPlaylistId);
        const isRankedDoubles = matchPlaylistId === _RANKED_DOUBLES_ID;
        isRanked = isRankedArena || isRankedSlayer || isRankedLegacy || isRankedDoubles;
        // Non-ranked (quickplay/social) games are allowed through so players
        // with no ranked games still see match history and a Fragr Score.
        // render.js statMatches logic falls back to all games when <100 ranked exist.

        // Game mode
        try {
          // Try multiple name sources — QP games sometimes have empty UgcGameVariant.Name
          const ugcName = md.MatchInfo?.UgcGameVariant?.Name
                       || md.MatchInfo?.UgcGameVariant?.Tags?.[0]
                       || md.MatchInfo?.PlaylistMapModePair?.Name
                       || md.MatchInfo?.GameVariant?.Name
                       || (!isRanked && !isBTB && !isQuickPlay ? KNOWN_PLAYLISTS[matchPlaylistId] : '')
                       || '';
          // Push non-ranked game mode info to debug buffer for admin inspection (no console log)
          if (!isRanked) {
            _pushGameModeDebug({
              ts: new Date().toISOString(),
              matchId: m.MatchId,
              gamertag,
              resolvedName: ugcName || null,
              UgcGameVariant: md.MatchInfo?.UgcGameVariant || null,
              PlaylistMapModePair: md.MatchInfo?.PlaylistMapModePair || null,
              PlaylistExperience: md.MatchInfo?.PlaylistExperience || null,
              GameVariantCategory: catNum,
              PlaylistId: matchPlaylistId,
              PlaylistName: md.MatchInfo?.Playlist?.PublicName || md.MatchInfo?.Playlist?.Name || null,
            });
          }
          const ugcLower = ugcName.toLowerCase();
          const myPd = (md.Players||[]).find(p => String(p.PlayerId||'').replace('xuid(','').replace(')','') === String(xuid));
          const myPstats = myPd?.PlayerTeamStats?.[0]?.Stats || {};
          const hasZones = !!myPstats.ZonesStats, hasOddball = !!myPstats.OddballStats;
          const isKothByName = ugcLower.includes('king of the hill') || ugcLower.includes('koth') || ugcLower.includes('hill');

          // Helper: prefix for objective modes (Arena gets "Ranked Arena: ", Doubles/Slayer just get name)
          const _arenaPrefix = isRankedLegacy ? 'Ranked Legacy: ' : (isRanked && !isRankedSlayer && !isRankedDoubles ? 'Ranked Arena: ' : '');

          if (catNum === 14) gameMode = _arenaPrefix + 'King of the Hill';
          else if (catNum === 20) gameMode = _arenaPrefix + 'Land Grab';
          else if (catNum === 11) gameMode = _arenaPrefix + 'Strongholds';
          else if (isKothByName) gameMode = _arenaPrefix + 'King of the Hill';
          else if (hasZones && !hasOddball && (catNum === 12 || catNum === 18)) {
            const z = myPstats.ZonesStats;
            gameMode = _arenaPrefix + (((z.StrongholdCaptures??0)>0||(z.StrongholdSecures??0)>0) ? 'Strongholds' : 'King of the Hill');
          } else if (ugcName) {
            gameMode = ugcName.replace(/^Arena:\s*/i,'').replace(/:/g,' ').replace(/\s+/g,' ').trim();
            if (isRanked) {
              if (isRankedDoubles) gameMode = 'Ranked Doubles';
              else if (isRankedSlayer) gameMode = 'Ranked Slayer';
              else if (isRankedLegacy) {
                if (!gameMode.toLowerCase().startsWith('ranked legacy')) gameMode = 'Ranked Legacy: ' + gameMode.replace(/^Ranked\s+/i,'');
              } else if (!gameMode.toLowerCase().startsWith('ranked')) gameMode = 'Ranked Arena: ' + gameMode;
              else if (!gameMode.toLowerCase().startsWith('ranked arena')) gameMode = gameMode.replace(/^Ranked /i,'Ranked Arena: ');
            }
          } else {
            gameMode = (isRanked ? 'Ranked ' : '') + (MODE_NAMES[catNum] || 'Mode ' + catNum);
            if (isRankedDoubles) gameMode = 'Ranked Doubles';
            else if (isRankedLegacy) gameMode = 'Ranked Legacy: ' + gameMode.replace(/^Ranked\s+/i,'');
            else if (isRankedSlayer) gameMode = 'Ranked Slayer';
            else if (isRanked && !gameMode.toLowerCase().startsWith('ranked arena')) gameMode = gameMode.replace(/^Ranked /i,'Ranked Arena: ');
          }
          gameMode = (gameMode||'').replace(/Capture the Flag (\d+) Captures?/gi,'CTF $1').replace(/Capture the Flag/gi,'CTF').trim();
          // FFA override
          if (isFFA && !gameMode.toLowerCase().startsWith('ffa')) gameMode = 'FFA ' + gameMode;
          // BTB override — slayer stays "BTB Slayer", everything else gets "Big Team Battle: " prefix
          if (isBTB && !gameMode.toLowerCase().startsWith('big team') && !gameMode.toLowerCase().startsWith('btb')) {
            gameMode = /slayer/i.test(gameMode) ? 'BTB Slayer' : 'Big Team Battle: ' + gameMode;
          }
          // Quick Play prefix
          if (isQuickPlay && !gameMode.toLowerCase().startsWith('quick play')) {
            gameMode = 'Quick Play: ' + gameMode;
          }
        } catch(e) { gameMode = (isFFA?'FFA ':isBTB?'BTB ':isQuickPlay?'Quick Play: ':isRanked?'Ranked ':'') + (MODE_NAMES[catNum]||'Unknown'); }

        const _mapAssetId = md.MatchInfo?.MapVariant?.AssetId;
        mapName = await resolveMapName(_mapAssetId, md.MatchInfo?.MapVariant?.VersionId, headers);
        mapImageUrl = getMapImageUrl(_mapAssetId);

        // (gamertag resolution handled after the loop — top rivals only)

        const teamMap = {};
        for (const player of (md.Players||[])) {
          const teamId = player.LastTeamId ?? 0;
          if (!teamMap[teamId]) teamMap[teamId] = { teamId, outcome: null, players: [] };
          const pcore = player.PlayerTeamStats?.[0]?.Stats?.CoreStats || {};
          const rawXuid = String(player.PlayerId||'').replace('xuid(','').replace(')','');
          const gt = xuidToGt[rawXuid] || ('Spartan ' + rawXuid.slice(-4));
          const pk = pcore.Kills||0, pd = pcore.Deaths||0, pa = pcore.Assists||0;
          const ppstats = player.PlayerTeamStats?.[0]?.Stats || {};
          const ppodd = ppstats.OddballStats, ppzones = ppstats.ZonesStats, ppctf = ppstats.CaptureTheFlagStats, ppstock = ppstats.StockpileStats;
          const parseDurP = s => { if(!s||s==='PT0S')return 0; const mm=String(s).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/); return mm?(parseInt(mm[1]||0)*3600)+(parseInt(mm[2]||0)*60)+parseFloat(mm[3]||0):0; };
          // Per-player CSR from RankRecap (present in ranked matches). PostMatchCsr
          // is the player's CSR after the game ended — what we surface next to their name.
          let plCsrTier = null, plCsrSubTier = null, plCsrValue = null;
          const plRankRecap = player.PlayerTeamStats?.[0]?.RankRecap;
          const plPost = plRankRecap?.PostMatchCsr;
          if (plPost && plPost.Tier !== undefined) {
            const _tn = ['Bronze','Silver','Gold','Platinum','Diamond','Onyx'];
            const _t = _tn[plPost.Tier];
            if (_t) {
              plCsrTier = _t;
              plCsrSubTier = (plPost.SubTier ?? 0) + 1;
              plCsrValue = plPost.Value ?? null;
            }
          }
          // Rich per-player fields captured here so saveMatchParticipants can
          // persist them to match_participants for the private-player fallback.
          // Computing once per roster slot keeps the cached payload self-
          // sufficient: future reconstructs don't need to re-fetch match
          // details.
          const ppShotsFired = pcore.ShotsFired || 0;
          const ppShotsHit   = pcore.ShotsHit   || 0;
          const ppAccuracy = pcore.Accuracy != null
            ? pcore.Accuracy
            : (pcore.ShotAccuracy != null ? pcore.ShotAccuracy * 100
                : (ppShotsFired > 0 ? (ppShotsHit / ppShotsFired) * 100 : null));
          const ppMedalsRaw = pcore.Medals || [];
          const ppTopMedals = Array.isArray(ppMedalsRaw)
            ? ppMedalsRaw
                .filter(mm => mm && mm.Count > 0)
                .sort((a,b) => (b.Count||0)-(a.Count||0))
                .slice(0, 12)
                .map(mm => ({ nameId: mm.NameId, count: mm.Count }))
            : [];
          let ppCsrPreValue = null, ppCsrDelta = null;
          const plPre = plRankRecap?.PreMatchCsr;
          if (plPre && plPre.Value != null) {
            ppCsrPreValue = plPre.Value;
            if (plPost && plPost.Value != null) ppCsrDelta = plPost.Value - plPre.Value;
          }
          // Per-player objective sub-stats for reconstruct → renderer. Shape
          // matches the per-search-target objStats below so the same UI cells
          // light up regardless of who fetched the match.
          let ppObjStats = null;
          if (ppodd && (catNum===12||catNum===18) && !ppzones) {
            ppObjStats = { mode:'Oddball',
              timeAsCarrier: parseDurP(ppodd.TimeAsSkullCarrier),
              longestCarry:  parseDurP(ppodd.LongestTimeAsSkullCarrier),
              ballGrabs:     ppodd.SkullGrabs ?? null,
              killsAsCarrier: ppodd.KillsAsSkullCarrier ?? null,
              carrierKills:  ppodd.SkullCarriersKilled ?? null,
              scoringTicks:  ppodd.SkullScoringTicks ?? null,
            };
          } else if (ppzones) {
            const _caps = ppzones.StrongholdCaptures ?? ppzones.ZoneCaptures ?? ppzones.HillCaptures ?? ppzones.Captures ?? null;
            const _secs = ppzones.StrongholdSecures  ?? ppzones.ZoneSecures  ?? ppzones.HillSecures  ?? ppzones.Secures  ?? null;
            const _defK = ppzones.StrongholdDefensiveKills ?? ppzones.DefensiveKills ?? null;
            const _offK = ppzones.StrongholdOffensiveKills ?? ppzones.OffensiveKills ?? null;
            const _ticks= ppzones.StrongholdScoringTicks ?? ppzones.ScoringTicks ?? null;
            const _occT = ppzones.StrongholdOccupationTime ?? ppzones.OccupationTime ?? ppzones.TotalTimeInZone ?? ppzones.TimeInZone ?? null;
            ppObjStats = { mode:'Zones',
              captures:_caps, secures:_secs,
              defensiveKills:_defK, offensiveKills:_offK,
              scoringTicks:_ticks, occupationTime: parseDurP(_occT),
            };
          } else if (ppctf) {
            const ctfCarrier = ppctf.TimeAsCarrier;
            ppObjStats = { mode:'CTF',
              flagCaptures: ppctf.FlagCaptures ?? null,
              flagGrabs:    ppctf.FlagGrabs    ?? null,
              flagReturns:  ppctf.FlagReturns  ?? null,
              flagCarrierKills: ppctf.FlagCarrierKills ?? null,
              flagsStolen:  ppctf.FlagsStolen ?? null,
              timeAsCarrier: typeof ctfCarrier === 'number' ? ctfCarrier : parseDurP(ctfCarrier),
            };
          } else if (ppstock) {
            ppObjStats = { mode:'Stockpile',
              seedsDeposited: ppstock.PowerSeedsDeposited ?? null,
              seedsStolen:    ppstock.PowerSeedsStolenFromBase ?? null,
              seedsPickedUp:  ppstock.PowerSeedsPickedUp ?? null,
            };
          }
          teamMap[teamId].players.push({
            gamertag: gt, rawXuid,
            kills: pk, deaths: pd, assists: pa,
            score: pcore.Score||0,
            kd: pd>0?(pk/pd).toFixed(2):pk.toString(),
            kda: (pk - pd + pa/3).toFixed(1),
            damage: pcore.DamageDealt||0,
            gamerpicUrl: xuidToGamerpic[rawXuid]||null,
            // Per-player rank — null when match is unranked or RankRecap is missing.
            // Renderer must treat any null field as "no badge".
            csrTier: plCsrTier,
            csrSubTier: plCsrSubTier,
            csrValue: plCsrValue,
            csrPreValue: ppCsrPreValue,
            csrDelta: ppCsrDelta,
            // Rich fields — every one mirrors what halo.js currently extracts
            // only for the search target. Capturing here lets the private-
            // player reconstruct surface the same data without re-fetching.
            damageTaken: pcore.DamageTaken != null ? pcore.DamageTaken : null,
            shotsFired: ppShotsFired || null,
            shotsLanded: ppShotsHit || null,
            accuracy: ppAccuracy != null ? parseFloat(ppAccuracy).toFixed(1) : null,
            headshotKills:    pcore.HeadshotKills    != null ? pcore.HeadshotKills    : null,
            meleeKills:       pcore.MeleeKills       != null ? pcore.MeleeKills       : null,
            grenadeKills:     pcore.GrenadeKills     != null ? pcore.GrenadeKills     : null,
            powerWeaponKills: pcore.PowerWeaponKills != null ? pcore.PowerWeaponKills : null,
            weaponStats: {
              headshots:   pcore.HeadshotKills    || 0,
              melee:       pcore.MeleeKills       || 0,
              grenades:    pcore.GrenadeKills     || 0,
              powerWeapon: pcore.PowerWeaponKills || 0,
            },
            placement: player.Rank != null ? player.Rank + 1 : null,
            medals: ppTopMedals.length ? ppTopMedals : null,
            objStats: ppObjStats,
            // Objective stats for ranking (legacy fields used by placement calc)
            ballTime: ppodd ? parseDurP(ppodd.TimeAsSkullCarrier) : 0,
            zoneCaptures: ppzones ? (ppzones.StrongholdCaptures||0) : 0,
            zoneSecures: ppzones ? (ppzones.StrongholdSecures||0) : 0,
            flagCaptures: ppctf ? (ppctf.FlagCaptures||0) : 0,
            seeds: ppstock ? (ppstock.PowerSeedsDeposited||0) : 0,
          });

          if (String(player.PlayerId||'') === `xuid(${xuid})` || String(player.Xuid||'') === String(xuid)) {
            // player.Outcome from detailed stats; fall back to match-list outcome
            matchOutcome = player.Outcome || m.Outcome || 0;
            kills=pk; deaths=pd; assists=pa; score=pcore.Score||0;
            damageDealt=pcore.DamageDealt||0; damageTaken=pcore.DamageTaken||0;
            shotsFired = pcore.ShotsFired||0; shotsHit = pcore.ShotsHit||0;
            accuracy = pcore.Accuracy!=null ? pcore.Accuracy : pcore.ShotAccuracy!=null ? pcore.ShotAccuracy*100 : shotsFired>0 ? (shotsHit/shotsFired)*100 : null;
            placement = player.Rank ? player.Rank + 1 : null;
            weaponStats = { headshots: pcore.HeadshotKills||0, melee: pcore.MeleeKills||0, grenades: pcore.GrenadeKills||0, powerWeapon: pcore.PowerWeaponKills||0 };
            const pstats = player.PlayerTeamStats?.[0]?.Stats || {};
            const rawMatchMedals = pstats.CoreStats?.Medals || pcore.Medals || [];
            matchTopMedals = rawMatchMedals
              .filter(mm => mm.Count > 0)
              .sort((a,b) => (b.Count||0)-(a.Count||0))
              .slice(0,12)
              .map(mm => ({ nameId: mm.NameId, count: mm.Count }));
            const oddball=pstats.OddballStats, zones=pstats.ZonesStats, ctf=pstats.CaptureTheFlagStats, stockpile=pstats.StockpileStats;
            const parseDur = s => { if(!s||s==='PT0S'||s==='PT')return 0; const mm=String(s).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/); return mm?(parseInt(mm[1]||0)*3600)+(parseInt(mm[2]||0)*60)+parseFloat(mm[3]||0):0; };
            if (oddball && (catNum===12||catNum===18) && !zones) objStats={mode:'Oddball',timeAsCarrier:parseDur(oddball.TimeAsSkullCarrier),longestCarry:parseDur(oddball.LongestTimeAsSkullCarrier),ballGrabs:oddball.SkullGrabs??null,killsAsCarrier:oddball.KillsAsSkullCarrier??null,carrierKills:oddball.SkullCarriersKilled??null,scoringTicks:oddball.SkullScoringTicks??null};
            else if (zones) {
              let zm=gameMode?.toLowerCase().includes('king')?'King of the Hill':gameMode?.toLowerCase().includes('land')?'Land Grab':'Strongholds';
              // KotH / Land Grab / Strongholds all use ZonesStats but with varying field names
              const _caps = zones.StrongholdCaptures ?? zones.ZoneCaptures ?? zones.HillCaptures ?? zones.Captures ?? null;
              const _secs = zones.StrongholdSecures  ?? zones.ZoneSecures  ?? zones.HillSecures  ?? zones.Secures  ?? null;
              const _defK = zones.StrongholdDefensiveKills ?? zones.DefensiveKills ?? null;
              const _offK = zones.StrongholdOffensiveKills ?? zones.OffensiveKills ?? null;
              const _ticks= zones.StrongholdScoringTicks ?? zones.ScoringTicks ?? null;
              const _occT = zones.StrongholdOccupationTime ?? zones.OccupationTime ?? zones.TotalTimeInZone ?? zones.TimeInZone ?? null;
              objStats={mode:zm,captures:_caps,secures:_secs,defensiveKills:_defK,offensiveKills:_offK,scoringTicks:_ticks,occupationTime:parseDur(_occT)};
            }
            else if (ctf) { const ctfCarrier = ctf.TimeAsCarrier; const ctfCarrierSecs = typeof ctfCarrier==='number' ? ctfCarrier : parseDur(ctfCarrier); objStats={mode:'CTF',flagCaptures:ctf.FlagCaptures??null,flagGrabs:ctf.FlagGrabs??null,flagReturns:ctf.FlagReturns??null,flagCarrierKills:ctf.FlagCarrierKills??null,flagsStolen:ctf.FlagsStolen??null,timeAsCarrier:ctfCarrierSecs||null}; }
            else if (stockpile) objStats={mode:'Stockpile',seedsDeposited:stockpile.PowerSeedsDeposited??null,seedsStolen:stockpile.PowerSeedsStolenFromBase??null,seedsPickedUp:stockpile.PowerSeedsPickedUp??null};
            teamMap[teamId].outcome = player.Outcome || m.Outcome;
            // CSR delta
            const rr = player.PlayerTeamStats?.[0]?.RankRecap;
            const csrEntry=rr?.PostMatchCsr, csrPre=rr?.PreMatchCsr;
            if (csrEntry) {
              const tn=['Bronze','Silver','Gold','Platinum','Diamond','Onyx'];
              const tier=tn[csrEntry.Tier??-1]||'', sub=csrEntry.SubTier!==undefined?csrEntry.SubTier+1:'';
              csrAfter=tier==='Onyx'?'Onyx '+csrEntry.Value:tier?tier+' '+sub:null;
              if (csrPre&&csrEntry.Value!=null&&csrPre.Value!=null) { csrDelta=csrEntry.Value-csrPre.Value; const pt=tn[csrPre.Tier??-1]||'',ps=csrPre.SubTier!==undefined?csrPre.SubTier+1:''; csrBefore=pt==='Onyx'?'Onyx '+csrPre.Value:pt?pt+' '+ps:null; }
            }
          }
        }
        pendingTracking.push({ matchId: m.MatchId, matchOutcome, teamMap, xuid });

        if (isRanked && prefetchedSkill) {
          try {
            const entry=(prefetchedSkill.Value||[])[0];
            if (entry?.Result) {
              const r=entry.Result;
              mmr=r.TeamMmr?Math.round(r.TeamMmr):null;
              const teamIds=Object.keys(r.TeamMmrs||{}), myTeamId=String(r.TeamId);
              const oppTeamId=teamIds.find(id=>id!==myTeamId);
              oppMmr=oppTeamId&&r.TeamMmrs[oppTeamId]?Math.round(r.TeamMmrs[oppTeamId]):null;
              const sp=r.StatPerformances;
              if(sp?.Kills)expectedKills=Math.round(sp.Kills.Expected*10)/10;
              if(sp?.Deaths)expectedDeaths=Math.round(sp.Deaths.Expected*10)/10;
              if(r.RankRecap?.PreMatchCsr?.Value!=null&&r.RankRecap?.PostMatchCsr?.Value!=null) {
                csrDelta=r.RankRecap.PostMatchCsr.Value-r.RankRecap.PreMatchCsr.Value;
                const post=r.RankRecap.PostMatchCsr, tn=['Bronze','Silver','Gold','Platinum','Diamond','Onyx'];
                const tier=tn[post.Tier??-1]||'';
                csrAfter=tier==='Onyx'?'Onyx '+post.Value:tier?tier+' '+(post.SubTier+1):null;
              }
            }
          } catch(e) {}
        }
        teams = Object.values(teamMap).map(t=>({...t,players:t.players.sort((a,b)=>b.kills-a.kills)}));

        // Calculate placement using a composite score per player:
        // Base: kills + assists*0.5 + damage/500
        // Objective bonus (replaces damage weight when present):
        //   Oddball: ball hold time (seconds) * 0.08 counts heavily
        //   Strongholds/KotH: zone caps * 3 + secures * 2
        //   CTF: flag caps * 10 + flag grabs * 2
        //   Stockpile: seeds deposited * 5
        // Winning team → ranks 1-4, losing team → ranks 5-8
        if (teams.length >= 2) {
          const isOddball = catNum && [12,18].includes(catNum) && gameMode && /oddball/i.test(gameMode);
          const isZones   = catNum && [11,14,20].includes(catNum);
          const isCTF     = catNum && [13,15].includes(catNum);
          const isStock   = catNum === 24;

          function playerScore(p) {
            const base = (p.kills||0) + (p.assists||0)*0.5;
            if (isOddball) return base + (p.ballTime||0)*0.08;
            if (isZones)   return base + (p.zoneCaptures||0)*3 + (p.zoneSecures||0)*2;
            if (isCTF)     return base + (p.flagCaptures||0)*10 + (p.seeds||0)*2;
            if (isStock)   return base + (p.seeds||0)*5;
            // Slayer: kills + assists*0.5 + damage contribution
            return base + (p.damage||0)/600;
          }

          const myTeam = teams.find(t => t.outcome === matchOutcome);
          if (myTeam && myTeam.players.length > 0) {
            // Sort team by composite score descending
            const sorted = [...myTeam.players].sort((a,b) => playerScore(b) - playerScore(a));
            const myRankOnTeam = sorted.findIndex(p =>
              p.kills === kills && p.deaths === deaths && p.assists === assists && p.damage === damageDealt
            );
            const offset = matchOutcome === 2 ? 0 : myTeam.players.length;
            if (myRankOnTeam >= 0) placement = myRankOnTeam + 1 + offset;
          }
        }
      }
      // Playlist context for downstream CSR pickers (match player rows + benchmark).
      // 'arena' | 'slayer' | 'legacy' — only meaningful when isRanked is true.
      playlistKind = !isRanked ? null
        : isRankedSlayer ? 'slayer'
        : isRankedLegacy ? 'legacy'
        : isRankedArena  ? 'arena'
        : null;
      results.push({
        matchId: m.MatchId, outcome: m.Outcome, startTime: m.MatchInfo?.StartTime, duration: m.MatchInfo?.Duration,
        mapName, mapImageUrl,
        _mapAssetId: md.MatchInfo?.MapVariant?.AssetId || null,
        _mapVersionId: md.MatchInfo?.MapVariant?.VersionId || null,
        gameMode, isRanked, kills, deaths, assists, score,
        kda: (kills - deaths + assists/3).toFixed(1),
        damageDealt, damageTaken, accuracy: accuracy!=null?parseFloat(accuracy).toFixed(1):null,
        shotsFired, shotsHit,
        placement: placementStr(placement), weaponStats, topMedals: matchTopMedals, csrAfter, csrBefore, csrDelta, teams,
        mmr, oppMmr, expectedKills, expectedDeaths, objStats,
        playlistId: matchPlaylistId || null, playlistKind,
      });
    } catch(e) {
      // Per-match parsing failure — log so a regression in classification
      // (e.g. a ReferenceError on the playlist vars) shows up in server logs
      // instead of silently producing `ranked=0/N`.
      console.warn(`[MatchFetch] Failed to parse match ${m.MatchId} for ${gamertag}: ${e && e.message ? e.message : e}`);
      results.push({ matchId: m.MatchId, outcome: m.Outcome, startTime: m.MatchInfo?.StartTime, gameMode: null, kills:0,deaths:0,assists:0,damageDealt:0,damageTaken:0 });
    }
    } // end for fetchedDetails

    if (hitStop) {
      stopReason = hitStopNoop ? 'incremental no-op (cache up to date)' : 'incremental stop (reached cached anchor)';
      break;
    }

    // batchLimit check goes here — AFTER processing fetchedDetails so this
    // batch's matches are always saved before we stop.
    if (_batchLimit !== null && batchScanned >= _batchLimit) {
      stopReason = 'batchLimit';
      break;
    }

    const rankedNow = _rankedCount();
    const validNow  = _validCount();
    if (onProgress) onProgress(rankedNow, start, RANKED_TARGET);
  } // end while
  const finalRanked = _rankedCount();
  const finalValid  = _validCount();
  // Only warn when we genuinely fell short — an incremental no-op is a
  // success path (cache already had everything) and shouldn't surface as
  // "Completed with 0 ranked / 0 total".
  const isIncrementalNoop = stopReason.startsWith('incremental no-op');
  if (!isIncrementalNoop && finalRanked < RANKED_TARGET && finalValid < TOTAL_TARGET) {
    if (start >= MAX_SCAN) stopReason = 'MAX_SCAN reached';
    console.warn(`[MatchFetch] Completed with ${finalRanked} ranked / ${finalValid} total after scanning ${start} raw matches for ${gamertag}. Reason: ${stopReason}`);
  } else if (isIncrementalNoop) {
    console.log(`[MatchFetch] No new matches since cached anchor for ${gamertag} (incremental no-op)`);
  }

  // (no bulk GT resolve here — we only resolve what we actually need below)

  // Backfill gamerpics on team players (always — lean or not, so DB rows stay enriched)
  for (const result of results) {
    for (const team of (result.teams||[])) {
      for (const pl of (team.players||[])) {
        if (!pl.gamerpicUrl && pl.rawXuid && xuidToGamerpic[pl.rawXuid]) pl.gamerpicUrl = xuidToGamerpic[pl.rawXuid];
        if (pl.rawXuid && xuidToGt[pl.rawXuid]) pl.gamertag = xuidToGt[pl.rawXuid];
      }
    }
  }

  // In lean mode (deep-scan background batches) skip rivals resolution, advancedStats,
  // and haloDNA — those are expensive and the results are discarded by the caller anyway.
  // The _lean flag is set by the deep-scan worker via _opts.lean = true.
  if (_lean) {
    return { matches: results, advancedStats: {}, haloDNA: null, rivals: [], nemesisList: [], victimsList: [], scanEndOffset: start, stopReason };
  }

  // Build rivals from all fetched matches — tracked by rawXuid (no GT needed yet)
  const myXuidStr = String(xuid);
  for (const { matchOutcome, teamMap } of pendingTracking) {
    let myTeamId = null;
    for (const [tid, team] of Object.entries(teamMap)) {
      if (team.players.some(pl => pl.rawXuid === myXuidStr)) { myTeamId = tid; break; }
    }
    if (myTeamId === null) continue;
    for (const [tid, team] of Object.entries(teamMap)) {
      if (String(tid) === String(myTeamId)) continue;
      for (const pl of team.players) {
        const oppXuid = pl.rawXuid;
        if (!oppXuid || oppXuid === myXuidStr) continue;
        if (!rivalStats[oppXuid]) rivalStats[oppXuid] = { wins:0, losses:0, gamerpicUrl: pl.gamerpicUrl||null };
        if (matchOutcome===2) rivalStats[oppXuid].wins++;
        else if (matchOutcome===3) rivalStats[oppXuid].losses++;
        if (pl.gamerpicUrl && !rivalStats[oppXuid].gamerpicUrl) rivalStats[oppXuid].gamerpicUrl = pl.gamerpicUrl;
      }
    }
  }

  // Pick top 50 rival xuids, then resolve ONLY those gamertags (1–2 API calls max)
  const topRivalXuids = Object.entries(rivalStats)
    .filter(([,s]) => s.wins+s.losses >= 1)
    .sort((a,b) => (b[1].wins+b[1].losses)-(a[1].wins+a[1].losses))
    .slice(0, 50)
    .map(([x]) => x);

  const _rivalBackoffMs = 30 * 60 * 1000; // 30 min
  const now30 = Date.now();
  const unknownRivalXuids = topRivalXuids.filter(x => !xuidToGt[x] && !((_rivalGtBackoff[x] || 0) > now30 - _rivalBackoffMs));
  if (unknownRivalXuids.length > 0) {
    console.log(`[Rivals] Resolving ${unknownRivalXuids.length} rival gamertags`);
    try {
      const rHeaders = getAuthHeaders();
      // Profile API accepts up to 50 xuids per call
      for (let i = 0; i < unknownRivalXuids.length; i += 50) {
        if (i > 0) await new Promise(r => setTimeout(r, 1500));
        const batch = unknownRivalXuids.slice(i, i + 50);
        const url = 'https://profile.svc.halowaypoint.com/users?' + batch.map(x => `xuids=${x}`).join('&');
        const r = await fetchT(url, { headers: rHeaders }, 15000);
        if (r.ok) {
          const data = await r.json();
          const users = Array.isArray(data) ? data : (data.users || data.Users || Object.values(data));
          for (const user of users) {
            if (!user || typeof user !== 'object') continue;
            const ux = String(user.xuid || user.Xuid || '').replace('xuid(','').replace(')','');
            const gt = user.gamertag || user.Gamertag || '';
            if (ux && gt) xuidToGt[ux] = gt;
            const gp = user.gamerpic?.medium || user.gamerpic?.large || null;
            if (ux && gp && !xuidToGamerpic[ux]) xuidToGamerpic[ux] = gp;
          }
        } else if (r.status === 429) {
          // Back off unresolved xuids for 30 min so we stop hammering on every fetch
          const resolved = new Set(Object.keys(xuidToGt));
          for (const x of batch) { if (!resolved.has(x)) _rivalGtBackoff[x] = Date.now(); }
          console.log('[Rivals] Rate limited — backing off unresolved rivals for 30min');
          break;
        }
      }
    } catch(e) { console.log('[Rivals] GT resolve error:', e.message); }
  }

  // Convert xuid-keyed rivalStats to gamertag-keyed rivals array
  const rivals = topRivalXuids
    .map(x => {
      const gt = xuidToGt[x];
      if (!gt) return null; // couldn't resolve — omit from rivals
      const s = rivalStats[x];
      return { gamertag: gt, wins: s.wins, losses: s.losses, total: s.wins+s.losses,
               gamerpicUrl: s.gamerpicUrl || xuidToGamerpic[x] || null };
    })
    .filter(Boolean);

  const nemesisList = [...rivals].filter(r=>r.losses>r.wins).sort((a,b)=>b.losses-a.losses||a.wins-b.wins).slice(0,15);
  const victimsList = [...rivals].filter(r=>r.wins>r.losses).sort((a,b)=>b.wins-a.wins||a.losses-b.losses).slice(0,15);

  const advancedStats = computeAdvancedStats(results);
  const haloDNA = generateHaloDNA(results, advancedStats, null);
  return { matches: results, advancedStats, haloDNA, rivals, nemesisList, victimsList, scanEndOffset: start, stopReason };
}

// Fetch skill data (MMR, expected K/D) for ranked matches in the background.
// Runs against skill.svc.halowaypoint.com — a separate domain from halostats,
// so it doesn't contend with the match list / match stats rate limit bucket.
// Mutates match objects in-place; call saveToCache after to persist.
async function fetchAndApplySkillData(xuid, matches) {
  const headers = getAuthHeaders();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ranked = matches.filter(m => m.isRanked && m.matchId && (m.mmr == null || m.csrDelta == null) && !_deadSkillMatchIds.has(m.matchId));
  if (!ranked.length) return;
  console.log(`[SkillBG] Fetching skill data for ${ranked.length} ranked matches (xuid=${xuid})`);

  const BATCH = 5;
  for (let i = 0; i < ranked.length; i += BATCH) {
    const batch = ranked.slice(i, i + BATCH);
    let _skillOk = 0, _skillNoSp = 0, _skillErr = 0;
    await Promise.all(batch.map(async (match) => {
      try {
        const sr = await fetchT(
          `https://skill.svc.halowaypoint.com/hi/matches/${match.matchId}/skill?players=xuid(${xuid})`,
          { headers },
          15000
        );
        if (!sr.ok) {
          if (sr.status === 404) {
            // Permanently dead match — cache so all future fetches skip it
            if (_deadSkillMatchIds.size < DEAD_SKILL_MAX) _deadSkillMatchIds.add(match.matchId);
          } else {
            console.warn(`[SkillBG] HTTP ${sr.status} for match ${match.matchId}`);
          }
          _skillErr++;
          return;
        }
        const skillData = await sr.json();
        const entry = (skillData.Value || [])[0];
        if (!entry?.Result) { _skillErr++; return; }
        const rv = entry.Result;
        match.mmr = rv.TeamMmr ? Math.round(rv.TeamMmr) : null;
        const teamIds = Object.keys(rv.TeamMmrs || {});
        const myTeamId = String(rv.TeamId);
        const oppTeamId = teamIds.find(id => id !== myTeamId);
        match.oppMmr = oppTeamId && rv.TeamMmrs[oppTeamId] ? Math.round(rv.TeamMmrs[oppTeamId]) : null;
        const sp = rv.StatPerformances;
        if (sp?.Kills) {
          match.expectedKills = Math.round(sp.Kills.Expected * 10) / 10;
        }
        if (sp?.Deaths) {
          match.expectedDeaths = Math.round(sp.Deaths.Expected * 10) / 10;
        }
        if (!sp) _skillNoSp++;
        else _skillOk++;
        // CSR delta from skill API RankRecap (primary reliable source)
        const rr = rv.RankRecap;
        if (rr?.PostMatchCsr?.Value != null && rr?.PreMatchCsr?.Value != null) {
          match.csrDelta = rr.PostMatchCsr.Value - rr.PreMatchCsr.Value;
          const tn = ['Bronze','Silver','Gold','Platinum','Diamond','Onyx'];
          const post = rr.PostMatchCsr, pre = rr.PreMatchCsr;
          const postTier = tn[post.Tier ?? -1] || '';
          const preTier  = tn[pre.Tier  ?? -1] || '';
          match.csrAfter  = postTier === 'Onyx' ? 'Onyx ' + post.Value : postTier ? postTier + ' ' + (post.SubTier + 1) : null;
          match.csrBefore = preTier  === 'Onyx' ? 'Onyx ' + pre.Value  : preTier  ? preTier  + ' ' + (pre.SubTier  + 1) : null;
        }
      } catch(e) { _skillErr++; console.warn(`[SkillBG] Exception on match ${match.matchId}:`, e.message); }
    }));
    if (_skillNoSp > 0) {
      console.warn(`[SkillBG] Batch summary — ok:${_skillOk} noStatPerf:${_skillNoSp} err:${_skillErr}`);
    }
    if (i + BATCH < ranked.length) await sleep(200);
  }
  console.log(`[SkillBG] Skill data applied to ${ranked.length} matches (xuid=${xuid})`);
}

// In-memory ring buffer for gamemode debug entries (newest first, capped at 100)
const _gameModeDebugLog = [];
function _pushGameModeDebug(entry) {
  _gameModeDebugLog.unshift(entry);
  if (_gameModeDebugLog.length > 100) _gameModeDebugLog.pop();
}

// Known playlist IDs whose names the API sometimes omits
const KNOWN_PLAYLISTS = {
  '1b1691dc-d8b9-4b1f-825d-cb1c065184c1': 'Quick Play',
  '57f4f0c0-bce9-4a34-b1b0-6188ed0f0198': 'Quick Play',
  'edfef3ac-9cbe-4fa2-b949-8f29deafd483': 'Ranked Arena',
  'f5580605-660c-43f9-ac69-4075c4a05c5d': 'Big Team Battle Slayer',
  'dcb2e24e-05fb-4390-8076-32a0cdb4326e': 'Ranked Slayer',
  'c94cb508-2fbd-450a-81db-bb74f7741d45': 'Ranked Legacy',
  'fa5aa2a3-2428-4912-a023-e1eeea7b877c': 'Ranked Doubles',
  '2825d417-93e6-4366-98f9-839a2dc41fe4': 'Big Team Battle',
  'a7d20ef6-ebdc-4c01-b96c-69b27afa88d7': 'FFA',
  '87783719-4b5c-45f9-834e-d0272292d573': 'Firefight',
};

// Standalone playlist discovery — fetches the player's 25 most recent matches and
// returns every unique playlist ID + name found. Runs completely outside the TARGET
// filter so it always sees recent matches regardless of how many ranked ones exist.
async function discoverPlaylists(xuid, gamertag) {
  await fetchClearanceToken(xuid);
  const headers = getAuthHeaders();

  const _listAc = new AbortController();
  const _listAt = setTimeout(() => _listAc.abort(), 10000);
  let listRes;
  try { listRes = await fetch(`https://halostats.svc.halowaypoint.com/hi/players/xuid(${xuid})/matches?count=25&start=0`, { headers, signal: _listAc.signal }); }
  finally { clearTimeout(_listAt); }
  if (!listRes.ok) throw new Error(`Match list failed: ${listRes.status}`);
  const data = await listRes.json();
  const matches = data.Results || [];

  const seen = new Map(); // playlistId -> { name, exp, lifecycle, matchId, count }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    try {
      if (i > 0 && i % 6 === 0) await sleep(300); // gentle rate limiting
      const _ac = new AbortController();
      const _at = setTimeout(() => _ac.abort(), 8000);
      let r;
      try { r = await fetch(`https://halostats.svc.halowaypoint.com/hi/matches/${m.MatchId}/stats`, { headers, signal: _ac.signal }); }
      finally { clearTimeout(_at); }
      if (!r.ok) continue;
      const md = await r.json();
      if (md?.MatchInfo?.ClearanceId && md.MatchInfo.ClearanceId !== cachedClearance) {
        cachedClearance = md.MatchInfo.ClearanceId;
        clearanceFetchedAt = Date.now();
        clearanceFailedAt = 0;
        getRedis().then(c => c && c.set('clearanceToken', JSON.stringify({ token: cachedClearance, fetchedAt: clearanceFetchedAt }))).catch(() => {});
      }
      const playlistId = md.MatchInfo?.Playlist?.AssetId;
      if (!playlistId) continue;
      if (seen.has(playlistId)) {
        seen.get(playlistId).count++;
      } else {
        const players = md.Players || [];
        const teams = md.Teams || [];
        const mi = md.MatchInfo || {};
        const durationSec = mi.Duration ? Math.round(
          (mi.Duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/)||[]).slice(1).reduce((acc,v,i)=>acc+(parseFloat(v)||0)*[3600,60,1][i],0)
        ) : null;
        seen.set(playlistId, {
          id: playlistId,
          name: mi.Playlist?.PublicName || mi.Playlist?.Name || KNOWN_PLAYLISTS[playlistId] || '(no name in API)',
          exp: mi.PlaylistExperience || '',
          lifecycle: mi.LifecycleMode,
          gameVariant: mi.UgcGameVariant?.PublicName || mi.UgcGameVariant?.Name || '',
          gameCategory: mi.GameVariantCategory ?? '',
          teamsEnabled: mi.TeamsEnabled ?? null,
          playerCount: players.length,
          teamCount: teams.length,
          mapName: mi.MapVariant?.PublicName || mi.MapVariant?.Name || mi.Map?.PublicName || mi.Map?.Name || '',
          durationSec,
          matchId: m.MatchId,
          rawMatchInfo: mi,
          count: 1,
        });
      }
    } catch(e) { /* skip individual match errors */ }
  }

  const playlists = [...seen.values()].sort((a, b) => b.count - a.count);
  console.log(`[PlaylistDiscover] Results for ${gamertag} (${xuid}):`);
  playlists.forEach(p => {
    const dur = p.durationSec ? `${Math.floor(p.durationSec/60)}m${p.durationSec%60}s` : '?';
    console.log(`  ${p.id}  "${p.name}"  exp="${p.exp}"  lifecycle=${p.lifecycle}  variant="${p.gameVariant}"  cat=${p.gameCategory}  players=${p.playerCount}  teams=${p.teamCount}  ffa=${!p.teamsEnabled}  map="${p.mapName}"  dur=${dur}  (${p.count} of last 25)`);
  });
  return playlists;
}

// === ADVANCED STATS COMPUTATION ===
function computeAdvancedStats(matches) {
  if (!matches || matches.length === 0) return {};

  let totalKills = 0, totalDeaths = 0, totalAssists = 0;
  let clutchKills = 0, clutchDeaths = 0, clutchGames = 0;
  const mapStats = {};
  const kdHistory = [];

  matches.forEach((m) => {
    const k = m.kills || 0;
    const d = m.deaths || 0;
    const a = m.assists || 0;

    totalKills += k;
    totalDeaths += d;
    totalAssists += a;

    // Clutch: close games (≤5 score diff) or big performance on loss
    // outcome: 2 = win, 3 = loss (numeric from Halo API)
    const scoreDiff = Math.abs((m.teamScore || 0) - (m.opponentScore || 0));
    const isClutch = scoreDiff <= 5 || (m.outcome === 3 && k >= 15);

    if (isClutch) {
      clutchKills += k;
      clutchDeaths += d;
      clutchGames++;
    }

    // Map stats
    if (m.mapName) {
      const map = m.mapName;
      if (!mapStats[map]) mapStats[map] = { wins: 0, losses: 0, kills: 0, deaths: 0, games: 0 };
      mapStats[map].games++;
      mapStats[map].kills += k;
      mapStats[map].deaths += d;
      if (m.outcome === 2) mapStats[map].wins++;
      else if (m.outcome === 3) mapStats[map].losses++;
    }

    kdHistory.push({
      kd: d > 0 ? Number((k / d).toFixed(2)) : k,
      map: m.mapName || 'Unknown',
      outcome: m.outcome === 2 ? 'W' : 'L'
    });
  });

  const clutchKD = clutchGames > 3
    ? (clutchKills / Math.max(clutchDeaths, 1)).toFixed(2)
    : '—';

  // Top maps by win rate
  const topMaps = Object.entries(mapStats)
    .map(([name, s]) => ({
      name,
      winRate: s.games ? Math.round((s.wins / s.games) * 100) : 0,
      kd: s.deaths ? (s.kills / s.deaths).toFixed(2) : s.kills.toFixed(1),
      games: s.games
    }))
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, 8);

  return {
    clutchKD,
    clutchGames,
    kdHistory: kdHistory.slice(-20).reverse(), // newest last
    topMaps,
    totalAnalyzed: matches.length
  };
}

// ====================== IMPROVEMENT COACH ======================
// ====================== HALO DNA ======================
function generateHaloDNA(matches, advancedStats, coach) {
  if (!matches || matches.length < 10) {
    return { title: "Recruit", emoji: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#378ADD" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>', description: "Still loading your DNA...", traits: [] };
  }

  const totalMatches = matches.length;
  // outcome === 2 is a win (numeric from Halo API)
  const wins = matches.filter(m => m.outcome === 2).length;
  const winRate = (wins / totalMatches) * 100;

  // Use overall K/D from match data rather than clutchKD for archetype logic
  let totalK = 0, totalD = 0;
  matches.forEach(m => { totalK += m.kills || 0; totalD += m.deaths || 0; });
  const avgKD = totalD > 0 ? totalK / totalD : totalK;

  let archetype = "Balanced";
  let emoji = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#378ADD" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>';
  const traits = [];

  if (avgKD > 1.8 && winRate > 65) {
    archetype = "Demon Slayer";
    emoji = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#378ADD" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/><line x1="19" y1="21" x2="21" y2="19"/></svg>';
    traits.push("Aggressive", "High Kill Power", "Clutch King");
  } else if (avgKD > 1.5 && winRate > 55) {
    archetype = "Map God";
    emoji = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#378ADD" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>';
    traits.push("Strong Map Control", "Consistent", "Team Player");
  } else if (advancedStats && advancedStats.clutchKD !== "—" && parseFloat(advancedStats.clutchKD) > 1.7) {
    archetype = "Clutch God";
    emoji = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#378ADD" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
    traits.push("Clutch Performer", "Mental Fortitude", "Comeback Artist");
  } else if (winRate > 60) {
    archetype = "Objective Beast";
    emoji = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#378ADD" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>';
    traits.push("Objective Focused", "Win Rate Monster");
  } else {
    archetype = "Grinder";
    emoji = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#378ADD" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';
    traits.push("Consistent", "Improving", "Dedicated");
  }

  if (coach && coach.trend === "improving") traits.push("Rising Star");
  if (avgKD < 0.9) traits.push("Underdog");

  return {
    title: archetype,
    emoji: emoji,
    description: `A true ${archetype.toLowerCase()}. ${winRate.toFixed(0)}% win rate with ${avgKD.toFixed(2)} K/D.`,
    traits: traits.slice(0, 5),
    winRate: winRate.toFixed(1),
    matchesAnalyzed: totalMatches
  };
}

module.exports = {
  fetchPlayerStats, fetchMatchHistory, fetchAndApplySkillData, getAuthHeaders, fetchClearanceToken,
  getXuidToGamerpic: () => xuidToGamerpic, getEmblemPathCache: () => emblemPathCache,
  getNameplatePathCache: () => nameplatePathCache,
  getXuidToGt: () => xuidToGt,
  getServiceTagCache: () => serviceTagCache,
  resolveGamertags,
  resolveEmblemForXuid, markEmblemMissing,
  getRedis,
  discoverPlaylists,
  computeAdvancedStats,
  generateHaloDNA,
  resetClearanceCache,
  isMatchListBackoffActive,
  matchListBackoffSecondsRemaining,
  isClearanceUnavailable,
  getGameModeDebugLog: () => _gameModeDebugLog,
  // Fill null mapImageUrl values on cached match objects using the in-memory
  // mapImageCache. No API calls — instant. Works whenever another player's
  // fetch has already resolved those maps. Updates the objects in-place.
  fillCachedMapImages: function(matches) {
    if (!matches) return;
    for (const m of matches) {
      if (!m.mapImageUrl && m._mapAssetId && mapImageCache[m._mapAssetId]) {
        m.mapImageUrl = mapImageCache[m._mapAssetId];
      }
    }
  },

  // Resolve mapImageUrl for matches that are missing it.
  // Calls the Waypoint map details API for any (assetId, versionId) pair not yet
  // in mapImageCache. Updates match objects in-place and returns those that were fixed.
  // Matches missing _mapVersionId are still filled from cache if available; if not
  // cached they are skipped (no versionId = can't call the API, but a subsequent warm
  // cache pass from another match with the same assetId will backfill them).
  resolveMapImagesForMatches: async function(matches, headers) {
    if (!matches || !matches.length || !headers) return [];
    // Deduplicate by assetId — only one API call per map.
    // Only queue for resolution if we have a versionId; matches with only assetId
    // are handled by the fill pass below if the cache is already warm.
    const needed = new Map();
    for (const m of matches) {
      if (!m.mapImageUrl && m._mapAssetId && m._mapVersionId && !mapImageCache[m._mapAssetId]) {
        needed.set(m._mapAssetId, m._mapVersionId);
      }
    }
    if (!needed.size) {
      // Cache might now have entries — do a fill pass and return changed matches
      const fixed = [];
      for (const m of matches) {
        if (!m.mapImageUrl && m._mapAssetId && mapImageCache[m._mapAssetId]) {
          m.mapImageUrl = mapImageCache[m._mapAssetId];
          fixed.push(m);
        }
      }
      return fixed;
    }
    // Resolve unique maps (concurrency capped at 6)
    const entries = [...needed.entries()];
    for (let i = 0; i < entries.length; i += 6) {
      const batch = entries.slice(i, i + 6);
      await Promise.all(batch.map(([assetId, versionId]) =>
        resolveMapName(assetId, versionId, headers).catch(() => {})
      ));
    }
    // Fill all matches that can now be resolved
    const fixed = [];
    for (const m of matches) {
      if (!m.mapImageUrl && m._mapAssetId && mapImageCache[m._mapAssetId]) {
        m.mapImageUrl = mapImageCache[m._mapAssetId];
        fixed.push(m);
      }
    }
    return fixed;
  },
};
