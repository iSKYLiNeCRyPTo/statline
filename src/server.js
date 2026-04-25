require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { fetchPlayerStats, fetchMatchHistory, getAuthHeaders, fetchClearanceToken, getXuidToGamerpic } = require('./halo');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Warn on missing required env vars
if (!process.env.SPARTAN_TOKEN) {
  console.error('[WARN] SPARTAN_TOKEN is not set — all API calls will fail with 401');
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
    const res = await fetch('https://gamecms-hacs.svc.halowaypoint.com/hi/Waypoint/file/images/medals/mapping.json', { headers });
    if (res.ok) {
      const data = await res.json();
      for (const [id, info] of Object.entries(data)) {
        medalMeta[id] = { name: info.name || String(id), sprite: info.spritePath || null };
      }
      global._medalMeta = medalMeta;
      console.log('[Medals] Loaded', Object.keys(medalMeta).length, 'medals');
    }
  } catch(e) { console.log('[Medals] Failed to load:', e.message); }
}
loadMedalMeta();

// --- Routes ---

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Main search endpoint
app.get('/api/search', rateLimit, async (req, res) => {
  const gamertag = (req.query.gamertag || '').trim();
  if (!gamertag) return res.status(400).json({ success: false, error: 'Gamertag required' });
  if (gamertag.length < 1 || gamertag.length > 32) return res.status(400).json({ success: false, error: 'Invalid gamertag' });

  // Check cache
  const cached = await getFromCache(gamertag);
  if (cached) return res.json({ success: true, player: cached, cached: true });

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
      });
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
    const sheetRes = await fetch('https://gamecms-hacs.svc.halowaypoint.com/hi/Waypoint/file/images/medals/medal-spritesheet.png', { headers });
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
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`[StatLine] Listening on port ${PORT}`));
