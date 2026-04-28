const fetch = require('node-fetch');
const { flushXuidCache } = require('./db');

// --- Redis (disabled — using in-memory cache only) ---
// Uncomment and configure when Redis is working
async function getRedis() {
  return null; // in-memory only for now
}

// --- In-memory caches ---
const xuidToGt = {};           // xuid -> gamertag
const xuidToGamerpic = {};     // xuid -> gamerpic URL
const mapNameCache = {};        // assetId -> map name
const mapImageCache = {};       // assetId -> image URL
const emblemPathCache = {};     // xuid -> gamecms image path
const nameplatePathCache = {};  // xuid -> gamecms nameplate image path
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
  if (clearanceInFlight) return clearanceInFlight;
  clearanceInFlight = (async () => {
    try {
      const res = await fetch(
        `https://settings.svc.halowaypoint.com/oban/flight-configurations/titles/hi/audiences/RETAIL/players/xuid(${xuid})/active?sandbox=UNUSED&build=6.10022.18539`,
        { headers: { 'x-343-authorization-spartan': process.env.SPARTAN_TOKEN || '', 'Accept': 'application/json' } }
      );
      if (res.ok) {
        const data = await res.json();
        cachedClearance = data.FlightConfigurationId || data.flightConfigurationId || null;
        clearanceFetchedAt = Date.now();
        console.log('[Clearance] OK:', cachedClearance ? 'set' : 'null');
        getRedis().then(c => c && c.set('clearanceToken', JSON.stringify({ token: cachedClearance, fetchedAt: clearanceFetchedAt }))).catch(() => {});
      }
    } catch(e) { console.error('[Clearance]', e.message); }
    finally { clearanceInFlight = null; }
    return cachedClearance;
  })();
  return clearanceInFlight;
}

// --- Startup: load persisted caches from Redis ---
async function loadCaches() {
  const c = await getRedis();
  if (!c) return;
  try {
    const [gtRaw, gpRaw, emblemRaw, npRaw, clearRaw] = await Promise.all([
      c.get('xuidToGt'), c.get('xuidToGamerpic'), c.get('emblemPathCache'), c.get('nameplatePathCache'), c.get('clearanceToken')
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
      if (cl?.token && Date.now() - cl.fetchedAt < 3600000) {
        cachedClearance = cl.token;
        clearanceFetchedAt = cl.fetchedAt;
        console.log('[Clearance] Loaded from Redis');
      }
    }
    console.log(`[Cache] Loaded: ${Object.keys(xuidToGt).length} gamertags, ${Object.keys(emblemPathCache).length} emblems, ${Object.keys(nameplatePathCache).length} nameplates`);
  } catch(e) { console.error('[Cache] Load failed:', e.message); }
}
loadCaches();

// --- Utilities ---
async function resolveMapName(assetId, versionId, headers) {
  if (!assetId) return null;
  if (mapNameCache[assetId]) return mapNameCache[assetId];
  try {
    const res = await fetch(`https://discovery-infiniteugc.svc.halowaypoint.com/hi/maps/${assetId}/versions/${versionId}`, { headers });
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
      const headers = getAuthHeaders();

      for (let i = 0; i < todo.length; i += BATCH_SIZE) {
        if (i > 0) await sleep(INTER_BATCH_DELAY);
        const batch = todo.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const url = 'https://profile.svc.halowaypoint.com/users?' + batch.map(x => `xuids=${x}`).join('&');

        let success = false;
        let backoff = 8000; // start at 8s — gives API more breathing room
        for (let attempt = 1; attempt <= 3 && !success; attempt++) {
          try {
            const r = await fetch(url, { headers });
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
                  const r2 = await fetch(`https://profile.svc.halowaypoint.com/users/xuid(${xuid})`, { headers });
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
    const res = await fetch('https://gamecms-hacs.svc.halowaypoint.com/hi/Waypoint/file/images/emblems/mapping.json', { headers: getAuthHeaders() });
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
        fetch(`https://economy.svc.halowaypoint.com/hi/players/xuid(${xuid})/customization?view=public`, { headers: freshHeaders }),
        fetch(`https://profile.svc.halowaypoint.com/users/xuid(${xuid})`, { headers: freshHeaders })
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
        // Log full Appearance keys once so we can find the nameplate field
        if (!resolveEmblemForXuid._loggedAppearance) {
          resolveEmblemForXuid._loggedAppearance = true;
          console.log('[Emblem] Appearance keys:', Object.keys(custData?.Appearance || {}));
          console.log('[Emblem] Full Appearance:', JSON.stringify(custData?.Appearance, null, 2).slice(0, 2000));
        }
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
              const npJsonRes = await fetch(npJsonUrl, { headers: freshHeaders });
              if (npJsonRes.ok) {
                const npJson = await npJsonRes.json();
                // Same structure as emblem JSON: CommonData.DisplayPath.Media
                const dp = npJson?.CommonData?.DisplayPath;
                const mediaUrlPath = dp?.Media?.MediaUrl?.Path || '';
                const mediaFolderPath = dp?.Media?.FolderPath || dp?.FolderPath || '';
                const mediaFileName = dp?.Media?.FileName || dp?.FileName || '';
                let displayPath = '';
                if (mediaUrlPath && /\.(png|jpg|webp)$/i.test(mediaUrlPath)) displayPath = mediaUrlPath;
                else if (mediaFolderPath && mediaFileName) displayPath = `${mediaFolderPath}/${mediaFileName}`;
                if (displayPath) {
                  const npCms = displayPath.startsWith('images/') ? `waypoint:${displayPath}`
                    : displayPath.startsWith('progression/') ? `images:${displayPath}`
                    : `images:progression/${displayPath}`;
                  nameplatePathCache[String(xuid)] = npCms;
                  console.log(`[Emblem] Nameplate resolved for ${xuid}: ${npCms}`);
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
            if (configMatch?.nameplateCmsPath) {
              nameplatePathCache[String(xuid)] = 'waypoint:' + configMatch.nameplateCmsPath;
              getRedis().then(c => c && c.set('nameplatePathCache', JSON.stringify(nameplatePathCache))).catch(() => {});
            }
          }
          // 2) Convention construct: images/emblems/<emblemId>_<configId>.png (negative configIds use 'n' prefix)
          if (configurationId !== undefined && configurationId !== null) {
            const configStr = configurationId < 0 ? `n${Math.abs(configurationId)}` : String(configurationId);
            const conv = `waypoint:images/emblems/${emblemId}_${configStr}.png`;
            if (!candidates.includes(conv)) candidates.push(conv);
          }
          // 3) Images-branch fallback for emblems missing from mapping.json or Waypoint convention
          try {
            const defRes = await fetch(`https://gamecms-hacs.svc.halowaypoint.com/hi/progression/file/${emblemJsonPath}`, { headers: freshHeaders });
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
  15:'CTF',16:'Infection',17:'Escalation Slayer',18:'Oddball',
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
    const xuidRes = await fetch(`https://profile.svc.halowaypoint.com/users/gt(${encoded})`, { headers });
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
    'Ranked Arena':  'edfef3ac-9cbe-4fa2-b949-8f29deafd483',
    'Ranked Slayer': 'f5580605-660c-43f9-ac69-4075c4a05c5d',
    'Ranked Slayer2': 'dcb2e24e-05fb-4390-8076-32a0cdb4326e',
  };

  const [statsRes, countRes, rankedStatsRes, ...csrResponses] = await Promise.all([
    fetch(`https://halostats.svc.halowaypoint.com/hi/players/xuid(${xuid})/matchmade/servicerecord`, { headers: freshHeaders }),
    fetch(`https://halostats.svc.halowaypoint.com/hi/players/xuid(${xuid})/matches/count`, { headers: freshHeaders }),
    fetch(`https://halostats.svc.halowaypoint.com/hi/players/xuid(${xuid})/matchmade/servicerecord?isRanked=true`, { headers: freshHeaders }).catch(() => null),
    ...Object.entries(RANKED_PLAYLISTS).map(([, id]) =>
      fetch(`https://skill.svc.halowaypoint.com/hi/playlist/${id}/csrs?players=xuid(${xuid})`, { headers: freshHeaders }).catch(() => null)
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
    const crRes = await fetch(`https://halostats.svc.halowaypoint.com/hi/players/xuid(${xuid})/careerranks`, { headers: freshHeaders });
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
    allMedalsSlim = rawMedals.map(m => ({ nameId: m.NameId, count: m.Count })).slice(0, 20);
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
        // Emblem cached but nameplate not — re-resolve to get it (fresh server start)
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
      // cachedPath === '__none__' (emblem image failed before) — emblem stays hidden but still
      // check nameplate independently: the config resolve may have cached it even if the image 404'd.
      const np = nameplatePathCache[String(xuid)];
      if (np) {
        nameplateUrl = `/api/emblem-img?path=${encodeURIComponent(np)}&xuid=${xuid}&type=nameplate`;
      } else {
        // No nameplate cached either — re-resolve to pick up the nameplate path
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
async function fetchMatchHistory(xuid, gamertag, count = 100, onProgress = null) {
  const TARGET   = 100;  // desired valid (non-custom/PvE) matches
  const BATCH    = 20;  // matches to request per API call
  const MAX_SCAN = 250; // give up after scanning this many raw matches

  const headers = getAuthHeaders();
  const rivalStats = {};   // keyed by rawXuid — resolved to gamertag later
  const results = [];
  const pendingTracking = [];

  let start = 0;
  while (results.filter(r => !r.isCustom).length < TARGET && start < MAX_SCAN) {
    const res = await fetch(
      `https://halostats.svc.halowaypoint.com/hi/players/xuid(${xuid})/matches?count=${BATCH}&start=${start}`,
      { headers }
    );
    if (!res.ok) break;
    const data = await res.json();
    const rawBatch = data.Results || [];
    if (!rawBatch.length) break; // no more history

    const fetchedDetails = await fetchConcurrent(rawBatch, async (m) => {
      try {
        const r = await fetch(`https://halostats.svc.halowaypoint.com/hi/matches/${m.MatchId}/stats`, { headers });
        const md = r.ok ? await r.json() : null;
        const isLikelyRanked = md && [1,2,3].includes(md.MatchInfo?.PlaylistExperience);
        let skillData = null;
        if (isLikelyRanked) {
          try {
            const sr = await fetch(`https://skill.svc.halowaypoint.com/hi/matches/${m.MatchId}/skill?players=xuid(${xuid})`, { headers });
            if (sr.ok) skillData = await sr.json();
          } catch(e) {}
        }
        return { m, md, skillData };
      } catch(e) { return { m, md: null, skillData: null }; }
    }, 5);

    start += BATCH;

    for (const { m, md, skillData: prefetchedSkill } of fetchedDetails) {
      if (results.filter(r => !r.isCustom).length >= TARGET) break;
    try {
      let kills = 0, deaths = 0, assists = 0, gameMode = null, teams = [];
      let placement = null, score = 0, damageDealt = 0, damageTaken = 0, accuracy = null;
      let weaponStats = [], mmr = null, oppMmr = null, expectedKills = null, expectedDeaths = null, objStats = null;
      let mapName = null, mapImageUrl = null, isRanked = false, csrAfter = null, csrBefore = null, csrDelta = null, matchOutcome = 0;
        let matchTopMedals = [];

      if (md) {
        const lifecycleMode = md.MatchInfo?.LifecycleMode;
        const playlistExp = md.MatchInfo?.PlaylistExperience;
        if (lifecycleMode === 1 && !playlistExp) {
          results.push({ matchId: m.MatchId, isCustom: true, gameMode: 'Custom Game', kills: 0, deaths: 0, assists: 0, damageDealt: 0, damageTaken: 0 });
          continue;
        }
        const catNum = md.MatchInfo?.GameVariantCategory;
        if ([27,28,29,21,31].includes(catNum)) {
          results.push({ matchId: m.MatchId, isCustom: true, gameMode: 'PvE', kills: 0, deaths: 0, assists: 0, damageDealt: 0, damageTaken: 0 });
          continue;
        }

        const SLAYER_IDS = ['f5580605-660c-43f9-ac69-4075c4a05c5d','dcb2e24e-05fb-4390-8076-32a0cdb4326e'];
        const RANKED_ARENA_ID = 'edfef3ac-9cbe-4fa2-b949-8f29deafd483';
        const matchPlaylistId = md.MatchInfo?.Playlist?.AssetId;
        const isRankedSlayer = SLAYER_IDS.includes(matchPlaylistId);
        const isRankedArena = matchPlaylistId === RANKED_ARENA_ID;
        isRanked = isRankedArena || isRankedSlayer;
        // Skip entirely if not Ranked Arena or Ranked Slayer
        if (!isRanked) {
          results.push({ matchId: m.MatchId, isCustom: true, gameMode: 'Filtered', kills: 0, deaths: 0, assists: 0, damageDealt: 0, damageTaken: 0 });
          continue;
        }

        // Game mode
        try {
          const ugcName = md.MatchInfo?.UgcGameVariant?.Name || '';
          const ugcLower = ugcName.toLowerCase();
          const myPd = (md.Players||[]).find(p => String(p.PlayerId||'').replace('xuid(','').replace(')','') === String(xuid));
          const myPstats = myPd?.PlayerTeamStats?.[0]?.Stats || {};
          const hasZones = !!myPstats.ZonesStats, hasOddball = !!myPstats.OddballStats;
          const isKothByName = ugcLower.includes('king of the hill') || ugcLower.includes('koth') || ugcLower.includes('hill');

          if (catNum === 14) gameMode = (isRanked && !isRankedSlayer ? 'Ranked Arena: ' : '') + 'King of the Hill';
          else if (catNum === 20) gameMode = (isRanked && !isRankedSlayer ? 'Ranked Arena: ' : '') + 'Land Grab';
          else if (catNum === 11) gameMode = (isRanked && !isRankedSlayer ? 'Ranked Arena: ' : '') + 'Strongholds';
          else if (isKothByName) gameMode = isRanked && !isRankedSlayer ? 'Ranked Arena: King of the Hill' : 'King of the Hill';
          else if (hasZones && !hasOddball && (catNum === 12 || catNum === 18)) {
            const z = myPstats.ZonesStats;
            gameMode = ((z.StrongholdCaptures??0)>0||(z.StrongholdSecures??0)>0) 
              ? (isRanked&&!isRankedSlayer?'Ranked Arena: ':'')+'Strongholds'
              : (isRanked&&!isRankedSlayer?'Ranked Arena: ':'')+'King of the Hill';
          } else if (ugcName) {
            gameMode = ugcName.replace(/^Arena:\s*/i,'').replace(/:/g,' ').replace(/\s+/g,' ').trim();
            if (isRanked) {
              if (isRankedSlayer) gameMode = 'Ranked Slayer';
              else if (!gameMode.toLowerCase().startsWith('ranked')) gameMode = 'Ranked Arena: ' + gameMode;
              else if (!gameMode.toLowerCase().startsWith('ranked arena')) gameMode = gameMode.replace(/^Ranked /i,'Ranked Arena: ');
            }
          } else {
            gameMode = (isRanked ? 'Ranked ' : '') + (MODE_NAMES[catNum] || 'Mode ' + catNum);
            if (isRanked && !isRankedSlayer && !gameMode.toLowerCase().startsWith('ranked arena')) gameMode = gameMode.replace(/^Ranked /i,'Ranked Arena: ');
            else if (isRanked && isRankedSlayer) gameMode = 'Ranked Slayer';
          }
          gameMode = (gameMode||'').replace(/Capture the Flag (\d+) Captures?/gi,'CTF $1').replace(/Capture the Flag/gi,'CTF').trim();
        } catch(e) { gameMode = (isRanked?'Ranked ':'') + (MODE_NAMES[catNum]||'Unknown'); }

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
          teamMap[teamId].players.push({
            gamertag: gt, rawXuid,
            kills: pk, deaths: pd, assists: pa,
            score: pcore.Score||0,
            kd: pd>0?(pk/pd).toFixed(2):pk.toString(),
            kda: (pk - pd + pa/3).toFixed(1),
            damage: pcore.DamageDealt||0,
            gamerpicUrl: xuidToGamerpic[rawXuid]||null,
            // Objective stats for ranking
            ballTime: ppodd ? parseDurP(ppodd.TimeAsSkullCarrier) : 0,
            zoneCaptures: ppzones ? (ppzones.StrongholdCaptures||0) : 0,
            zoneSecures: ppzones ? (ppzones.StrongholdSecures||0) : 0,
            flagCaptures: ppctf ? (ppctf.FlagCaptures||0) : 0,
            seeds: ppstock ? (ppstock.PowerSeedsDeposited||0) : 0,
          });

          if (String(player.PlayerId||'') === `xuid(${xuid})` || String(player.Xuid||'') === String(xuid)) {
            matchOutcome = player.Outcome || 0;
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
      results.push({
        matchId: m.MatchId, outcome: m.Outcome, startTime: m.MatchInfo?.StartTime, duration: m.MatchInfo?.Duration,
        mapName, mapImageUrl, gameMode, isRanked, kills, deaths, assists, score,
        kda: (kills - deaths + assists/3).toFixed(1),
        damageDealt, damageTaken, accuracy: accuracy!=null?parseFloat(accuracy).toFixed(1):null,
        shotsFired, shotsHit,
        placement: placementStr(placement), weaponStats, topMedals: matchTopMedals, csrAfter, csrBefore, csrDelta, teams,
        mmr, oppMmr, expectedKills, expectedDeaths, objStats,
      });
    } catch(e) {
      results.push({ matchId: m.MatchId, outcome: m.Outcome, startTime: m.MatchInfo?.StartTime, gameMode: null, kills:0,deaths:0,assists:0,damageDealt:0,damageTaken:0 });
    }
    } // end for fetchedDetails

    const validNow = results.filter(r => !r.isCustom).length;
    console.log(`[MatchFetch] scanned=${start} valid=${validNow}/${TARGET}`);
    if (onProgress) onProgress(validNow, TARGET);
  } // end while

  // (no bulk GT resolve here — we only resolve what we actually need below)

  // Backfill gamerpics on team players
  for (const result of results) {
    for (const team of (result.teams||[])) {
      for (const pl of (team.players||[])) {
        if (!pl.gamerpicUrl && pl.rawXuid && xuidToGamerpic[pl.rawXuid]) pl.gamerpicUrl = xuidToGamerpic[pl.rawXuid];
        if (pl.rawXuid && xuidToGt[pl.rawXuid]) pl.gamertag = xuidToGt[pl.rawXuid];
      }
    }
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

  const unknownRivalXuids = topRivalXuids.filter(x => !xuidToGt[x]);
  if (unknownRivalXuids.length > 0) {
    console.log(`[Rivals] Resolving ${unknownRivalXuids.length} rival gamertags`);
    try {
      const rHeaders = getAuthHeaders();
      // Profile API accepts up to 50 xuids per call
      for (let i = 0; i < unknownRivalXuids.length; i += 50) {
        if (i > 0) await new Promise(r => setTimeout(r, 1500));
        const batch = unknownRivalXuids.slice(i, i + 50);
        const url = 'https://profile.svc.halowaypoint.com/users?' + batch.map(x => `xuids=${x}`).join('&');
        const r = await fetch(url, { headers: rHeaders });
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
          console.log('[Rivals] Rate limited — skipping remaining rival GT resolution');
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

  return { matches: results, rivals, nemesisList, victimsList };
}

module.exports = {
  fetchPlayerStats, fetchMatchHistory, getAuthHeaders, fetchClearanceToken,
  getXuidToGamerpic: () => xuidToGamerpic, getEmblemPathCache: () => emblemPathCache,
  getNameplatePathCache: () => nameplatePathCache,
  getXuidToGt: () => xuidToGt,
  getServiceTagCache: () => serviceTagCache,
  resolveGamertags,
  resolveEmblemForXuid, markEmblemMissing,
  getRedis,
};
