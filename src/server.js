require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { fetchPlayerStats, fetchMatchHistory, getAuthHeaders, fetchClearanceToken, getXuidToGamerpic } = require('./halo');
const { startAutoRefresh } = require('./tokenRefresh');

const app = express();
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
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

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
  if (cached && !forceRefresh) return res.json({ success: true, player: cached, cached: true });

  // Deduplicate concurrent searches
  const key = gamertag.toLowerCase().trim();
  if (searchInFlight[key]) {
    try {
      const result = await searchInFlight[key];
      return res.json({ success: true, player: result });
    } catch(e) {
      return res.status(404).json({ success: false, error: e.message });
    }
  }

  const searchPromise = (async () => {
    try {
      const playerStats = await fetchPlayerStats(gamertag);
      const histData = await fetchMatchHistory(playerStats.xuid, gamertag, 25);
      const PVE = ['firefight','gruntpocalypse','attrition','pve'];
      const BAD_MAPS = ['launch site','yuletide','octagon','aimbotz'];
      const matches = (histData.matches || []).filter(m => {
        if (m.isCustom) return false;
        if (m.gameMode && PVE.some(p => m.gameMode.toLowerCase().includes(p))) return false;
        if (m.mapName && BAD_MAPS.some(p => m.mapName.toLowerCase().includes(p))) return false;
        return true;
      }).slice(0, 25);
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
    }
  })();
  searchInFlight[key] = searchPromise;

  try {
    const result = await searchPromise;
    res.json({ success: true, player: result });
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

// Match history (returns the 25 cached matches, paginated)
app.get('/api/matches', async (req, res) => {
  try {
    const { gamertag, page = 1, perPage = 25 } = req.query;
    if (!gamertag) return res.status(400).json({ error: 'gamertag required' });
    const cached = await getFromCache(gamertag);
    const source = cached?.allMatches || cached?.recentMatches || [];
    const ranked = req.query.ranked === '1';
    const all = source.filter(m => !ranked || m.isRanked);
    const pg = parseInt(page) || 1;
    const pp = Math.min(parseInt(perPage) || 25, 25);
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
  const { path: imgPath, xuid } = req.query;
  if (!imgPath) return res.status(400).send('path required');
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
    let candidates;
    if (imgPath.startsWith('waypoint:')) {
      candidates = [`https://gamecms-hacs.svc.halowaypoint.com/hi/Waypoint/file/${imgPath.slice('waypoint:'.length)}`];
    } else {
      const parts = imgPath.split('/');
      const withFile = parts.length > 1 ? parts[0]+'/file/'+parts.slice(1).join('/') : 'progression/file/'+imgPath;
      candidates = [
        `https://gamecms-hacs.svc.halowaypoint.com/hi/${withFile}`,
        `https://gamecms-hacs.svc.halowaypoint.com/hi/${imgPath}`,
      ];
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
    // Redirect to gamerpic fallback
    if (xuid) {
      const gpUrl = getXuidToGamerpic()[String(xuid)];
      if (gpUrl) return gpUrl;
    }
    throw new Error('Emblem not found');
  })();
  imgInFlight[imgPath] = fetchPromise;
  try {
    const result = await fetchPromise;
    if (typeof result === 'string') return res.redirect(302, result);
    res.setHeader('Content-Type', result.ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(result.buf);
  } catch(e) {
    if (xuid) { const gpUrl = getXuidToGamerpic()[String(xuid)]; if (gpUrl) return res.redirect(302, gpUrl); }
    res.status(404).send('Emblem not found');
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
  const emblemPaths = require('./halo').getEmblemPathCache ? require('./halo').getEmblemPathCache() : {};
  const imagePath = emblemPaths[String(xuid)];
  if (!imagePath || imagePath === '__none__') {
    const gpUrl = getXuidToGamerpic()[String(xuid)];
    return gpUrl ? res.redirect(302, gpUrl) : res.status(404).send('No emblem');
  }
  try {
    await fetchClearanceToken(xuid);
    const headers = getAuthHeaders();
    let imgUrls;
    if (imagePath.startsWith('waypoint:')) {
      imgUrls = [`https://gamecms-hacs.svc.halowaypoint.com/hi/Waypoint/file/${imagePath.slice('waypoint:'.length)}`];
    } else {
      const parts = imagePath.split('/');
      const withFile = parts.length>1 ? parts[0]+'/file/'+parts.slice(1).join('/') : 'progression/file/'+imagePath;
      imgUrls = [`https://gamecms-hacs.svc.halowaypoint.com/hi/${withFile}`, `https://gamecms-hacs.svc.halowaypoint.com/hi/${imagePath}`];
    }
    let imgRes = null;
    for (const url of imgUrls) {
      const r = await fetch(url, { headers });
      if (r.ok) { imgRes = r; break; }
    }
    if (!imgRes) { const gpUrl = getXuidToGamerpic()[String(xuid)]; emblemImgCache[xuid] = gpUrl || '__none__'; return gpUrl ? res.redirect(302, gpUrl) : res.status(404).send('Not found'); }
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start token auto-refresh (requires MS_REFRESH_TOKEN env var)
startAutoRefresh();

app.listen(PORT, () => console.log(`[fragr] Listening on port ${PORT} — fragr.live`));
