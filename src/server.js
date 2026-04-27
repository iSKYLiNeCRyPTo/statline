require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { fetchPlayerStats, fetchMatchHistory, getAuthHeaders, fetchClearanceToken, getXuidToGamerpic, getXuidToGt, resolveGamertags } = require('./halo');
const { startAutoRefresh } = require('./tokenRefresh');
const { Pool } = require('pg');
const { getDb: getXuidDb, loadXuidCache, flushXuidCache } = require('./db');
const _memSearchLog = [];
const _memTabLog = [];
let _dbPool = null;

async function getDb() {
  if (!_dbPool && process.env.DATABASE_URL) {
    _dbPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await _dbPool.query(`CREATE TABLE IF NOT EXISTS search_log (id SERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT NOW(), gamertag TEXT NOT NULL, ip TEXT, user_agent TEXT, cached TEXT, success BOOLEAN, duration_ms INTEGER)`);
      await _dbPool.query(`CREATE TABLE IF NOT EXISTS tab_log (id SERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT NOW(), gamertag TEXT, ip TEXT, tab TEXT NOT NULL, seconds NUMERIC(8,2) NOT NULL)`);
      await _dbPool.query(`ALTER TABLE search_log ADD COLUMN IF NOT EXISTS user_agent TEXT`).catch(()=>{});
      await _dbPool.query(`ALTER TABLE search_log ADD COLUMN IF NOT EXISTS duration_ms INTEGER`).catch(()=>{});
      await _dbPool.query(`ALTER TABLE search_log ALTER COLUMN cached TYPE TEXT USING cached::text`).catch(()=>{});
      console.log('[DB] Tables ready');
    } catch(e) { console.error('[DB] Table create error:', e.message); }
  }
  return _dbPool;
}
getDb();

// Load xuid cache from Postgres into halo.js in-memory map on startup
loadXuidCache(getXuidToGt());

// Flush new xuids to Postgres every 2 minutes
setInterval(() => flushXuidCache(getXuidToGt()), 2 * 60 * 1000);

async function logSearch(gamertag, userAgent, cached, success, durationMs) {
  const entry = { ts: new Date().toISOString(), gamertag, user_agent: userAgent||null, cached: String(cached), success: !!success, duration_ms: durationMs||null };
  _memSearchLog.push(entry);
  if (_memSearchLog.length > 1000) _memSearchLog.shift();
  try {
    const db = await getDb();
    if (db) await db.query('INSERT INTO search_log (gamertag,user_agent,cached,success,duration_ms) VALUES ($1,$2,$3,$4,$5)', [gamertag, userAgent||null, String(cached), !!success, durationMs||null]);
  } catch(e) { console.error('[DB] logSearch error:', e.message); }
}

async function logTab(gamertag, tab, seconds) {
  const entry = { ts: new Date().toISOString(), gamertag, tab, seconds };
  _memTabLog.push(entry);
  if (_memTabLog.length > 2000) _memTabLog.shift();
  try {
    const db = await getDb();
    if (db) await db.query('INSERT INTO tab_log (gamertag,tab,seconds) VALUES ($1,$2,$3)', [gamertag||null, tab, seconds]);
  } catch(e) { console.error('[DB] logTab error:', e.message); }
}

const app = express();
app.set('trust proxy', 1); // trust Render's proxy for real IPs
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Warn on missing required env vars
if (!process.env.SPARTAN_TOKEN) {
  console.warn('[WARN] SPARTAN_TOKEN is not set — will wait for auto-refresh via MS_REFRESH_TOKEN');
}
if (!process.env.MS_REFRESH_TOKEN) {
  console.warn('[WARN] MS_REFRESH_TOKEN is not set — token will expire in ~4 hours and not auto-refresh');
}

// --- Rate limiting (in-memory, per IP) ---
const rateLimitMap = {};
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 10;       // 10 searches per minute per IP

function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (!rateLimitMap[ip]) rateLimitMap[ip] = [];
  rateLimitMap[ip] = rateLimitMap[ip].filter(t => now - t < RATE_LIMIT_WINDOW);
  if (rateLimitMap[ip].length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests — please wait a moment before searching again.' });
  }
  rateLimitMap[ip].push(now);
  next();
}
// Clean up rate limit map every 5 min
setInterval(() => {
  const now = Date.now();
  for (const ip of Object.keys(rateLimitMap)) {
    rateLimitMap[ip] = rateLimitMap[ip].filter(t => now - t < RATE_LIMIT_WINDOW);
    if (!rateLimitMap[ip].length) delete rateLimitMap[ip];
  }
}, 300000);

// --- Search cache (Redis + in-memory) ---
const searchCache = {}; // gamertag.lower -> { data, fetchedAt }
const CACHE_TTL = 60 * 60 * 1000; // 60 minutes
const _searchProgress = {}; // gamertag.lower -> { step, valid, total, ts }

async function getFromCache(gamertag) {
  const key = gamertag.toLowerCase().trim();
  if (searchCache[key] && Date.now() - searchCache[key].fetchedAt < CACHE_TTL) {
    return searchCache[key].data;
  }
  return null;
}

async function saveToCache(gamertag, data) {
  const key = gamertag.toLowerCase().trim();
  searchCache[key] = { data, fetchedAt: Date.now() };
}

// Deduplicate concurrent searches for the same gamertag
const searchInFlight = {};

// --- Medal meta (loaded once) ---
let medalMeta = {};
async function loadMedalMeta() {
  if (Object.keys(medalMeta).length) return;
  try {
    const headers = getAuthHeaders();
    // Medal metadata with sprite sheet indices
    const urls = [
      'https://gamecms-hacs.svc.halowaypoint.com/hi/Waypoint/file/medals/metadata.json',
      'https://gamecms-hacs.svc.halowaypoint.com/hi/progression/file/Multiplayer/medals/metadata.json',
      'https://gamecms-hacs.svc.halowaypoint.com/hi/Waypoint/file/medals/Metadata.json',
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, { headers });
        console.log('[Medals] ' + res.status + ' from ' + url);
        if (!res.ok) continue;
        const raw = await res.text();
        console.log('[Medals] Response preview:', raw.slice(0, 200));
        const data = JSON.parse(raw);
        // Handle array format
        const arr = Array.isArray(data) ? data : (data.Medals || data.medals || null);
        if (arr && arr.length) {
          const columns = data.columns || data.Columns || 16;
          arr.forEach(m => {
            const id = String(m.nameId || m.NameId || m.id || '');
            if (!id) return;
            medalMeta[id] = {
              name: (m.name?.value) || m.name || id,
              difficulty: ['normal','heroic','legendary','mythic'][m.difficultyIndex ?? 0] || 'normal',
              spriteIndex: m.spriteIndex ?? m.SpriteIndex ?? null,
              columns,
            };
          });
        } else if (typeof data === 'object' && !Array.isArray(data)) {
          // Object map format
          for (const [id, info] of Object.entries(data)) {
            if (!id || typeof info !== 'object') continue;
            medalMeta[id] = { name: info.name || id, difficulty: 'normal', spriteIndex: info.spriteIndex ?? null, columns: 16 };
          }
        }
        if (Object.keys(medalMeta).length > 0) {
          global._medalMeta = medalMeta;
          console.log('[Medals] Loaded', Object.keys(medalMeta).length, 'medals from', url);
          break;
        }
      } catch(e) { console.log('[Medals] Error from', url, ':', e.message); }
    }
    if (!Object.keys(medalMeta).length) console.log('[Medals] All sources failed');
  } catch(e) { console.log('[Medals] Fatal:', e.message); }
}
loadMedalMeta();

// --- Routes ---

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Debug — check token status without exposing the token itself
app.get('/api/token-status', (req, res) => {
  const token = process.env.SPARTAN_TOKEN || '';
  const refresh = process.env.MS_REFRESH_TOKEN || '';
  res.json({
    hasToken: token.length > 0,
    tokenLength: token.length,
    tokenPreview: token ? token.slice(0, 8) + '...' : 'NOT SET',
    hasRefreshToken: refresh.length > 0,
    refreshPreview: refresh ? refresh.slice(0, 8) + '...' : 'NOT SET',
  });
});

// Main search endpoint
app.get('/api/search', rateLimit, async (req, res) => {
  const gamertag = (req.query.gamertag || '').trim();
  if (!gamertag) return res.status(400).json({ success: false, error: 'Gamertag required' });
  if (gamertag.length < 1 || gamertag.length > 32) return res.status(400).json({ success: false, error: 'Invalid gamertag' });

  // Check cache (skip if force refresh requested)
  const forceRefresh = req.query.force === '1';
  const cached = await getFromCache(gamertag);
  if (cached && !forceRefresh) { logSearch(gamertag, req.headers['user-agent'], 'cached', true, null); return res.json({ success: true, player: cached, cached: true }); }

  // Deduplicate concurrent searches
  const key = gamertag.toLowerCase().trim();
  if (searchInFlight[key]) {
    try {
      const result = await searchInFlight[key];
      logSearch(gamertag, req.headers['user-agent'], 'inflight', true, null); return res.json({ success: true, player: result });
    } catch(e) {
      logSearch(gamertag, req.headers['user-agent'], 'error', false, null); return res.status(404).json({ success: false, error: e.message });
    }
  }

  // statsOnly mode — return service record immediately, skip match fetch
  const statsOnly = req.query.statsOnly === '1';
  if (statsOnly) {
    try {
      _searchProgress[key] = { step: 1, valid: 0, total: 100, ts: Date.now() };
      const playerStats = await fetchPlayerStats(gamertag);
      _searchProgress[key] = { step: 2, valid: 0, total: 100, ts: Date.now() };
      return res.json({ success: true, player: { ...playerStats, recentMatches: [], allMatches: [] }, statsOnly: true });
    } catch(e) {
      return res.status(404).json({ success: false, error: e.message });
    }
  }

  const searchPromise = (async () => {
    try {
      _searchProgress[key] = { step: 1, valid: 0, total: 100, ts: Date.now() };
      const playerStats = await fetchPlayerStats(gamertag);
      _searchProgress[key] = { step: 2, valid: 0, total: 100, ts: Date.now() };
      const histData = await fetchMatchHistory(playerStats.xuid, gamertag, 100, (valid, total) => {
        _searchProgress[key] = { step: 2, valid, total, ts: Date.now() };
      });
      _searchProgress[key] = { step: 3, valid: 100, total: 100, ts: Date.now() };
      const PVE = ['firefight','gruntpocalypse','attrition','pve'];
      const BAD_MAPS = ['launch site','yuletide','octagon','aimbotz'];
      const matches = (histData.matches || []).filter(m => {
        if (m.isCustom) return false;
        if (m.gameMode && PVE.some(p => m.gameMode.toLowerCase().includes(p))) return false;
        if (m.mapName && BAD_MAPS.some(p => m.mapName.toLowerCase().includes(p))) return false;
        return true;
      }).slice(0, 100);
      const result = {
        ...playerStats,
        recentMatches: matches,
        allMatches: matches,
        rivals: histData.rivals || [],
        nemesisList: histData.nemesisList || [],
        victimsList: histData.victimsList || [],
      };
      await saveToCache(gamertag, result);
      return result;
    } finally {
      delete searchInFlight[key];
      setTimeout(()=>{ delete _searchProgress[key]; }, 10000);
    }
  })();
  searchInFlight[key] = searchPromise;

  try {
    const _t0 = Date.now();
    const result = await searchPromise;
    logSearch(gamertag, req.headers['user-agent'], 'fresh', true, Date.now()-_t0);
    res.json({ success: true, player: result });
    flushXuidCache(getXuidToGt()).catch(() => {});
  } catch(e) {
    console.error('[Search] Error for', gamertag, ':', e.message);
    if (e.message.includes('Could not resolve gamertag') || e.message.includes('404')) {
      res.status(404).json({ success: false, error: `Player "${gamertag}" not found. Check the spelling and try again.` });
    } else if (e.message.includes('SPARTAN_TOKEN') || e.message.includes('401') || e.message.includes('403')) {
      res.status(503).json({ success: false, error: 'Authentication error — check SPARTAN_TOKEN in environment variables.' });
    } else {
      res.status(500).json({ success: false, error: 'Could not load stats: ' + e.message });
    }
  }
});

// Match history (returns up to 100 cached matches, paginated)
app.get('/api/matches', async (req, res) => {
  try {
    const { gamertag, page = 1, perPage = 100 } = req.query;
    if (!gamertag) return res.status(400).json({ error: 'gamertag required' });
    const cached = await getFromCache(gamertag);
    const source = cached?.allMatches || cached?.recentMatches || [];
    const ranked = req.query.ranked === '1';
    const all = source.filter(m => !ranked || m.isRanked);
    const pg = parseInt(page) || 1;
    const pp = Math.min(parseInt(perPage) || 100, 100);
    const totalPages = Math.max(1, Math.ceil(all.length / pp));
    const matches = all.slice((pg-1)*pp, (pg-1)*pp+pp);
    res.json({ matches, page: pg, perPage: pp, totalPages, total: all.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Medal sprite sheet proxy
app.get('/api/medal-sheet', async (req, res) => {
  try {
    const headers = getAuthHeaders();
    const sheetRes = await fetch('https://gamecms-hacs.svc.halowaypoint.com/hi/Waypoint/file/medals/images/medal_sheet_xl.png', { headers });
    if (!sheetRes.ok) return res.status(sheetRes.status).send('Medal sheet unavailable');
    const buf = Buffer.from(await sheetRes.arrayBuffer());
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch(e) { res.status(500).send(e.message); }
});

// Medal meta
app.get('/api/medal-meta', async (req, res) => {
  await loadMedalMeta();
  res.json(medalMeta);
});

// CSR tier image proxy
app.get('/api/csr-image', async (req, res) => {
  const { tier } = req.query;
  if (!tier) return res.status(400).send('tier required');
  const imgPath = global._csrTierImages?.[tier.toLowerCase()];
  if (!imgPath) return res.status(404).send('Not found');
  try {
    const headers = getAuthHeaders();
    const parts = imgPath.split('/');
    const withFile = parts[0] + '/file/' + parts.slice(1).join('/');
    const r = await fetch(`https://gamecms-hacs.svc.halowaypoint.com/hi/${withFile}`, { headers });
    if (!r.ok) return res.status(404).send('Image not found');
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch(e) { res.status(500).send(e.message); }
});

// Emblem image proxy (path-based)
const imgCache = {};
const imgInFlight = {};
app.get('/api/emblem-img', async (req, res) => {
  const { path: imgPath, xuid, type } = req.query;
  const isNameplate = type === 'nameplate';
  if (!imgPath) return res.status(400).send('path required');
  // Negative-cached path: skip straight to gamerpic (for emblems only — nameplates just 404).
  if (imgCache[imgPath] === '__none__') {
    if (!isNameplate && xuid) { const gpUrl = getXuidToGamerpic()[String(xuid)]; if (gpUrl) return res.redirect(302, gpUrl); }
    return res.status(404).send('Not found');
  }
  if (imgCache[imgPath]) {
    res.setHeader('Content-Type', imgCache[imgPath].ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(imgCache[imgPath].buf);
  }
  if (imgInFlight[imgPath]) {
    try {
      const result = await imgInFlight[imgPath];
      if (typeof result === 'string') return res.redirect(302, result);
      res.setHeader('Content-Type', result.ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(result.buf);
    } catch(e) { return res.status(404).send('Not found'); }
  }
  const fetchPromise = (async () => {
    try { await fetchClearanceToken(xuid || '2533274802953504'); } catch(e) {}
    const headers = getAuthHeaders();
    // imgPath may be a single path or ';'-separated list of candidates.
    const candidates = [];
    for (const p of imgPath.split(';').filter(Boolean)) {
      if (p.startsWith('waypoint:')) {
        candidates.push(`https://gamecms-hacs.svc.halowaypoint.com/hi/Waypoint/file/${p.slice('waypoint:'.length)}`);
      } else if (p.startsWith('images:')) {
        candidates.push(`https://gamecms-hacs.svc.halowaypoint.com/hi/Images/file/${p.slice('images:'.length)}`);
      } else {
        const parts = p.split('/');
        const withFile = parts.length > 1 ? parts[0]+'/file/'+parts.slice(1).join('/') : 'progression/file/'+p;
        candidates.push(`https://gamecms-hacs.svc.halowaypoint.com/hi/${withFile}`);
        candidates.push(`https://gamecms-hacs.svc.halowaypoint.com/hi/${p}`);
        const stripped = p.replace(/^progression\//,'');
        candidates.push(`https://gamecms-hacs.svc.halowaypoint.com/hi/Images/file/progression/${stripped}`);
      }
    }
    for (const url of candidates) {
      try {
        const r = await fetch(url, { headers });
        if (r.ok) {
          const ct = r.headers.get('content-type') || 'image/png';
          const buf = Buffer.from(await r.arrayBuffer());
          imgCache[imgPath] = { ct, buf };
          return { ct, buf };
        }
      } catch(e) {}
    }
    // All candidates failed: negative-cache the path.
    // For emblems: also downgrade xuid emblem cache and redirect to gamerpic.
    // For nameplates: just 404 — don't touch the emblem cache.
    imgCache[imgPath] = '__none__';
    if (!isNameplate && xuid) {
      try { require('./halo').markEmblemMissing(xuid); } catch(e) {}
      const gpUrl = getXuidToGamerpic()[String(xuid)];
      if (gpUrl) return gpUrl;
    }
    throw new Error('Not found');
  })();
  imgInFlight[imgPath] = fetchPromise;
  try {
    const result = await fetchPromise;
    if (typeof result === 'string') return res.redirect(302, result);
    res.setHeader('Content-Type', result.ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(result.buf);
  } catch(e) {
    if (!isNameplate && xuid) { const gpUrl = getXuidToGamerpic()[String(xuid)]; if (gpUrl) return res.redirect(302, gpUrl); }
    res.status(404).send('Not found');
  } finally { delete imgInFlight[imgPath]; }
});

// Emblem proxy (xuid-based, for player cards)
const emblemImgCache = {};
app.get('/api/emblem', async (req, res) => {
  const { xuid } = req.query;
  if (!xuid) return res.status(400).send('xuid required');
  if (emblemImgCache[xuid]) {
    if (typeof emblemImgCache[xuid] === 'string') return res.redirect(302, emblemImgCache[xuid]);
    res.setHeader('Content-Type', emblemImgCache[xuid].ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(emblemImgCache[xuid].buf);
  }
  const halo = require('./halo');
  let imagePath = halo.getEmblemPathCache()[String(xuid)];
  // Cache miss: trigger fresh resolution so we don't hard-404 for xuids that haven't been through getStats yet.
  if (!imagePath) {
    try {
      const resolved = await halo.resolveEmblemForXuid(xuid);
      imagePath = resolved?.emblemPath;
    } catch(e) {}
  }
  if (!imagePath || imagePath === '__none__') {
    const gpUrl = getXuidToGamerpic()[String(xuid)];
    if (gpUrl) emblemImgCache[xuid] = gpUrl;
    return gpUrl ? res.redirect(302, gpUrl) : res.status(404).send('No emblem');
  }
  try {
    await fetchClearanceToken(xuid);
    const headers = getAuthHeaders();
    // imagePath may be a single path or ';'-separated list of candidates.
    const imgUrls = [];
    for (const p of imagePath.split(';').filter(Boolean)) {
      if (p.startsWith('waypoint:')) {
        imgUrls.push(`https://gamecms-hacs.svc.halowaypoint.com/hi/Waypoint/file/${p.slice('waypoint:'.length)}`);
      } else if (p.startsWith('images:')) {
        imgUrls.push(`https://gamecms-hacs.svc.halowaypoint.com/hi/Images/file/${p.slice('images:'.length)}`);
      } else {
        const parts = p.split('/');
        const withFile = parts.length>1 ? parts[0]+'/file/'+parts.slice(1).join('/') : 'progression/file/'+p;
        imgUrls.push(`https://gamecms-hacs.svc.halowaypoint.com/hi/${withFile}`);
        imgUrls.push(`https://gamecms-hacs.svc.halowaypoint.com/hi/${p}`);
        const stripped = p.replace(/^progression\//,'');
        imgUrls.push(`https://gamecms-hacs.svc.halowaypoint.com/hi/Images/file/progression/${stripped}`);
      }
    }
    let imgRes = null;
    for (const url of imgUrls) {
      const r = await fetch(url, { headers });
      if (r.ok) { imgRes = r; break; }
    }
    if (!imgRes) {
      // All candidates failed. Downgrade emblem cache so future requests skip path resolution.
      halo.markEmblemMissing(xuid);
      const gpUrl = getXuidToGamerpic()[String(xuid)];
      emblemImgCache[xuid] = gpUrl || '__none__';
      return gpUrl ? res.redirect(302, gpUrl) : res.status(404).send('Not found');
    }
    const ct = imgRes.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await imgRes.arrayBuffer());
    emblemImgCache[xuid] = { ct, buf };
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch(e) {
    const gpUrl = getXuidToGamerpic()[String(xuid)];
    return gpUrl ? res.redirect(302, gpUrl) : res.status(500).send(e.message);
  }
});

// Serve the SPA for all other routes

// --- Xbox Live people search (gamertag autocomplete) ---
let xblSuggestToken = null;
let xblSuggestTokenExpiry = 0;

async function getXblPeopleToken() {
  if (xblSuggestToken && Date.now() < xblSuggestTokenExpiry) return xblSuggestToken;
  const refreshToken = process.env.MS_REFRESH_TOKEN;
  if (!refreshToken) return null;
  try {
    const https = require('https');
    const post = (hostname, path, headers, body) => new Promise((resolve, reject) => {
      const data = typeof body === 'string' ? body : JSON.stringify(body);
      const req = https.request({ hostname, path, method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(data) }
      }, res => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve(raw); } }); });
      req.on('error', reject);
      req.write(data); req.end();
    });
    // Step 1: refresh MS access token
    const CLIENT_ID = '000000004C12AE6F';
    const REDIRECT  = 'https://login.live.com/oauth20_desktop.srf';
    const SCOPE     = 'Xboxlive.signin Xboxlive.offline_access';
    const msBody = `client_id=${CLIENT_ID}&refresh_token=${encodeURIComponent(refreshToken)}&grant_type=refresh_token&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent(SCOPE)}`;
    const msData = await post('login.live.com', '/oauth20_token.srf', { 'Content-Type': 'application/x-www-form-urlencoded' }, msBody);
    if (!msData.access_token) return null;
    // Step 2: XBL token
    const xblData = await post('user.auth.xboxlive.com', '/user/authenticate',
      { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      { Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msData.access_token}` }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' }
    );
    if (!xblData.Token) return null;
    // Step 3: XSTS with xboxlive.com relying party (for people search)
    const xstsData = await post('xsts.auth.xboxlive.com', '/xsts/authorize',
      { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      { Properties: { SandboxId: 'RETAIL', UserTokens: [xblData.Token] }, RelyingParty: 'http://xboxlive.com', TokenType: 'JWT' }
    );
    if (!xstsData.Token || !xstsData.DisplayClaims?.xui?.[0]?.uhs) return null;
    const uhs = xstsData.DisplayClaims.xui[0].uhs;
    xblSuggestToken = `XBL3.0 x=${uhs};${xstsData.Token}`;
    xblSuggestTokenExpiry = Date.now() + 3.5 * 60 * 60 * 1000;
    return xblSuggestToken;
  } catch(e) {
    console.error('[Suggest] Token error:', e.message);
    return null;
  }
}

// Suggest: server-side cache + rate limiter (peoplehub allows 10 req/15s)
const _suggestCache = new Map(); // query -> { people, ts }
const SUGGEST_CACHE_TTL = 30000; // 30s
const SUGGEST_RATE_WINDOW = 15000; // 15s
const SUGGEST_MAX_PER_WINDOW = 8;  // stay under Xbox's limit of 10
let _suggestReqTimes = []; // timestamps of recent upstream calls

async function callPeoplehub(q, token) {
  // Serve from cache if fresh
  const cached = _suggestCache.get(q.toLowerCase());
  if (cached && Date.now() - cached.ts < SUGGEST_CACHE_TTL) return cached.people;

  // Rate limit: only allow SUGGEST_MAX_PER_WINDOW upstream calls per window
  const now = Date.now();
  _suggestReqTimes = _suggestReqTimes.filter(t => now - t < SUGGEST_RATE_WINDOW);
  if (_suggestReqTimes.length >= SUGGEST_MAX_PER_WINDOW) {
    // Return stale cache if available, otherwise empty
    if (cached) return cached.people;
    return null; // signal: rate limited, no data
  }
  _suggestReqTimes.push(now);

  const url = `https://peoplehub.xboxlive.com/users/me/people/search/decoration/detail,preferredColor?q=${encodeURIComponent(q)}&maxItems=8`;
  const r = await fetch(url, {
    headers: {
      'Authorization': token,
      'x-xbl-contract-version': '3',
      'Accept': 'application/json',
      'Accept-Language': 'en-us',
    }
  });
  if (!r.ok) {
    const txt = await r.text();
    console.error('[Suggest] peoplehub error', r.status, txt.slice(0, 200));
    return cached ? cached.people : [];
  }
  const data = await r.json();
  const people = (data.people || []).map(p => ({
    gamertag: p.modernGamertag || p.gamertag || '',
    gamerpicUrl: p.displayPicRaw || p.displayPicUri || null,
    gamerScore: p.gamerScore || null,
  })).filter(p => p.gamertag);
  _suggestCache.set(q.toLowerCase(), { people, ts: Date.now() });
  return people;
}

app.get('/api/suggest', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ people: [] });
  try {
    const token = await getXblPeopleToken();
    if (!token) return res.json({ people: [], error: 'no_token' });
    const people = await callPeoplehub(q, token);
    if (people === null) return res.json({ people: [], error: 'rate_limited' });
    res.json({ people });
  } catch(e) {
    console.error('[Suggest] Error:', e.message);
    res.json({ people: [] });
  }
});



// Resolve gamertags on demand — called when a match card is expanded
app.get('/api/resolve-gamertags', async (req, res) => {
  const { xuids } = req.query;
  if (!xuids) return res.json({ gamertags: {} });
  const xuidList = String(xuids).split(',').map(x => x.trim()).filter(Boolean).slice(0, 100);
  if (!xuidList.length) return res.json({ gamertags: {} });
  try {
    const missing = xuidList.filter(x => !getXuidToGt()[x]);
    if (missing.length) await resolveGamertags(missing);
    const gt = getXuidToGt();
    const gamertags = {};
    for (const xuid of xuidList) { if (gt[xuid]) gamertags[xuid] = gt[xuid]; }
    res.json({ gamertags });
  } catch(e) {
    console.error('[ResolveGT]', e.message);
    res.json({ gamertags: {} });
  }
});

// Map image proxy — blobs-infiniteugc requires auth headers that can't be sent from browser
const mapImageProxyCache = new Map(); // url -> {buf, contentType, ts}
const MAP_IMG_TTL = 24 * 60 * 60 * 1000; // 24h

app.get('/api/map-image', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('https://blobs-infiniteugc.svc.halowaypoint.com/')) {
    return res.status(400).send('invalid url');
  }
  try {
    const cached = mapImageProxyCache.get(url);
    if (cached && Date.now() - cached.ts < MAP_IMG_TTL) {
      res.set('Content-Type', cached.contentType);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(cached.buf);
    }
    const headers = getAuthHeaders();
    const r = await fetch(url, { headers });
    if (!r.ok) return res.status(r.status).send('upstream error');
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type') || 'image/png';
    mapImageProxyCache.set(url, { buf, contentType: ct, ts: Date.now() });
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch(e) {
    console.error('[MapImg]', e.message);
    res.status(500).send('error');
  }
});

// ── Batch resolve gamerpics for rivals ───────────────────────────────────────
app.get('/api/rival-pics', async (req, res) => {
  const gamertags = (req.query.gamertags||'').split(',').map(g=>g.trim()).filter(Boolean).slice(0,30);
  if(!gamertags.length) return res.json({});
  const xuidToGt = getXuidToGt();
  const xuidToGamerpic = getXuidToGamerpic();
  // Build reverse map: gamertag.lower -> xuid
  const gtToXuid = {};
  Object.entries(xuidToGt).forEach(([xuid,gt])=>{ gtToXuid[gt.toLowerCase()]=xuid; });
  const result = {};
  gamertags.forEach(gt => {
    const xuid = gtToXuid[gt.toLowerCase()];
    if(xuid && xuidToGamerpic[xuid]) result[gt] = xuidToGamerpic[xuid];
  });
  res.json(result);
});

// ── Search progress SSE ──────────────────────────────────────────────────────
app.get('/api/search/progress', (req, res) => {
  const key = (req.query.gamertag||'').toLowerCase();
  if (!key) return res.json({ step: 0, valid: 0, total: 100 });
  const p = _searchProgress[key] || { step: 0, valid: 0, total: 100 };
  res.json(p);
});

// ── Public stats (landing page) ──────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const db = await getDb();
    if (db) {
      const r = await db.query(`SELECT COUNT(*) as total, COUNT(DISTINCT LOWER(gamertag)) as unique_players FROM search_log WHERE success = true`);
      const st = r.rows[0] || {};
      return res.json({ totalSearches: parseInt(st.total)||0, uniquePlayers: parseInt(st.unique_players)||0 });
    }
    const unique = new Set(_memSearchLog.filter(s=>s.success).map(s=>s.gamertag.toLowerCase())).size;
    res.json({ totalSearches: _memSearchLog.filter(s=>s.success).length, uniquePlayers: unique });
  } catch(e) { res.json({ totalSearches: 0, uniquePlayers: 0 }); }
});

// ── Tab analytics ────────────────────────────────────────────────────────────
app.post('/api/analytics/tab', async (req, res) => {
  const { gamertag, tab, seconds } = req.body || {};
  if (!tab || !seconds || seconds < 1 || seconds > 3600) return res.json({ ok: false });
  await logTab(gamertag || null, tab, parseFloat(seconds));
  res.json({ ok: true });
});

// ── Admin: search log JSON ───────────────────────────────────────────────────
app.get('/api/admin/searches', async (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== (process.env.ADMIN_PASS || 'changeme')) return res.status(401).send('Unauthorized');
  try {
    const db = await getDb();
    let searches = [], tabStats = [];
    if (db) {
      const r = await db.query('SELECT ts,gamertag,ip,user_agent,cached,success,duration_ms FROM search_log ORDER BY ts DESC LIMIT 500');
      searches = r.rows;
      const tr = await db.query(`SELECT tab,COUNT(*) as visits,ROUND(AVG(seconds),1) as avg_seconds,ROUND(SUM(seconds)/60,1) as total_minutes FROM tab_log GROUP BY tab ORDER BY visits DESC`).catch(()=>({rows:[]}));
      tabStats = tr.rows;
      const statsR = await db.query(`SELECT COUNT(*) as total, COUNT(DISTINCT LOWER(gamertag)) as unique_players, SUM(CASE WHEN user_agent ~* 'mobile|android|iphone|ipad' THEN 1 ELSE 0 END) as mobile, SUM(CASE WHEN user_agent IS NOT NULL AND user_agent !~* 'mobile|android|iphone|ipad' THEN 1 ELSE 0 END) as desktop FROM search_log`).catch(()=>({rows:[{}]}));
      const topR = await db.query(`SELECT LOWER(gamertag) as gt, COUNT(*) as count FROM search_log GROUP BY LOWER(gamertag) ORDER BY count DESC LIMIT 10`).catch(()=>({rows:[]}));
      const st = statsR.rows[0] || {};
      res.json({ total: parseInt(st.total)||searches.length, uniquePlayers: parseInt(st.unique_players)||0, top: topR.rows.map(r=>({gt:r.gt,count:parseInt(r.count)})), searches, tabStats, devices: { mobile: parseInt(st.mobile)||0, desktop: parseInt(st.desktop)||0, unknown: 0 } });
      return;
    } else {
      searches = _memSearchLog.slice().reverse();
    }
    const unique = [...new Set(searches.map(s => s.gamertag.toLowerCase()))];
    const topMap = {};
    searches.forEach(s => { const k = s.gamertag.toLowerCase(); topMap[k] = (topMap[k]||0)+1; });
    const top = Object.entries(topMap).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([gt,count])=>({gt,count}));
    const devices = { mobile: 0, desktop: 0, unknown: 0 };
    searches.forEach(s => {
      if (!s.user_agent) { devices.unknown++; return; }
      if (/mobile|android|iphone|ipad/i.test(s.user_agent)) devices.mobile++;
      else devices.desktop++;
    });
    res.json({ total: searches.length, uniquePlayers: unique.length, top, searches, tabStats, devices });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: search log UI ──────────────────────────────────────────────────────
app.get('/api/admin', (req, res) => {
  const pass = req.query.pass || '';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';
  if (pass !== ADMIN_PASS) {
    return res.send(`<!DOCTYPE html><html><body style="font-family:monospace;background:#0a0f1a;color:#ccc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><form method="get"><input name="pass" type="password" placeholder="Password" style="padding:8px;background:#1a2035;border:1px solid #333;color:#fff;border-radius:4px;margin-right:8px"><button type="submit" style="padding:8px 16px;background:#00d4ff;color:#000;border:none;border-radius:4px;cursor:pointer">Enter</button></form></body></html>`);
  }
  res.send(`<!DOCTYPE html><html><head><title>fragr // analytics</title>
  <style>body{font-family:Share Tech Mono,monospace;background:#0a0f1a;color:#ccc;margin:0;padding:20px}h1,h2{color:#00d4ff;letter-spacing:2px;text-transform:uppercase}h1{font-size:16px;margin-bottom:20px}h2{font-size:11px;margin:24px 0 10px}table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:24px}th{text-align:left;color:#666;padding:6px 10px;border-bottom:1px solid #1a2035;font-size:10px;letter-spacing:1px}td{padding:6px 10px;border-bottom:1px solid #111}tr:hover td{background:#0d1425}.win{color:#4caf50}.loss{color:#f44336}.muted{color:#555}.gold{color:#ffc107}.summary{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap}.stat{background:#0d1425;padding:12px 18px;border-radius:6px;border:1px solid #1a2035;min-width:100px}.stat-val{font-size:28px;font-weight:700;color:#00d4ff;line-height:1}.stat-lbl{font-size:10px;color:#555;margin-top:4px}#filter{background:#0d1425;border:1px solid #1a2035;color:#fff;padding:6px 12px;border-radius:4px;font-family:inherit;margin-bottom:12px;width:200px}.bar-wrap{background:#0d1425;border-radius:3px;height:6px;width:100px;display:inline-block;vertical-align:middle;margin-left:8px}.bar{background:#00d4ff;height:6px;border-radius:3px}.ua-pill{font-size:9px;padding:2px 6px;border-radius:10px;background:#1a2035;color:#888}</style></head>
  <body><h1>// fragr analytics</h1>
  <div class="summary" id="summary">Loading...</div>
  <h2>// tab engagement</h2>
  <table><thead><tr><th>TAB</th><th>VISITS</th><th>AVG TIME</th><th>TOTAL TIME</th></tr></thead><tbody id="tabtbody"></tbody></table>
  <h2>// recent searches</h2>
  <input id="filter" placeholder="Filter gamertag..." oninput="filterRows()">
  <table><thead><tr><th>TIME</th><th>GAMERTAG</th><th>IP</th><th>DEVICE</th><th>CACHED</th><th>DURATION</th><th>STATUS</th></tr></thead><tbody id="tbody"></tbody></table>
  <script>
  var allRows=[];
  function ua2device(ua){if(!ua)return'<span class="ua-pill">?</span>';var u=ua.toLowerCase();if(/iphone/.test(u))return'<span class="ua-pill" style="color:#4caf50">iPhone</span>';if(/ipad/.test(u))return'<span class="ua-pill" style="color:#2196f3">iPad</span>';if(/android/.test(u))return'<span class="ua-pill" style="color:#ff9800">Android</span>';if(/mac/.test(u))return'<span class="ua-pill" style="color:#9c27b0">Mac</span>';if(/windows/.test(u))return'<span class="ua-pill" style="color:#00bcd4">Windows</span>';return'<span class="ua-pill">desktop</span>';}
  function fmtSec(s){if(!s)return'—';var n=parseFloat(s);return n>=60?(n/60).toFixed(1)+'m':n+'s';}
  function loadData(){
    fetch('/api/admin/searches?pass=${pass}').then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}).then(function(d){
      allRows=d.searches||[];
      var dev=d.devices||{};
      document.getElementById('summary').innerHTML='<div class="stat"><div class="stat-val">'+d.total+'</div><div class="stat-lbl">SEARCHES</div></div><div class="stat"><div class="stat-val">'+d.uniquePlayers+'</div><div class="stat-lbl">UNIQUE PLAYERS</div></div><div class="stat"><div class="stat-val">'+(d.top[0]?d.top[0].gt:'—')+'</div><div class="stat-lbl">MOST SEARCHED</div></div><div class="stat"><div class="stat-val">'+(dev.mobile||0)+'</div><div class="stat-lbl">MOBILE</div></div><div class="stat"><div class="stat-val">'+(dev.desktop||0)+'</div><div class="stat-lbl">DESKTOP</div></div>';
      var tabs=d.tabStats||[];var maxV=tabs.reduce(function(m,t){return Math.max(m,parseInt(t.visits)||0);},1);
      document.getElementById('tabtbody').innerHTML=tabs.length?tabs.map(function(t){var pct=Math.round((parseInt(t.visits)/maxV)*100);return'<tr><td style="color:#00d4ff">'+t.tab+'</td><td>'+t.visits+'<div class="bar-wrap"><div class="bar" style="width:'+pct+'%"></div></div></td><td class="gold">'+fmtSec(t.avg_seconds)+'</td><td class="muted">'+t.total_minutes+'m</td></tr>';}).join(''):'<tr><td colspan="4" class="muted">No tab data yet</td></tr>';
      renderRows(allRows);
    }).catch(function(e){document.getElementById('summary').innerHTML='<div style="color:#f44336">Error: '+e.message+'</div>';});
  }
  loadData();setInterval(loadData,30000);
  function renderRows(rows){document.getElementById('tbody').innerHTML=rows.map(function(s){var cached=String(s.cached);var cs=cached==='cached'?'<span class="muted">cached</span>':cached==='inflight'?'<span style="color:#555">inflight</span>':cached==='error'?'<span class="loss">error</span>':'<span style="color:#888">fresh</span>';return'<tr><td class="muted">'+new Date(s.ts).toISOString().replace('T',' ').slice(0,19)+'</td><td style="color:#00d4ff">'+s.gamertag+'</td><td class="muted">'+s.ip+'</td><td>'+ua2device(s.user_agent)+'</td><td>'+cs+'</td><td class="muted">'+(s.duration_ms?s.duration_ms+'ms':'—')+'</td><td>'+(s.success?'<span class="win">✓</span>':'<span class="loss">✗</span>')+'</td></tr>';}).join('');}
  function filterRows(){var q=document.getElementById('filter').value.toLowerCase();renderRows(q?allRows.filter(function(r){return r.gamertag.toLowerCase().includes(q);}):allRows);}
  </script></body></html>`);
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start token auto-refresh (requires MS_REFRESH_TOKEN env var)
startAutoRefresh();

app.listen(PORT, () => console.log(`[fragr] Listening on port ${PORT} — fragr.live`));
