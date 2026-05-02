require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { fetchPlayerStats, fetchMatchHistory, fetchAndApplySkillData, getAuthHeaders, fetchClearanceToken, getXuidToGamerpic, getXuidToGt, resolveGamertags, discoverPlaylists } = require('./halo');
const { startAutoRefresh, refreshSpartanToken } = require('./tokenRefresh');
const { Pool } = require('pg');
const { getDb: getXuidDb, loadXuidCache, flushXuidCache, loadEmblemCache, flushEmblemCache, savePlayerSnapshot, getSnapshotsByRank, addProPlayer, removeProPlayer, getProPlayers, getProStats } = require('./db');
const _memSearchLog = [];
const _memTabLog = [];
const _memFeedbackLog = [];
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
      await _dbPool.query(`CREATE TABLE IF NOT EXISTS feedback_log (id SERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT NOW(), type TEXT NOT NULL, message TEXT NOT NULL, email TEXT, ip TEXT, user_agent TEXT)`);
      console.log('[DB] Tables ready');
    } catch(e) { console.error('[DB] Table create error:', e.message); }
  }
  return _dbPool;
}
getDb();

// Load xuid + emblem/nameplate caches from Postgres into halo.js in-memory maps on startup
loadXuidCache(getXuidToGt());
const { getEmblemPathCache, getNameplatePathCache } = require('./halo');
loadEmblemCache(getEmblemPathCache(), getNameplatePathCache());

// Flush new xuids to Postgres every 2 minutes
setInterval(() => flushXuidCache(getXuidToGt()), 2 * 60 * 1000);
// Flush new emblem/nameplate paths every 5 minutes
setInterval(() => flushEmblemCache(getEmblemPathCache(), getNameplatePathCache()), 5 * 60 * 1000);

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
const RATE_LIMIT_MAX = 30;       // 30 searches per minute per IP

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

// Live API connectivity test — actually hits the Halo API so admin knows if auth is working
app.get('/api/admin/test-api', async (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== (process.env.ADMIN_PASS || 'changeme')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    // Use a known-stable public gamertag as the canary — just needs profile lookup, no match fetch
    await fetchPlayerStats('Ninja');
    res.json({ ok: true, message: 'Halo API reachable — token valid' });
  } catch(e) {
    const is403 = e.message && (e.message.includes('403') || e.message.includes('clearance') || e.message.includes('Unauthorized'));
    res.json({ ok: false, message: is403
      ? 'Token expired (403) — click "force refresh token" to get a new one'
      : 'API error: ' + e.message });
  }
});

// Force-trigger a Spartan token refresh on demand (same flow as the scheduled auto-refresh)
app.post('/api/admin/refresh-token', async (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== (process.env.ADMIN_PASS || 'changeme')) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.MS_REFRESH_TOKEN) {
    return res.status(400).json({ ok: false, error: 'MS_REFRESH_TOKEN is not set — cannot auto-refresh. Set it in your env vars.' });
  }
  try {
    await refreshSpartanToken();
    res.json({ ok: true, message: 'Spartan token refreshed successfully' });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Main search endpoint
app.get('/api/search', rateLimit, async (req, res) => {
  const gamertag = (req.query.gamertag || '').trim();
  if (!gamertag) return res.status(400).json({ success: false, error: 'Gamertag required' });
  if (gamertag.length < 1 || gamertag.length > 32) return res.status(400).json({ success: false, error: 'Invalid gamertag' });

  // Check cache (skip if force refresh requested)
  const forceRefresh = req.query.force === '1';
  const cached = await getFromCache(gamertag);
  if (cached && !forceRefresh) {
    // Re-trigger skill enrichment in background if the cached data is missing skill pills
    const _allM = cached.allMatches || cached.recentMatches || [];
    const _ranked = _allM.filter(m => m.isRanked && m.matchId);
    const _withSkill = _ranked.filter(m => m.expectedKills != null || m.mmr != null).length;
    if (_ranked.length > 0 && _withSkill < _ranked.length * 0.5) {
      setTimeout(() => fetchAndApplySkillData(cached.xuid, _allM)
        .then(() => saveToCache(gamertag, cached))
        .catch(e => console.warn('[SkillBG/cached] skill fetch failed:', e.message)), 1000);
    }
    logSearch(gamertag, req.headers['user-agent'], 'cached', true, null);
    return res.json({ success: true, player: cached, cached: true });
  }

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
      const histData = await fetchMatchHistory(playerStats.xuid, gamertag, 100, (valid, scanned, total, retrying) => {
        _searchProgress[key] = { step: 2, valid, scanned, total, retrying: retrying || null, ts: Date.now() };
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
    flushEmblemCache(getEmblemPathCache(), getNameplatePathCache()).catch(() => {});
    // Save player snapshot for rank comparison feature (fire and forget)
    savePlayerSnapshot(result).catch(() => {});
    // Background: enrich matches with skill data (hits skill.svc — separate rate limit from halostats)
    // We wait 2s first to let the halostats burst cool off, then mutate result in-place and re-cache.
    const _bgMatches = result.allMatches || result.recentMatches || [];
    if (_bgMatches.some(m => m.isRanked)) {
      setTimeout(() => {
        fetchAndApplySkillData(result.xuid, _bgMatches)
          .then(() => saveToCache(gamertag, result))
          .catch(e => console.warn('[SkillBG] Background skill fetch failed:', e.message));
      }, 2000);
    }
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

// Latest match check — lightweight poll used by auto-refresh.
// Fetches only 1 match from Waypoint to check if something new has finished,
// then compares against cached data. Triggers a full force-refresh on the server
// if a new match is found so the next /api/search call gets fresh data.
const _latestMatchCheckCache = {}; // gamertag.lower -> { matchId, checkedAt }
const LATEST_CHECK_TTL = 60000;    // don't hammer Waypoint — reuse result for 60s
app.get('/api/latest-match', async (req, res) => {
  try {
    const { gamertag } = req.query;
    if (!gamertag) return res.json({ ok: false });
    const key = gamertag.toLowerCase().trim();

    // Get the xuid from our cache — we need it for the Waypoint call
    const entry = searchCache[key];
    const xuid = entry && entry.data && entry.data.xuid;
    if (!xuid) return res.json({ ok: false, reason: 'not_cached' });

    // Rate-limit: reuse the last check result for 60s to avoid hammering Waypoint
    const lastCheck = _latestMatchCheckCache[key];
    if (lastCheck && Date.now() - lastCheck.checkedAt < LATEST_CHECK_TTL) {
      return res.json({ ok: true, matchId: lastCheck.matchId, startTime: lastCheck.startTime, fromCache: true });
    }

    // Fetch just the 1 most recent match from Waypoint
    const headers = getAuthHeaders();
    const wayRes = await fetch(
      `https://halostats.svc.halowaypoint.com/hi/players/xuid(${xuid})/matches?count=1&start=0`,
      { headers, signal: AbortSignal.timeout(8000) }
    );
    if (!wayRes.ok) return res.json({ ok: false, reason: `waypoint_${wayRes.status}` });
    const wayData = await wayRes.json();
    const latestWay = wayData.Results && wayData.Results[0];
    const latestMatchId = latestWay ? latestWay.MatchId : null;
    const latestStartTime = latestWay ? latestWay.MatchInfo?.StartTime : null;

    // Cache the result
    _latestMatchCheckCache[key] = { matchId: latestMatchId, startTime: latestStartTime, checkedAt: Date.now() };

    // If the new matchId differs from what's in the player cache, invalidate the
    // server cache so the next force-refresh pulls fresh data from Waypoint
    const cachedMatches = entry.data.allMatches || entry.data.recentMatches || [];
    const cachedLatestId = cachedMatches[0] ? cachedMatches[0].matchId : null;
    if (latestMatchId && latestMatchId !== cachedLatestId) {
      delete searchCache[key]; // bust cache so next /api/search?force=1 fetches fresh
    }

    res.json({ ok: true, matchId: latestMatchId, startTime: latestStartTime });
  } catch(e) { res.json({ ok: false, reason: e.message }); }
});

// Skill enrichment status — tells the client how much of the background skill fetch is done
app.get('/api/skill-status', async (req, res) => {
  try {
    const { gamertag } = req.query;
    if (!gamertag) return res.json({ ready: false, pct: 0 });
    const cached = await getFromCache(gamertag);
    if (!cached) return res.json({ ready: false, pct: 0 });
    const matches = cached.allMatches || cached.recentMatches || [];
    const ranked = matches.filter(m => m.isRanked && m.matchId);
    if (!ranked.length) return res.json({ ready: true, pct: 100 }); // nothing to enrich
    const withSkill = ranked.filter(m => m.expectedKills != null || m.mmr != null).length;
    const pct = Math.round(withSkill / ranked.length * 100);
    res.json({ ready: pct >= 95, pct, withSkill, total: ranked.length });
  } catch(e) { res.json({ ready: false, pct: 0 }); }
});

// Rank comparison — returns peer stats and next-rank targets from stored snapshots
const TIER_ORDER = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Onyx'];
function getNextRank(tier, subTier, csrValue) {
  if (tier === 'Onyx') {
    // Onyx buckets in 100-point bands up to 1900+
    const bandLow = csrValue != null ? Math.min(Math.floor(csrValue / 100) * 100, 1900) : 1500;
    if (bandLow >= 1900) return null; // already in top bucket
    return { tier: 'Onyx', subTier: 0, csrValue: bandLow + 100 }; // next band
  }
  if (subTier < 6) return { tier, subTier: subTier + 1 };
  const idx = TIER_ORDER.indexOf(tier);
  if (idx < 0 || idx === TIER_ORDER.length - 1) return null;
  const next = TIER_ORDER[idx + 1];
  return { tier: next, subTier: next === 'Onyx' ? 0 : 1, csrValue: next === 'Onyx' ? 1500 : null };
}
function computeGroupStats(rows, playerStats) {
  if (!rows.length) return { count: 0 };
  const avg = key => rows.reduce((s, r) => s + (parseFloat(r[key]) || 0), 0) / rows.length;
  // Mid-point percentile rank: count_below + 0.5 * count_equal, using display-precision
  // rounding so a player at the peer average always reads ~50th, not deceptively low.
  const PRECISION = { kd: 2, win_rate: 1, accuracy: 1, avg_kills: 1 };
  const percentile = (key, val) => {
    if (val == null) return null;
    const dec = PRECISION[key] ?? 1;
    const round = v => Math.round(v * Math.pow(10, dec)) / Math.pow(10, dec);
    const rv = round(val);
    const sorted = rows.map(r => round(parseFloat(r[key]) || 0)).sort((a, b) => a - b);
    const below = sorted.filter(v => v < rv).length;
    const equal = sorted.filter(v => v === rv).length;
    return Math.round((below + equal * 0.5) / sorted.length * 100);
  };
  const ps = playerStats || {};
  return {
    count: rows.length,
    avg: {
      kd:        +avg('kd').toFixed(2),
      win_rate:  +avg('win_rate').toFixed(1),
      accuracy:  +avg('accuracy').toFixed(1),
      avg_kills: +avg('avg_kills').toFixed(1),
    },
    percentiles: ps.kd != null ? {
      kd:        percentile('kd',        ps.kd),
      win_rate:  percentile('win_rate',  ps.win_rate),
      accuracy:  percentile('accuracy',  ps.accuracy),
      avg_kills: percentile('avg_kills', ps.avg_kills),
    } : null,
  };
}

app.get('/api/rank-comparison', async (req, res) => {
  try {
    const { gamertag, playlist } = req.query;
    if (!gamertag) return res.status(400).json({ error: 'gamertag required' });

    const player = await getFromCache(gamertag);
    if (!player) return res.json({ available: false, reason: 'not_cached' });

    const csr = player.csr || {};
    // Ranked Arena is the authoritative competitive metric — always prefer it.
    // Keys match the display names produced by halo.js csrResults (NOT snake_case).
    const PREFERRED = ['Ranked Arena', 'Ranked Slayer', 'Ranked Legacy'];
    let pl = playlist || null;
    // If a specific playlist was requested, validate it; otherwise pick by preference.
    if (!pl || !csr[pl] || !csr[pl].tier) {
      pl = PREFERRED.find(k => csr[k] && csr[k].tier) || Object.keys(csr).find(k => csr[k] && csr[k].tier);
    }
    if (!pl || !csr[pl] || !csr[pl].tier) return res.json({ available: false, reason: 'no_csr' });

    const isArena = pl === 'Ranked Arena';
    const { tier, subTier = 0 } = csr[pl];
    const csrValue = csr[pl].value || 0;

    // Prefer recent-match stats so this card is consistent with the rest of the app
    // (Pro Reference, Insights, etc. all use match history). Fall back to career API stats.
    let playerStats, statsSource = 'career', statsGames = null;
    const allMatchArr = Array.isArray(player.allMatches) ? player.allMatches
                      : Array.isArray(player.recentMatches) ? player.recentMatches : [];
    // Use all matches (PvP, non-custom) — outcome filter only needed for win rate calc
    const validMatches = allMatchArr.filter(m => m && m.kills != null);
    if (validMatches.length >= 5) {
      const totalKills  = validMatches.reduce((s, m) => s + (m.kills || 0), 0);
      const totalDeaths = validMatches.reduce((s, m) => s + (m.deaths || 0), 0);
      // Win rate: only count decisive outcomes (2=win, 3=loss), ignore draws/unknown
      const wlMatches   = validMatches.filter(m => m.outcome === 2 || m.outcome === 3);
      const wins        = wlMatches.filter(m => m.outcome === 2).length;
      const accGames    = validMatches.filter(m => m.accuracy != null && parseFloat(m.accuracy) > 0);
      const avgAcc      = accGames.length ? accGames.reduce((s, m) => s + parseFloat(m.accuracy), 0) / accGames.length : null;
      playerStats = {
        kd:        totalDeaths > 0 ? parseFloat((totalKills / totalDeaths).toFixed(2)) : null,
        win_rate:  wlMatches.length > 0 ? parseFloat(((wins / wlMatches.length) * 100).toFixed(1)) : null,
        accuracy:  avgAcc != null ? parseFloat(avgAcc.toFixed(1)) : null,
        avg_kills: parseFloat((totalKills / validMatches.length).toFixed(1)),
      };
      statsSource = 'recent';
      statsGames  = validMatches.length;
    } else {
      const s = player.stats || {};
      playerStats = {
        kd:        parseFloat(s.kd)              || null,
        win_rate:  parseFloat(s.winRate)         || null,
        accuracy:  parseFloat(s.accuracy)        || null,
        avg_kills: parseFloat(s.avgKillsPerGame) || null,
      };
    }

    // For Onyx, bucket into 100-point CSR bands so 1500 ≠ 1900
    const onyxBandLow  = tier === 'Onyx' ? Math.min(Math.floor(csrValue / 100) * 100, 1900) : null;
    const onyxBandHigh = onyxBandLow != null ? (onyxBandLow >= 1900 ? null : onyxBandLow + 100) : null;
    const onyxLabel    = onyxBandLow != null ? (onyxBandHigh != null ? `Onyx ${onyxBandLow}–${onyxBandHigh - 1}` : `Onyx ${onyxBandLow}+`) : null;

    const peerRows = await getSnapshotsByRank(tier, subTier, csrValue);
    const next = getNextRank(tier, subTier, csrValue);
    const nextRows = next ? await getSnapshotsByRank(next.tier, next.subTier, next.csrValue) : [];
    const proStats = await getProStats();

    // Label for next Onyx band
    const nextOnyxLow  = next && next.tier === 'Onyx' ? Math.min(Math.floor((next.csrValue || 1500) / 100) * 100, 1900) : null;
    const nextOnyxHigh = nextOnyxLow != null ? (nextOnyxLow >= 1900 ? null : nextOnyxLow + 100) : null;
    const nextOnyxLabel = nextOnyxLow != null ? (nextOnyxHigh != null ? `Onyx ${nextOnyxLow}–${nextOnyxHigh - 1}` : `Onyx ${nextOnyxLow}+`) : null;

    res.json({
      available: true,
      playlist: pl,
      isArena,
      statsSource,   // 'recent' | 'career'
      statsGames,    // number of recent matches used, or null
      // Surface all CSR ranks so the client can display a note when not using Arena
      allPlaylists: Object.entries(csr)
        .filter(([, c]) => c && c.tier)
        .map(([label, c]) => ({ label, display: c.display, value: c.value })),
      rank: { tier, subTier, csrValue, display: onyxLabel || csr[pl].display || `${tier} ${subTier}` },
      player: playerStats,
      peers: {
        label: onyxLabel || (tier === 'Onyx' ? 'Onyx' : `${tier} ${subTier}`),
        ...computeGroupStats(peerRows, playerStats),
      },
      nextRank: next ? {
        label: nextOnyxLabel || (next.tier === 'Onyx' ? 'Onyx' : `${next.tier} ${next.subTier}`),
        ...computeGroupStats(nextRows, null),
      } : null,
      pro: proStats,
    });
  } catch(e) {
    console.error('[rank-comparison]', e.message);
    res.json({ available: false, reason: 'error' });
  }
});

// Public pro stats — used by the client to calibrate analysis zones
app.get('/api/pro-stats', async (req, res) => {
  try {
    const stats = await getProStats();
    res.json({ ok: true, stats: stats || null });
  } catch(e) { res.json({ ok: false, stats: null }); }
});

// Playlist discovery — fetches the player's 25 most recent matches and returns
// every unique playlist ID + name. Use this to find the Ranked Legacy playlist ID.
// Hit: GET /api/discover-playlists?gamertag=<gt>
app.get('/api/discover-playlists', async (req, res) => {
  try {
    const { gamertag } = req.query;
    if (!gamertag) return res.status(400).json({ error: 'gamertag required' });
    const cached = await getFromCache(gamertag);
    if (!cached?.xuid) return res.status(404).json({ error: 'Player not in cache — search them first' });
    const playlists = await discoverPlaylists(cached.xuid, gamertag);
    res.json({ gamertag, playlists });
  } catch(e) {
    console.error('[discover-playlists]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Match history (paginated; perPage capped at 2000 so loadFullMatches can pull the whole set)
app.get('/api/matches', async (req, res) => {
  try {
    const { gamertag, page = 1, perPage = 100 } = req.query;
    if (!gamertag) return res.status(400).json({ error: 'gamertag required' });
    const cached = await getFromCache(gamertag);
    const source = cached?.allMatches || cached?.recentMatches || [];
    const ranked = req.query.ranked === '1';
    const all = source.filter(m => !ranked || m.isRanked);
    const pg = parseInt(page) || 1;
    const pp = Math.min(parseInt(perPage) || 100, 2000);
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
        const imgSuffix = p.slice('images:'.length);
        candidates.push(`https://gamecms-hacs.svc.halowaypoint.com/hi/Images/file/${imgSuffix}`);
        // Some paths have progression/Progression/ (double) — also try deduplicated and progression/file/
        candidates.push(`https://gamecms-hacs.svc.halowaypoint.com/hi/progression/file/${imgSuffix}`);
        const deduped = imgSuffix.replace(/^progression\/Progression\//i, 'progression/');
        if (deduped !== imgSuffix) candidates.push(`https://gamecms-hacs.svc.halowaypoint.com/hi/Images/file/${deduped}`);
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
      const r = await db.query('SELECT ts,gamertag,user_agent,cached,success,duration_ms FROM search_log ORDER BY ts DESC LIMIT 500');
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

// ── Feedback ──────────────────────────────────────────────────────────────────
app.post('/api/feedback', express.json(), async (req, res) => {
  const { type, message, email } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });
  if (!['feedback','contact'].includes(type)) return res.status(400).json({ error: 'type must be feedback or contact' });
  if (message.trim().length > 2000) return res.status(400).json({ error: 'message too long' });
  const entry = { ts: new Date().toISOString(), type, message: message.trim(), email: email?.trim()||null, user_agent: req.headers['user-agent']||null };
  _memFeedbackLog.push(entry);
  if (_memFeedbackLog.length > 500) _memFeedbackLog.shift();
  try {
    const db = await getDb();
    if (db) await db.query('INSERT INTO feedback_log (type,message,email,ip,user_agent) VALUES ($1,$2,$3,$4,$5)', [entry.type, entry.message, entry.email, null, entry.user_agent]);
  } catch(e) { console.error('[Feedback] DB error:', e.message); }
  console.log(`[Feedback] type=${type} email=${email||'—'} msg="${message.trim().slice(0,80)}"`);
  res.json({ success: true });
});

// ── Admin: cache status ───────────────────────────────────────────────────────
app.get('/api/admin/cache-status', (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== (process.env.ADMIN_PASS || 'changeme')) return res.status(401).send('Unauthorized');
  const entries = Object.entries(searchCache).map(([k, v]) => ({
    gamertag: v.data?.gamertag || k,
    cachedAt: new Date(v.fetchedAt).toISOString(),
    ageMinutes: Math.round((Date.now() - v.fetchedAt) / 60000),
    matchCount: (v.data?.allMatches || v.data?.recentMatches || []).length,
    rankedCount: (v.data?.allMatches || v.data?.recentMatches || []).filter(m => m.isRanked).length,
    hasCsrDelta: (v.data?.allMatches || v.data?.recentMatches || []).some(m => m.csrDelta != null),
  }));
  res.json({ count: entries.length, entries });
});

// ── Admin: clear player cache ─────────────────────────────────────────────────
app.post('/api/admin/clear-cache', express.json(), (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== (process.env.ADMIN_PASS || 'changeme')) return res.status(401).send('Unauthorized');
  const { gamertag } = req.body || {};
  if (gamertag) {
    const key = gamertag.toLowerCase().trim();
    const had = !!searchCache[key];
    delete searchCache[key];
    console.log(`[Admin] Cleared cache for: ${gamertag}`);
    return res.json({ success: true, cleared: had ? 1 : 0, gamertag });
  } else {
    const count = Object.keys(searchCache).length;
    for (const k of Object.keys(searchCache)) delete searchCache[k];
    console.log(`[Admin] Cleared all cache (${count} entries)`);
    return res.json({ success: true, cleared: count });
  }
});

// ── Admin: delete searches by gamertag ────────────────────────────────────────
app.post('/api/admin/delete-searches', express.json(), async (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== (process.env.ADMIN_PASS || 'changeme')) return res.status(401).send('Unauthorized');
  const { gamertags } = req.body || {};
  if (!Array.isArray(gamertags) || !gamertags.length) return res.status(400).json({ error: 'gamertags array required' });
  const lower = gamertags.map(g => g.toLowerCase());
  // Remove from in-memory log
  const before = _memSearchLog.length;
  for (let i = _memSearchLog.length - 1; i >= 0; i--) {
    if (lower.includes(_memSearchLog[i].gamertag.toLowerCase())) _memSearchLog.splice(i, 1);
  }
  // Remove from DB
  let dbDeleted = 0;
  try {
    const db = await getDb();
    if (db) {
      const r = await db.query(
        `DELETE FROM search_log WHERE LOWER(gamertag) = ANY($1::text[])`,
        [lower]
      );
      dbDeleted = r.rowCount || 0;
    }
  } catch(e) { console.error('[Admin] delete-searches DB error:', e.message); }
  console.log(`[Admin] Deleted searches for: ${gamertags.join(', ')} — mem: ${before - _memSearchLog.length}, db: ${dbDeleted}`);
  res.json({ success: true, memRemoved: before - _memSearchLog.length, dbRemoved: dbDeleted });
});

app.get('/api/admin/feedback', async (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== (process.env.ADMIN_PASS || 'changeme')) return res.status(401).send('Unauthorized');
  try {
    const db = await getDb();
    if (db) {
      const r = await db.query('SELECT id,ts,type,message,email FROM feedback_log ORDER BY ts DESC LIMIT 200');
      return res.json(r.rows);
    }
    res.json(_memFeedbackLog.slice().reverse());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/// ── Admin: pro player management ─────────────────────────────────────────────
app.get('/api/admin/pro-players', async (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== (process.env.ADMIN_PASS || 'changeme')) return res.status(401).json({ error: 'Unauthorized' });
  try { res.json(await getProPlayers()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/pro-players', express.json(), async (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== (process.env.ADMIN_PASS || 'changeme')) return res.status(401).json({ error: 'Unauthorized' });
  const { gamertag, label } = req.body || {};
  if (!gamertag) return res.status(400).json({ error: 'gamertag required' });
  try {
    // 1. Check in-memory cache
    const cached = await getFromCache(gamertag);
    let xuid = cached && cached.xuid;
    let canonicalGt = (cached && cached.gamertag) || gamertag;
    // 2. Try snapshot table
    if (!xuid) {
      const db = await getXuidDb();
      if (db) {
        const r = await db.query('SELECT xuid, gamertag FROM player_snapshots WHERE LOWER(gamertag)=LOWER($1) LIMIT 1', [gamertag]);
        if (r.rows.length) { xuid = r.rows[0].xuid; canonicalGt = r.rows[0].gamertag || gamertag; }
      }
    }
    // 3. Auto-lookup via Halo API — no pre-search required
    if (!xuid) {
      console.log(`[Admin/addPro] XUID not cached for "${gamertag}" — fetching from Halo API`);
      const stats = await fetchPlayerStats(gamertag);
      if (stats && stats.xuid) { xuid = stats.xuid; canonicalGt = stats.gamertag || gamertag; }
    }
    if (!xuid) return res.status(404).json({ error: `Could not resolve XUID for "${gamertag}" — check the gamertag spelling.` });
    await addProPlayer(xuid, canonicalGt, label || null);
    res.json({ success: true, xuid, gamertag: canonicalGt, autoFetched: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: refresh all pro snapshots ──────────────────────────────────────────
// Fetches fresh match history for every tracked pro and saves their snapshot.
// Runs sequentially with a 3s gap between players to avoid hammering the API.
// Returns immediately with { queued: n } — progress is visible via loadProPlayers().
app.post('/api/admin/refresh-pros', async (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== (process.env.ADMIN_PASS || 'changeme')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const pros = await getProPlayers();
    if (!pros.length) return res.json({ queued: 0 });
    res.json({ queued: pros.length });
    // Fire and forget — runs after response is sent
    (async () => {
      const PVE     = ['firefight','gruntpocalypse','attrition','pve'];
      const BAD_MAPS= ['launch site','yuletide','octagon','aimbotz'];
      // Minimum thresholds for a valid pro snapshot.
      // Below these = wrong account, inactive, smurf, or bad data — skip snapshot save.
      const MIN_RANKED_MATCHES = 10;  // need at least 10 ranked games to be useful
      const MIN_KD             = 0.7; // below 0.7 K/D is not pro-level, likely wrong account
      const MIN_ACCURACY       = 28;  // below 28% accuracy is unreliable / non-competitive
      const MIN_AVG_KILLS      = 5;   // below 5 avg kills per game is a data red flag

      for (const pro of pros) {
        try {
          console.log(`[Admin/refreshPros] Fetching ${pro.gamertag}…`);
          const playerStats = await fetchPlayerStats(pro.gamertag);
          const histData    = await fetchMatchHistory(playerStats.xuid, pro.gamertag, 100, () => {});
          const matches = (histData.matches || []).filter(m => {
            if (m.isCustom) return false;
            if (m.gameMode && PVE.some(p => m.gameMode.toLowerCase().includes(p))) return false;
            if (m.mapName  && BAD_MAPS.some(p => m.mapName.toLowerCase().includes(p))) return false;
            return true;
          }).slice(0, 100);

          // ── Validate data quality before saving snapshot ──────────────────
          const rankedMs = matches.filter(m => m.isRanked && (m.outcome===2||m.outcome===3) && m.kills!=null);
          if (rankedMs.length < MIN_RANKED_MATCHES) {
            console.warn(`[Admin/refreshPros] ⚠ SKIP ${pro.gamertag} — only ${rankedMs.length} ranked matches (need ${MIN_RANKED_MATCHES}). Player may be inactive or gamertag may have changed.`);
            await saveToCache(pro.gamertag, { ...playerStats, recentMatches: matches, allMatches: matches });
            await new Promise(r => setTimeout(r, 3000)); continue;
          }

          // Compute quick inline stats from ranked matches to sanity-check
          const totK  = rankedMs.reduce((s,m) => s+(m.kills||0), 0);
          const totD  = rankedMs.reduce((s,m) => s+(m.deaths||0), 1); // floor at 1
          const totW  = rankedMs.filter(m => m.outcome===2).length;
          const accMs = rankedMs.filter(m => m.shotsHit!=null && m.shotsFired>0);
          const kd    = totK / totD;
          const winPct= totW / rankedMs.length * 100;
          const acc   = accMs.length ? accMs.reduce((s,m) => s+m.shotsHit/m.shotsFired*100, 0)/accMs.length : null;
          const avgK  = totK / rankedMs.length;

          const flags = [];
          if (kd     < MIN_KD)          flags.push(`K/D ${kd.toFixed(2)} < ${MIN_KD}`);
          if (acc!=null && acc < MIN_ACCURACY) flags.push(`acc ${acc.toFixed(1)}% < ${MIN_ACCURACY}%`);
          if (avgK   < MIN_AVG_KILLS)   flags.push(`avg kills ${avgK.toFixed(1)} < ${MIN_AVG_KILLS}`);

          if (flags.length) {
            console.warn(`[Admin/refreshPros] ⚠ SKIP ${pro.gamertag} — stats below pro threshold: ${flags.join(', ')}. Check gamertag or account activity.`);
            // Cache the fetch so we don't re-hit the API, but don't save to snapshot pool
            await saveToCache(pro.gamertag, { ...playerStats, recentMatches: matches, allMatches: matches });
            await new Promise(r => setTimeout(r, 3000)); continue;
          }

          // Borderline warning — save but flag it
          const warnings = [];
          if (kd     < 1.0)  warnings.push(`K/D ${kd.toFixed(2)} (below 1.0 — low for pro)`);
          if (winPct < 45)   warnings.push(`win rate ${winPct.toFixed(0)}% (below 45%)`);
          if (acc!=null && acc < 40) warnings.push(`accuracy ${acc.toFixed(1)}% (below 40%)`);
          if (warnings.length) {
            console.warn(`[Admin/refreshPros] ⚠ WARN ${pro.gamertag} — borderline stats (saving anyway): ${warnings.join(', ')}`);
          }

          const result = { ...playerStats, recentMatches: matches, allMatches: matches };
          await savePlayerSnapshot(result);
          await saveToCache(pro.gamertag, result);
          console.log(`[Admin/refreshPros] ✓ ${pro.gamertag} — ${rankedMs.length} ranked games · K/D ${kd.toFixed(2)} · acc ${acc!=null?acc.toFixed(1)+'%':'n/a'}`);
        } catch(e) {
          console.warn(`[Admin/refreshPros] ✗ ${pro.gamertag} — ${e.message}`);
        }
        // 3-second gap between players to respect API rate limits
        await new Promise(r => setTimeout(r, 3000));
      }
      console.log('[Admin/refreshPros] All pros refreshed.');
    })();
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/pro-players', express.json(), async (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== (process.env.ADMIN_PASS || 'changeme')) return res.status(401).json({ error: 'Unauthorized' });
  const { xuid } = req.body || {};
  if (!xuid) return res.status(400).json({ error: 'xuid required' });
  try { await removeProPlayer(xuid); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: search log UI ──────────────────────────────────────────────────────
app.get('/api/admin', (req, res) => {
  const pass = req.query.pass || '';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';
  if (pass !== ADMIN_PASS) {
    return res.send(`<!DOCTYPE html><html><body style="font-family:monospace;background:#0a0f1a;color:#ccc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><form method="get"><input name="pass" type="password" placeholder="Password" style="padding:8px;background:#1a2035;border:1px solid #333;color:#fff;border-radius:4px;margin-right:8px"><button type="submit" style="padding:8px 16px;background:#00d4ff;color:#000;border:none;border-radius:4px;cursor:pointer">Enter</button></form></body></html>`);
  }
  res.send(`<!DOCTYPE html><html><head><title>fragr // analytics</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font-family:Share Tech Mono,monospace;background:#0a0f1a;color:#ccc;margin:0;padding:16px;box-sizing:border-box}h1,h2{color:#00d4ff;letter-spacing:2px;text-transform:uppercase}h1{font-size:16px;margin-bottom:20px}h2{font-size:11px;margin:24px 0 10px}.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-bottom:24px}table{width:100%;border-collapse:collapse;font-size:12px;min-width:500px}th{text-align:left;color:#666;padding:6px 10px;border-bottom:1px solid #1a2035;font-size:10px;letter-spacing:1px}td{padding:6px 10px;border-bottom:1px solid #111}tr:hover td{background:#0d1425}.win{color:#4caf50}.loss{color:#f44336}.muted{color:#555}.gold{color:#ffc107}.summary{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}.stat{background:#0d1425;padding:10px 14px;border-radius:6px;border:1px solid #1a2035;min-width:80px}.stat-val{font-size:24px;font-weight:700;color:#00d4ff;line-height:1;word-break:break-all}.stat-lbl{font-size:9px;color:#555;margin-top:4px}#filter{background:#0d1425;border:1px solid #1a2035;color:#fff;padding:6px 12px;border-radius:4px;font-family:inherit;margin-bottom:12px;width:100%;max-width:220px;box-sizing:border-box}.bar-wrap{background:#0d1425;border-radius:3px;height:6px;width:60px;display:inline-block;vertical-align:middle;margin-left:8px}.bar{background:#00d4ff;height:6px;border-radius:3px}.ua-pill{font-size:9px;padding:2px 6px;border-radius:10px;background:#1a2035;color:#888}.del-btn{background:transparent;border:none;color:#333;cursor:pointer;font-size:12px;padding:2px 6px;border-radius:3px;transition:color 0.15s}.del-btn:hover{color:#f44336}.action-btn{background:#0d1425;border:1px solid #1a2035;color:#00d4ff;cursor:pointer;font-size:11px;padding:4px 10px;border-radius:4px;font-family:inherit;transition:all 0.15s}.action-btn:hover{background:#1a2035;border-color:#00d4ff}.action-btn.danger{color:#f44336;border-color:#1a2035}.action-btn.danger:hover{background:#1a0d0d;border-color:#f44336}.action-btn.warn{color:#ffc107;border-color:#1a2035}.action-btn.warn:hover{background:#1a1500;border-color:#ffc107}.action-row{display:flex;gap:8px;align-items:center;margin-bottom:16px;flex-wrap:wrap}.token-ok{color:#4caf50}.token-err{color:#f44336}</style></head>
  <body><h1>// fragr analytics</h1>
  <div class="action-row">
    <button class="action-btn warn" onclick="checkToken()">check token</button>
    <button class="action-btn warn" onclick="forceRefreshToken()" id="force-token-btn">↻ refresh token</button>
    <button class="action-btn danger" onclick="clearAllCache()">clear all cache</button>
    <button class="action-btn" onclick="loadCache()">refresh cache view</button>
    <a href="/calibrate?key=${CAL_KEY}" target="_blank" class="action-btn" style="text-decoration:none">aim calibration ↗</a>
    <span id="token-status" style="font-size:11px;color:#555"></span>
  </div>
  <h2>// playlist discovery</h2>
  <div class="action-row">
    <input id="disc-gt" placeholder="Gamertag..." style="background:#0d1425;border:1px solid #1a2035;color:#fff;padding:6px 12px;border-radius:4px;font-family:inherit;width:220px;box-sizing:border-box">
    <button class="action-btn" onclick="discoverPlaylists()">scan recent matches</button>
    <span style="font-size:10px;color:#555">finds playlist IDs from last 25 matches — use to get Ranked Legacy/Doubles IDs</span>
  </div>
  <div id="disc-result" style="font-size:11px;margin-bottom:24px;display:none">
    <table style="width:auto;font-size:11px"><thead><tr><th>PLAYLIST ID</th><th>NAME</th><th>EXP</th><th>MATCHES (of 25)</th></tr></thead><tbody id="disc-tbody"></tbody></table>
  </div>
  <h2>// pro players <span style="color:#555;font-size:9px;font-weight:normal">— used as benchmark reference in rank comparison</span></h2>
  <div class="action-row">
    <input id="pro-gt" placeholder="Gamertag..." style="background:#0d1425;border:1px solid #1a2035;color:#fff;padding:6px 12px;border-radius:4px;font-family:inherit;width:180px;box-sizing:border-box">
    <input id="pro-label" placeholder="Label (optional, e.g. OpTic Snakebite)" style="background:#0d1425;border:1px solid #1a2035;color:#fff;padding:6px 12px;border-radius:4px;font-family:inherit;width:260px;box-sizing:border-box">
    <button class="action-btn" onclick="addPro()">add pro</button>
    <button class="action-btn" onclick="seedPros()" id="seed-pros-btn">＋ seed known pros</button>
    <button class="action-btn warn" onclick="refreshAllPros()" id="refresh-pros-btn">↻ refresh all stats</button>
    <span id="pro-msg" style="font-size:10px;color:#555"></span>
  </div>
  <div id="pro-panel" style="font-size:11px;margin-bottom:24px">Loading...</div>
  <div class="summary" id="summary">Loading...</div>
  <h2>// active cache</h2>
  <div id="cache-panel" style="font-size:11px;color:#555;margin-bottom:16px">Loading...</div>
  <h2>// feedback &amp; contact</h2>
  <div class="table-wrap"><table><thead><tr><th>TIME</th><th>TYPE</th><th>EMAIL</th><th>MESSAGE</th></tr></thead><tbody id="fbtbody"><tr><td colspan="4" class="muted">Loading...</td></tr></tbody></table></div>
  <h2>// tab engagement</h2>
  <div class="table-wrap"><table><thead><tr><th>TAB</th><th>VISITS</th><th>AVG TIME</th><th>TOTAL TIME</th></tr></thead><tbody id="tabtbody"></tbody></table></div>
  <h2>// recent searches</h2>
  <div class="action-row" style="margin-bottom:8px">
    <input id="filter" placeholder="Filter gamertag..." oninput="filterRows()">
    <button class="action-btn" onclick="refreshPlayer()">force refresh player</button>
  </div>
  <div class="table-wrap"><table><thead><tr><th>TIME</th><th>GAMERTAG</th><th>DEVICE</th><th>CACHED</th><th>DURATION</th><th>STATUS</th><th></th></tr></thead><tbody id="tbody"></tbody></table></div>
  <script>
  var allRows=[];
  function ua2device(ua){if(!ua)return'<span class="ua-pill">?</span>';var u=ua.toLowerCase();if(/iphone/.test(u))return'<span class="ua-pill" style="color:#4caf50">iPhone</span>';if(/ipad/.test(u))return'<span class="ua-pill" style="color:#2196f3">iPad</span>';if(/android/.test(u))return'<span class="ua-pill" style="color:#ff9800">Android</span>';if(/mac/.test(u))return'<span class="ua-pill" style="color:#9c27b0">Mac</span>';if(/windows/.test(u))return'<span class="ua-pill" style="color:#00bcd4">Windows</span>';return'<span class="ua-pill">desktop</span>';}
  function fmtSec(s){if(!s)return'--';var n=parseFloat(s);return n>=60?(n/60).toFixed(1)+'m':n+'s';}
  function fmtMins(m){if(!m)return'--';var n=parseFloat(m);if(n<60)return Math.round(n)+'m';var h=Math.floor(n/60),rm=Math.round(n%60);return h+'h '+(rm?rm+'m':'');}

  function checkToken(){
    var el=document.getElementById('token-status');
    el.className='';el.textContent='testing live API…';
    // First check env vars, then do a live Halo API call to confirm auth actually works
    fetch('/api/token-status').then(function(r){return r.json();}).then(function(d){
      if(!d.hasToken){el.className='token-err';el.textContent='NO SPARTAN_TOKEN SET';return;}
      el.textContent='token set ('+d.tokenPreview+') — testing live call…';
      return fetch('/api/admin/test-api?pass=${pass}').then(function(r){return r.json();}).then(function(t){
        if(t.ok){el.className='token-ok';el.textContent='✓ '+t.message+(d.hasRefreshToken?' · refresh token ok':'');}
        else{el.className='token-err';el.textContent='✗ '+t.message;}
      });
    }).catch(function(){el.className='token-err';el.textContent='check failed';});
  }

  function forceRefreshToken(){
    var btn=document.getElementById('force-token-btn');
    var el=document.getElementById('token-status');
    btn.disabled=true;btn.textContent='refreshing…';
    el.className='';el.textContent='requesting new Spartan token…';
    fetch('/api/admin/refresh-token?pass=${pass}',{method:'POST'})
      .then(function(r){return r.json();})
      .then(function(d){
        btn.disabled=false;btn.textContent='↻ refresh token';
        if(d.ok){el.className='token-ok';el.textContent='✓ '+d.message+' — token live';}
        else{el.className='token-err';el.textContent='✗ '+(d.error||'refresh failed');}
      })
      .catch(function(e){btn.disabled=false;btn.textContent='↻ refresh token';el.className='token-err';el.textContent='✗ '+e.message;});
  }

  // Pre-flight: test the Halo API before any bulk operation that would waste time on a dead token.
  // Returns a Promise that resolves to true if ok, or rejects with a user-friendly message.
  function preflightApi(){
    return fetch('/api/admin/test-api?pass=${pass}')
      .then(function(r){return r.json();})
      .then(function(d){
        if(!d.ok) throw new Error(d.message||'Halo API auth failed');
        return true;
      });
  }

  function clearAllCache(){
    if(!confirm('Clear ALL cached player data? All next searches will be fresh fetches.'))return;
    fetch('/api/admin/clear-cache?pass=${pass}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})})
      .then(function(r){return r.json();})
      .then(function(d){alert('Cleared '+d.cleared+' cached entries.');loadCache();})
      .catch(function(e){alert('Error: '+e.message);});
  }

  function clearPlayerCache(gt){
    fetch('/api/admin/clear-cache?pass=${pass}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gamertag:gt})})
      .then(function(r){return r.json();})
      .then(function(d){
        if(d.success){loadCache();}
        else alert('Error clearing cache');
      }).catch(function(e){alert('Error: '+e.message);});
  }

  function refreshPlayer(){
    var q=document.getElementById('filter').value.trim()||prompt('Gamertag to force-refresh:');
    if(!q)return;
    clearPlayerCache(q);
    setTimeout(function(){
      window.open('/?player='+encodeURIComponent(q),'_blank');
    },300);
  }

  function discoverPlaylists(){
    var gt=(document.getElementById('disc-gt').value||'').trim();
    if(!gt){alert('Enter a gamertag first');return;}
    var resultDiv=document.getElementById('disc-result');
    var tbody=document.getElementById('disc-tbody');
    tbody.innerHTML='<tr><td colspan="4" class="muted">scanning…</td></tr>';
    resultDiv.style.display='block';
    fetch('/api/discover-playlists?gamertag='+encodeURIComponent(gt))
      .then(function(r){return r.json();})
      .then(function(d){
        if(d.error){tbody.innerHTML='<tr><td colspan="4" style="color:#f44336">'+d.error+'</td></tr>';return;}
        var rows=d.playlists||[];
        if(!rows.length){tbody.innerHTML='<tr><td colspan="4" class="muted">no playlists found</td></tr>';return;}
        tbody.innerHTML=rows.map(function(p){
          var known=['edfef3ac-9cbe-4fa2-b949-8f29deafd483','f5580605-660c-43f9-ac69-4075c4a05c5d','dcb2e24e-05fb-4390-8076-32a0cdb4326e'];
          var isNew=known.indexOf(p.id)===-1;
          return'<tr>'
            +'<td style="font-family:monospace;color:'+(isNew?'#ffc107':'#555')+'">'+p.id+(isNew?' ★':'')+'</td>'
            +'<td style="color:'+(isNew?'#00d4ff':'#ccc')+'">'+p.name+'</td>'
            +'<td class="muted">'+p.exp+'</td>'
            +'<td>'+p.count+'</td>'
            +'</tr>';
        }).join('');
      })
      .catch(function(e){tbody.innerHTML='<tr><td colspan="4" style="color:#f44336">'+e.message+'</td></tr>';});
  }

  function loadProPlayers(){
    var el=document.getElementById('pro-panel');
    el.innerHTML='<span class="muted">loading...</span>';
    fetch('/api/admin/pro-players?pass=${pass}')
      .then(function(r){return r.json();})
      .then(function(rows){
        if(!rows.length){el.innerHTML='<span class="muted">no pro players added yet</span>';return;}
        var now=Date.now();
        var html='<table style="width:auto;font-size:11px"><thead><tr>'
          +'<th>GAMERTAG</th><th>LABEL</th><th>RANK</th>'
          +'<th>K/D</th><th>WIN%</th><th>ACC%</th><th>K/G</th>'
          +'<th>QUALITY</th><th>LAST SEARCHED</th><th>ADDED</th><th></th>'
          +'</tr></thead><tbody>';
        var unsearched=[];
        rows.forEach(function(p){
          var rank=p.csr_tier?(p.csr_tier+(p.csr_value?' '+p.csr_value:'')):'—';
          var added=p.added_at?new Date(p.added_at).toLocaleDateString():'';
          var noSnap=p.kd==null;
          var lastSearched='—';
          var staleCell='';
          if(p.last_snapshot){
            var days=Math.floor((now-new Date(p.last_snapshot))/86400000);
            lastSearched=days===0?'today':days===1?'yesterday':days+'d ago';
            if(days>7) staleCell=' style="color:#ffc107"';
          } else {
            lastSearched='<span style="color:#f44336">never searched</span>';
            unsearched.push(p.gamertag);
          }
          // Flag rows whose stats are below the pro-quality threshold used in getProStats()
          // These snapshots are excluded from the benchmark aggregate — surface that here.
          var qualityFlags=[];
          if(p.kd!=null&&parseFloat(p.kd)<0.7)   qualityFlags.push('K/D '+parseFloat(p.kd).toFixed(2)+' < 0.7');
          if(p.avg_kills!=null&&parseFloat(p.avg_kills)<5) qualityFlags.push('avg kills '+parseFloat(p.avg_kills).toFixed(1)+' < 5');
          if(p.accuracy!=null&&parseFloat(p.accuracy)<28)  qualityFlags.push('acc '+parseFloat(p.accuracy).toFixed(1)+'% < 28%');
          var isBorderline=p.kd!=null&&(parseFloat(p.kd)<1.0||(p.win_rate!=null&&parseFloat(p.win_rate)<45)||(p.accuracy!=null&&parseFloat(p.accuracy)<40));
          var rowStyle=qualityFlags.length?'background:rgba(244,67,54,0.07)':noSnap?'opacity:0.6':'';
          html+='<tr style="'+rowStyle+'">'
            +'<td style="color:#00d4ff">'+p.gamertag+'</td>'
            +'<td style="color:#ffc107">'+(p.label||'—')+'</td>'
            +'<td class="muted">'+rank+'</td>'
            +'<td>'+(p.kd!=null?parseFloat(p.kd).toFixed(2):'<span style="color:#555">no data</span>')+'</td>'
            +'<td>'+(p.win_rate!=null?parseFloat(p.win_rate).toFixed(1)+'%':'—')+'</td>'
            +'<td>'+(p.accuracy!=null?parseFloat(p.accuracy).toFixed(1)+'%':'—')+'</td>'
            +'<td>'+(p.avg_kills!=null?parseFloat(p.avg_kills).toFixed(1):'—')+'</td>'
            +'<td>'+(qualityFlags.length
              ? '<span style="color:#f44336" title="Excluded from pro aggregate: '+qualityFlags.join(', ')+'">✗ excluded</span>'
              : isBorderline && p.kd!=null
                ? '<span style="color:#ffc107" title="Saved but borderline — check logs">⚠ borderline</span>'
                : p.kd!=null ? '<span style="color:#4caf50">✓ ok</span>' : '<span style="color:#555">—</span>')+'</td>'
            +'<td'+staleCell+'>'+lastSearched+'</td>'
            +'<td class="muted">'+added+'</td>'
            +'<td><button class="action-btn danger" style="font-size:10px;padding:2px 7px" data-pro-xuid="'+p.xuid+'" data-pro-gt="'+p.gamertag.replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'">remove</button></td>'
            +'</tr>';
        });
        html+='</tbody></table>';
        if(unsearched.length){
          html+='<div style="margin-top:10px;font-size:10px;color:#f44336">⚠ '+unsearched.length+' pro'+(unsearched.length>1?'s':'')+' never searched — search on fragr to populate their stats: '+unsearched.join(', ')+'</div>';
        }
        el.innerHTML=html;
      })
      .catch(function(e){el.innerHTML='<span class="muted">error: '+e.message+'</span>';});
  }

  function addPro(){
    var gt=(document.getElementById('pro-gt').value||'').trim();
    var label=(document.getElementById('pro-label').value||'').trim();
    var msg=document.getElementById('pro-msg');
    if(!gt){msg.style.color='#f44336';msg.textContent='enter a gamertag';return;}
    msg.style.color='#555';msg.textContent='adding...';
    fetch('/api/admin/pro-players?pass=${pass}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gamertag:gt,label:label||null})})
      .then(function(r){return r.json();})
      .then(function(d){
        if(d.success){
          msg.style.color='#4caf50';msg.textContent=d.gamertag+' added';
          document.getElementById('pro-gt').value='';document.getElementById('pro-label').value='';
          loadProPlayers();
        } else {
          msg.style.color='#f44336';msg.textContent=d.error||'error';
        }
      })
      .catch(function(e){msg.style.color='#f44336';msg.textContent=e.message;});
  }

  function removePro(xuid,gt){
    if(!confirm('Remove '+gt+' from pro players?'))return;
    fetch('/api/admin/pro-players?pass=${pass}',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({xuid:xuid})})
      .then(function(r){return r.json();})
      .then(function(d){if(d.success)loadProPlayers();else alert('Error: '+(d.error||'unknown'));})
      .catch(function(e){alert('Error: '+e.message);});
  }

  // Known HCS/competitive pros — gamertag → label
  var KNOWN_PROS=[
    {gt:'Fragxr Stark',    label:'HCS Pro'},
    {gt:'bubu dubu',       label:'HCS Pro'},
    {gt:'RyaNoob Nerds',   label:'HCS Pro'},
    {gt:'Royal 2',         label:'HCS Pro'},
    {gt:'pznguin',         label:'HCS Pro'},
    {gt:'Falcated',        label:'HCS Pro'},
    {gt:'Bound',           label:'HCS Pro'},
    {gt:'MQSE',            label:'HCS Pro'},
    {gt:'The Eco Smith',   label:'HCS Pro'},
    {gt:'Tapping Buttons', label:'HCS Pro'},
    {gt:'r Sica',          label:'HCS Pro'},
    {gt:'SLGzz',           label:'HCS Pro'},
    {gt:'Trippy',          label:'HCS Pro'},
    {gt:'Noblc',           label:'HCS Pro'},
    {gt:'Rorzch',          label:'HCS Pro'},
    {gt:'KingJay JSDescendant', label:'HCS Pro'},
    {gt:'Druk RN',         label:'HCS Pro'},
    {gt:'Mr Soul Snipe',   label:'HCS Pro'},
    {gt:'Taulek',          label:'HCS Pro'},
    {gt:'Envore',          label:'HCS Pro'},
    {gt:'Suppressecl',     label:'HCS Pro'},
    {gt:'Strikeyy',        label:'HCS Pro'},
    {gt:'Barcode AK',      label:'HCS Pro'},
    {gt:'Piggy EX',        label:'HCS Pro'},
    {gt:'leuor',           label:'HCS Pro'},
    {gt:'Preecisionn',     label:'HCS Pro'},
    {gt:'Swayz',           label:'HCS Pro'},
    {gt:'yakzn',           label:'HCS Pro'},
    {gt:'Cearion',         label:'HCS Pro'},
    {gt:'Scoobmeistr',     label:'HCS Pro'},
    {gt:'svspector',       label:'HCS Pro'},
    {gt:'flubs',           label:'HCS Pro'},
    {gt:'aPG',             label:'HCS Pro'},
    {gt:'l3astosS',        label:'HCS Pro'},
    {gt:'FR IceKid',       label:'HCS Pro'},
    {gt:'Zovay',           label:'HCS Pro'},
    {gt:'wryceDOTexe',     label:'HCS Pro'},
    {gt:'Knuqkles',        label:'HCS Pro'},
    {gt:'Wutum',           label:'HCS Pro'},
    {gt:'rrayni',          label:'HCS Pro'},
    {gt:'Kamp',            label:'HCS Pro'},
    {gt:'kaos clx',        label:'HCS Pro'},
    {gt:'Guwmy',           label:'HCS Pro'},
    {gt:'Ryscu',           label:'HCS Pro'},
    {gt:'Mop2Clutch',      label:'HCS Pro'},
    {gt:'jezkko',          label:'HCS Pro'},
    {gt:'Dysectorr',       label:'HCS Pro'},
    {gt:'ObnoxiuzZ',       label:'HCS Pro'},
    {gt:'Little gatorz',   label:'HCS Pro'},
    {gt:'Fate ZD',         label:'HCS Pro'},
    {gt:'Bandamonium',     label:'HCS Pro'},
    {gt:'Perzecute',       label:'HCS Pro'},
    {gt:'JaggedCloud',     label:'HCS Pro'},
    {gt:'k3llz',           label:'HCS Pro'},
    {gt:'Frenzydxm',       label:'HCS Pro'},
    {gt:'IamsarEX',        label:'HCS Pro'},
    {gt:'MOUSECOP07',      label:'HCS Pro'},
    {gt:'iiBez',           label:'HCS Pro'},
    {gt:'Merkin 50z',      label:'HCS Pro'},
    {gt:'Whsspprr',        label:'HCS Pro'},
    {gt:'PROJECTROCK',     label:'HCS Pro'},
    {gt:'CKsned',          label:'HCS Pro'},
    {gt:'StonedJourner',   label:'HCS Pro'},
    {gt:'AJAY5120',        label:'HCS Pro'},
    {gt:'Mighty XL2546',   label:'HCS Pro'},
    {gt:'Pinchy',          label:'HCS Pro'},
    {gt:'Dxnt Jxmp',       label:'HCS Pro'},
    {gt:'PYRO092',         label:'HCS Pro'},
    {gt:'the suspcnse',    label:'HCS Pro'},
    {gt:'iTF JFive',       label:'HCS Pro'},
    {gt:'pitBvll x',       label:'HCS Pro'},
    {gt:'JonnySwalsh',     label:'HCS Pro'},
    {gt:'Snqga',           label:'HCS Pro'},
    {gt:'RaneWater',       label:'HCS Pro'},
    {gt:'Rebel1152',       label:'HCS Pro'},
    {gt:'tomjpr',          label:'HCS Pro'},
    {gt:'not Pr0M',        label:'HCS Pro'},
    {gt:'Infiini',         label:'HCS Pro'},
    {gt:'Fennvc',          label:'HCS Pro'},
    {gt:'Sune',            label:'HCS Pro'},
    {gt:'Mapogo Nono',     label:'HCS Pro'},
    {gt:'I Buddaah I',     label:'HCS Pro'},
    {gt:'Uleashedude',     label:'HCS Pro'},
    {gt:'MisTer Baldo',    label:'HCS Pro'},
    {gt:'i7948',           label:'HCS Pro'},
    {gt:'RQMPAGE JT',      label:'HCS Pro'},
    {gt:'Mifoushi',        label:'HCS Pro'},
    {gt:'Audacity AQ',     label:'HCS Pro'},
    {gt:'Constences',      label:'HCS Pro'},
    {gt:'Meatsyyy',        label:'HCS Pro'},
    {gt:'Jyon 001',        label:'HCS Pro'},
    {gt:'FiDG3TZ',         label:'HCS Pro'},
    {gt:'Frcnzied',        label:'HCS Pro'},
    {gt:'zJayoo',          label:'HCS Pro'},
    {gt:'BBuffed',         label:'HCS Pro'},
    {gt:'TasteyFluff',     label:'HCS Pro'},
    {gt:'uPenguinu',       label:'HCS Pro'},
    {gt:'being03',         label:'HCS Pro'},
    {gt:'Tuckze',          label:'HCS Pro'},
    {gt:'Elamite',         label:'HCS Pro'},
    {gt:'Spetter',         label:'HCS Pro'},
    {gt:'UHL Wxsh',        label:'HCS Pro'},
    {gt:'Mjonir',          label:'HCS Pro'},
    {gt:'sNeilk',          label:'HCS Pro'},
    {gt:'CrazyMiller',     label:'HCS Pro'},
    {gt:'Awake HCS',       label:'HCS Pro'},
    {gt:'Nebvlx',          label:'HCS Pro'},
    {gt:'Cruvu',           label:'HCS Pro'},
    {gt:'Euzey',           label:'HCS Pro'},
    {gt:'Morgans6744',     label:'HCS Pro'},
    {gt:'YNOT B RECKLESS', label:'HCS Pro'},
    {gt:'Avucy',           label:'HCS Pro'},
    {gt:'Xuzeyy',          label:'HCS Pro'},
  ];

  function seedPros(){
    var btn=document.getElementById('seed-pros-btn');
    var msg=document.getElementById('pro-msg');
    if(!confirm('Add '+KNOWN_PROS.length+' known HCS pros? Any already tracked will be skipped.'))return;
    btn.disabled=true;btn.textContent='checking API…';
    msg.style.color='#ffc107';msg.textContent='testing Halo API before starting…';
    preflightApi().then(function(){
      _doSeedPros(btn,msg);
    }).catch(function(e){
      btn.disabled=false;btn.textContent='＋ seed known pros';
      msg.style.color='#f44336';msg.textContent='✗ Cannot seed — '+e.message+'. Use "check token" button to diagnose.';
    });
  }

  function _doSeedPros(btn,msg){
    btn.textContent='adding…';
    msg.style.color='#ffc107';msg.textContent='adding pros one by one (auto-fetching XUIDs)…';
    var added=0,failed=[];
    function next(i){
      if(i>=KNOWN_PROS.length){
        btn.disabled=false;btn.textContent='＋ seed known pros';
        msg.style.color=failed.length?'#ffc107':'#4caf50';
        msg.textContent='Done — '+added+' added'+(failed.length?' · failed: '+failed.join(', '):'');
        loadProPlayers();
        return;
      }
      var p=KNOWN_PROS[i];
      fetch('/api/admin/pro-players?pass=${pass}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gamertag:p.gt,label:p.label})})
        .then(function(r){return r.json();})
        .then(function(d){
          if(d.success){added++;}else{failed.push(p.gt+'('+d.error+')');}
          msg.textContent='('+(i+1)+'/'+KNOWN_PROS.length+') '+p.gt+(d.success?' ✓':' ✗');
          setTimeout(function(){next(i+1);},1500); // 1.5s between adds to not spam the Halo API
        })
        .catch(function(){failed.push(p.gt);setTimeout(function(){next(i+1);},1500);});
    }
    next(0);
  } // end _doSeedPros

  function refreshAllPros(){
    var btn=document.getElementById('refresh-pros-btn');
    var msg=document.getElementById('pro-msg');
    btn.disabled=true;btn.textContent='checking API…';
    msg.style.color='#ffc107';msg.textContent='testing Halo API before starting…';
    preflightApi().then(function(){
      btn.textContent='refreshing…';
      msg.textContent='fetching fresh stats for all pros — this takes ~3s per player, runs in background';
      return fetch('/api/admin/refresh-pros?pass=${pass}',{method:'POST'});
    }).then(function(r){return r.json();})
    .then(function(d){
      if(d.error){msg.style.color='#f44336';msg.textContent='Error: '+d.error;btn.disabled=false;btn.textContent='↻ refresh all stats';return;}
      msg.style.color='#ffc107';msg.textContent='Queued '+d.queued+' pros — stats will update over the next ~'+(d.queued*3)+'s. Reload the table to see progress.';
      var polls=0,maxPolls=Math.ceil(d.queued*3/10)+3;
      var iv=setInterval(function(){
        loadProPlayers();polls++;
        if(polls>=maxPolls){clearInterval(iv);btn.disabled=false;btn.textContent='↻ refresh all stats';msg.textContent='Refresh complete.';}
      },10000);
    })
    .catch(function(e){msg.style.color='#f44336';msg.textContent='✗ '+e.message+'. Use "check token" to diagnose.';btn.disabled=false;btn.textContent='↻ refresh all stats';});
  }

  function loadCache(){
    fetch('/api/admin/cache-status?pass=${pass}').then(function(r){return r.json();}).then(function(d){
      var el=document.getElementById('cache-panel');
      if(!d.count){el.innerHTML='<span class="muted">no cached players</span>';return;}
      el.innerHTML='<table style="font-size:11px;width:auto;margin-bottom:0"><thead><tr><th>GAMERTAG</th><th>AGE</th><th>MATCHES</th><th>RANKED</th><th>CSR DELTA</th><th></th></tr></thead><tbody>'
        +d.entries.map(function(e){
          var age=e.ageMinutes<1?'&lt;1m':(e.ageMinutes+'m');
          var csrMark=e.hasCsrDelta?'<span class="win">yes</span>':'<span class="loss">no</span>';
          var safeGt=(e.gamertag||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
          return'<tr>'
            +'<td style="color:#00d4ff">'+e.gamertag+'</td>'
            +'<td class="muted">'+age+'</td>'
            +'<td>'+e.matchCount+'</td>'
            +'<td>'+e.rankedCount+'</td>'
            +'<td>'+csrMark+'</td>'
            +'<td><button class="action-btn danger" data-clr="'+safeGt+'" style="font-size:10px;padding:2px 7px">clear</button></td>'
            +'</tr>';
        }).join('')+'</tbody></table>';
    }).catch(function(){document.getElementById('cache-panel').innerHTML='<span class="muted">failed to load cache</span>';});
  }

  document.addEventListener('click',function(e){
    var proBtn=e.target.closest('[data-pro-xuid]');
    if(proBtn){removePro(proBtn.getAttribute('data-pro-xuid'),proBtn.getAttribute('data-pro-gt'));return;}
    var clrBtn=e.target.closest('[data-clr]');
    if(clrBtn){clearPlayerCache(clrBtn.getAttribute('data-clr'));return;}
    var fbRow=e.target.closest('.fb-row');
    if(fbRow){var pid=fbRow.getAttribute('data-fb-target');if(pid){var p=document.getElementById(pid);if(p)p.style.display=p.style.display==='none'?'table-row':'none';}return;}
    var btn=e.target.closest('.del-btn');
    if(!btn)return;
    var gt=btn.getAttribute('data-gt');
    if(!gt||!confirm('Delete ALL searches for "'+gt+'"?'))return;
    fetch('/api/admin/delete-searches?pass=${pass}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gamertags:[gt]})})
      .then(function(r){return r.json();})
      .then(function(d){
        if(d.success){allRows=allRows.filter(function(r){return r.gamertag.toLowerCase()!==gt.toLowerCase();});renderRows(allRows);}
        else alert('Error: '+(d.error||'unknown'));
      }).catch(function(e){alert('Error: '+e.message);});
  });

  function loadData(){
    fetch('/api/admin/searches?pass=${pass}').then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}).then(function(d){
      allRows=d.searches||[];
      var dev=d.devices||{};
      var topGt=d.top&&d.top[0]?d.top[0].gt:'--';
      document.getElementById('summary').innerHTML='<div class="stat"><div class="stat-val">'+d.total+'</div><div class="stat-lbl">SEARCHES</div></div><div class="stat"><div class="stat-val">'+d.uniquePlayers+'</div><div class="stat-lbl">UNIQUE PLAYERS</div></div><div class="stat"><div class="stat-val">'+topGt+'</div><div class="stat-lbl">MOST SEARCHED</div></div><div class="stat"><div class="stat-val">'+(dev.mobile||0)+'</div><div class="stat-lbl">MOBILE</div></div><div class="stat"><div class="stat-val">'+(dev.desktop||0)+'</div><div class="stat-lbl">DESKTOP</div></div>';
      var tabs=d.tabStats||[];var maxV=tabs.reduce(function(m,t){return Math.max(m,parseInt(t.visits)||0);},1);
      document.getElementById('tabtbody').innerHTML=tabs.length?tabs.map(function(t){var pct=Math.round((parseInt(t.visits)/maxV)*100);return'<tr><td style="color:#00d4ff">'+t.tab+'</td><td>'+t.visits+'<div class="bar-wrap"><div class="bar" style="width:'+pct+'%"></div></div></td><td class="gold">'+fmtSec(t.avg_seconds)+'</td><td class="muted">'+fmtMins(t.total_minutes)+'</td></tr>';}).join(''):'<tr><td colspan="4" class="muted">No tab data yet</td></tr>';
      renderRows(allRows);
    }).catch(function(e){document.getElementById('summary').innerHTML='<span style="color:#f44336">Error: '+e.message+'</span>';});
  }
  function loadFeedback(){
    fetch('/api/admin/feedback?pass=${pass}').then(function(r){return r.json();}).then(function(rows){
      document.getElementById('fbtbody').innerHTML=rows.length?rows.map(function(f,i){
        var typeColor=f.type==='contact'?'#ffc107':'#00d4ff';
        var preview=f.message.replace(/</g,'&lt;').replace(/>/g,'&gt;');
        var short=preview.length>80?preview.slice(0,80)+'…':preview;
        var ts=new Date(f.ts).toISOString().replace('T',' ').slice(0,19);
        var pid='fb_'+i;
        return'<tr class="fb-row" data-fb-target="'+pid+'" style="cursor:pointer">'
          +'<td class="muted" style="white-space:nowrap">'+ts+'</td>'
          +'<td style="color:'+typeColor+'">'+f.type+'</td>'
          +'<td style="color:#4caf50">'+(f.email||'<span class="muted">--</span>')+'</td>'
          +'<td style="color:#ccc;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+short+'</td>'
          +'</tr>'
          +'<tr id="'+pid+'" style="display:none"><td colspan="4" style="padding:12px 16px;background:#07090f;border-bottom:1px solid #1a2035">'
          +'<div style="font-size:12px;white-space:pre-wrap;word-break:break-word;color:#ccc;line-height:1.6">'+preview+'</div>'
          +'</td></tr>';
      }).join(''):'<tr><td colspan="4" class="muted">No feedback yet</td></tr>';
    }).catch(function(){document.getElementById('fbtbody').innerHTML='<tr><td colspan="4" class="muted">Failed to load</td></tr>';});
  }
  loadData();loadFeedback();loadCache();loadProPlayers();setInterval(loadData,30000);setInterval(loadFeedback,60000);setInterval(loadCache,15000);
  function renderRows(rows){
    document.getElementById('tbody').innerHTML=rows.map(function(s){
      var cached=String(s.cached);
      var cs=cached==='cached'?'<span class="muted">cached</span>':cached==='inflight'?'<span style="color:#555">inflight</span>':cached==='error'?'<span class="loss">error</span>':'<span style="color:#888">fresh</span>';
      var gt=s.gamertag||'';
      var safeGt=gt.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
      return'<tr>'
        +'<td class="muted">'+new Date(s.ts).toISOString().replace('T',' ').slice(0,19)+'</td>'
        +'<td style="color:#00d4ff">'+gt+'</td>'
        +'<td>'+ua2device(s.user_agent)+'</td>'
        +'<td>'+cs+'</td>'
        +'<td class="muted">'+(s.duration_ms?s.duration_ms+'ms':'--')+'</td>'
        +'<td>'+(s.success?'<span class="win">ok</span>':'<span class="loss">err</span>')+'</td>'
        +'<td><button class="del-btn" data-gt="'+safeGt+'" title="Delete all searches for this gamertag">x</button></td>'
        +'</tr>';
    }).join('');
  }
  function filterRows(){var q=document.getElementById('filter').value.toLowerCase();renderRows(q?allRows.filter(function(r){return r.gamertag.toLowerCase().includes(q);}):allRows);}
</script></body></html>`);
});

// ── Aim Calibration ───────────────────────────────────────────────────────────
// Personal hidden page — protected by CALIBRATE_KEY env var (default: 'calibrate')

const CAL_KEY = process.env.CALIBRATE_KEY || 'calibrate';

// Analysis endpoint — POST with settings JSON, returns recommendations
app.post('/api/calibrate', express.json(), async (req, res) => {
  const { key, gamertag, sensitivityH, sensitivityV, innerDead, outerDead, fov,
          deadzoneType, viewingDist, acceleration, tzOffset } = req.body || {};
  if (key !== CAL_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!gamertag) return res.status(400).json({ error: 'Gamertag required' });

  const player = await getFromCache(gamertag);
  if (!player) return res.json({ ok: false, error: 'Player not in cache — search them on fragr first.' });

  const matches = (player.allMatches || player.recentMatches || [])
    .filter(m => m && m.kills != null && !m.isCustom);

  // ── Core helpers ──────────────────────────────────────────────────────────
  const mean   = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  const stdDev = arr => { const m = mean(arr); return arr.length ? Math.sqrt(mean(arr.map(v => (v - m) ** 2))) : 0; };
  const gameAcc = m => m.shotsHit / m.shotsFired * 100;

  // ── Filter to valid aim games ─────────────────────────────────────────────
  const aimGames = matches.filter(m =>
    m.shotsFired > 0 && m.shotsHit != null && m.kills > 0 &&
    (m.outcome === 2 || m.outcome === 3) && !(m.gameMode && m.gameMode.includes('Legacy')));

  if (aimGames.length < 5) return res.json({ ok: false, error: 'Need at least 5 ranked games with accuracy data.' });

  // ── Core averages ─────────────────────────────────────────────────────────
  const accPerGame = aimGames.map(gameAcc);
  const hsPerGame  = aimGames.map(m => m.weaponStats && m.kills > 0 ? m.weaponStats.headshots / m.kills * 100 : 0);
  const spkPerGame = aimGames.map(m => m.shotsFired / Math.max(m.kills, 1));

  const avgAcc = mean(accPerGame);
  const accSd  = stdDev(accPerGame);
  const avgHs  = mean(hsPerGame);
  const avgSpk = mean(spkPerGame);

  // Close-range proxy: high melee finish rate
  const closeGames = aimGames.filter(m => m.weaponStats && m.kills > 0 && m.weaponStats.melee / m.kills > 0.25);
  const closeAcc   = closeGames.length >= 3 ? mean(closeGames.map(gameAcc)) : null;

  // ── Settings ──────────────────────────────────────────────────────────────
  const sensH  = parseFloat(sensitivityH) || 3;
  const sensV  = parseFloat(sensitivityV) || 3;
  const iDead  = parseFloat(innerDead)    || 0.0;
  const oDead  = parseFloat(outerDead)    || 0.0;
  const fovVal = parseFloat(fov)          || 78;
  const accel  = parseFloat(acceleration) || 0;
  const vDist  = parseFloat(viewingDist)  || 8;   // feet
  const tzOff  = typeof tzOffset === 'number' ? tzOffset : 0; // minutes offset from UTC
  const TV_IN  = 60;
  const tvWidthIn     = TV_IN * (16 / Math.sqrt(16**2 + 9**2));
  const screenAngleDeg = 2 * Math.atan((tvWidthIn / 2) / (vDist * 12)) * (180 / Math.PI);

  // ── Session analysis (warm-up + fatigue) ──────────────────────────────────
  const timed = aimGames.filter(m => m.startTime).sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  let warmupDelta = null, fatigueDelta = null, avgSessionLen = null;
  if (timed.length >= 8) {
    const sessions = [];
    let cur = [timed[0]];
    for (let i = 1; i < timed.length; i++) {
      const gap = new Date(timed[i].startTime) - new Date(timed[i - 1].startTime);
      if (gap > 2 * 60 * 60 * 1000) { sessions.push(cur); cur = []; }
      cur.push(timed[i]);
    }
    sessions.push(cur);
    const longS = sessions.filter(s => s.length >= 4);
    avgSessionLen = longS.length ? Math.round(mean(longS.map(s => s.length))) : null;
    if (longS.length >= 2) {
      // Warm-up: first game of session vs rest
      const firstAcc = longS.map(s => gameAcc(s[0]));
      const restAcc  = longS.map(s => mean(s.slice(1).map(gameAcc)));
      warmupDelta = +(mean(restAcc) - mean(firstAcc)).toFixed(1); // positive = first game is worse
      // Fatigue: first third vs last third
      const fatS = longS.filter(s => s.length >= 5);
      if (fatS.length >= 2) {
        const earlyAcc = fatS.map(s => mean(s.slice(0, Math.ceil(s.length / 3)).map(gameAcc)));
        const lateAcc  = fatS.map(s => mean(s.slice(-Math.ceil(s.length / 3)).map(gameAcc)));
        fatigueDelta = +(mean(lateAcc) - mean(earlyAcc)).toFixed(1); // negative = drops late in session
      }
    }
  }

  // ── Map type accuracy split ───────────────────────────────────────────────
  const CLOSE_MAPS = ['empyrean','streets','catalyst','live fire','bazaar','solitude','prism','launch site'];
  const OPEN_MAPS  = ['aquarius','recharge','forbidden','illusion','breaker','fragmentation','highpower','interference','oasis','detachment','avalanche'];
  const closeMapG = aimGames.filter(m => m.mapName && CLOSE_MAPS.some(n => m.mapName.toLowerCase().includes(n)));
  const openMapG  = aimGames.filter(m => m.mapName && OPEN_MAPS.some(n => m.mapName.toLowerCase().includes(n)));
  const closeMapAcc = closeMapG.length >= 3 ? +mean(closeMapG.map(gameAcc)).toFixed(1) : null;
  const openMapAcc  = openMapG.length  >= 3 ? +mean(openMapG.map(gameAcc)).toFixed(1)  : null;

  // ── Accuracy → win rate correlation ──────────────────────────────────────
  const bucketMap = {};
  aimGames.forEach(m => {
    const acc = gameAcc(m);
    const b   = Math.floor(acc / 5) * 5;
    if (!bucketMap[b]) bucketMap[b] = { wins: 0, total: 0 };
    if (m.outcome === 2) bucketMap[b].wins++;
    bucketMap[b].total++;
  });
  const accWinCorr = Object.entries(bucketMap)
    .filter(([, v]) => v.total >= 2)
    .map(([k, v]) => ({ acc: +k, wr: Math.round(v.wins / v.total * 100), n: v.total }))
    .sort((a, b) => a.acc - b.acc);
  // Find the accuracy floor where win rate first exceeds 50%
  const winFloor = accWinCorr.find(b => b.wr >= 50);

  // ── Time of day performance ───────────────────────────────────────────────
  const hourBuckets = {};
  aimGames.forEach(m => {
    if (!m.startTime) return;
    const localH = (new Date(m.startTime).getUTCHours() + Math.round(tzOff / 60) + 24) % 24;
    const bucket = localH < 6 ? 'Late Night (12–6am)' : localH < 12 ? 'Morning (6–12pm)' : localH < 18 ? 'Afternoon (12–6pm)' : 'Evening (6–12am)';
    if (!hourBuckets[bucket]) hourBuckets[bucket] = [];
    hourBuckets[bucket].push(gameAcc(m));
  });
  const timeOfDay = Object.entries(hourBuckets)
    .filter(([, arr]) => arr.length >= 3)
    .map(([label, arr]) => ({ label, avgAcc: +mean(arr).toFixed(1), n: arr.length }))
    .sort((a, b) => b.avgAcc - a.avgAcc);

  // ── Consistency score 0–100 ───────────────────────────────────────────────
  // Weighted: accuracy level 30pts, variance 25pts, headshot rate 25pts, SPK 20pts
  const accScore = Math.min(30, Math.max(0, (avgAcc - 30) / 30 * 30));
  const sdScore  = Math.min(25, Math.max(0, (1 - accSd / 15) * 25));
  const hsScore  = Math.min(25, Math.max(0, (avgHs - 20) / 40 * 25));
  const spkScore = Math.min(20, Math.max(0, (1 - (avgSpk - 5) / 15) * 20));
  const consistencyScore = Math.round(accScore + sdScore + hsScore + spkScore);

  // ── Build recommendations ─────────────────────────────────────────────────
  const recs = [];
  const note = (cat, title, body, severity = 'info', priority = 5) => recs.push({ cat, title, body, severity, priority });

  // 1. Sensitivity vs 60fps (priority 1 — biggest impact)
  const MAX_SENS_60FPS = 5;
  if (sensH > MAX_SENS_60FPS) {
    const sug = Math.max(sensH - 1, MAX_SENS_60FPS);
    note('Sensitivity', `H-Sensitivity ${sensH} is high for 60fps`,
      `At 60fps each frame takes 16.7ms to render. High sensitivity maps large stick deflections to big angular jumps between frames, making micro-corrections unpredictable. Most 60fps players perform best at 4–5H. Your accuracy of ${avgAcc.toFixed(1)}% ${avgAcc < 43 ? `supports lowering — try ${sug}H first.` : `is reasonable, but you may find ${sug}H even cleaner on a 60" TV.`}`,
      avgAcc < 43 ? 'warn' : 'info', 1);
  } else if (sensH < 3 && avgAcc < 42 && avgHs > 40) {
    note('Sensitivity', `H-Sensitivity ${sensH} may be too low`,
      `Your headshot rate (${avgHs.toFixed(0)}%) is decent but overall accuracy (${avgAcc.toFixed(1)}%) is low — you're precise when still but missing strafing targets. Try raising H-Sensitivity by 1 to improve lateral tracking.`,
      'warn', 1);
  }

  if (Math.abs(sensH - sensV) > 1) {
    note('Sensitivity', `H/V sensitivity gap (${sensH}H vs ${sensV}V)`,
      `A gap larger than 1 between axes can cause aim to feel "sticky" vertically or horizontally. Most players use V = H or V = H−1. Consider bringing them closer together.`,
      'info', 2);
  }

  // 2. Deadzone analysis (priority 2)
  if (iDead > 0.12) {
    const closePart = closeAcc != null
      ? ` Your close-range accuracy (${closeAcc.toFixed(1)}%) ${closeAcc < avgAcc - 5 ? 'drops vs your overall average — consistent with a large deadzone masking micro-adjustments in CQB.' : 'holds up — but you may still feel sluggishness on slow tracking shots.'}`
      : '';
    note('Deadzone', `Inner Deadzone ${(iDead * 100).toFixed(0)}% is large`,
      `A large inner deadzone creates a dead spot where small stick movements do nothing — fine micro-adjustments and slow tracking shots feel unresponsive. Try reducing to 5–8% (0.05–0.08). If your stick drifts at lower values, try 3–5% first.${closePart}`,
      iDead > 0.15 ? 'warn' : 'info', 2);
  } else if (iDead < 0.03 && accSd > 8) {
    note('Deadzone', `Inner Deadzone ${(iDead * 100).toFixed(0)}% may be too low`,
      `Very low inner deadzone with high game-to-game accuracy variance (±${accSd.toFixed(1)}%) can mean stick drift is bleeding into your aim when you think you're still. Try 3–5% and watch if consistency improves.`,
      'info', 2);
  }

  if (oDead > 0.12) {
    note('Deadzone', `Outer Deadzone ${(oDead * 100).toFixed(0)}% limits max turn speed`,
      `Above ~10% outer deadzone you may never reach full rotation speed — 180° snap-turns feel slow and you'll get outmaneuvered by flankers. Try reducing to 5–8% (0.05–0.08).`,
      'warn', 2);
  }

  // 3. Acceleration (priority 3)
  if (accel > 2) {
    note('Sensitivity', `Acceleration ${accel} adds unpredictable ramping at 60fps`,
      `Acceleration ramps speed as you push the stick further. At 120fps the ramp feels smooth; at 60fps the frames between ramp steps are visible as stuttery over-rotation. For 60fps, 0–1 acceleration is almost universally preferred — it makes aim predictable and consistent.`,
      'warn', 3);
  }

  // 4. FOV (priority 4)
  if (fovVal > 100 && screenAngleDeg < 30) {
    note('FOV', `FOV ${fovVal}° is high for your ${vDist}ft viewing distance`,
      `From ${vDist}ft your 60" TV subtends ~${screenAngleDeg.toFixed(0)}° of your horizontal vision. At game FOV ${fovVal}° targets are quite small — each pixel of stick error is amplified. Try 90–95° for better target size and aim feel at this distance.`,
      'info', 4);
  } else if (fovVal < 90 && screenAngleDeg > 35) {
    note('FOV', `FOV ${fovVal}° is conservative — you can safely go higher`,
      `Your 60" TV at ${vDist}ft gives ~${screenAngleDeg.toFixed(0)}° of real horizontal vision. FOV ${fovVal}° leaves peripheral awareness on the table. Bumping to 95–100° adds game awareness without meaningfully shrinking targets.`,
      'info', 4);
  }

  // 5. Deadzone type (priority 5)
  if (deadzoneType === 'axial') {
    note('Deadzone', 'Axial deadzone can feel notchy on diagonal tracking',
      `Axial deadzone applies independently per axis — precise for pure horizontal/vertical aim but can feel "notchy" when tracking targets that strafe diagonally. Radial (circular) deadzone generally feels smoother for 360° tracking in Halo.`,
      'info', 5);
  }

  // 6. Consistency from accSd (priority 2)
  if (accSd > 10) {
    note('Consistency', `High accuracy variance ±${accSd.toFixed(1)}% game-to-game`,
      `Large swings in per-game accuracy usually mean something external is affecting your input — stick drift, inconsistent grip pressure, or fatigue. Both too-large and too-small inner deadzones can cause this. Check your sticks with a deadzone visualizer app.`,
      'warn', 2);
  }

  // 7. Session warm-up (priority 3)
  if (warmupDelta !== null && warmupDelta > 4) {
    note('Session', `Cold-aim drop: ~${warmupDelta.toFixed(1)}% accuracy in your first game`,
      `Your first game of each session runs ${warmupDelta.toFixed(1)}% lower accuracy than the rest of that session — you need a warm-up period. This makes your settings feel inconsistent cold. Either treat your first game as a throw-away warm-up, or lower sensitivity by 1 so the cost of cold aim is smaller.`,
      'info', 3);
  }

  // 8. Session fatigue (priority 3)
  if (fatigueDelta !== null && fatigueDelta < -4) {
    note('Session', `Fatigue drop: ~${Math.abs(fatigueDelta).toFixed(1)}% accuracy late in sessions`,
      `Your accuracy drops ~${Math.abs(fatigueDelta).toFixed(1)}% by the end of long sessions. Fatigue causes your grip to loosen, which can make high sensitivity feel out of control. Consider capping ranked sessions at ${avgSessionLen ? avgSessionLen - 2 : 6} games, or taking a 10-minute break halfway through.`,
      'info', 3);
  }

  // 9. Map type gap (priority 2)
  if (closeMapAcc !== null && openMapAcc !== null && Math.abs(closeMapAcc - openMapAcc) > 5) {
    if (closeMapAcc < openMapAcc - 5) {
      note('Map Profile', `CQB accuracy (${closeMapAcc}%) vs open-map (${openMapAcc}%) — gap of ${(openMapAcc - closeMapAcc).toFixed(1)}%`,
        `You aim better on open maps than in close-quarters. In CQB the inner deadzone limits fast micro-corrections, or your sensitivity is too high for the snap-tracking required at close range. Try reducing inner deadzone to 3–6% and see if Streets/Empyrean feel more responsive.`,
        'info', 2);
    } else {
      note('Map Profile', `Open-map accuracy (${openMapAcc}%) trails CQB (${closeMapAcc}%) — gap of ${(closeMapAcc - openMapAcc).toFixed(1)}%`,
        `You aim better in close-quarters than on open maps. Long-range strafe tracking requires more consistent lateral tracking — your sensitivity may be too low to track targets strafing at distance. Try raising H-Sensitivity by 1 to improve strafe-following on Aquarius/Recharge.`,
        'info', 2);
    }
  }

  // Sort recommendations by priority (warnings first within same priority)
  recs.sort((a, b) => a.priority - b.priority || (b.severity === 'warn' ? 1 : 0) - (a.severity === 'warn' ? 1 : 0));

  // ── Summary ───────────────────────────────────────────────────────────────
  const issues = recs.filter(r => r.severity === 'warn').length;
  const topRec = recs[0];
  const summary = issues === 0
    ? `Settings look solid for 60fps play on a 60" TV. Accuracy (${avgAcc.toFixed(1)}%) and headshot rate (${avgHs.toFixed(0)}%) are consistent with these settings. Consistency score: ${consistencyScore}/100.`
    : `${issues} warning${issues > 1 ? 's' : ''} flagged. Start with ${topRec ? topRec.cat.toLowerCase() : 'sensitivity'} first — it has the highest impact. Change one setting, play 10+ games, then re-analyze. Consistency score: ${consistencyScore}/100.`;

  res.json({
    ok: true,
    games: aimGames.length,
    consistencyScore,
    stats: {
      avgAccuracy:  +avgAcc.toFixed(1),
      accuracySd:   +accSd.toFixed(1),
      avgHsRate:    +avgHs.toFixed(1),
      avgSpk:       +avgSpk.toFixed(1),
      closeAccuracy: closeAcc != null ? +closeAcc.toFixed(1) : null,
      screenAngle:  +screenAngleDeg.toFixed(1),
      closeMapAcc, openMapAcc,
      closeMapCount: closeMapG.length,
      openMapCount:  openMapG.length,
    },
    session: { warmupDelta, fatigueDelta, avgSessionLen },
    accWinCorr,
    winFloor: winFloor ? winFloor.acc : null,
    timeOfDay,
    recommendations: recs,
    summary,
  });
});

// Calibration page (hidden — requires ?key=CALIBRATE_KEY in URL)
app.get('/calibrate', (req, res) => {
  if (req.query.key !== CAL_KEY) return res.status(404).send('Not found');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>fragr // aim calibration</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#0d0f12;--surface:#151820;--surface2:#1c2030;--border:#262d3d;--text:#e8eaf0;--muted:#8a8a9a;--muted2:#555870;--accent:#4fc3f7;--gold:#f59e0b;--win:#4caf50;--loss:#ef5350}
  body{background:var(--bg);color:var(--text);font-family:'Share Tech Mono',monospace;min-height:100vh;padding:32px 20px}
  .wrap{max-width:760px;margin:0 auto}
  .logo{font-family:Rajdhani,sans-serif;font-size:22px;font-weight:700;color:var(--accent);letter-spacing:2px;margin-bottom:4px}
  .sub{font-size:10px;color:var(--muted2);letter-spacing:2px;text-transform:uppercase;margin-bottom:28px}
  h2{font-family:Rajdhani,sans-serif;font-size:15px;font-weight:700;letter-spacing:2px;color:var(--muted2);text-transform:uppercase;margin-bottom:14px;padding-bottom:6px;border-bottom:1px solid var(--border)}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px}
  .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:20px}
  label{display:block;font-size:9px;letter-spacing:1.5px;color:var(--muted2);text-transform:uppercase;margin-bottom:5px}
  input,select{width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:'Share Tech Mono',monospace;font-size:13px;padding:8px 10px;border-radius:4px;outline:none}
  input:focus,select:focus{border-color:var(--accent)}
  input:disabled{opacity:.4;cursor:not-allowed}
  .hint{font-size:9px;color:var(--muted2);margin-top:3px}
  .btn{width:100%;background:var(--accent);color:#0d0f12;font-family:Rajdhani,sans-serif;font-weight:700;font-size:15px;letter-spacing:2px;text-transform:uppercase;padding:12px;border:none;border-radius:5px;cursor:pointer;margin-top:8px}
  .btn:hover{filter:brightness(1.1)}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .context-box{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--gold);border-radius:6px;padding:14px 16px;margin-bottom:24px;font-size:10px;color:var(--muted);line-height:1.7}
  .context-box strong{color:var(--gold)}
  #out{margin-top:28px}
  .stat-row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:11px}
  .stat-row:last-child{border:none}
  .stat-label{color:var(--muted)}
  .stat-val{font-weight:600}
  .rec{background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:14px 16px;margin-bottom:12px}
  .rec.warn{border-left:3px solid var(--gold)}
  .rec.info{border-left:3px solid var(--accent)}
  .rec-meta{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
  .rec-cat{font-size:8px;letter-spacing:2px;color:var(--muted2);text-transform:uppercase}
  .rec-pri{font-size:8px;color:var(--muted2)}
  .rec-title{font-family:Rajdhani,sans-serif;font-size:15px;font-weight:700;margin-bottom:6px}
  .rec.warn .rec-title{color:var(--gold)}
  .rec.info .rec-title{color:var(--accent)}
  .rec-body{font-size:10px;color:var(--muted);line-height:1.7}
  .summary-box{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:14px 16px;margin-bottom:20px;font-size:11px;color:var(--text);line-height:1.6}
  .score-ring{display:inline-flex;align-items:center;justify-content:center;width:54px;height:54px;border-radius:50%;border:3px solid;font-family:Rajdhani,sans-serif;font-size:22px;font-weight:700;flex-shrink:0}
  .err{color:var(--loss);font-size:11px;margin-top:12px}
  .section-head{font-size:9px;letter-spacing:2px;color:var(--muted2);text-transform:uppercase;margin:20px 0 10px}
  .spin{display:inline-block;width:12px;height:12px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px;margin-right:6px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .bar-wrap{height:6px;background:var(--surface2);border-radius:3px;margin-top:4px}
  .bar-fill{height:100%;border-radius:3px;transition:width .5s ease}
  .bucket-row{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:10px}
  .bucket-acc{color:var(--muted);width:56px;flex-shrink:0}
  .bucket-bar-wrap{flex:1;height:5px;background:var(--surface2);border-radius:3px}
  .bucket-bar{height:100%;border-radius:3px}
  .bucket-wr{width:36px;text-align:right;flex-shrink:0;font-weight:600}
  .bucket-n{width:28px;text-align:right;flex-shrink:0;color:var(--muted2);font-size:9px}
  .pro-row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border);font-size:10px}
  .pro-row:last-child{border:none}
  .pro-label{color:var(--muted)}
  .pro-val{color:var(--gold);font-weight:600}
  .pro-yours{color:var(--accent)}
  .tod-row{display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);font-size:10px}
  .tod-row:last-child{border:none}
  .tod-label{color:var(--muted);min-width:160px}
  .tod-bar-wrap{flex:1;height:5px;background:var(--surface2);border-radius:3px}
  .tod-bar{height:100%;border-radius:3px;background:var(--accent)}
  .tod-val{color:var(--text);font-weight:600;min-width:38px;text-align:right}
</style>
</head>
<body>
<div class="wrap">
  <div class="logo">fragr</div>
  <div class="sub">// aim calibration · personal</div>

  <div class="context-box">
    <strong>Setup context locked in:</strong> 60fps · 60" TV · controller<br>
    Analysis uses your last 100 tracked games. The more accurate your settings below, the better the recommendations.
  </div>

  <h2>Player</h2>
  <div style="margin-bottom:20px">
    <label>Gamertag</label>
    <input id="gt" type="text" placeholder="your Xbox gamertag" autocomplete="off">
    <div class="hint">Must have been searched on fragr at least once</div>
  </div>

  <h2>Look Sensitivity</h2>
  <div class="grid">
    <div>
      <label>Horizontal Sensitivity</label>
      <input id="sensH" type="number" min="1" max="10" step="1" value="3">
      <div class="hint">1–10 · Halo default: 3</div>
    </div>
    <div>
      <label>Vertical Sensitivity</label>
      <input id="sensV" type="number" min="1" max="10" step="1" value="3">
      <div class="hint">1–10 · Halo default: 3</div>
    </div>
  </div>
  <div style="margin-bottom:20px">
    <label>Acceleration (0–5)</label>
    <input id="accel" type="number" min="0" max="5" step="1" value="0">
    <div class="hint">0 = linear · higher = ramps as you push stick further</div>
  </div>

  <h2>Deadzones</h2>
  <div class="grid">
    <div>
      <label>Inner Deadzone</label>
      <input id="innerDead" type="number" min="0" max="1" step="0.01" value="0.08">
      <div class="hint">0.00–1.00 · default ~0.08</div>
    </div>
    <div>
      <label>Outer Deadzone</label>
      <input id="outerDead" type="number" min="0" max="1" step="0.01" value="0.08">
      <div class="hint">0.00–1.00 · default ~0.08</div>
    </div>
  </div>
  <div style="margin-bottom:20px">
    <label>Deadzone Type</label>
    <select id="deadzoneType">
      <option value="radial">Radial — circular, smoother 360° tracking</option>
      <option value="axial">Axial — cross-shaped, sharper H/V axis control</option>
    </select>
  </div>

  <h2>Display</h2>
  <div class="grid3">
    <div>
      <label>Field of View</label>
      <input id="fov" type="number" min="78" max="120" step="1" value="78">
      <div class="hint">78–120 · console default: 78</div>
    </div>
    <div>
      <label>Viewing Distance (ft)</label>
      <input id="viewDist" type="number" min="3" max="20" step="0.5" value="8">
      <div class="hint">How far you sit from the TV</div>
    </div>
    <div>
      <label>TV Size</label>
      <input value='60" · locked' disabled>
      <div class="hint">60" diagonal · 16:9</div>
    </div>
  </div>

  <button class="btn" id="runBtn" onclick="runAnalysis()">Analyze My Settings</button>
  <div id="out"></div>
</div>

<script>
const KEY = '${CAL_KEY}';

// Pro HCS reference settings (competitive average)
const PRO = {
  'H Sensitivity':   { val: '3–4', note: 'most use 3' },
  'V Sensitivity':   { val: '3–4', note: 'V = H or H−1' },
  'Inner Deadzone':  { val: '0–5%', note: 'avg ~3%' },
  'Outer Deadzone':  { val: '0–5%', note: 'avg ~3%' },
  'Acceleration':    { val: '0', note: 'all use linear' },
  'FOV':             { val: '90–100°', note: '' },
  'Deadzone Type':   { val: 'Radial', note: 'majority' },
};

async function runAnalysis() {
  const btn = document.getElementById('runBtn');
  const out = document.getElementById('out');
  const gt  = document.getElementById('gt').value.trim();
  if (!gt) { out.innerHTML = '<div class="err">Enter your gamertag.</div>'; return; }
  btn.disabled = true;
  out.innerHTML = '<div style="color:var(--muted);font-size:11px;margin-top:16px"><span class="spin"></span>Analyzing your games...</div>';
  try {
    const r = await fetch('/api/calibrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: KEY,
        gamertag:     gt,
        sensitivityH: parseFloat(document.getElementById('sensH').value),
        sensitivityV: parseFloat(document.getElementById('sensV').value),
        acceleration: parseFloat(document.getElementById('accel').value),
        innerDead:    parseFloat(document.getElementById('innerDead').value),
        outerDead:    parseFloat(document.getElementById('outerDead').value),
        deadzoneType: document.getElementById('deadzoneType').value,
        fov:          parseFloat(document.getElementById('fov').value),
        viewingDist:  parseFloat(document.getElementById('viewDist').value),
        tzOffset:     new Date().getTimezoneOffset() * -1, // minutes from UTC
      })
    });
    const d = await r.json();
    if (!d.ok) { out.innerHTML = '<div class="err">Error: ' + (d.error || 'Unknown') + '</div>'; btn.disabled = false; return; }
    renderResults(d);
  } catch(e) {
    out.innerHTML = '<div class="err">Request failed: ' + e.message + '</div>';
  }
  btn.disabled = false;
}

function scoreColor(n) {
  return n >= 70 ? 'var(--win)' : n >= 45 ? 'var(--gold)' : 'var(--loss)';
}

function renderResults(d) {
  const s = d.stats;
  const warns = d.recommendations.filter(r => r.severity === 'warn').length;
  const sc = d.consistencyScore;
  let h = '';

  // ── Summary + Consistency Score ──────────────────────────────────────────
  h += '<div class="section-head">Summary · ' + d.games + ' games analyzed</div>';
  h += '<div class="summary-box" style="display:flex;gap:16px;align-items:center">';
  h += '<div class="score-ring" style="border-color:' + scoreColor(sc) + ';color:' + scoreColor(sc) + '">' + sc + '</div>';
  h += '<div><div style="font-size:9px;color:var(--muted2);letter-spacing:1px;margin-bottom:4px">CONSISTENCY SCORE / 100</div>';
  h += '<div style="font-size:11px;line-height:1.6">' + d.summary + '</div></div>';
  h += '</div>';

  // ── Your Aim Profile ─────────────────────────────────────────────────────
  h += '<div class="section-head">Aim Profile</div>';
  h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:12px 16px;margin-bottom:20px">';
  h += statRow('Avg Accuracy', s.avgAccuracy + '%', s.avgAccuracy >= 50 ? 'var(--win)' : s.avgAccuracy >= 42 ? 'var(--gold)' : 'var(--loss)');
  h += statRow('Accuracy Variance', '±' + s.accuracySd + '% game-to-game', s.accuracySd <= 6 ? 'var(--win)' : s.accuracySd <= 10 ? 'var(--gold)' : 'var(--loss)');
  h += statRow('Avg Headshot Rate', s.avgHsRate + '% of kills', s.avgHsRate >= 45 ? 'var(--win)' : s.avgHsRate >= 32 ? 'var(--gold)' : 'var(--loss)');
  h += statRow('Avg Shots / Kill', s.avgSpk.toFixed(1), s.avgSpk <= 7 ? 'var(--win)' : s.avgSpk <= 9 ? 'var(--gold)' : 'var(--loss)');
  if (s.closeAccuracy != null) h += statRow('Melee-Heavy Game Accuracy', s.closeAccuracy + '%', s.closeAccuracy >= s.avgAccuracy - 3 ? 'var(--win)' : 'var(--gold)');
  if (s.closeMapAcc != null)   h += statRow('Close-Map Accuracy (' + s.closeMapCount + 'g)', s.closeMapAcc + '%', s.closeMapAcc >= s.avgAccuracy - 3 ? 'var(--win)' : 'var(--gold)');
  if (s.openMapAcc != null)    h += statRow('Open-Map Accuracy (' + s.openMapCount + 'g)', s.openMapAcc + '%', s.openMapAcc >= s.avgAccuracy - 3 ? 'var(--win)' : 'var(--gold)');
  h += statRow('Screen Angle (TV at ' + document.getElementById('viewDist').value + 'ft)', s.screenAngle + '° horizontal', 'var(--accent)');
  h += '</div>';

  // ── Session Analysis ─────────────────────────────────────────────────────
  const sess = d.session;
  if (sess && (sess.warmupDelta !== null || sess.fatigueDelta !== null)) {
    h += '<div class="section-head">Session Pattern</div>';
    h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:12px 16px;margin-bottom:20px">';
    if (sess.warmupDelta !== null) {
      const wColor = sess.warmupDelta > 4 ? 'var(--gold)' : 'var(--win)';
      h += statRow('Cold-Start Penalty (first game)', (sess.warmupDelta > 0 ? '-' : '+') + Math.abs(sess.warmupDelta) + '% vs session avg', wColor);
    }
    if (sess.fatigueDelta !== null) {
      const fColor = sess.fatigueDelta < -4 ? 'var(--gold)' : 'var(--win)';
      h += statRow('Late-Session Drift (last third)', (sess.fatigueDelta >= 0 ? '+' : '') + sess.fatigueDelta + '% vs early session', fColor);
    }
    if (sess.avgSessionLen !== null) {
      h += statRow('Avg Session Length', sess.avgSessionLen + ' games', 'var(--muted)');
    }
    h += '</div>';
  }

  // ── Accuracy → Win Rate Correlation ──────────────────────────────────────
  if (d.accWinCorr && d.accWinCorr.length >= 3) {
    h += '<div class="section-head">Accuracy → Win Rate</div>';
    h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:12px 16px;margin-bottom:8px">';
    if (d.winFloor !== null) {
      h += '<div style="font-size:10px;color:var(--text);margin-bottom:10px">Win rate crosses 50% at <strong style="color:var(--win)">' + d.winFloor + '%+ accuracy</strong> — that\'s your target floor.</div>';
    }
    const maxWr = Math.max(...d.accWinCorr.map(b => b.wr));
    d.accWinCorr.forEach(function(b) {
      const wrColor = b.wr >= 55 ? 'var(--win)' : b.wr >= 45 ? 'var(--gold)' : 'var(--loss)';
      h += '<div class="bucket-row">';
      h += '<div class="bucket-acc">' + b.acc + '–' + (b.acc + 4) + '%</div>';
      h += '<div class="bucket-bar-wrap"><div class="bucket-bar" style="width:' + (b.wr) + '%;background:' + wrColor + '"></div></div>';
      h += '<div class="bucket-wr" style="color:' + wrColor + '">' + b.wr + '%</div>';
      h += '<div class="bucket-n">' + b.n + 'g</div>';
      h += '</div>';
    });
    h += '<div style="margin-top:8px;font-size:9px;color:var(--muted2)">Win rate per accuracy bucket · bar = win %</div>';
    h += '</div>';
  }

  // ── Time of Day ───────────────────────────────────────────────────────────
  if (d.timeOfDay && d.timeOfDay.length >= 2) {
    h += '<div class="section-head">Performance by Time of Day</div>';
    h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:12px 16px;margin-bottom:20px">';
    const maxTod = Math.max(...d.timeOfDay.map(t => t.avgAcc));
    d.timeOfDay.forEach(function(t, i) {
      const isBest = i === 0;
      h += '<div class="tod-row">';
      h += '<div class="tod-label" style="color:' + (isBest ? 'var(--text)' : 'var(--muted)') + '">' + t.label + (isBest ? ' ★' : '') + '</div>';
      h += '<div class="tod-bar-wrap"><div class="tod-bar" style="width:' + Math.round(t.avgAcc / maxTod * 100) + '%;opacity:' + (isBest ? '1' : '0.5') + '"></div></div>';
      h += '<div class="tod-val" style="color:' + (isBest ? 'var(--win)' : 'var(--muted)') + '">' + t.avgAcc + '%</div>';
      h += '<div style="font-size:9px;color:var(--muted2);min-width:24px;text-align:right">' + t.n + 'g</div>';
      h += '</div>';
    });
    h += '<div style="margin-top:8px;font-size:9px;color:var(--muted2)">Times shown in your local timezone · schedule ranked sessions during your peak window</div>';
    h += '</div>';
  }

  // ── 60fps Context ─────────────────────────────────────────────────────────
  h += '<div style="background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--muted2);border-radius:6px;padding:12px 16px;margin-bottom:20px;font-size:10px;color:var(--muted);line-height:1.7">';
  h += '<strong style="color:var(--text)">60fps context:</strong> Each frame renders every 16.7ms — stick corrections only register at frame boundaries, not continuously. This makes fine micro-adjustments inherently less smooth than at 120fps, which is why lower sensitivity and smaller deadzones help more at 60. ';
  h += 'Also check your TV\'s <strong style="color:var(--gold)">Game Mode</strong> — non-game-mode TVs add 30–100ms of input lag on top of the 16.7ms frame time.';
  h += '</div>';

  // ── Pro Settings Reference ────────────────────────────────────────────────
  const yourSettings = {
    'H Sensitivity':  document.getElementById('sensH').value,
    'V Sensitivity':  document.getElementById('sensV').value,
    'Inner Deadzone': Math.round(parseFloat(document.getElementById('innerDead').value) * 100) + '%',
    'Outer Deadzone': Math.round(parseFloat(document.getElementById('outerDead').value) * 100) + '%',
    'Acceleration':   document.getElementById('accel').value,
    'FOV':            document.getElementById('fov').value + '°',
    'Deadzone Type':  document.getElementById('deadzoneType').value.charAt(0).toUpperCase() + document.getElementById('deadzoneType').value.slice(1),
  };
  h += '<div class="section-head">Pro Settings Reference (HCS competitive average)</div>';
  h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:12px 16px;margin-bottom:20px">';
  h += '<div style="display:grid;grid-template-columns:1fr auto auto;gap:0;margin-bottom:6px">';
  h += '<div style="font-size:8px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px">Setting</div>';
  h += '<div style="font-size:8px;color:var(--gold);text-transform:uppercase;letter-spacing:1px;text-align:right;margin-right:16px">Pro Avg</div>';
  h += '<div style="font-size:8px;color:var(--accent);text-transform:uppercase;letter-spacing:1px;text-align:right">Yours</div>';
  h += '</div>';
  Object.entries(PRO).forEach(function(entry) {
    const k = entry[0], v = entry[1];
    h += '<div class="pro-row">';
    h += '<div class="pro-label">' + k + (v.note ? ' <span style="color:var(--muted2);font-size:9px">(' + v.note + ')</span>' : '') + '</div>';
    h += '<div style="display:flex;gap:16px">';
    h += '<div class="pro-val">' + v.val + '</div>';
    h += '<div class="pro-yours">' + (yourSettings[k] || '—') + '</div>';
    h += '</div></div>';
  });
  h += '</div>';

  // ── Prioritized Recommendations ───────────────────────────────────────────
  if (d.recommendations.length) {
    h += '<div class="section-head">Recommendations — fix in this order (' + d.recommendations.length + ' · ' + warns + ' warning' + (warns !== 1 ? 's' : '') + ')</div>';
    d.recommendations.forEach(function(rec, i) {
      h += '<div class="rec ' + rec.severity + '">';
      h += '<div class="rec-meta"><div class="rec-cat">' + rec.cat + '</div><div class="rec-pri">#' + (i + 1) + ' priority</div></div>';
      h += '<div class="rec-title">' + rec.title + '</div>';
      h += '<div class="rec-body">' + rec.body + '</div>';
      h += '</div>';
    });
  } else {
    h += '<div style="color:var(--win);font-size:11px;margin-top:4px">✓ No issues flagged — settings look good for your setup.</div>';
  }

  document.getElementById('out').innerHTML = h;
}

function statRow(label, val, color) {
  return '<div class="stat-row"><span class="stat-label">' + label + '</span><span class="stat-val" style="color:' + color + '">' + val + '</span></div>';
}
</script>
</body>
</html>`);
});

// Catch-all — must come AFTER all explicit routes (including /calibrate)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start token auto-refresh (requires MS_REFRESH_TOKEN env var)
startAutoRefresh();

app.listen(PORT, () => console.log(`[fragr] Listening on port ${PORT} — fragr.live`));
