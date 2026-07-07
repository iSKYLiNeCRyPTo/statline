require('dotenv').config();
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const path = require('path');
const { fetchPlayerStats, fetchMatchHistory, fetchAndApplySkillData, getAuthHeaders, fetchClearanceToken, getXuidToGamerpic, getXuidToGt, resolveGamertags, discoverPlaylists, getRedis, computeAdvancedStats, generateHaloDNA, resetClearanceCache, isMatchListBackoffActive, matchListBackoffSecondsRemaining, isClearanceUnavailable, getGameModeDebugLog, fillCachedMapImages, resolveMapImagesForMatches } = require('./halo');
const { fetchRivalsPlayer, refreshRivalsPlayer, clearRivalsCache, getCacheStatus: getRivalsCacheStatus } = require('./rivals');
const { startAutoRefresh, refreshSpartanToken } = require('./tokenRefresh');
const { Pool } = require('pg');
const { getDb: getXuidDb, loadXuidCache, flushXuidCache, loadEmblemCache, flushEmblemCache, savePlayerSnapshot, getRecentlySnapshotted, getSnapshotsByRank, addProPlayer, removeProPlayer, getProPlayers, getProStats, getLeaderboardData, getLeaderboardTab, getActivityTimes, saveMatchParticipants, reconstructMatchHistoryForXuid, getFrequentCoPlayers, getRecoverySeeds, countMatchesForXuid, lookupXuidByGamertag, getRefreshMeta, markRefreshAttempt, enrichMatchTeamsWithCsr, savePlayerMatchHistory, updatePlayerMatchSkillData, getPlayerMatchHistory, getDeepScanCursor, upsertDeepScanCursor } = require('./db');
const { runBackfill } = require('./backfillParticipants');
const recoveryQueue = require('./recoveryQueue');
const adminAuth = require('./auth');
const _memSearchLog = [];
const _memTabLog = [];
const _memFeedbackLog = [];
const _serverStartTime = new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────
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
app.use(compression());
app.use(cors());
app.use(express.json());

// ── Dynamic sitemap ───────────────────────────────────────────────────────────
// Serves /sitemap.xml with static pages + all tracked players from DB
app.get('/sitemap.xml', async (req, res) => {
  try {
    const db = await getDb();
    let playerUrls = '';
    if (db) {
      // Pull all gamertags from player_snapshots, ordered by most recently updated
      const result = await db.query(
        `SELECT DISTINCT ON (LOWER(gamertag)) gamertag
         FROM player_snapshots
         ORDER BY LOWER(gamertag), ts DESC
         LIMIT 10000`
      );
      playerUrls = result.rows.map(r => {
        const enc = encodeURIComponent(r.gamertag);
        return `  <url>\n    <loc>https://fragr.live/?player=${enc}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.5</priority>\n  </url>`;
      }).join('\n');
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://fragr.live/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://fragr.live/?view=leaderboard</loc>
    <changefreq>hourly</changefreq>
    <priority>0.8</priority>
  </url>
${playerUrls}
</urlset>`;
    res.set('Content-Type', 'application/xml');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  } catch (e) {
    console.error('[Sitemap] error:', e.message);
    res.status(500).send('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>');
  }
});

// ── Player page meta injection ────────────────────────────────────────────────
// When ?player=X is present, serve index.html with dynamic <title> and <meta> tags
// so Google can index and preview individual player pages.
const _indexHtmlPath = path.join(__dirname, 'public', 'index.html');
let _indexHtmlCache = null;
function getIndexHtml() {
  if (!_indexHtmlCache) {
    try { _indexHtmlCache = require('fs').readFileSync(_indexHtmlPath, 'utf8'); } catch(e) { _indexHtmlCache = ''; }
  }
  return _indexHtmlCache;
}
app.get('/', (req, res, next) => {
  const gt = req.query.player || req.query.search;
  if (!gt) return next(); // no player param — fall through to static
  const safe = gt.replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const title = `${safe} — Halo Stats | fragr`;
  const desc  = `View ${safe}'s Halo Infinite stats on fragr — K/D, CSR rank, win rate, match history, maps, and more.`;
  const canonical = `https://fragr.live/?player=${encodeURIComponent(gt)}`;
  let html = getIndexHtml();
  // Replace default title + meta tags with player-specific ones
  html = html
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/<meta name="description"[^>]*>/,  `<meta name="description" content="${desc}">`)
    .replace(/<link rel="canonical"[^>]*>/,      `<link rel="canonical" href="${canonical}">`)
    .replace(/<meta property="og:title"[^>]*>/,  `<meta property="og:title" content="${title}">`)
    .replace(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${desc}">`)
    .replace(/<meta property="og:url"[^>]*>/,    `<meta property="og:url" content="${canonical}">`)
    .replace(/<meta name="twitter:title"[^>]*>/, `<meta name="twitter:title" content="${title}">`)
    .replace(/<meta name="twitter:description"[^>]*>/, `<meta name="twitter:description" content="${desc}">`);
  res.set('Content-Type', 'text/html');
  res.set('Cache-Control', 'public, max-age=300'); // 5 min cache per player
  res.send(html);
});

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

// --- Shared match filter constants ---
// Used by fresh search, incremental fetch, admin pro-refresh, and the aim stats endpoint
// to exclude PvE modes and known practice/test maps from all stat calculations.
const FILTER_PVE_MODES = ['firefight','gruntpocalypse','attrition','pve'];
const FILTER_BAD_MAPS  = ['launch site','yuletide','octagon','aimbotz'];
function _isValidPvpMatch(m) {
  if (m.isCustom) return false;
  if (m.gameMode && FILTER_PVE_MODES.some(p => m.gameMode.toLowerCase().includes(p))) return false;
  if (m.mapName  && FILTER_BAD_MAPS.some(p => m.mapName.toLowerCase().includes(p))) return false;
  return true;
}

// Extract match duration in seconds from either:
//   m.durationSec — number, set on DB-reconstructed matches
//   m.duration    — ISO 8601 string ("PT9M30S"), set on live-fetched matches
// Returns 0 if neither is available or parseable.
function _matchDurSec(m) {
  if (typeof m.durationSec === 'number' && m.durationSec > 0) return m.durationSec;
  if (typeof m.duration === 'number'    && m.duration > 0)    return m.duration;
  if (typeof m.duration === 'string') {
    const mm = m.duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/);
    if (mm) return (parseInt(mm[1] || 0) * 3600) + (parseInt(mm[2] || 0) * 60) + parseFloat(mm[3] || 0);
  }
  return 0;
}

// --- Search cache (Redis-primary, in-memory fallback) ---
const searchCache = {}; // gamertag.lower -> { data, fetchedAt }
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours (incrementals keep data fresh)
const CACHE_TTL_SECONDS = 86400;        // Redis TTL in seconds
const _searchProgress = {}; // gamertag.lower -> { step, valid, total, ts }

// ── Background opponent/teammate snapshot queue ──────────────────────────────
// When a player is searched, we extract every unique opponent & teammate from
// their ranked match history and quietly build snapshots for them so the
// leaderboard grows organically. Throttled to 1 fetch per 2.5s to stay well
// within Halo API rate limits.
//
// Freshness gating (env-tunable):
//   SNAPSHOT_RECENT_TTL_HOURS         — skip players refreshed in this window (default 24)
//   SNAPSHOT_STALE_RESCAN_DAYS        — rescan cadence for snapshotted players (default 7)
//   SNAPSHOT_NO_NEW_DATA_COOLDOWN_DAYS — additional cooldown after N empty refreshes
//                                       (default 14)
//   SNAPSHOT_EMPTY_STRIKES            — empty-refresh strikes before cooldown kicks
//                                       in (default 2)
const SNAPSHOT_RECENT_TTL_HOURS = Math.max(1, parseInt(process.env.SNAPSHOT_RECENT_TTL_HOURS || '24', 10) || 24);
const SNAPSHOT_STALE_RESCAN_DAYS = Math.max(1, parseInt(process.env.SNAPSHOT_STALE_RESCAN_DAYS || '7', 10) || 7);
const SNAPSHOT_NO_NEW_DATA_COOLDOWN_DAYS = Math.max(1, parseInt(process.env.SNAPSHOT_NO_NEW_DATA_COOLDOWN_DAYS || '14', 10) || 14);
const SNAPSHOT_EMPTY_STRIKES = Math.max(1, parseInt(process.env.SNAPSHOT_EMPTY_STRIKES || '2', 10) || 2);

const _snapQueue = [];          // [ { xuid, gamertag } ]
const _snapQueued = new Set();  // xuid strings already in queue (dedup guard)
let _snapRunning = false;

// Returns true when xuid was refreshed within SNAPSHOT_RECENT_TTL_HOURS,
// regardless of whether the refresh produced new data. Caller passes the
// pre-fetched refresh-meta map.
function _isRecentlyRefreshed(meta) {
  if (!meta || !meta.lastRefreshTs) return false;
  const ageMs = Date.now() - meta.lastRefreshTs.getTime();
  return ageMs < SNAPSHOT_RECENT_TTL_HOURS * 3600 * 1000;
}

// Returns true when the player has accumulated >= SNAPSHOT_EMPTY_STRIKES
// empty refreshes AND the last empty refresh was within the cooldown window.
// These players are skipped in background scans so we don't keep hammering
// inactive accounts.
function _isInNoNewDataCooldown(meta) {
  if (!meta) return false;
  if ((meta.consecutiveEmptyRefreshes || 0) < SNAPSHOT_EMPTY_STRIKES) return false;
  if (!meta.lastNoNewDataTs) return false;
  const ageMs = Date.now() - meta.lastNoNewDataTs.getTime();
  return ageMs < SNAPSHOT_NO_NEW_DATA_COOLDOWN_DAYS * 86400000;
}

// Aggregate per-match counters into the same shape `stats` carries from the
// Halo service-record fetch. Used for reconstructed (private-profile) players
// where the service-record endpoint may return empty/zero — without this the
// Overview KDA/KD/Kills tiles render as "—" or "0.00" even though the
// reconstructed matches contain real numbers.
function aggregateStatsFromMatches(matches, base) {
  let ms = Array.isArray(matches) ? matches : [];
  if (!ms.length) return base || {};
  // Belt-and-suspenders: collapse by canonical matchId so a duplicate row
  // (e.g. reconstructed match also present in a fresh fetch on edge paths)
  // never inflates K/D, win-rate, kill totals, or matchesPlayed. Keeps the
  // first occurrence (callers pass DESC-sorted match lists, so newest wins).
  if (ms.length > 1) {
    const seen = new Set();
    const out = [];
    for (const m of ms) {
      const id = m && m.matchId;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(m);
    }
    ms = out;
  }
  const kills   = ms.reduce((s, m) => s + (m.kills   || 0), 0);
  const deaths  = ms.reduce((s, m) => s + (m.deaths  || 0), 0);
  const assists = ms.reduce((s, m) => s + (m.assists || 0), 0);
  const wins    = ms.filter(m => m.outcome === 2).length;
  const losses  = ms.filter(m => m.outcome === 3).length;
  const matchesPlayed = ms.length;
  // K/D — guard zero deaths by treating as raw kills (matches halo.js behavior
  // and what expanded match cards already display per-row).
  const kd = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
  // KDA per game — (K - D + A/3) averaged. Same formula as halo.js.
  const kda = matchesPlayed > 0
    ? ((kills - deaths + assists / 3) / matchesPlayed).toFixed(2)
    : (kills - deaths + assists / 3).toFixed(2);
  const accuracyVals = ms.map(m => m.accuracy != null ? parseFloat(m.accuracy) : null).filter(v => v != null && !isNaN(v));
  const accuracy = accuracyVals.length
    ? (accuracyVals.reduce((a, v) => a + v, 0) / accuracyVals.length).toFixed(1)
    : (base && base.accuracy != null ? base.accuracy : null);
  const damageDealt = ms.reduce((s, m) => s + (m.damageDealt || 0), 0);
  const damageTaken = ms.reduce((s, m) => s + (m.damageTaken || 0), 0);
  // Kills per minute: only count matches that (a) had a decisive outcome (no quits/cancels),
  // (b) actually started (duration > 60s), and (c) have kill data. This normalises across
  // game types with different kill counts (e.g. Oddball vs Slayer) and excludes bad matches.
  // _matchDurSec handles both live-fetched matches (duration ISO string) and DB matches (durationSec number).
  const kpmMatches = ms.filter(m =>
    (m.outcome === 2 || m.outcome === 3) &&
    _matchDurSec(m) > 60 &&
    m.kills != null
  );
  const kpmTotalDurMin = kpmMatches.reduce((s, m) => s + _matchDurSec(m) / 60, 0);
  const kpmTotalKills  = kpmMatches.reduce((s, m) => s + (m.kills || 0), 0);
  const killsPerMin = kpmTotalDurMin > 0 ? parseFloat((kpmTotalKills / kpmTotalDurMin).toFixed(2)) : null;
  // Damage per minute: same eligibility filter as KPM (decisive outcome, > 60s).
  const dpmMatches = kpmMatches.filter(m => m.damageDealt != null && m.damageDealt > 0);
  const dpmTotalDurMin = dpmMatches.reduce((s, m) => s + _matchDurSec(m) / 60, 0);
  const dpmTotalDmg    = dpmMatches.reduce((s, m) => s + (m.damageDealt || 0), 0);
  const damagePerMin = dpmTotalDurMin > 0 ? parseFloat((dpmTotalDmg / dpmTotalDurMin).toFixed(1)) : null;
  return {
    ...(base || {}),
    matchesPlayed, wins, losses,
    winRate: (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0.0',
    kills, deaths, assists,
    kd, kda,
    accuracy,
    killsPerMin,
    damagePerMin,
    // Legacy alias kept so any callers still referencing avgKillsPerGame get a value
    avgKillsPerGame: killsPerMin != null ? killsPerMin.toFixed(1) : (matchesPlayed > 0 ? (kills / matchesPlayed).toFixed(1) : '0.0'),
    damageDealt, damageTaken,
  };
}

// Dependencies bundle handed to the recovery queue so it can call into the
// same Halo / DB / freshness primitives the request path uses without
// importing them through indirect paths.
function _recoveryDeps() {
  return {
    fetchMatchHistory,
    saveMatchParticipants,
    getRecoverySeeds,
    countMatchesForXuid,
    getRefreshMeta,
    isRecentlyRefreshed: _isRecentlyRefreshed,
    isInNoNewDataCooldown: _isInNoNewDataCooldown,
  };
}

// Wrapper: only trigger recovery for reconstructed/private-history results,
// and surface the queue's metadata on the response. Never throws — all errors
// are absorbed inside recoveryQueue.
function _attachRecoveryMeta(result, gamertag) {
  if (!result || !result.reconstructed || !result.xuid) return;
  const known = result.reconstructedCount || (result.allMatches || result.recentMatches || []).length || 0;
  try {
    const meta = recoveryQueue.maybeQueueRecovery({
      xuid: result.xuid,
      gamertag: result.gamertag || gamertag,
      knownCount: known,
      deps: _recoveryDeps(),
    });
    if (meta) {
      result.recoveryQueued  = !!meta.recoveryQueued;
      result.recoveryStatus  = meta.recoveryStatus || null;
      result.recoverySeeds   = meta.recoverySeeds != null ? meta.recoverySeeds : null;
      result.recoveryDepth   = meta.recoveryDepth != null ? meta.recoveryDepth : null;
      result.recoveryKnown   = known;
      result.recoveryThreshold = meta.threshold != null ? meta.threshold : null;
    }
  } catch(e) {
    console.warn('[Recovery] attach meta failed:', e.message);
  }
}

async function _processSnapQueue() {
  if (_snapRunning) return;
  _snapRunning = true;
  while (_snapQueue.length > 0) {
    const { xuid, gamertag } = _snapQueue.shift();
    // Keep xuid in _snapQueued during the entire fetch so concurrent
    // enqueueOpponentSnapshots calls can't re-add it while it's in-flight.
    // We only delete it after the fetch (and markRefreshAttempt) complete.
    // Skip obviously unresolved gamertags ("Spartan 1234")
    if (/^Spartan\s+\w+$/i.test(gamertag)) { _snapQueued.delete(xuid); continue; }

    // If the match-list API is in backoff, pause the entire snap queue until it
    // clears — background snapshots are lower priority than live user searches
    // and should never burn the rate limit while users are getting 503s.
    if (isMatchListBackoffActive()) {
      const waitMs = matchListBackoffSecondsRemaining() * 1000 + 6000;
      console.log(`[SnapQueue] API in backoff — pausing queue ${Math.round(waitMs / 1000)}s`);
      _snapQueue.unshift({ xuid, gamertag }); // put item back at front
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    try {
      const result = await fetchPlayerStats(gamertag);
      if (result && result.xuid) {
        // Fetch a single batch of recent matches (25 max) so savePlayerSnapshot
        // can compute real kills-per-minute using actual match durations, instead
        // of falling back to the career API's kills/matchesPlayed ratio (KPG, not KPM).
        // lean:true skips rival resolution and advancedStats — we only need the matches.
        // batchLimit:1 keeps this to one match-list call + up to 25 detail calls.
        // Skip if the API is already in backoff — career stats fallback is fine.
        try {
          if (!isMatchListBackoffActive()) {
            const histData = await fetchMatchHistory(
              result.xuid, gamertag, 25,
              null, null,
              { batchLimit: 1, lean: true }
            );
            const snapMatches = (histData.matches || []).filter(_isValidPvpMatch);
            if (snapMatches.length > 0) {
              result.allMatches    = snapMatches;
              result.recentMatches = snapMatches;
            }
          }
        } catch(histErr) {
          console.warn(`[SnapQueue] match fetch failed for ${gamertag} (using career stats):`, histErr.message);
        }

        await savePlayerSnapshot(result);
        // Track refresh attempt so subsequent enqueue passes can skip recently
        // refreshed players and detect inactive accounts.
        const matchesPlayed = result.stats && result.stats.matchesPlayed != null
          ? Number(result.stats.matchesPlayed) : null;
        await markRefreshAttempt(result.xuid, gamertag, matchesPlayed).catch(() => null);
      }
    } catch(e) {
      // Non-fatal — player may have changed gamertag or be unavailable
      console.warn(`[SnapQueue] failed for ${gamertag}:`, e.message);
    }
    // Remove from in-flight guard only after fetch + markRefreshAttempt are done
    _snapQueued.delete(xuid);
    // Throttle: 6s between players — background snapshots are lower priority
    // than live searches and should consume API budget conservatively.
    await new Promise(r => setTimeout(r, 6000));
  }
  _snapRunning = false;
}

// Extract opponents + teammates from ranked matches and queue any we haven't
// snapshotted recently. myXuid is excluded so we don't re-queue the searcher.
//
// Two gating layers:
//   1. Snapshot freshness — players with a snapshot in the last
//      SNAPSHOT_STALE_RESCAN_DAYS (default 7d) are skipped.
//   2. Refresh-attempt freshness — players we've touched in the last
//      SNAPSHOT_RECENT_TTL_HOURS (default 24h) are skipped even if their
//      snapshot was unchanged, so a chain of co-player searches doesn't
//      re-enqueue the same teammates over and over.
//   3. No-new-data cooldown — players whose last N refreshes produced no new
//      matches are deprioritized for SNAPSHOT_NO_NEW_DATA_COOLDOWN_DAYS
//      (default 14d) so background scans don't burn rate-limit on inactive
//      accounts.
async function enqueueOpponentSnapshots(matches, myXuid) {
  if (!matches || !matches.length) return;
  const myXuidStr = String(myXuid || '');

  // Collect unique { xuid, gamertag } pairs from ranked match team rosters
  const seen = new Map(); // xuid -> gamertag
  for (const m of matches) {
    if (!m.isRanked || !m.teams) continue;
    for (const team of m.teams) {
      for (const pl of (team.players || [])) {
        const xu = String(pl.rawXuid || '');
        if (!xu || xu === myXuidStr || seen.has(xu)) continue;
        seen.set(xu, pl.gamertag || '');
      }
    }
  }
  if (!seen.size) return;

  // Filter to ones not already queued in-memory
  const candidates = [];
  for (const [xu, gt] of seen) {
    if (!_snapQueued.has(xu)) candidates.push({ xuid: xu, gamertag: gt });
  }
  if (!candidates.length) return;

  const xuids = candidates.map(c => c.xuid);
  // Two parallel DB checks: a recent snapshot wins outright, but we also need
  // refresh-meta to enforce the 24h re-fetch TTL and the no-new-data cooldown.
  const [alreadyDone, refreshMeta] = await Promise.all([
    getRecentlySnapshotted(xuids, SNAPSHOT_STALE_RESCAN_DAYS).catch(() => new Set()),
    getRefreshMeta(xuids).catch(() => new Map()),
  ]);

  const toQueue = [];
  let skipFresh = 0, skipRecentRefresh = 0, skipCooldown = 0;
  for (const c of candidates) {
    if (alreadyDone.has(c.xuid)) {
      skipFresh++;
      continue;
    }
    const meta = refreshMeta.get(String(c.xuid));
    if (_isRecentlyRefreshed(meta)) {
      skipRecentRefresh++;
      continue;
    }
    if (_isInNoNewDataCooldown(meta)) {
      skipCooldown++;
      continue;
    }
    toQueue.push(c);
  }

  // Sample logging so operators can see why bulk searches no longer reprocess
  // the same set of teammates. Aggregated counts keep log volume reasonable.
  if (skipFresh || skipRecentRefresh || skipCooldown) {
    const parts = [];
    if (skipFresh)         parts.push(`${skipFresh} fresh-snapshot (≤${SNAPSHOT_STALE_RESCAN_DAYS}d)`);
    if (skipRecentRefresh) parts.push(`${skipRecentRefresh} recently refreshed (≤${SNAPSHOT_RECENT_TTL_HOURS}h)`);
    if (skipCooldown)      parts.push(`${skipCooldown} no-new-data cooldown`);
    // skip log removed (noisy)
  }

  for (const c of toQueue) {
    _snapQueued.add(c.xuid);
    _snapQueue.push(c);
  }
  if (toQueue.length > 0) {
    console.log(`[SnapQueue] +${toQueue.length} players queued (${_snapQueue.length} total pending)`);
    // Kick off processor if not already running (fire-and-forget)
    _processSnapQueue().catch(e => console.warn('[SnapQueue] processor error:', e.message));
  }
}

// A cached match is "valid enough to anchor incremental fetch on" if it has
// a real matchId AND has been parsed past the stub stage (gameMode populated
// OR explicitly classified). Old caches from the PR #11 regression era could
// contain rows with `{matchId, kills:0, deaths:0, ...}` and no gameMode —
// using those as the incremental anchor stops the fetch after 25 raw matches
// without finding any ranked games. Detect that case so we can force a
// full refetch instead of trusting the stub.
function _isValidAnchorMatch(m) {
  if (!m || typeof m !== 'object') return false;
  if (!m.matchId) return false;
  // A valid parsed match always has gameMode set (even "Filtered" stubs do).
  // The pure-failure stub from the per-match catch sets gameMode: null.
  if (m.gameMode == null) return false;
  return true;
}

// Find the first cached match that's safe to use as the incremental anchor.
// Returns null if the cached list is empty or contains only stubs.
function _findValidAnchorId(cached) {
  const arr = (cached && (cached.allMatches || cached.recentMatches)) || [];
  for (const m of arr) {
    if (_isValidAnchorMatch(m)) return m.matchId;
  }
  return null;
}

async function getFromCache(gamertag) {
  const key = gamertag.toLowerCase().trim();

  // Try Redis first
  try {
    const redis = await getRedis();
    if (redis) {
      const raw = await redis.get('player:' + key);
      if (raw) {
        const parsed = JSON.parse(raw);
        searchCache[key] = { data: parsed, fetchedAt: Date.now() }; // sync to memory
        return parsed;
      }
    }
  } catch(e) {
    console.warn('[Cache] Redis get failed, falling back to memory:', e.message);
  }

  // Fallback: in-memory
  if (searchCache[key] && Date.now() - searchCache[key].fetchedAt < CACHE_TTL) {
    return searchCache[key].data;
  }
  return null;
}

async function saveToCache(gamertag, data) {
  const key = gamertag.toLowerCase().trim();

  // Always write to memory
  searchCache[key] = { data, fetchedAt: Date.now() };

  // Write to Redis async (don't await — never block the response)
  getRedis().then(redis => {
    if (!redis) return;
    redis.set('player:' + key, JSON.stringify(data), { EX: CACHE_TTL_SECONDS })
      .catch(e => console.warn('[Cache] Redis set failed:', e.message));
  }).catch(() => {});
}

// Deduplicate concurrent searches for the same gamertag
const searchInFlight = {};

// --- Medal meta (loaded once) ---
let medalMeta = {};
let _medalMetaFailedAt = 0;
const MEDAL_META_RETRY_MS = 15 * 60 * 1000; // 15 min cooldown after all sources fail
async function loadMedalMeta() {
  if (Object.keys(medalMeta).length) return;
  if (_medalMetaFailedAt && Date.now() - _medalMetaFailedAt < MEDAL_META_RETRY_MS) return; // still in cooldown
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
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
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
    if (!Object.keys(medalMeta).length) { _medalMetaFailedAt = Date.now(); console.log('[Medals] All sources failed — will retry in 15 min'); }
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
    const isAuthErr = e.message && (e.message.includes('401') || e.message.includes('403') || e.message.includes('clearance') || e.message.includes('Unauthorized'));
    res.json({ ok: false, message: isAuthErr
      ? 'Token expired/invalid (' + e.message + ') — click "force refresh token" to get a new one'
      : 'API error: ' + e.message });
  }
});

// Raw match detail dump — returns full Halo API JSON for a single match (for debugging)
app.get('/api/admin/match-raw', async (req, res) => {
  if (!adminAuth.checkAdminPass(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { matchId } = req.query;
  if (!matchId) return res.status(400).json({ error: 'matchId required' });
  try {
    const headers = getAuthHeaders();
    const url = `https://halostats.svc.halowaypoint.com/hi/matches/${matchId}/stats`;
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return res.status(r.status).json({ error: `Halo API ${r.status}`, url });
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
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

  // Enrich teams[].players[] with CSR data (per-match → snapshot fallback)
  // so the expanded match-detail table can always render rank badges. Old
  // cached blobs predating PR #5 carry no csrTier on team rosters; this fills
  // them in from match_participants / player_snapshots without re-hitting
  // Halo's API. Safe to call repeatedly — it only enriches missing slots.
  async function enrichForResponse(player) {
    if (!player) return player;
    const arr = player.allMatches || player.recentMatches;
    if (!Array.isArray(arr) || !arr.length) return player;
    try {
      await enrichMatchTeamsWithCsr(arr);
    } catch(e) {
      console.warn('[CSR-enrich] failed:', e.message);
    }
    return player;
  }

  // Check cache (skip if force refresh requested)
  const forceRefresh = req.query.force === '1';
  const key = gamertag.toLowerCase().trim();
  const cached = await getFromCache(gamertag);
  if (cached && !forceRefresh) {
    // Cached path is fast; only log when we end up doing real work
    // (incremental fetch or reconstruct retry).
    const _cachedT0 = Date.now();
    // Anchor incremental on the first cached match that's actually parsed —
    // a stub row (matchId only, no gameMode) would otherwise make us stop
    // after the first batch of 25 raw matches without ever scanning into
    // real ranked history. If no valid anchor exists, we skip incremental
    // and fall through to either reconstruct or full refresh.
    const newestCachedId = _findValidAnchorId(cached);
    const _hasAnyCachedMatch = !!(cached.allMatches || cached.recentMatches || []).length;
    if (_hasAnyCachedMatch && !newestCachedId) {
      console.log(`[Search] ${gamertag} cached matches present but no valid anchor (stub payload) — skipping incremental, will refresh below`);
    }

    // If the match-list endpoint is in shared backoff (recent 429/403 burst),
    // serve the cached payload immediately without firing another match-list
    // request. This is the core anti-hammer: every refresh poll arriving
    // during the cooldown returns cache instead of piling on more requests.
    if (isMatchListBackoffActive() && _hasAnyCachedMatch) {
      console.log(`[Search] ${gamertag} match-list in backoff (${matchListBackoffSecondsRemaining()}s) — serving stale cache`);
      logSearch(gamertag, req.headers['user-agent'], 'cached+stale-backoff', true, null);
      await enrichForResponse(cached);
      return res.json({ success: true, player: cached, cached: true, stale: true, reason: 'match-list-backoff' });
    }

    // ── Incremental fetch: only pull matches newer than what we have ──────────
    if (newestCachedId && cached.xuid) {
      try {
        _searchProgress[key] = { step: 2, valid: 0, total: 25, ts: Date.now() };
        const newHistData = await fetchMatchHistory(
          cached.xuid, gamertag, 100,
          (valid, scanned, total, retrying) => {
            _searchProgress[key] = { step: 2, valid, scanned, total, retrying: retrying || null, ts: Date.now() };
          },
          newestCachedId
        );
        setTimeout(() => { delete _searchProgress[key]; }, 10000);

        // fetchMatchHistory returns a temporary-unavailable shape when the
        // match-list backoff was armed mid-flight. Treat it the same as the
        // pre-flight short-circuit above: serve cache, do not overwrite it.
        if (newHistData.temporaryUnavailable) {
          console.log(`[Search] ${gamertag} match-list temporarily unavailable (${newHistData.reason}) — serving stale cache`);
          logSearch(gamertag, req.headers['user-agent'], 'cached+stale-backoff', true, null);
          await enrichForResponse(cached);
          return res.json({ success: true, player: cached, cached: true, stale: true, reason: newHistData.reason });
        }

        const rawNew = newHistData.matches || [];
        const filteredNew = rawNew.filter(_isValidPvpMatch);

        if (filteredNew.length > 0) {
          const existing = cached.allMatches || cached.recentMatches || [];
          const merged = [...filteredNew, ...existing].slice(0, 250);
          const advancedStats = computeAdvancedStats(merged);
          const haloDNA = generateHaloDNA(merged, advancedStats, null);
          // [Search/phase] timing log removed
          // Refresh player stats (CSR, service record) — fast, just 2-3 API calls
          const freshStats = await fetchPlayerStats(gamertag).catch(() => null);
          const updated = {
            ...(freshStats || cached),
            allMatches: merged,
            recentMatches: merged,
            advancedStats,
            haloDNA,
          };
          await saveToCache(gamertag, updated);
          logSearch(gamertag, req.headers['user-agent'], 'incremental', true, null);
          console.log(`[Incremental] ${filteredNew.length} new matches + fresh stats for ${gamertag}`);
          // Background: enrich new ranked matches with skill data (expectedKills, mmr, oppMmr)
          // Same pattern as fresh search — wait 1s for rate-limit headroom then mutate + re-cache.
          if (filteredNew.some(m => m.isRanked) && cached.xuid) {
            const _skillXuid = cached.xuid;
            setTimeout(() => {
              fetchAndApplySkillData(_skillXuid, merged)
                .then(() => {
                  saveToCache(gamertag, updated);
                  // Persist enriched skill data back to DB so it survives cache expiry
                  updatePlayerMatchSkillData(_skillXuid, merged)
                    .catch(e => console.warn('[SkillBG/incremental] DB skill persist failed:', e.message));
                })
                .catch(e => console.warn('[SkillBG/incremental] skill fetch failed:', e.message));
            }, 1000);
          }
          // Mark refresh — even an incremental fetch counts as touching this
          // player so co-player background scans honor the 24h TTL.
          if (cached.xuid) {
            const mp = (freshStats && freshStats.stats && freshStats.stats.matchesPlayed != null)
              ? Number(freshStats.stats.matchesPlayed)
              : ((updated.stats && updated.stats.matchesPlayed != null) ? Number(updated.stats.matchesPlayed) : null);
            markRefreshAttempt(cached.xuid, gamertag, mp).catch(() => {});
          }
          // Queue snapshots for any new opponents/teammates we haven't seen before
          enqueueOpponentSnapshots(filteredNew, cached.xuid).catch(() => {});
          // Persist participants for the newly-fetched matches.
          saveMatchParticipants(filteredNew, cached.xuid).catch(() => {});
          await enrichForResponse(updated);
          return res.json({ success: true, player: updated, newMatches: filteredNew.length });
        }
        // No new matches — fall through to cached response below
      } catch(e) {
        console.warn(`[Incremental] failed for ${gamertag}, returning cache:`, e.message);
        setTimeout(() => { delete _searchProgress[key]; }, 10000);
      }
    }

    // Return cached (no new matches, or no newestCachedId to anchor on)
    const _allM = cached.allMatches || cached.recentMatches || [];

    // ── Repair: stub-only cached payloads ─────────────────────────────────────
    // If the cache has matches but none of them are valid anchors (all stubs
    // with gameMode==null — e.g. cached during the PR #11 ReferenceError
    // window), invalidate this cache and fall through to a fresh fetch so the
    // user sees real ranked data instead of being stuck on stubs forever.
    if (_hasAnyCachedMatch && !newestCachedId && cached.xuid) {
      // Don't blow it away if the match list is in backoff — we already
      // returned stale cache above in that case, this guard is defensive.
      if (!isMatchListBackoffActive()) {
        console.warn(`[Search] ${gamertag} cached payload contains only stub matches (${_allM.length} entries) — invalidating cache and falling through to fresh fetch`);
        try { delete searchCache[key]; } catch (e) {}
        // Drop redis copy too so the next request can't re-hydrate the stub.
        try {
          const redis = await getRedis();
          if (redis) await redis.del('player:' + key);
        } catch (e) { /* non-fatal */ }
        // Fall through to the fresh-search code path below by NOT returning.
      }
    }
    // After the optional invalidation above, re-check cache. If we cleared
    // it, drop into the fresh path; otherwise continue with cached.
    const _stillCached = searchCache[key];
    if (!_stillCached) {
      // Skip the cached-response branch entirely and fall through to the
      // fresh `searchPromise` flow further down.
    } else {

    // ── Private-player: retry reconstruction on cached empty payloads ─────────
    // If we previously cached an empty match list (private profile / pre-backfill
    // cache) we will NOT have entered the incremental block above (no
    // newestCachedId). Backfill since then may have added participant rows for
    // this xuid — re-run reconstruct so the user sees the latest coverage
    // without needing a manual force-refresh.
    if (!_allM.length && cached.xuid) {
      try {
        const recon = await reconstructMatchHistoryForXuid(cached.xuid, 100);
        if (recon && recon.matches.length) {
          const updated = {
            ...cached,
            stats: aggregateStatsFromMatches(recon.matches, cached.stats),
            recentMatches: recon.matches,
            allMatches: recon.matches,
            privateHistory: true,
            reconstructed: true,
            reconstructedCount: recon.matches.length,
          };
          await saveToCache(gamertag, updated);
          console.log(`[Reconstruct/cached] ${gamertag} (${cached.xuid}) — surfaced ${recon.matches.length} matches from participants table`);
          logSearch(gamertag, req.headers['user-agent'], 'cached+reconstruct', true, null);
          await enrichForResponse(updated);
          _attachRecoveryMeta(updated, gamertag);
          return res.json({ success: true, player: updated, cached: true, reconstructed: true });
        }
      } catch (e) {
        console.warn('[Reconstruct/cached] failed:', e.message);
      }
    }
    // ── Reconstructed cache: refresh match field shape + recompute Overview ───
    // For cached payloads flagged `reconstructed:true` (private profile, served
    // from match_participants), older cache entries are missing the per-match
    // `csrValue`/`csrPreValue` fields and carry stale Overview `stats` from the
    // service-record fetch (often zeros for private profiles). That produces
    // two visible bugs:
    //   • Overview KDA / KD / Kills tiles render as "—" or "0.00" even though
    //     the expanded match cards already show real numbers per row.
    //   • The CSR History chart hides or plots tier indices because the new
    //     numeric csrValue field isn't present on the cached rows.
    // Re-running reconstruct is a single DB query against match_participants
    // and re-projects the rows into the current shape. Cheap, and heals the
    // payload on the next search without forcing the user to refresh.
    if (cached.reconstructed && cached.xuid) {
      try {
        const recon = await reconstructMatchHistoryForXuid(cached.xuid, 100);
        if (recon && recon.matches.length) {
          cached.recentMatches = recon.matches;
          cached.allMatches = recon.matches;
          cached.stats = aggregateStatsFromMatches(recon.matches, cached.stats);
          cached.reconstructedCount = recon.matches.length;
          cached.privateHistory = true;
          await saveToCache(gamertag, cached).catch(() => {});
        }
      } catch (e) {
        console.warn('[Reconstruct/cached-refresh] failed:', e.message);
      }
    }
    const _ranked = _allM.filter(m => m.isRanked && m.matchId);
    const _withSkill = _ranked.filter(m => m.expectedKills != null || m.mmr != null).length;
    if (_ranked.length > 0 && _withSkill < _ranked.length * 0.5) {
      const _skillXuid2 = cached.xuid;
      setTimeout(() => fetchAndApplySkillData(_skillXuid2, _allM)
        .then(() => {
          saveToCache(gamertag, cached);
          // Persist enriched skill data back to DB so it survives cache expiry
          updatePlayerMatchSkillData(_skillXuid2, _allM)
            .catch(e => console.warn('[SkillBG/cached] DB skill persist failed:', e.message));
        })
        .catch(e => console.warn('[SkillBG/cached] skill fetch failed:', e.message)), 1000);
    }
    if (_allM.length >= 10 && !cached.haloDNA) {
      try {
        const _adv = cached.advancedStats || computeAdvancedStats(_allM);
        cached.haloDNA = generateHaloDNA(_allM, _adv, null);
        saveToCache(gamertag, cached).catch(() => {});
      } catch(e) { /* non-fatal */ }
    }
    // Fill any null mapImageUrl values from in-memory cache (no API calls)
    fillCachedMapImages(cached.allMatches || cached.recentMatches || []);
    logSearch(gamertag, req.headers['user-agent'], 'cached', true, null);
    await enrichForResponse(cached);
    _attachRecoveryMeta(cached, gamertag);
    return res.json({ success: true, player: cached, cached: true });
    } // end else (_stillCached)
  }

  // Deduplicate concurrent searches
  if (searchInFlight[key]) {
    try {
      const result = await searchInFlight[key];
      logSearch(gamertag, req.headers['user-agent'], 'inflight', true, null);
      await enrichForResponse(result);
      _attachRecoveryMeta(result, gamertag);
      return res.json({ success: true, player: result });
    } catch(e) {
      logSearch(gamertag, req.headers['user-agent'], 'error', false, null); return res.status(404).json({ success: false, error: e.message });
    }
  }

  // No cache + match list in backoff — before returning a 503, try to serve
  // stale data reconstructed from match_participants. This lets returning players
  // see their stats even during a rate-limit window instead of a hard error screen.
  if (isMatchListBackoffActive()) {
    try {
      const dbXuid = await lookupXuidByGamertag(gamertag);
      if (dbXuid) {
        const recon = await reconstructMatchHistoryForXuid(dbXuid);
        let dbMatches = (recon && recon.matches) || [];
        if (dbMatches.length) {
          // Pull the most recent snapshot for rank + basic stats
          const _db = await getDb();
          const snapRow = _db ? await _db.query(
            `SELECT * FROM player_snapshots WHERE xuid = $1 ORDER BY ts DESC LIMIT 1`,
            [String(dbXuid)]
          ).then(r => r.rows[0] || null).catch(() => null) : null;

          const csrRaw = snapRow && snapRow.csr;
          const csr = csrRaw
            ? (typeof csrRaw === 'string' ? (() => { try { return JSON.parse(csrRaw); } catch { return null; } })() : csrRaw)
            : null;

          const dbFallback = {
            gamertag,
            xuid: dbXuid,
            allMatches:    dbMatches,
            recentMatches: dbMatches,
            csr,
            stats: snapRow ? {
              kd:            snapRow.kd,
              winRate:       snapRow.win_rate,
              accuracy:      snapRow.accuracy,
              killsPerMin:   snapRow.avg_kills,
              avgKillsPerGame: snapRow.avg_kills,
              matchesPlayed: snapRow.matches_played,
              wins:          snapRow.wins,
              losses:        snapRow.losses,
            } : {},
            emblemUrl:   null,
            gamerpicUrl: null,
            nameplateUrl: null,
          };
          await saveToCache(gamertag, dbFallback);
          console.log(`[Search] ${gamertag} no cache + backoff → DB fallback (${dbMatches.length} matches)`);
          logSearch(gamertag, req.headers['user-agent'], 'db-fallback+stale-backoff', true, null);
          await enrichForResponse(dbFallback);
          return res.json({ success: true, player: dbFallback, cached: true, stale: true, reason: 'match-list-backoff' });
        }
      }
    } catch(dbFallbackErr) {
      console.warn(`[Search] ${gamertag} DB fallback attempt failed:`, dbFallbackErr.message);
    }
    // No DB data available either — return a clean temporary-unavailable response
    console.warn(`[Search] ${gamertag} no cache + no DB data + match-list in backoff (${matchListBackoffSecondsRemaining()}s) — returning 503`);
    logSearch(gamertag, req.headers['user-agent'], 'temp-unavailable', false, null);
    return res.status(503).json({
      success: false,
      error: 'Halo API is temporarily rate-limited. Please try again in a minute.',
      reason: 'match-list-backoff',
      retryAfterSec: matchListBackoffSecondsRemaining(),
    });
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
    // Phase timing — logged once per fresh search so slow phases are visible
    // in production logs without needing a profiler attached.
    const _phT0 = Date.now();
    let _phLast = _phT0;
    const _phase = (label) => {
      const now = Date.now();
      // [Search/phase] timing log removed
      _phLast = now;
    };
    try {
      _searchProgress[key] = { step: 1, valid: 0, total: 250, ts: Date.now() };
      const playerStats = await fetchPlayerStats(gamertag);
      _phase('fetchPlayerStats');
      _searchProgress[key] = { step: 2, valid: 0, total: 250, ts: Date.now() };
      const histData = await fetchMatchHistory(playerStats.xuid, gamertag, 250, (valid, scanned, total, retrying) => {
        _searchProgress[key] = { step: 2, valid, scanned, total, retrying: retrying || null, ts: Date.now() };
      });
      _phase('fetchMatchHistory');
      // If the match list backoff fired mid-flight, do NOT overwrite the
      // existing cache with an empty payload — surface the temporary state
      // and let the caller (this request + any future ones) keep returning
      // the prior cache instead of a no-data record.
      if (histData && histData.temporaryUnavailable) {
        const err = new Error('match-list-backoff');
        err.code = 'TEMP_UNAVAILABLE';
        err.retryAfterSec = matchListBackoffSecondsRemaining();
        throw err;
      }
      _searchProgress[key] = { step: 3, valid: 250, total: 250, ts: Date.now() };
      const matches = (histData.matches || []).filter(_isValidPvpMatch).slice(0, 250);

      // ── Private-player fallback ────────────────────────────────────────────
      // Career stats came back but the match-history endpoint returned nothing
      // (private/restricted profile, or empty). Reconstruct what we can from
      // the participants table — rows captured from OTHER public players'
      // match details where this xuid appeared as a teammate or opponent.
      let reconstructed = false;
      let reconstructedCount = 0;
      let displayMatches = matches;
      let reconstructedStats = null;
      if (!matches.length && playerStats.xuid) {
        try {
          const recon = await reconstructMatchHistoryForXuid(playerStats.xuid, 100);
          if (recon && recon.matches.length) {
            displayMatches = recon.matches;
            reconstructed = true;
            reconstructedCount = recon.matches.length;
            // Service-record stats are often empty/zero for private profiles
            // — recompute Overview tiles (KDA, KD, kills, win rate, …) from
            // the reconstructed per-match data so the user sees real numbers
            // instead of "—" / "0.00".
            reconstructedStats = aggregateStatsFromMatches(recon.matches, playerStats.stats);
            console.log(`[Reconstruct] ${gamertag} (${playerStats.xuid}) — built ${reconstructedCount} matches from public match records`);
          } else {
            console.log(`[Reconstruct] ${gamertag} (${playerStats.xuid}) — no public match records found yet`);
          }
        } catch(e) {
          console.warn('[Reconstruct] failed:', e.message);
        }
        _phase('reconstructMatchHistoryForXuid');
      }

      const result = {
        ...playerStats,
        ...(reconstructedStats ? { stats: reconstructedStats } : {}),
        recentMatches: displayMatches,
        allMatches: displayMatches,
        rivals: histData.rivals || [],
        nemesisList: histData.nemesisList || [],
        victimsList: histData.victimsList || [],
        advancedStats: histData.advancedStats || {},
        haloDNA: histData.haloDNA || null,
        privateHistory: reconstructed,
        reconstructed: reconstructed,
        reconstructedCount,
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
    // Fill any team-roster slots that lack per-match CSR (e.g. unranked
    // teammates, or roster slots from old matches) with snapshot CSR so the
    // expanded match table can still render a badge.
    await enrichForResponse(result);
    // For private/reconstructed players with low coverage, kick off active
    // background recovery (teammate-history fetches). Non-blocking — the
    // queue returns metadata immediately and the heavy lifting happens
    // after the response is sent. The current search returns whatever rows
    // were already in the DB; the next search picks up the recovered matches.
    _attachRecoveryMeta(result, gamertag);
    res.json({ success: true, player: result });
    flushXuidCache(getXuidToGt()).catch(() => {});
    flushEmblemCache(getEmblemPathCache(), getNameplatePathCache()).catch(() => {});
    // Save player snapshot for rank comparison feature (fire and forget)
    savePlayerSnapshot(result).catch(() => {});
    // Update refresh metadata so background queue skips this player for the
    // next SNAPSHOT_RECENT_TTL_HOURS. Explicit user searches always count as a
    // refresh attempt regardless of whether new matches were found.
    if (result.xuid) {
      const mp = result.stats && result.stats.matchesPlayed != null ? Number(result.stats.matchesPlayed) : null;
      markRefreshAttempt(result.xuid, result.gamertag || gamertag, mp).catch(() => {});
    }
    // Queue snapshots for all opponents + teammates encountered in ranked matches
    const _bgMatchesForQueue = result.allMatches || result.recentMatches || [];
    enqueueOpponentSnapshots(_bgMatchesForQueue, result.xuid).catch(() => {});
    // Persist participants — powers private-player history reconstruction.
    saveMatchParticipants(_bgMatchesForQueue, result.xuid).catch(() => {});
    // If we just served a reconstructed history (private direct match endpoint),
    // schedule a background expansion: queue this player's frequent co-players
    // so the next visit has more coverage. We reuse the snapshot queue with its
    // built-in 2.5s throttle so we don't hammer the Halo API.
    if (result.reconstructed && result.xuid) {
      getFrequentCoPlayers(result.xuid, 15).then(coPlayers => {
        if (!coPlayers.length) return;
        const seedMatches = [{
          isRanked: true,
          teams: [{ players: coPlayers.map(c => ({ rawXuid: c.xuid, gamertag: c.gamertag })) }],
        }];
        return enqueueOpponentSnapshots(seedMatches, result.xuid);
      }).catch(e => console.warn('[Reconstruct] co-player expansion failed:', e.message));
    }
    // Background: enrich matches with skill data (hits skill.svc — separate rate limit from halostats)
    // We wait 2s first to let the halostats burst cool off, then mutate result in-place and re-cache.
    const _bgMatches = result.allMatches || result.recentMatches || [];
    if (_bgMatches.some(m => m.isRanked)) {
      const _skillXuid3 = result.xuid;
      setTimeout(() => {
        fetchAndApplySkillData(_skillXuid3, _bgMatches)
          .then(() => {
            saveToCache(gamertag, result);
            // Persist enriched skill data back to DB so it survives cache expiry
            updatePlayerMatchSkillData(_skillXuid3, _bgMatches)
              .catch(e => console.warn('[SkillBG] DB skill persist failed:', e.message));
          })
          .catch(e => console.warn('[SkillBG] Background skill fetch failed:', e.message));
      }, 2000);
    }
  } catch(e) {
    console.error('[Search] Error for', gamertag, ':', e.message);
    if (e.code === 'TEMP_UNAVAILABLE') {
      // Match list backoff fired mid-flight on a fresh search. Surface a
      // clean temporary state so the client can retry — do not 404 / 500.
      res.status(503).json({
        success: false,
        error: 'Halo API is temporarily rate-limited. Please try again in a minute.',
        reason: 'match-list-backoff',
        retryAfterSec: e.retryAfterSec || 60,
      });
    } else if (e.message.includes('Could not resolve gamertag') || e.message.includes('404')) {
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
const LATEST_CHECK_TTL = 15000;    // 15s TTL — fast enough to catch new games
// Lightweight activity times — just timestamps, up to 1000 matches
app.get('/api/activity-times', async (req, res) => {
  try {
    const { gamertag } = req.query;
    if (!gamertag) return res.json({ ok: false, times: [] });
    const key = gamertag.toLowerCase().trim();
    // Try searchCache first (various shapes), fall back to DB lookup
    const entry = searchCache[key];
    let xuid = (entry && (entry.xuid || (entry.data && entry.data.xuid))) || null;
    if (!xuid) xuid = await lookupXuidByGamertag(gamertag).catch(() => null);
    if (!xuid) return res.json({ ok: false, times: [] });
    const times = await getActivityTimes(xuid, 1000);
    res.json({ ok: true, times });
  } catch (e) {
    console.error('[activity-times]', e.message);
    res.json({ ok: false, times: [] });
  }
});

app.get('/api/latest-match', async (req, res) => {
  try {
    const { gamertag } = req.query;
    if (!gamertag) return res.json({ ok: false });
    const key = gamertag.toLowerCase().trim();

    // Get the xuid from our cache — we need it for the Waypoint call
    const entry = searchCache[key];
    const xuid = entry && entry.data && entry.data.xuid;
    if (!xuid) return res.json({ ok: false, reason: 'not_cached' });

    // Rate-limit: reuse the last check result for 60s — try Redis first, fall back to memory
    const _lmRedis = await getRedis().catch(() => null);
    if (_lmRedis) {
      try {
        const _lmRaw = await _lmRedis.get('latestmatch:' + key);
        if (_lmRaw) {
          const _lmParsed = JSON.parse(_lmRaw);
          return res.json({ ok: true, matchId: _lmParsed.matchId, startTime: _lmParsed.startTime, fromCache: true });
        }
      } catch(e) { /* fall through to memory */ }
    }
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

    // Persist result to Redis (60s TTL) and memory
    if (_lmRedis) {
      _lmRedis.set('latestmatch:' + key, JSON.stringify({ matchId: latestMatchId, startTime: latestStartTime }), { EX: 15 })
        .catch(() => {});
    }
    _latestMatchCheckCache[key] = { matchId: latestMatchId, startTime: latestStartTime, checkedAt: Date.now() };

    // If the new matchId differs from what's in the player cache, bust the cache
    // so the next /api/search picks up new matches via the incremental path
    const cachedMatches = entry.data.allMatches || entry.data.recentMatches || [];
    const cachedLatestId = cachedMatches[0] ? cachedMatches[0].matchId : null;
    if (latestMatchId && latestMatchId !== cachedLatestId) {
      delete searchCache[key];
      if (_lmRedis) _lmRedis.del('player:' + key).catch(() => {});
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
  // avg: skip null/zero rows so sparse columns (e.g. avg_damage before backfill) don't read as 0
  const avg = key => {
    const valid = rows.filter(r => r[key] != null && parseFloat(r[key]) > 0);
    if (!valid.length) return 0;
    return valid.reduce((s, r) => s + parseFloat(r[key]), 0) / valid.length;
  };
  // Mid-point percentile rank: count_below + 0.5 * count_equal, using display-precision
  // rounding so a player at the peer average always reads ~50th, not deceptively low.
  const PRECISION = { kd: 2, win_rate: 1, accuracy: 1, avg_kills: 2, avg_damage: 0 };
  const percentile = (key, val) => {
    if (val == null) return null;
    const dec = PRECISION[key] ?? 1;
    const round = v => Math.round(v * Math.pow(10, dec)) / Math.pow(10, dec);
    const rv = round(val);
    const sorted = rows.filter(r => r[key] != null && parseFloat(r[key]) > 0).map(r => round(parseFloat(r[key]))).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const below = sorted.filter(v => v < rv).length;
    const equal = sorted.filter(v => v === rv).length;
    return Math.round((below + equal * 0.5) / sorted.length * 100);
  };
  const ps = playerStats || {};
  return {
    count: rows.length,
    avg: {
      kd:         +avg('kd').toFixed(2),
      win_rate:   +avg('win_rate').toFixed(1),
      accuracy:   +avg('accuracy').toFixed(1),
      avg_kills:  +avg('avg_kills').toFixed(2),
      avg_damage: +avg('avg_damage').toFixed(0),
    },
    percentiles: ps.kd != null ? {
      kd:         percentile('kd',         ps.kd),
      win_rate:   percentile('win_rate',   ps.win_rate),
      accuracy:   percentile('accuracy',   ps.accuracy),
      avg_kills:  percentile('avg_kills',  ps.avg_kills),
      avg_damage: percentile('avg_damage', ps.avg_damage),
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
    // Use all matches with kill data for K/D; decisive-outcome + started matches for KPM.
    const validMatches = allMatchArr.filter(m => m && m.kills != null);
    if (validMatches.length >= 5) {
      const totalKills  = validMatches.reduce((s, m) => s + (m.kills || 0), 0);
      const totalDeaths = validMatches.reduce((s, m) => s + (m.deaths || 0), 0);
      // Win rate: only count decisive outcomes (2=win, 3=loss), ignore draws/unknown
      const wlMatches   = validMatches.filter(m => m.outcome === 2 || m.outcome === 3);
      const wins        = wlMatches.filter(m => m.outcome === 2).length;
      const accGames    = validMatches.filter(m => m.accuracy != null && parseFloat(m.accuracy) > 0);
      const avgAcc      = accGames.length ? accGames.reduce((s, m) => s + parseFloat(m.accuracy), 0) / accGames.length : null;
      // Kills per minute: exclude quit/cancelled matches and matches that didn't properly start.
      // This normalises across game types (Oddball vs Slayer have very different kill counts).
      const kpmMs      = validMatches.filter(m =>
        (m.outcome === 2 || m.outcome === 3) &&
        _matchDurSec(m) > 60
      );
      const kpmDurMin  = kpmMs.reduce((s, m) => s + _matchDurSec(m) / 60, 0);
      const kpmKills   = kpmMs.reduce((s, m) => s + (m.kills || 0), 0);
      const avgKpm     = kpmDurMin > 0 ? parseFloat((kpmKills / kpmDurMin).toFixed(2)) : null;
      const dpmMs      = kpmMs.filter(m => m.damageDealt != null && m.damageDealt > 0);
      const dpmDurMin  = dpmMs.reduce((s, m) => s + _matchDurSec(m) / 60, 0);
      const dpmDmg     = dpmMs.reduce((s, m) => s + (m.damageDealt || 0), 0);
      const avgDpm     = dpmDurMin > 0 ? parseFloat((dpmDmg / dpmDurMin).toFixed(1)) : null;
      playerStats = {
        kd:         totalDeaths > 0 ? parseFloat((totalKills / totalDeaths).toFixed(2)) : null,
        win_rate:   wlMatches.length > 0 ? parseFloat(((wins / wlMatches.length) * 100).toFixed(1)) : null,
        accuracy:   avgAcc != null ? parseFloat(avgAcc.toFixed(1)) : null,
        avg_kills:  avgKpm,
        avg_damage: avgDpm,
      };
      statsSource = 'recent';
      statsGames  = validMatches.length;
    } else {
      const s = player.stats || {};
      playerStats = {
        kd:         parseFloat(s.kd)              || null,
        win_rate:   parseFloat(s.winRate)         || null,
        accuracy:   parseFloat(s.accuracy)        || null,
        avg_kills:  parseFloat(s.killsPerMin)     || parseFloat(s.avgKillsPerGame) || null,
        avg_damage: parseFloat(s.damagePerMin)    || null,
      };
    }

    // For Onyx, bucket into 100-point CSR bands so 1500 ≠ 1900
    const onyxBandLow  = tier === 'Onyx' ? Math.min(Math.floor(csrValue / 100) * 100, 1900) : null;
    const onyxBandHigh = onyxBandLow != null ? (onyxBandLow >= 1900 ? null : onyxBandLow + 100) : null;
    const onyxLabel    = onyxBandLow != null ? (onyxBandHigh != null ? `Onyx ${onyxBandLow}–${onyxBandHigh - 1}` : `Onyx ${onyxBandLow}+`) : null;

    // Peer pool: when the user picked a non-Arena playlist, sample peers by
    // their CSR in THAT playlist (from snapshot.csr JSON). Without this the
    // pool would just be Arena peers at the same tier/subtier — the bug
    // we're fixing for non-Arena benchmarks.
    const playlistKey = pl; // 'Ranked Arena' | 'Ranked Slayer' | 'Ranked Legacy'
    const peerRows = await getSnapshotsByRank(tier, subTier, csrValue, playlistKey);
    const next = getNextRank(tier, subTier, csrValue);
    const nextRows = next ? await getSnapshotsByRank(next.tier, next.subTier, next.csrValue, playlistKey) : [];
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
// Reconstructed match history for private/restricted players.
// Looks up the player's xuid in our participants table — built from public
// match records captured while indexing other players' histories.
app.get('/api/reconstructed-history', async (req, res) => {
  try {
    const { gamertag, xuid: xuidParam, limit } = req.query;
    if (!gamertag && !xuidParam) return res.status(400).json({ error: 'gamertag or xuid required' });

    let xuid = xuidParam ? String(xuidParam) : null;
    if (!xuid && gamertag) {
      // Prefer the search cache (already-resolved xuid for canonical casing).
      const cached = await getFromCache(gamertag).catch(() => null);
      if (cached && cached.xuid) xuid = String(cached.xuid);
      if (!xuid) xuid = await lookupXuidByGamertag(gamertag).catch(() => null);
    }
    if (!xuid) return res.json({ available: false, reason: 'unknown_xuid', matches: [] });

    const lim = Math.min(parseInt(limit, 10) || 100, 250);
    const recon = await reconstructMatchHistoryForXuid(xuid, lim);
    const matches = recon.matches || [];

    // Lightweight summary: recent K/D, win rate, ranked-vs-social count, top map/mode
    let kd = null, winRate = null, ranked = 0, social = 0;
    if (matches.length) {
      const k = matches.reduce((s, m) => s + (m.kills  || 0), 0);
      const d = matches.reduce((s, m) => s + (m.deaths || 0), 0);
      const wl = matches.filter(m => m.outcome === 2 || m.outcome === 3);
      const wins = wl.filter(m => m.outcome === 2).length;
      kd = d > 0 ? +(k / d).toFixed(2) : null;
      winRate = wl.length ? +((wins / wl.length) * 100).toFixed(1) : null;
      ranked = matches.filter(m => m.isRanked).length;
      social = matches.length - ranked;
    }
    res.json({
      available: matches.length > 0,
      xuid,
      matchCount: matches.length,
      participantRowCount: recon.participantRowCount || 0,
      // Per-field enrichment counters: how many of the reconstructed matches
      // carry real (non-null) CoreStats / RankRecap data. Lets the UI tell
      // "0/12 damage_taken found" vs "12/12 — partial-coverage but rich".
      enrichmentCoverage: recon.enrichmentCoverage || {},
      summary: { kd, winRate, ranked, social },
      matches,
      banner: 'Official match history is private. Showing known matches found in public match records.',
      partial: true,
    });
  } catch(e) {
    console.error('[Reconstruct] endpoint error:', e.message);
    res.status(500).json({ error: e.message, matches: [] });
  }
});

// Admin diagnostic: status of the active match-history recovery queue.
// Returns config, currently-running runs (per xuid), and a ring-buffer of
// recent completed runs with their per-seed shared-hit metrics. Public-safe
// summary if `pass` is omitted; full details (per-seed gamertags, shared
// counts) only with admin auth.
app.get('/api/admin/recovery-status', async (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  const isAdmin = pass === (process.env.ADMIN_PASS || 'changeme');
  try {
    const cfg = recoveryQueue.getConfig();
    if (!isAdmin) {
      // Public summary — no per-seed gamertags or xuids leaked.
      const recent = recoveryQueue.getRecentRuns(10);
      return res.json({
        config: cfg,
        recentRunCount: recent.length,
        runningCount: recent.filter(r => !r.finishedAt).length,
      });
    }
    const xuidQ = req.query.xuid ? String(req.query.xuid) : null;
    if (xuidQ) {
      return res.json({
        xuid: xuidQ,
        status: recoveryQueue.getStatus(xuidQ),
        config: cfg,
      });
    }
    const recent = recoveryQueue.getRecentRuns(parseInt(req.query.limit, 10) || 25);
    res.json({
      config: cfg,
      recentRuns: recent,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin diagnostic: how many participant rows exist for an xuid/gamertag?
// Lets us tell at a glance whether a missing reconstructed history is a code
// bug or simple data coverage (target xuid never appeared in any indexed match).
app.get('/api/admin/participant-coverage', async (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== (process.env.ADMIN_PASS || 'changeme')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { gamertag, xuid: xuidParam } = req.query;
    if (!gamertag && !xuidParam) return res.status(400).json({ error: 'gamertag or xuid required' });

    let xuid = xuidParam ? String(xuidParam) : null;
    let resolution = xuid ? 'param' : null;
    if (!xuid && gamertag) {
      const cached = await getFromCache(gamertag).catch(() => null);
      if (cached && cached.xuid) { xuid = String(cached.xuid); resolution = 'cache'; }
      if (!xuid) {
        const lookup = await lookupXuidByGamertag(gamertag).catch(() => null);
        if (lookup) { xuid = lookup; resolution = 'lookup'; }
      }
    }
    if (!xuid) {
      return res.json({ xuid: null, gamertag: gamertag || null, resolved: false,
        reason: 'unknown_xuid — never searched and not present as a participant',
        recommendation: 'Search this player at least once so their xuid is resolved, or call /api/admin/backfill-participants to rebuild from cached blobs.' });
    }

    const db = await getXuidDb();
    if (!db) return res.status(503).json({ error: 'DB unavailable' });

    // Aggregate stats — total rows, distinct matches, ranked split, recent activity.
    const stats = await db.query(`
      SELECT COUNT(*)::int AS rows,
             COUNT(DISTINCT match_id)::int AS distinct_matches,
             COUNT(*) FILTER (WHERE is_ranked)::int AS ranked,
             COUNT(*) FILTER (WHERE NOT is_ranked OR is_ranked IS NULL)::int AS social,
             MIN(start_time) AS oldest,
             MAX(start_time) AS newest,
             COUNT(DISTINCT source_xuid)::int AS distinct_sources
      FROM match_participants
      WHERE xuid = $1
    `, [String(xuid)]);
    const row = stats.rows[0] || {};
    const rowCount = row.rows || 0;

    let recommendation = null;
    if (rowCount === 0) {
      recommendation = 'No indexed rows for this xuid yet. The target player has never appeared in any cached public match. '
        + 'Run /api/admin/backfill-participants (dry-run=false) to (re)index, or wait for more public players who share matches with the target to be searched.';
    } else if (rowCount < 5) {
      recommendation = 'Very low coverage — reconstruction will surface a small number of matches. '
        + 'Search known co-players (teammates/opponents) to grow coverage organically.';
    } else {
      recommendation = `OK — ${row.distinct_matches} distinct matches indexed. Reconstruction should surface these on next search. `
        + 'If the player UI still shows career-only with no reconstructed banner, clear their Redis player:* cache or use ?force=1.';
    }

    res.json({
      xuid,
      gamertag: gamertag || null,
      resolved: true,
      resolution,
      rowCount,
      distinctMatches: row.distinct_matches || 0,
      ranked: row.ranked || 0,
      social: row.social || 0,
      oldest: row.oldest,
      newest: row.newest,
      distinctSources: row.distinct_sources || 0,
      recommendation,
    });
  } catch(e) {
    console.error('[ParticipantCoverage] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/matches', async (req, res) => {
  try {
    const { gamertag, page = 1, perPage = 100 } = req.query;
    if (!gamertag) return res.status(400).json({ error: 'gamertag required' });

    const cached = await getFromCache(gamertag);
    const memMatches = cached?.allMatches || cached?.recentMatches || [];

    // ── Filter + paginate ────────────────────────────────────────────────────
    const ranked = req.query.ranked === '1';
    const all = ranked ? memMatches.filter(m => m.isRanked) : memMatches;
    const pg = parseInt(page) || 1;
    const pp = Math.min(parseInt(perPage) || 100, 2000);
    const totalPages = Math.max(1, Math.ceil(all.length / pp));
    const matches = all.slice((pg-1)*pp, (pg-1)*pp+pp);
    fillCachedMapImages(matches);

    res.json({ matches, page: pg, perPage: pp, totalPages, total: all.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// Medal sprite sheet proxy
app.get('/api/medal-sheet', async (req, res) => {
  try {
    const headers = getAuthHeaders();
    const sheetRes = await fetch('https://gamecms-hacs.svc.halowaypoint.com/hi/Waypoint/file/medals/images/medal_sheet_xl.png', { headers, signal: AbortSignal.timeout(15000) });
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
    const r = await fetch(`https://gamecms-hacs.svc.halowaypoint.com/hi/${withFile}`, { headers, signal: AbortSignal.timeout(15000) });
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
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
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
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
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
    // Persist rotated refresh token so it isn't lost
    if (msData.refresh_token && msData.refresh_token !== process.env.MS_REFRESH_TOKEN) {
      process.env.MS_REFRESH_TOKEN = msData.refresh_token;
      getRedis().then(r => r && r.set('msRefreshToken', msData.refresh_token)).catch(() => {});
    }
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
    signal: AbortSignal.timeout(15000),
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
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
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

// ── Leaderboard ──────────────────────────────────────────────────────────────
// ── Leaderboard in-memory cache (2 min TTL) ──────────────────────────────────
const _lbTabCache = {}; // per-tab cache: { csrArena: { data, ts }, ... }
const LB_CACHE_TTL = 5 * 60 * 1000; // 5 min server-side per tab
const VALID_LB_TABS = new Set(['csrArena', 'csrSlayer', 'csrLegacy', 'csrDoubles', 'kd', 'winRate']);

app.get('/api/leaderboard', async (req, res) => {
  try {
    const now = Date.now();
    const force = req.query.force === '1';
    const tab = VALID_LB_TABS.has(req.query.tab) ? req.query.tab : 'csrArena';
    const cached = _lbTabCache[tab];
    if (!force && cached && (now - cached.ts) < LB_CACHE_TTL) {
      res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=60');
      res.set('X-Cache', 'HIT');
      return res.json({ rows: cached.data });
    }
    const limit = parseInt(req.query.limit) || 100000;
    const rows = await getLeaderboardTab(tab, limit);
    _lbTabCache[tab] = { data: rows, ts: now };
    res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=60');
    res.set('X-Cache', 'MISS');
    res.json({ rows });
  } catch(e) {
    console.error('[Leaderboard]', e.message);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
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
      // Minimum thresholds for a valid pro snapshot.
      // Below these = wrong account, inactive, smurf, or bad data — skip snapshot save.
      const MIN_RANKED_MATCHES = 10;  // need at least 10 ranked games to be useful
      const MIN_KD             = 0.7; // below 0.7 K/D is not pro-level, likely wrong account
      const MIN_ACCURACY       = 28;  // below 28% accuracy is unreliable / non-competitive
      const MIN_KPM            = 0.5; // below 0.5 kills/min is a data red flag (quit-heavy or wrong account)

      for (const pro of pros) {
        try {
          console.log(`[Admin/refreshPros] Fetching ${pro.gamertag}…`);
          const playerStats = await fetchPlayerStats(pro.gamertag);
          const histData    = await fetchMatchHistory(playerStats.xuid, pro.gamertag, 100, () => {});
          const matches = (histData.matches || []).filter(_isValidPvpMatch).slice(0, 100);

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
          // KPM: only matches with valid duration, normalises across game types
          const kpmMs = rankedMs.filter(m => _matchDurSec(m) > 60);
          const kpmDurMin = kpmMs.reduce((s,m) => s + _matchDurSec(m)/60, 0);
          const kpmKills  = kpmMs.reduce((s,m) => s + (m.kills||0), 0);
          const kpm = kpmDurMin > 0 ? kpmKills / kpmDurMin : null;

          const flags = [];
          if (kd < MIN_KD)                         flags.push(`K/D ${kd.toFixed(2)} < ${MIN_KD}`);
          if (acc!=null && acc < MIN_ACCURACY)      flags.push(`acc ${acc.toFixed(1)}% < ${MIN_ACCURACY}%`);
          if (kpm!=null && kpm < MIN_KPM)           flags.push(`KPM ${kpm.toFixed(2)} < ${MIN_KPM}`);

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

// ── Admin: force-recompute avg_kills (KPM) across all snapshots ──────────────
// Fixes the legacy data problem where avg_kills was stored as kills-per-game
// (KPG, typically 5-20) instead of kills-per-minute (KPM, typically 0.5-2.5).
//
// Two-pass approach:
//   Pass 1 — re-compute KPM from match_participants rows (real per-match duration
//             and kill data we already have in the DB). Updates all snapshots for
//             any xuid that has >= 5 qualifying rows.
//   Pass 2 — NULL out any remaining avg_kills > 3.5 (impossible KPM, clearly old
//             KPG values we couldn't fix from participant data).  The benchmark
//             will show "—" for those players until they're re-searched naturally.
app.post('/api/admin/fix-kpm', async (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== (process.env.ADMIN_PASS || 'changeme')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const db = await getDb();
    if (!db) return res.status(503).json({ error: 'No DB' });

    // Pass 1: re-compute KPM from match_participants for every xuid with enough data.
    // Filters: completed matches (outcome 2=win, 3=loss), duration > 60s, kills not null.
    // Excludes known PVE modes and practice maps (same logic as _isValidPvpMatch).
    // Caps at KPM <= 5 as a sanity guard (anything higher is almost certainly bad data).
    const pass1 = await db.query(`
      WITH kpm_calc AS (
        SELECT
          xuid,
          ROUND(
            SUM(kills)::numeric / NULLIF(SUM(duration_sec) / 60.0, 0),
            2
          ) AS kpm_value,
          COUNT(*) AS match_count
        FROM match_participants
        WHERE outcome IN (2, 3)
          AND is_ranked = true
          AND duration_sec > 60
          AND kills IS NOT NULL
          AND (game_mode IS NULL OR (
            game_mode NOT ILIKE '%firefight%'
            AND game_mode NOT ILIKE '%gruntpocalypse%'
            AND game_mode NOT ILIKE '%attrition%'
            AND game_mode NOT ILIKE '%pve%'
          ))
          AND (map_name IS NULL OR (
            map_name NOT ILIKE '%launch site%'
            AND map_name NOT ILIKE '%yuletide%'
            AND map_name NOT ILIKE '%octagon%'
            AND map_name NOT ILIKE '%aimbotz%'
          ))
        GROUP BY xuid
        HAVING COUNT(*) >= 3
      )
      UPDATE player_snapshots ps
      SET avg_kills = kpm_calc.kpm_value
      FROM kpm_calc
      WHERE kpm_calc.xuid = ps.xuid
        AND kpm_calc.kpm_value IS NOT NULL
        AND kpm_calc.kpm_value <= 5
    `);

    // Pass 2: compute DPM from match_participants for every xuid with enough data.
    // Same ranked-only, duration > 60s filters as KPM. Caps at 2000 DPM as sanity guard.
    const pass2 = await db.query(`
      WITH dpm_calc AS (
        SELECT
          xuid,
          ROUND(
            SUM(damage)::numeric / NULLIF(SUM(duration_sec) / 60.0, 0),
            1
          ) AS dpm_value,
          COUNT(*) AS match_count
        FROM match_participants
        WHERE outcome IN (2, 3)
          AND is_ranked = true
          AND duration_sec > 60
          AND damage IS NOT NULL
          AND (game_mode IS NULL OR (
            game_mode NOT ILIKE '%firefight%'
            AND game_mode NOT ILIKE '%gruntpocalypse%'
            AND game_mode NOT ILIKE '%attrition%'
            AND game_mode NOT ILIKE '%pve%'
          ))
          AND (map_name IS NULL OR (
            map_name NOT ILIKE '%launch site%'
            AND map_name NOT ILIKE '%yuletide%'
            AND map_name NOT ILIKE '%octagon%'
            AND map_name NOT ILIKE '%aimbotz%'
          ))
        GROUP BY xuid
        HAVING COUNT(*) >= 3
      )
      UPDATE player_snapshots ps
      SET avg_damage = dpm_calc.dpm_value
      FROM dpm_calc
      WHERE dpm_calc.xuid = ps.xuid
        AND dpm_calc.dpm_value IS NOT NULL
        AND dpm_calc.dpm_value <= 2000
    `);

    // Pass 3: NULL out any remaining avg_kills that are clearly old KPG (> 3.5).
    const pass3 = await db.query(`
      UPDATE player_snapshots
      SET avg_kills = NULL
      WHERE avg_kills > 3.5
    `);

    console.log(`[Admin/fixKpm] Pass 1: ${pass1.rowCount} KPM rows updated. Pass 2: ${pass2.rowCount} DPM rows updated. Pass 3: ${pass3.rowCount} stale KPG rows nulled.`);
    res.json({
      ok: true,
      updated_kpm: pass1.rowCount,
      updated_dpm: pass2.rowCount,
      nulled_stale_kpg: pass3.rowCount,
      message: `KPM fixed for ${pass1.rowCount} rows. DPM computed for ${pass2.rowCount} rows. ${pass3.rowCount} stale KPG values cleared.`,
    });
  } catch(e) {
    console.error('[Admin/fixKpm] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/pro-players', express.json(), async (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'];
  if (pass !== (process.env.ADMIN_PASS || 'changeme')) return res.status(401).json({ error: 'Unauthorized' });
  const { xuid } = req.body || {};
  if (!xuid) return res.status(400).json({ error: 'xuid required' });
  try { await removeProPlayer(xuid); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: HTTP trigger for match_participants backfill ──────────────────────
// Production data op. Defaults to dry-run. Real writes require BOTH
// `dryRun:false` AND `confirm:true` in the JSON body. Concurrency-locked.
// Auth uses src/auth.js (constant-time compare, refuses placeholder secrets);
// since secrets() throws on misconfiguration, we catch and fail closed with
// 503 instead of leaking a stack trace.
const BACKFILL_API_LIMITS = {
  defaultLimit: 200,    // canary-sized default; the user can ask for more, up to MAX
  maxLimit: 5000,       // hard cap per HTTP-triggered run to avoid Render timeouts
  defaultBatchSize: 100,
  maxBatchSize: 1000,
  defaultScanCount: 200,
  maxScanCount: 2000,
};
let _backfillRunning = null; // { startedAt: number, dryRun: boolean } when active

function checkAdminFailClosed(req, res) {
  try {
    if (!adminAuth.checkAdminPass(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
    return true;
  } catch (e) {
    // secrets() throws on missing/placeholder/short ADMIN_PASS — refuse rather than
    // accidentally exposing the endpoint with a leftover default.
    console.error('[Admin/backfill] admin auth misconfigured:', e.message);
    res.status(503).json({ error: 'Admin auth misconfigured — set ADMIN_PASS to a strong value.' });
    return false;
  }
}

function clampInt(value, fallback, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

app.post('/api/admin/backfill-participants', express.json(), async (req, res) => {
  if (!checkAdminFailClosed(req, res)) return;

  if (_backfillRunning) {
    return res.status(409).json({
      error: 'Backfill already running',
      since: new Date(_backfillRunning.startedAt).toISOString(),
      dryRun: _backfillRunning.dryRun,
    });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  // Fail closed: anything other than the explicit pair (dryRun:false + confirm:true)
  // is treated as a dry-run.
  const dryRun = !(body.dryRun === false && body.confirm === true);

  const options = {
    dryRun,
    limit: clampInt(body.limit, BACKFILL_API_LIMITS.defaultLimit, BACKFILL_API_LIMITS.maxLimit),
    batchSize: clampInt(body.batchSize, BACKFILL_API_LIMITS.defaultBatchSize, BACKFILL_API_LIMITS.maxBatchSize),
    scanCount: clampInt(body.scanCount, BACKFILL_API_LIMITS.defaultScanCount, BACKFILL_API_LIMITS.maxScanCount),
    keyPattern: (typeof body.keyPattern === 'string' && body.keyPattern.length > 0 && body.keyPattern.length < 200)
      ? body.keyPattern : 'player:*',
    verbose: !!body.verbose,
  };

  // Pre-flight: real runs require DATABASE_URL. Surface that as 400 rather than
  // letting saveMatchParticipants fail per-player.
  if (!options.dryRun && !process.env.DATABASE_URL) {
    return res.status(400).json({ error: 'DATABASE_URL not configured — cannot run live backfill.' });
  }

  // Reuse the running server's Redis client. If Redis is unavailable the
  // backfill cannot proceed at all.
  const redis = await getRedis();
  if (!redis) {
    return res.status(503).json({ error: 'Redis not available — cannot scan cached player blobs.' });
  }

  _backfillRunning = { startedAt: Date.now(), dryRun: options.dryRun };
  try {
    const result = await runBackfill({
      redis,
      saveMatchParticipants,
      options,
      logger: {
        log:  (...a) => console.log('[Admin/backfill]', ...a),
        warn: (...a) => console.warn('[Admin/backfill]', ...a),
      },
    });
    res.json({
      ok: true,
      dryRun: result.dryRun,
      requested: options,
      counters: {
        keysScanned: result.keysScanned,
        playersParsed: result.playersParsed,
        playersSkippedNoXuid: result.playersSkippedNoXuid,
        playersSkippedMalformed: result.playersSkippedMalformed,
        matchesFound: result.matchesFound,
        matchesEligible: result.matchesEligible,
        rowsWrittenReported: result.rowsWrittenReported,
        errors: result.errors,
      },
      elapsedSeconds: result.elapsedSeconds,
    });
  } catch (e) {
    console.error('[Admin/backfill] FATAL:', e && e.stack || e);
    res.status(500).json({ error: e.message || String(e) });
  } finally {
    _backfillRunning = null;
  }
});

// ── Admin: search log UI ──────────────────────────────────────────────────────
app.get('/api/admin/gamemode-debug', (req, res) => {
  if (!adminAuth.checkAdminPass(req)) return res.status(401).json({ error: 'Unauthorized' });
  const entries = getGameModeDebugLog();
  res.json({ entries, count: entries.length, serverStarted: _serverStartTime });
});

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
    <table style="width:auto;font-size:11px"><thead><tr><th>PLAYLIST ID</th><th>NAME</th><th>EXP</th><th>GAME MODE</th><th>CAT</th><th>PLAYERS</th><th>TEAMS</th><th>FFA</th><th>MAP</th><th>DUR</th><th>MATCHES</th><th></th></tr></thead><tbody id="disc-tbody"></tbody></table>
  </div>
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
  <h2>// gamemode debug log</h2>
  <div class="action-row" style="margin-bottom:8px">
    <button class="action-btn" onclick="loadGamemodeDebug()">↺ refresh</button>
    <span id="gm-meta" style="font-size:10px;color:#555">last 100 non-ranked games processed — newest first</span>
  </div>
  <div class="table-wrap"><table id="gm-table"><thead><tr><th>TIME</th><th>GAMERTAG</th><th>MATCH ID</th><th>RESOLVED NAME</th><th>UGC NAME</th><th>PLAYLIST NAME</th><th>PLAYLIST ID</th><th>EXPERIENCE</th><th>CAT#</th></tr></thead><tbody id="gmtbody"><tr><td colspan="9" class="muted">Loading...</td></tr></tbody></table></div>
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

  function showDiscRaw(i){
    var existing=document.getElementById('disc-raw-overlay');
    if(existing){existing.remove();}
    var el=document.createElement('div');
    el.id='disc-raw-overlay';
    el.style.cssText='position:fixed;top:5%;left:5%;width:90%;max-height:88vh;overflow:auto;background:#111;border:1px solid #444;padding:16px;font-size:11px;z-index:9999;border-radius:6px';
    var closeBtn=document.createElement('button');
    closeBtn.textContent='x close';
    closeBtn.style.cssText='float:right;background:#333;border:1px solid #555;color:#aaa;cursor:pointer;padding:2px 8px;border-radius:3px';
    closeBtn.onclick=function(){el.remove();};
    var pre=document.createElement('pre');
    pre.style.cssText='white-space:pre-wrap;margin-top:24px;color:#ccc';
    pre.textContent=JSON.stringify(window._discRawData[i]||{},null,2);
    el.appendChild(closeBtn);
    el.appendChild(pre);
    document.body.appendChild(el);
  }
  function discoverPlaylists(){
    var gt=(document.getElementById('disc-gt').value||'').trim();
    if(!gt){alert('Enter a gamertag first');return;}
    var resultDiv=document.getElementById('disc-result');
    var tbody=document.getElementById('disc-tbody');
    tbody.innerHTML='<tr><td colspan="12" class="muted">scanning…</td></tr>';
    resultDiv.style.display='block';
    fetch('/api/discover-playlists?gamertag='+encodeURIComponent(gt))
      .then(function(r){return r.json();})
      .then(function(d){
        if(d.error){tbody.innerHTML='<tr><td colspan="12" style="color:#f44336">'+d.error+'</td></tr>';return;}
        var rows=d.playlists||[];
        if(!rows.length){tbody.innerHTML='<tr><td colspan="12" class="muted">no playlists found</td></tr>';return;}
        window._discRawData={};
        tbody.innerHTML=rows.map(function(p,i){
          var known=['edfef3ac-9cbe-4fa2-b949-8f29deafd483','f5580605-660c-43f9-ac69-4075c4a05c5d','dcb2e24e-05fb-4390-8076-32a0cdb4326e'];
          var isNew=known.indexOf(p.id)===-1;
          var dur=p.durationSec?Math.floor(p.durationSec/60)+'m'+(p.durationSec%60)+'s':'';
          window._discRawData[i]=p.rawMatchInfo||{};
          return'<tr>'
            +'<td style="font-family:monospace;font-size:10px;color:'+(isNew?'#ffc107':'#555')+'">'+p.id+(isNew?' ★':'')+'</td>'
            +'<td style="color:'+(isNew?'#00d4ff':'#ccc')+'">'+p.name+'</td>'
            +'<td class="muted">'+p.exp+'</td>'
            +'<td class="muted" style="color:#aaa">'+(p.gameVariant||'')+'</td>'
            +'<td class="muted">'+p.gameCategory+'</td>'
            +'<td class="muted">'+p.playerCount+'</td>'
            +'<td class="muted">'+p.teamCount+'</td>'
            +'<td class="muted">'+(p.teamsEnabled===false?'<span style="color:#ffc107">YES</span>':'')+'</td>'
            +'<td class="muted" style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+p.mapName+'">'+p.mapName+'</td>'
            +'<td class="muted">'+dur+'</td>'
            +'<td>'+p.count+'</td>'
            +'<td><button onclick="showDiscRaw('+i+')" style="font-size:9px;padding:2px 6px;background:#222;border:1px solid #444;color:#aaa;cursor:pointer;border-radius:3px">RAW</button></td>'
            +'</tr>';
        }).join('');
      })
      .catch(function(e){tbody.innerHTML='<tr><td colspan="12" style="color:#f44336">'+e.message+'</td></tr>';});
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

  function loadGamemodeDebug(){
    fetch('/api/admin/gamemode-debug?pass=${pass}').then(function(r){return r.json();}).then(function(d){
      var meta=document.getElementById('gm-meta');
      if(meta) meta.textContent='entries: '+(d.count||0)+' | server started: '+(d.serverStarted||'?');
      var rows=d.entries||[];
      var tb=document.getElementById('gmtbody');
      if(!rows.length){tb.innerHTML='<tr><td colspan="9" class="muted">No non-ranked games logged yet — play some games and reload</td></tr>';return;}
      tb.innerHTML=rows.map(function(e){
        var ts=new Date(e.ts).toISOString().replace('T',' ').slice(0,19);
        var mid=e.matchId?e.matchId.slice(0,8)+'…':'--';
        var ugcName=(e.UgcGameVariant&&e.UgcGameVariant.Name)||'<span class="muted">--</span>';
        var plName=e.PlaylistName||'<span class="muted">--</span>';
        var plId=e.PlaylistId?('<span style="font-family:monospace;font-size:10px;color:#555">'+e.PlaylistId.slice(0,8)+'…</span>'):'<span class="muted">--</span>';
        var exp=e.PlaylistExperience||'<span class="muted">--</span>';
        var cat=e.GameVariantCategory!=null?e.GameVariantCategory:'<span class="muted">--</span>';
        var resolved=e.resolvedName?('<span style="color:#00d4ff">'+e.resolvedName+'</span>'):'<span class="loss">--</span>';
        return'<tr>'
          +'<td class="muted" style="white-space:nowrap">'+ts+'</td>'
          +'<td style="color:#00d4ff">'+e.gamertag+'</td>'
          +'<td style="font-family:monospace;font-size:10px;color:#555">'+mid+'</td>'
          +'<td>'+resolved+'</td>'
          +'<td>'+ugcName+'</td>'
          +'<td>'+plName+'</td>'
          +'<td>'+plId+'</td>'
          +'<td class="muted">'+exp+'</td>'
          +'<td class="muted">'+cat+'</td>'
          +'</tr>';
      }).join('');
    }).catch(function(e){document.getElementById('gmtbody').innerHTML='<tr><td colspan="9" style="color:#f44336">Error: '+e.message+'</td></tr>';});
  }
  loadData();loadFeedback();loadCache();loadGamemodeDebug();setInterval(loadData,30000);setInterval(loadFeedback,60000);setInterval(loadCache,15000);setInterval(loadGamemodeDebug,30000);
</script></body></html>`);
});

// ── Aim Calibration ───────────────────────────────────────────────────────────
// Personal hidden page — protected by CALIBRATE_KEY env var (default: 'calibrate')

const CAL_KEY = process.env.CALIBRATE_KEY || 'calibrate';

// Analysis endpoint — POST with settings JSON, returns recommendations
app.post('/api/calibrate', express.json(), async (req, res) => {
  const { key, gamertag, sensitivityH, sensitivityV, innerDead, outerDead, axialDead, fov,
          deadzoneType, viewingDist, acceleration, tzOffset,
          zoomSens, vibration } = req.body || {};
  if (key !== CAL_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!gamertag) return res.status(400).json({ error: 'Gamertag required' });

  // Try cache first; if expired or missing, do a live fetch so calibration
  // works at any time without needing a recent search on the main app.
  let player = await getFromCache(gamertag);
  if (!player) {
    console.log('[Calibrate] Cache miss for', gamertag, '— fetching live from Halo API');
    try {
      const playerStats = await fetchPlayerStats(gamertag);
      const histData    = await fetchMatchHistory(playerStats.xuid, gamertag, 100, () => {});
      const filteredMatches = (histData.matches || []).filter(_isValidPvpMatch).slice(0, 100);
      player = { ...playerStats, allMatches: filteredMatches, recentMatches: filteredMatches };
      await saveToCache(gamertag, player);
    } catch(fetchErr) {
      console.error('[Calibrate] Live fetch failed:', fetchErr.message);
      return res.json({ ok: false, error: 'Could not load player data — check that "' + gamertag + '" is a valid Xbox gamertag and has played Halo Infinite.' });
    }
  }

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
  const sensH       = parseFloat(sensitivityH) || 3;
  const sensV       = parseFloat(sensitivityV) || 3;
  const iDead       = parseFloat(innerDead)    || 0.0;
  const oDead       = parseFloat(outerDead)    || 0.0;
  const fovVal      = parseFloat(fov)          || 78;
  const accel       = parseFloat(acceleration) || 0;
  const vDist       = parseFloat(viewingDist)  || 8;   // feet
  const tzOff       = typeof tzOffset === 'number' ? tzOffset : 0; // minutes offset from UTC
  const axialDeadVal = parseFloat(axialDead) >= 0 ? parseFloat(axialDead) : 0.20;
  const zoomSensVal = parseFloat(zoomSens)  || 1.0;
const vibOn       = (vibration || 'off').toLowerCase() === 'on';
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

  // ── Scoped weapon accuracy (for zoom sens analysis) ──────────────────────
  // Weapons that require zooming to be effective: BR, Commando, Sniper, Stalker, Skewer
  const SCOPED_WEAPONS = ['battle rifle','br75','commando','vk78','sniper','s7 sniper','stalker rifle','skewer','campaign sniper'];
  const scopedGames = aimGames.filter(m => {
    if (!m.weaponStats || !m.weaponStats.topWeapon) return false;
    const w = (m.weaponStats.topWeapon || '').toLowerCase();
    return SCOPED_WEAPONS.some(s => w.includes(s));
  });
  const scopedAcc   = scopedGames.length  >= 4 ? +mean(scopedGames.map(gameAcc)).toFixed(1)  : null;
  const unscopedGames = aimGames.filter(m => {
    if (!m.weaponStats || !m.weaponStats.topWeapon) return false;
    const w = (m.weaponStats.topWeapon || '').toLowerCase();
    return !SCOPED_WEAPONS.some(s => w.includes(s));
  });
  const unscopedAcc = unscopedGames.length >= 4 ? +mean(unscopedGames.map(gameAcc)).toFixed(1) : null;

  // ── Consistency score 0–100 ───────────────────────────────────────────────
  // Weighted: accuracy level 30pts, variance 25pts, headshot rate 25pts, SPK 20pts
  const accScore = Math.min(30, Math.max(0, (avgAcc - 30) / 30 * 30));
  const sdScore  = Math.min(25, Math.max(0, (1 - accSd / 15) * 25));
  const hsScore  = Math.min(25, Math.max(0, (avgHs - 20) / 40 * 25));
  const spkScore = Math.min(20, Math.max(0, (1 - (avgSpk - 5) / 15) * 20));
  const consistencyScore = Math.round(accScore + sdScore + hsScore + spkScore);

  // ── Build recommendations ─────────────────────────────────────────────────
  const recs = [];
  const note = (cat, title, body, severity = 'info', priority = 5, change = null) => recs.push({ cat, title, body, severity, priority, change });

  // 1. Sensitivity vs 60fps (priority 1 — biggest impact)
  const MAX_SENS_60FPS = 5;
  if (sensH > MAX_SENS_60FPS) {
    const sug = Math.max(sensH - 1, MAX_SENS_60FPS);
    note('Sensitivity', `H-Sensitivity ${sensH} is high for 60fps`,
      `At 60fps each frame takes 16.7ms to render. High sensitivity maps large stick deflections to big angular jumps between frames, making micro-corrections unpredictable. Most 60fps players perform best at 4–5H. Your accuracy of ${avgAcc.toFixed(1)}% ${avgAcc < 43 ? `supports lowering — try ${sug}H first.` : `is reasonable, but you may find ${sug}H even cleaner on a 60" TV.`}`,
      avgAcc < 43 ? 'warn' : 'info', 1, `H-Sensitivity: ${sensH} → ${sug}`);
  } else if (sensH < 3 && avgAcc < 42 && avgHs > 40) {
    note('Sensitivity', `H-Sensitivity ${sensH} may be too low`,
      `Your headshot rate (${avgHs.toFixed(0)}%) is decent but overall accuracy (${avgAcc.toFixed(1)}%) is low — you're precise when still but missing strafing targets. Try raising H-Sensitivity by 1 to improve lateral tracking.`,
      'warn', 1, `H-Sensitivity: ${sensH} → ${sensH + 1}`);
  }

  if (Math.abs(sensH - sensV) > 1) {
    note('Sensitivity', `H/V sensitivity gap (${sensH}H vs ${sensV}V)`,
      `A gap larger than 1 between axes can cause aim to feel "sticky" vertically or horizontally. Most players use V = H or V = H−1. Consider bringing them closer together.`,
      'info', 2, `V-Sensitivity: ${sensV} → ${sensH} or ${sensH - 1}`);
  }

  // 2. Deadzone analysis (priority 2)
  if (iDead > 0.12) {
    const closePart = closeAcc != null
      ? ` Your close-range accuracy (${closeAcc.toFixed(1)}%) ${closeAcc < avgAcc - 5 ? 'drops vs your overall average — consistent with a large deadzone masking micro-adjustments in CQB.' : 'holds up — but you may still feel sluggishness on slow tracking shots.'}`
      : '';
    note('Deadzone', `Center Deadzone ${(iDead * 100).toFixed(0)}% is large`,
      `A large center deadzone creates a dead spot where small stick movements do nothing — fine micro-adjustments and slow tracking shots feel unresponsive. Try reducing to 5–8% (0.05–0.08). If your stick drifts at lower values, try 3–5% first.${closePart}`,
      iDead > 0.15 ? 'warn' : 'info', 2, `Center Deadzone: ${(iDead * 100).toFixed(0)}% → 5–8%`);
  } else if (iDead < 0.03 && accSd > 8) {
    note('Deadzone', `Center Deadzone ${(iDead * 100).toFixed(0)}% may be too low`,
      `Very low center deadzone with high game-to-game accuracy variance (±${accSd.toFixed(1)}%) can mean stick drift is bleeding into your aim when you think you're still. Try 3–5% and watch if consistency improves.`,
      'info', 2, `Center Deadzone: ${(iDead * 100).toFixed(0)}% → 3–5%`);
  }

  if (oDead > 0.12) {
    note('Deadzone', `Max Input Threshold ${(oDead * 100).toFixed(0)}% limits max turn speed`,
      `Above ~10% max input threshold you may never reach full rotation speed — 180° snap-turns feel slow and you'll get outmaneuvered by flankers. Try reducing to 5–8% (0.05–0.08).`,
      'warn', 2, `Max Input Threshold: ${(oDead * 100).toFixed(0)}% → 5–8%`);
  }

  // 3. Acceleration (priority 3)
  if (accel > 2) {
    note('Sensitivity', `Acceleration ${accel} adds unpredictable ramping at 60fps`,
      `Acceleration ramps speed as you push the stick further. At 120fps the ramp feels smooth; at 60fps the frames between ramp steps are visible as stuttery over-rotation. For 60fps, 1–2 acceleration is almost universally preferred — it makes aim predictable and consistent.`,
      'warn', 3, `Acceleration: ${accel} → 1`);
  }

  // 4. FOV (priority 4)
  if (fovVal > 100 && screenAngleDeg < 30) {
    note('FOV', `FOV ${fovVal}° is high for your ${vDist}ft viewing distance`,
      `From ${vDist}ft your 60" TV subtends ~${screenAngleDeg.toFixed(0)}° of your horizontal vision. At game FOV ${fovVal}° targets are quite small — each pixel of stick error is amplified. Try 90–95° for better target size and aim feel at this distance.`,
      'info', 4, `FOV: ${fovVal}° → 90–95°`);
  } else if (fovVal < 90 && screenAngleDeg > 35) {
    note('FOV', `FOV ${fovVal}° is conservative — you can safely go higher`,
      `Your 60" TV at ${vDist}ft gives ~${screenAngleDeg.toFixed(0)}° of real horizontal vision. FOV ${fovVal}° leaves peripheral awareness on the table. Bumping to 95–100° adds game awareness without meaningfully shrinking targets.`,
      'info', 4, `FOV: ${fovVal}° → 95–100°`);
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
      `Large swings in per-game accuracy usually mean something external is affecting your input — stick drift, inconsistent grip pressure, or fatigue. Both too-large and too-small center deadzones can cause this. Check your sticks with a deadzone visualizer app.`,
      'warn', 2, 'Check sticks for drift · adjust Center Deadzone to 3–8%');
  }

  // 7. Session warm-up (priority 3)
  if (warmupDelta !== null && warmupDelta > 4) {
    note('Session', `Cold-aim drop: ~${warmupDelta.toFixed(1)}% accuracy in your first game`,
      `Your first game of each session runs ${warmupDelta.toFixed(1)}% lower accuracy than the rest of that session — you need a warm-up period. This makes your settings feel inconsistent cold. Either treat your first game as a throw-away warm-up, or lower sensitivity by 1 so the cost of cold aim is smaller.`,
      'info', 3, `Play 1 warm-up game before ranked · or try H-Sensitivity: ${sensH} → ${sensH - 1}`);
  }

  // 8. Session fatigue (priority 3)
  if (fatigueDelta !== null && fatigueDelta < -4) {
    note('Session', `Fatigue drop: ~${Math.abs(fatigueDelta).toFixed(1)}% accuracy late in sessions`,
      `Your accuracy drops ~${Math.abs(fatigueDelta).toFixed(1)}% by the end of long sessions. Fatigue causes your grip to loosen, which can make high sensitivity feel out of control. Consider capping ranked sessions at ${avgSessionLen ? avgSessionLen - 2 : 6} games, or taking a 10-minute break halfway through.`,
      'info', 3, `Cap sessions at ${avgSessionLen ? avgSessionLen - 2 : 6} games · take breaks`);
  }

  // 9. Map type gap (priority 2)
  if (closeMapAcc !== null && openMapAcc !== null && Math.abs(closeMapAcc - openMapAcc) > 5) {
    if (closeMapAcc < openMapAcc - 5) {
      note('Map Profile', `CQB accuracy (${closeMapAcc}%) vs open-map (${openMapAcc}%) — gap of ${(openMapAcc - closeMapAcc).toFixed(1)}%`,
        `You aim better on open maps than in close-quarters. In CQB the center deadzone limits fast micro-corrections, or your sensitivity is too high for the snap-tracking required at close range. Try reducing center deadzone to 3–6% and see if Streets/Empyrean feel more responsive.`,
        'info', 2, `Center Deadzone: ${(iDead * 100).toFixed(0)}% → 3–6%`);
    } else {
      note('Map Profile', `Open-map accuracy (${openMapAcc}%) trails CQB (${closeMapAcc}%) — gap of ${(closeMapAcc - openMapAcc).toFixed(1)}%`,
        `You aim better in close-quarters than on open maps. Long-range strafe tracking requires more consistent lateral tracking — your sensitivity may be too low to track targets strafing at distance. Try raising H-Sensitivity by 1 to improve strafe-following on Aquarius/Recharge.`,
        'info', 2, `H-Sensitivity: ${sensH} → ${sensH + 1}`);
    }
  }

  // 10. Axial Deadzone
  if (axialDeadVal > 0.15) {
    note('Deadzone', `Axial Deadzone ${(axialDeadVal * 100).toFixed(0)}% limits diagonal tracking`,
      'Axial deadzone creates a dead band on purely horizontal and vertical stick movement. Above ~15% it starts killing diagonal aim — turns feel like they snap to cardinal directions rather than moving smoothly. Most pros run 0–10%. Try dropping to 10% and see if diagonal tracking feels cleaner.',
      axialDeadVal > 0.25 ? 'warn' : 'info', 2, `Axial Deadzone: ${(axialDeadVal * 100).toFixed(0)}% → 10%`);
  }

  // 11. Vibration
  if (vibOn) {
    note('Controller', 'Turn vibration off for competitive play',
      `Controller vibration fires during explosions, gunfire hits, and melee — which means your thumbs are being physically jolted during the moments you most need precision tracking. Even small vibrations cause involuntary micro-inputs that show up as aim drift. Go to Settings → Controller → Vibration and turn it off. This is a free consistency gain.`,
      'warn', 2, 'Vibration: On → Off');
  }

  // 12. Zoom sensitivity
  if (zoomSensVal > 0.0) {
    if (scopedAcc !== null && unscopedAcc !== null) {
      const scopedGap = unscopedAcc - scopedAcc;
      if (scopedGap > 6 && zoomSensVal > 0.7) {
        note('Zoom Sensitivity', `Scoped accuracy (${scopedAcc}%) trails hip-fire (${unscopedAcc}%) by ${scopedGap.toFixed(1)}%`,
          `When zoomed in, your accuracy drops significantly vs hip-fire. At zoom multiplier ${zoomSensVal.toFixed(2)}, scoped sensitivity may be too fast — you're overshooting targets when the view snaps in. Try reducing Zoom Sensitivity Multiplier to 0.6–0.75 so scoped shots feel more controlled. Settings → Controller → Zoom Sensitivity Multiplier.`,
          'warn', 2, `Zoom Sensitivity: ${zoomSensVal.toFixed(2)} → 0.60–0.75`);
      } else if (scopedGap < -5 && zoomSensVal < 0.6) {
        note('Zoom Sensitivity', `Hip-fire accuracy (${unscopedAcc}%) trails scoped (${scopedAcc}%) — zoom sens may be too slow`,
          `Your scoped accuracy is actually better than hip-fire, which can mean your zoom sensitivity is set conservatively enough that you're more precise when scoped. This is fine — but if hip-fire tracking feels too fast relative to scoped, a slight increase of zoom multiplier toward 0.7–0.8 can balance the feel. Settings → Controller → Zoom Sensitivity Multiplier.`,
          'info', 4, `Zoom Sensitivity: ${zoomSensVal.toFixed(2)} → 0.70–0.80`);
      } else if (scopedAcc !== null) {
        // No major gap — just note the setting for reference
        note('Zoom Sensitivity', `Zoom sensitivity ${zoomSensVal.toFixed(2)} — scoped accuracy looks consistent`,
          `Your scoped accuracy (${scopedAcc}%) is within ${Math.abs(scopedGap).toFixed(1)}% of hip-fire (${unscopedAcc}%) — zoom sensitivity looks appropriate for your playstyle. No change needed.`,
          'info', 6);
      }
    }
  }


  // ── Stretch goals for consistent players ─────────────────────────────────
  const isConsistent = accSd <= 7 && avgAcc >= 44;
  const hasWarningSens = recs.some(r => r.cat === 'Sensitivity' && r.severity === 'warn');
  const hasWarningFov  = recs.some(r => r.cat === 'FOV'         && r.severity === 'warn');

  if (isConsistent && !hasWarningSens && sensH <= 3) {
    note('Stretch Goal', `Consistent aim — consider trying sensitivity ${sensH + 1}`,
      `Your accuracy variance (±${accSd.toFixed(1)}%) is low and accuracy (${avgAcc.toFixed(1)}%) is solid — your current sensitivity is dialed in. If you want more — faster snap-turns, quicker target acquisition — you have the consistency to absorb a +1 bump. Try H-Sensitivity ${sensH + 1} for 15–20 games and see if it clicks without hurting accuracy.`,
      'info', 7, `H-Sensitivity: ${sensH} → ${sensH + 1} (optional — you have headroom)`);
  }

  if (isConsistent && !hasWarningFov && fovVal < 95) {
    note('Stretch Goal', `Consistent aim — consider bumping FOV to ${Math.min(fovVal + 5, 100)}°`,
      `With low accuracy variance (±${accSd.toFixed(1)}%) you're not losing fights to shaky aim — you might be losing them to awareness. Bumping FOV from ${fovVal}° to ${Math.min(fovVal + 5, 100)}° widens your peripheral view without meaningfully shrinking targets at this sensitivity. Worth a test.`,
      'info', 7, `FOV: ${fovVal}° → ${Math.min(fovVal + 5, 100)}° (optional)`);
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
      scopedAcc, unscopedAcc,
      scopedCount: scopedGames.length,
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
    <label>Acceleration (1–5)</label>
    <input id="accel" type="number" min="1" max="5" step="1" value="1">
    <div class="hint">1 = linear · higher = ramps as you push stick further</div>
  </div>

  <h2>Deadzones</h2>
  <div class="grid3">
    <div>
      <label>Center Deadzone</label>
      <input id="innerDead" type="number" min="0" max="100" step="0.5" value="8">
      <div class="hint">0–100 in 0.5 steps · default ~8 · Settings → Controller</div>
    </div>
    <div>
      <label>Max Input Threshold</label>
      <input id="outerDead" type="number" min="0" max="100" step="0.5" value="8">
      <div class="hint">0–100 in 0.5 steps · default ~8 · Settings → Controller</div>
    </div>
    <div>
      <label>Axial Deadzone</label>
      <input id="axialDead" type="number" min="0" max="100" step="0.5" value="20">
      <div class="hint">0–100 in 0.5 steps · default ~20 · Settings → Controller</div>
    </div>
  </div>
  <div style="margin-bottom:20px">
    <input type="hidden" id="deadzoneType" value="radial">
  </div>

  <h2>Controller</h2>
  <div class="grid3">
    <div>
      <label>Zoom Sensitivity Multiplier</label>
      <input id="zoomSens" type="number" min="0.1" max="1.0" step="0.05" value="1.0">
      <div class="hint">0.10–1.00 · default 1.0</div>
    </div>
    <div>
      <label>Vibration</label>
      <select id="vibration">
        <option value="off">Off</option>
        <option value="on">On</option>
      </select>
      <div class="hint">Settings → Controller · pros use Off</div>
    </div>
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

// Auto-populate gamertag from ?player= URL param
(function(){
  var p = new URLSearchParams(window.location.search).get('player');
  if(p){ var el = document.getElementById('gt'); if(el) el.value = p; }
})();

// Pro HCS reference settings (competitive average)
const PRO = {
  'H Sensitivity':      { val: '3–4', note: 'most use 3' },
  'V Sensitivity':      { val: '3–4', note: 'V = H or H−1' },
  'Center Deadzone':    { val: '0–5%', note: 'avg ~3%' },
  'Max Input Threshold':{ val: '0–5%', note: 'avg ~3%' },
  'Axial Deadzone':     { val: '0–10%', note: 'lower = better diagonal tracking' },
  'Acceleration':       { val: '1', note: 'all use linear' },
  'FOV':                { val: '90–100°', note: '' },
  'Zoom Sensitivity':   { val: '0.75–1.0', note: 'varies by style' },
'Vibration':          { val: 'Off', note: 'universal' },
};

async function runAnalysis() {
  const btn = document.getElementById('runBtn');
  const out = document.getElementById('out');
  const gt  = document.getElementById('gt').value.trim();
  if (!gt) {
    var gtEl = document.getElementById('gt');
    gtEl.style.borderColor = 'var(--loss)';
    gtEl.focus();
    setTimeout(function(){ gtEl.style.borderColor = ''; }, 2000);
    out.innerHTML = '<div class="err" style="font-size:13px;padding:10px 14px;background:rgba(224,80,80,0.08);border:1px solid rgba(224,80,80,0.3);border-radius:6px;margin-top:12px">⚠ Enter your gamertag above first.</div>';
    out.scrollIntoView({behavior:'smooth',block:'nearest'});
    return;
  }
  btn.disabled = true;
  out.innerHTML = '<div style="color:var(--muted);font-size:11px;margin-top:16px"><span class="spin"></span>Loading your match data — this may take 10–15s if not recently searched…</div>';
  out.scrollIntoView({behavior:'smooth',block:'start'});
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
        innerDead:    parseFloat(document.getElementById('innerDead').value) / 100,
        outerDead:    parseFloat(document.getElementById('outerDead').value) / 100,
        axialDead:    parseFloat(document.getElementById('axialDead').value) / 100,
        deadzoneType: document.getElementById('deadzoneType').value,
        fov:          parseFloat(document.getElementById('fov').value),
        viewingDist:  parseFloat(document.getElementById('viewDist').value),
        zoomSens:     parseFloat(document.getElementById('zoomSens').value),
        vibration:    document.getElementById('vibration').value,
        tzOffset:     new Date().getTimezoneOffset() * -1, // minutes from UTC
      })
    });
    const d = await r.json();
    if (!d.ok) {
      out.innerHTML = '<div style="font-size:13px;padding:12px 16px;background:rgba(224,80,80,0.08);border:1px solid rgba(224,80,80,0.3);border-radius:6px;color:var(--loss)">⚠ ' + (d.error || 'Unknown error') + '</div>';
      out.scrollIntoView({behavior:'smooth',block:'start'});
      btn.disabled = false;
      return;
    }
    renderResults(d);
  } catch(e) {
    out.innerHTML = '<div style="font-size:13px;padding:12px 16px;background:rgba(224,80,80,0.08);border:1px solid rgba(224,80,80,0.3);border-radius:6px;color:var(--loss)">⚠ Request failed: ' + e.message + '</div>';
    out.scrollIntoView({behavior:'smooth',block:'start'});
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
  if (s.scopedAcc != null)    h += statRow('Scoped Weapon Accuracy (' + s.scopedCount + 'g)', s.scopedAcc + '%', s.scopedAcc >= s.avgAccuracy - 4 ? 'var(--win)' : s.scopedAcc >= s.avgAccuracy - 8 ? 'var(--gold)' : 'var(--loss)');
  if (s.unscopedAcc != null)  h += statRow('Hip-Fire Accuracy', s.unscopedAcc + '%', s.unscopedAcc >= s.avgAccuracy - 4 ? 'var(--win)' : 'var(--gold)');
  if (s.closeMapAcc != null)  h += statRow('Close-Map Accuracy (' + s.closeMapCount + 'g)', s.closeMapAcc + '%', s.closeMapAcc >= s.avgAccuracy - 3 ? 'var(--win)' : 'var(--gold)');
  if (s.openMapAcc != null)   h += statRow('Open-Map Accuracy (' + s.openMapCount + 'g)', s.openMapAcc + '%', s.openMapAcc >= s.avgAccuracy - 3 ? 'var(--win)' : 'var(--gold)');
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
      h += '<div style="font-size:10px;color:var(--text);margin-bottom:10px">Win rate crosses 50% at <strong style="color:var(--win)">' + d.winFloor + '%+ accuracy</strong> — that\\'s your target floor.</div>';
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
  h += 'Also check your TV\\'s <strong style="color:var(--gold)">Game Mode</strong> — non-game-mode TVs add 30–100ms of input lag on top of the 16.7ms frame time.';
  h += '</div>';

  // ── Pro Settings Reference ────────────────────────────────────────────────
  const yourSettings = {
    'H Sensitivity':     document.getElementById('sensH').value,
    'V Sensitivity':     document.getElementById('sensV').value,
    'Center Deadzone':    document.getElementById('innerDead').value + '%',
    'Max Input Threshold':document.getElementById('outerDead').value + '%',
    'Axial Deadzone':     document.getElementById('axialDead').value + '%',
    'Acceleration':      document.getElementById('accel').value,
    'FOV':               document.getElementById('fov').value + '°',
    'Zoom Sensitivity':  document.getElementById('zoomSens').value,
    'Vibration':         document.getElementById('vibration').options[document.getElementById('vibration').selectedIndex].text,
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
      var isWarn = rec.severity === 'warn';
      var accentColor = isWarn ? 'var(--gold)' : 'var(--accent)';
      h += '<div class="rec ' + rec.severity + '">';
      h += '<div class="rec-meta"><div class="rec-cat">' + rec.cat + '</div><div class="rec-pri">#' + (i + 1) + ' priority</div></div>';
      h += '<div class="rec-title">' + rec.title + '</div>';
      if (rec.change) {
        h += '<div style="display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,0.04);border:1px solid ' + accentColor + ';border-radius:4px;padding:6px 12px;margin:8px 0 10px;font-family:Share Tech Mono,monospace;font-size:12px;font-weight:700;color:' + accentColor + '">';
        h += '<span style="font-size:9px;letter-spacing:1.5px;opacity:0.7;text-transform:uppercase">SET THIS</span>';
        h += '<span style="color:var(--muted2)">|</span>';
        h += rec.change;
        h += '</div>';
      }
      h += '<div class="rec-body">' + rec.body + '</div>';
      h += '</div>';
    });
  } else {
    h += '<div style="color:var(--win);font-size:11px;margin-top:4px">✓ No issues flagged — settings look good for your setup.</div>';
  }

  const outEl = document.getElementById('out');
  outEl.innerHTML = h;
  outEl.scrollIntoView({behavior:'smooth',block:'start'});
}

</script>
</body>
</html>
`);
});

// ── Marvel Rivals ─────────────────────────────────────────────────────────────

// Serve rivals page
app.get('/rivals', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'rivals.html'));
});

// Serve stream overlay page
app.get('/overlay', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});

// Player stats + match history
app.get('/api/rivals/player', async (req, res) => {
  const { name } = req.query;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const data = await fetchRivalsPlayer(name.trim());
    res.json(data);
  } catch(e) {
    const status = e.message?.includes('not found') ? 404
                 : e.message?.includes('API key')   ? 503
                 : 500;
    res.status(status).json({ error: e.message });
  }
});

// Force-refresh player data from Rivals API
app.post('/api/rivals/refresh', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  clearRivalsCache(name);
  const upd = await refreshRivalsPlayer(name.trim());
  res.json(upd);
});

// ── Periodic cache maintenance ─────────────────────────────────────────────
// Prevent unbounded in-memory cache growth from triggering OOM kills on
// memory-constrained hosting (e.g. Render starter plans).
const _IMG_CACHE_MAX    = 300;  // entries; each ~100–400 KB image buffer
const _EMBLEM_CACHE_MAX = 500;  // xuid-keyed emblem image buffers
const _SEARCH_CACHE_MAX = 100;  // full player payloads; Redis is the primary store
// xuid->gamertag/emblem-path maps: small per-entry but loaded in full from Postgres
// at startup and never evicted, so they grow forever as the DB tables grow. Cap them
// too — see loadXuidCache/loadEmblemCache in db.js for the matching startup-load cap.
const _XUID_GT_CACHE_MAX      = 150000;
const _EMBLEM_PATH_CACHE_MAX  = 150000;
const _NAMEPLATE_PATH_CACHE_MAX = 150000;

function _pruneObjectCache(cache, max, label) {
  const keys = Object.keys(cache);
  if (keys.length > max) {
    const drop = keys.slice(0, keys.length - max);
    for (const k of drop) delete cache[k];
    console.log(`[Cache] Pruned ${label}: ${keys.length} → ${max}`);
  }
}

setInterval(() => {
  _pruneObjectCache(imgCache, _IMG_CACHE_MAX, 'imgCache');
  _pruneObjectCache(emblemImgCache, _EMBLEM_CACHE_MAX, 'emblemImgCache');
  _pruneObjectCache(searchCache, _SEARCH_CACHE_MAX, 'searchCache');
  _pruneObjectCache(getXuidToGt(), _XUID_GT_CACHE_MAX, 'xuidToGt');
  _pruneObjectCache(getEmblemPathCache(), _EMBLEM_PATH_CACHE_MAX, 'emblemPathCache');
  _pruneObjectCache(getNameplatePathCache(), _NAMEPLATE_PATH_CACHE_MAX, 'nameplatePathCache');

  const now = Date.now();

  // mapImageProxyCache uses Map with TTL — evict entries the TTL check missed
  let mapPruned = 0;
  for (const [url, entry] of mapImageProxyCache) {
    if (now - entry.ts > MAP_IMG_TTL) { mapImageProxyCache.delete(url); mapPruned++; }
  }
  if (mapPruned) console.log(`[Cache] Evicted ${mapPruned} stale mapImageProxyCache entries`);

  // _suggestCache entries linger long past their 30s TTL — flush anything older than 5 min
  let suggestPruned = 0;
  for (const [q, entry] of _suggestCache) {
    if (now - entry.ts > 5 * 60 * 1000) { _suggestCache.delete(q); suggestPruned++; }
  }
  if (suggestPruned) console.log(`[Cache] Evicted ${suggestPruned} stale _suggestCache entries`);

  // _latestMatchCheckCache has no automatic cleanup — flush entries older than 10 min
  let lmcPruned = 0;
  for (const key of Object.keys(_latestMatchCheckCache)) {
    if (now - (_latestMatchCheckCache[key].checkedAt || 0) > 10 * 60 * 1000) {
      delete _latestMatchCheckCache[key]; lmcPruned++;
    }
  }
  if (lmcPruned) console.log(`[Cache] Evicted ${lmcPruned} stale _latestMatchCheckCache entries`);
}, 2 * 60 * 1000); // run every 2 minutes

app.listen(PORT, () => {
  console.log('fragr listening on port ' + PORT);
  const rivalsKey = process.env.RIVALS_API_KEY || '';
  console.log(`[Rivals] API key: ${rivalsKey ? `set (${rivalsKey.length} chars, starts "${rivalsKey.slice(0,4)}...")` : 'NOT SET'}`);

  // On startup: pull the latest rotated refresh token from Redis.
  // Redis may have a newer token than the env var (rotated on a previous run that
  // was then redeployed/restarted, wiping the ephemeral file).
  getRedis().then(async r => {
    if (!r) return;
    try {
      const saved = await r.get('msRefreshToken');
      if (saved && saved !== process.env.MS_REFRESH_TOKEN) {
        process.env.MS_REFRESH_TOKEN = saved;
        console.log('[TokenRefresh] Loaded rotated refresh token from Redis');
      }
    } catch(e) { console.warn('[TokenRefresh] Redis token load failed:', e.message); }
  }).catch(() => {});

  // Start the auto-refresh scheduler, wired to Redis persistence + clearance reset
  startAutoRefresh({ getRedis, onRefreshed: resetClearanceCache });
});
