// db.js — shared Postgres helpers used by both server.js and halo.js
require('dotenv').config();
const { Pool } = require('pg');

let _dbPool = null;
let _dbInitPromise = null; // shared across concurrent callers — prevents race on startup
const _dbPersistedXuids = new Set();

async function getDb() {
  if (_dbPool) return _dbPool;
  if (!process.env.DATABASE_URL) return null;
  if (!_dbInitPromise) {
    _dbInitPromise = (async () => {
      _dbPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      try {
        await _dbPool.query(`CREATE TABLE IF NOT EXISTS xuid_cache (xuid TEXT PRIMARY KEY, gamertag TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await _dbPool.query(`CREATE TABLE IF NOT EXISTS emblem_cache (xuid TEXT PRIMARY KEY, emblem_path TEXT, nameplate_path TEXT, ts TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await _dbPool.query(`CREATE TABLE IF NOT EXISTS player_snapshots (
          xuid TEXT NOT NULL,
          gamertag TEXT NOT NULL,
          snap_date DATE NOT NULL DEFAULT CURRENT_DATE,
          ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          primary_playlist TEXT,
          csr_tier TEXT,
          csr_subtier INT,
          csr_value INT,
          csr JSONB,
          matches_played INT,
          wins INT,
          losses INT,
          kd FLOAT,
          kda FLOAT,
          win_rate FLOAT,
          accuracy FLOAT,
          avg_kills FLOAT,
          PRIMARY KEY (xuid, snap_date)
        )`);
        await _dbPool.query(`CREATE TABLE IF NOT EXISTS pro_players (
          xuid TEXT PRIMARY KEY,
          gamertag TEXT NOT NULL,
          label TEXT,
          added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        // match_participants: powers the "private player" fallback — every time we
        // fetch a public player's match history we record every roster slot here so
        // we can later reconstruct a partial history for a private/restricted player
        // whose own /matches endpoint returns nothing.
        await _dbPool.query(`CREATE TABLE IF NOT EXISTS match_participants (
          match_id TEXT NOT NULL,
          xuid TEXT NOT NULL,
          gamertag TEXT,
          team_id INT,
          outcome INT,
          kills INT, deaths INT, assists INT,
          score INT, damage INT,
          is_ranked BOOLEAN,
          game_mode TEXT,
          map_name TEXT,
          map_image_url TEXT,
          start_time TIMESTAMPTZ,
          duration_sec INT,
          source_xuid TEXT,
          ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (match_id, xuid)
        )`);
        await _dbPool.query(`CREATE INDEX IF NOT EXISTS idx_match_participants_xuid ON match_participants(xuid)`);
        await _dbPool.query(`CREATE INDEX IF NOT EXISTS idx_match_participants_start_time ON match_participants(start_time DESC)`);
        // player_refresh_meta: per-player background-refresh bookkeeping.
        // last_refresh_ts          — when we last fetched their stats (any source)
        // last_no_new_data_ts      — when the most recent refresh found NO new
        //                            matches played vs the previous snapshot
        // last_matches_played      — last observed career match count
        // consecutive_empty_refreshes — strikes; deprioritize after N
        // Powers freshness gating so the background snapshot queue skips
        // players we recently touched and deprioritizes inactive accounts.
        await _dbPool.query(`CREATE TABLE IF NOT EXISTS player_refresh_meta (
          xuid TEXT PRIMARY KEY,
          gamertag TEXT,
          last_refresh_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_no_new_data_ts TIMESTAMPTZ,
          last_matches_played INT,
          consecutive_empty_refreshes INT NOT NULL DEFAULT 0
        )`);
      } catch(e) { console.error('[DB] schema error:', e.message); }
      return _dbPool;
    })();
  }
  return _dbInitPromise;
}

// Load all persisted xuids into the provided in-memory map and mark them as persisted
async function loadXuidCache(xuidToGt) {
  try {
    const db = await getDb();
    if (!db) return;
    const result = await db.query('SELECT xuid, gamertag FROM xuid_cache');
    if (result.rows.length > 0) {
      result.rows.forEach(r => {
        if (!xuidToGt[r.xuid]) xuidToGt[r.xuid] = r.gamertag;
        _dbPersistedXuids.add(r.xuid);
      });
      console.log('[DB] Loaded', result.rows.length, 'cached xuids from Postgres');
    }
  } catch(e) { console.error('[DB] loadXuidCache error:', e.message); }
}

// Write only NEW (not yet persisted) xuids to DB
async function flushXuidCache(xuidToGt) {
  try {
    const db = await getDb();
    if (!db) return;
    const entries = Object.entries(xuidToGt).filter(([xuid, v]) =>
      v && !v.startsWith('Spartan ') && !_dbPersistedXuids.has(xuid)
    );
    if (!entries.length) return;
    console.log(`[DB] Flushing ${entries.length} new xuids to xuid_cache`);
    for (let i = 0; i < entries.length; i += 200) {
      const batch = entries.slice(i, i + 200);
      const vals = batch.map((_, j) => `($${j*2+1},$${j*2+2})`).join(',');
      await db.query(
        `INSERT INTO xuid_cache (xuid,gamertag) VALUES ${vals} ON CONFLICT (xuid) DO UPDATE SET gamertag=EXCLUDED.gamertag,ts=NOW()`,
        batch.flatMap(([x, g]) => [x, g])
      );
      batch.forEach(([xuid]) => _dbPersistedXuids.add(xuid));
    }
  } catch(e) { console.error('[DB] flushXuidCache error:', e.message); }
}

// Load persisted emblem/nameplate paths into the in-memory caches
async function loadEmblemCache(emblemPathCache, nameplatePathCache) {
  try {
    const db = await getDb();
    if (!db) return;
    const result = await db.query('SELECT xuid, emblem_path, nameplate_path FROM emblem_cache');
    result.rows.forEach(r => {
      if (r.emblem_path && !emblemPathCache[r.xuid]) emblemPathCache[r.xuid] = r.emblem_path;
      if (r.nameplate_path && !nameplatePathCache[r.xuid]) nameplatePathCache[r.xuid] = r.nameplate_path;
    });
    if (result.rows.length) console.log(`[DB] Loaded ${result.rows.length} emblem/nameplate paths from Postgres`);
  } catch(e) { console.error('[DB] loadEmblemCache error:', e.message); }
}

const _dbPersistedEmblems = new Set();

// Write only NEW or UPDATED emblem/nameplate paths to DB
async function flushEmblemCache(emblemPathCache, nameplatePathCache) {
  try {
    const db = await getDb();
    if (!db) return;
    const xuids = new Set([...Object.keys(emblemPathCache), ...Object.keys(nameplatePathCache)]);
    const toFlush = [...xuids].filter(x => !_dbPersistedEmblems.has(x) && (emblemPathCache[x] || nameplatePathCache[x]));
    if (!toFlush.length) return;
    for (let i = 0; i < toFlush.length; i += 200) {
      const batch = toFlush.slice(i, i + 200);
      const vals = batch.map((_, j) => `($${j*3+1},$${j*3+2},$${j*3+3})`).join(',');
      await db.query(
        `INSERT INTO emblem_cache (xuid, emblem_path, nameplate_path) VALUES ${vals}
         ON CONFLICT (xuid) DO UPDATE SET emblem_path=EXCLUDED.emblem_path, nameplate_path=EXCLUDED.nameplate_path, ts=NOW()`,
        batch.flatMap(x => [x, emblemPathCache[x] || null, nameplatePathCache[x] || null])
      );
      batch.forEach(x => _dbPersistedEmblems.add(x));
    }
    console.log(`[DB] Flushed ${toFlush.length} emblem paths to Postgres`);
  } catch(e) { console.error('[DB] flushEmblemCache error:', e.message); }
}

// Save a snapshot of a player's stats at search time (one row per player per day)
async function savePlayerSnapshot(player) {
  try {
    const db = await getDb();
    if (!db) return;

    const csr = player.csr || {};
    // Keys must match the display names from halo.js csrResults (NOT snake_case).
    // Ranked Arena is the authoritative competitive metric — always preferred.
    const PREFERRED = ['Ranked Arena', 'Ranked Slayer', 'Ranked Legacy'];
    let primaryPlaylist = null, csrTier = null, csrSubtier = null, csrValue = null;

    for (const pl of PREFERRED) {
      if (csr[pl] && csr[pl].tier) {
        primaryPlaylist = pl; csrTier = csr[pl].tier;
        csrSubtier = csr[pl].subTier || 0; csrValue = csr[pl].value || 0;
        break;
      }
    }
    if (!primaryPlaylist) {
      for (const k of Object.keys(csr)) {
        if (csr[k] && csr[k].tier) {
          primaryPlaylist = k; csrTier = csr[k].tier;
          csrSubtier = csr[k].subTier || 0; csrValue = csr[k].value || 0;
          break;
        }
      }
    }
    if (!csrTier) return; // unranked — nothing to store

    // Compute stats from recent match history so snapshots (and peer benchmarks) reflect
    // current play, not career/lifetime API numbers. Falls back to career stats if no matches.
    const recentArr = Array.isArray(player.allMatches) ? player.allMatches
                    : Array.isArray(player.recentMatches) ? player.recentMatches : [];
    const mValid = recentArr.filter(m => m && m.kills != null);
    let snapKd = null, snapWinRate = null, snapAccuracy = null, snapAvgKills = null;
    let snapMatchesPlayed = null, snapWins = null, snapLosses = null;
    if (mValid.length >= 5) {
      const totalKills  = mValid.reduce((s, m) => s + (m.kills || 0), 0);
      const totalDeaths = mValid.reduce((s, m) => s + (m.deaths || 0), 0);
      const wlMatches   = mValid.filter(m => m.outcome === 2 || m.outcome === 3);
      const wins        = wlMatches.filter(m => m.outcome === 2).length;
      const accGames    = mValid.filter(m => m.accuracy != null && parseFloat(m.accuracy) > 0);
      snapKd        = totalDeaths > 0 ? parseFloat((totalKills / totalDeaths).toFixed(2)) : null;
      snapWinRate   = wlMatches.length > 0 ? parseFloat(((wins / wlMatches.length) * 100).toFixed(1)) : null;
      snapAccuracy  = accGames.length ? parseFloat((accGames.reduce((s, m) => s + parseFloat(m.accuracy), 0) / accGames.length).toFixed(1)) : null;
      snapAvgKills  = parseFloat((totalKills / mValid.length).toFixed(1));
      // Prefer career total from service record so the leaderboard shows real game counts,
      // not just our cached sample size. Fall back to sample length if not available.
      const _s = player.stats || {};
      snapMatchesPlayed = _s.matchesPlayed || mValid.length;
      snapWins      = _s.wins   || wins;
      snapLosses    = _s.losses || (wlMatches.length - wins);
    } else {
      // Fall back to career API stats
      const s = player.stats || {};
      snapKd        = parseFloat(s.kd)              || null;
      snapWinRate   = parseFloat(s.winRate)         || null;
      snapAccuracy  = parseFloat(s.accuracy)        || null;
      snapAvgKills  = parseFloat(s.avgKillsPerGame) || null;
      snapMatchesPlayed = s.matchesPlayed || null;
      snapWins      = s.wins || null;
      snapLosses    = s.losses || null;
    }

    // Don't write a snapshot with no usable stats — it can't help the peer pool and could
    // overwrite a previously valid snapshot (same xuid + same day) with nulls.
    if (snapKd == null) {
      console.log(`[DB] Snapshot skipped for ${player.gamertag} — no usable stats (0 recent matches, no career K/D)`);
      return;
    }

    await db.query(`
      INSERT INTO player_snapshots
        (xuid, gamertag, snap_date, ts, primary_playlist, csr_tier, csr_subtier, csr_value,
         csr, matches_played, wins, losses, kd, kda, win_rate, accuracy, avg_kills)
      VALUES ($1,$2,CURRENT_DATE,NOW(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (xuid, snap_date) DO UPDATE SET
        gamertag=EXCLUDED.gamertag, ts=NOW(),
        primary_playlist=EXCLUDED.primary_playlist,
        csr_tier=EXCLUDED.csr_tier, csr_subtier=EXCLUDED.csr_subtier, csr_value=EXCLUDED.csr_value,
        csr=EXCLUDED.csr, matches_played=EXCLUDED.matches_played,
        wins=EXCLUDED.wins, losses=EXCLUDED.losses,
        -- Only overwrite stats columns if the new values are non-null,
        -- so a bad re-search never clobbers a previously good snapshot.
        kd        = COALESCE(EXCLUDED.kd,        player_snapshots.kd),
        kda       = COALESCE(EXCLUDED.kda,       player_snapshots.kda),
        win_rate  = COALESCE(EXCLUDED.win_rate,  player_snapshots.win_rate),
        accuracy  = COALESCE(EXCLUDED.accuracy,  player_snapshots.accuracy),
        avg_kills = COALESCE(EXCLUDED.avg_kills, player_snapshots.avg_kills)
    `, [
      player.xuid, player.gamertag, primaryPlaylist, csrTier, csrSubtier, csrValue,
      JSON.stringify(csr),
      snapMatchesPlayed, snapWins, snapLosses,
      snapKd, null, snapWinRate, snapAccuracy, snapAvgKills
    ]);
    console.log(`[DB] Snapshot saved for ${player.gamertag} (${csrTier} ${csrSubtier}) — ${mValid.length || 'career'} match stats`);
  } catch(e) { console.error('[DB] savePlayerSnapshot error:', e.message); }
}

// Fetch stats rows for players at a given rank tier+subtier (last 30 days, up to 1000 rows).
// For Onyx, csrValue is required — players are bucketed in 100-point ranges (1500-1599, 1600-1699, etc.)
// so an Onyx 1500 is never compared against an Onyx 1900.
async function getSnapshotsByRank(tier, subTier, csrValue) {
  try {
    const db = await getDb();
    if (!db) return [];
    let queryStr, params;
    if (tier === 'Onyx') {
      // Bucket into 100-point bands: floor to nearest 100, cap at 1900+
      const bandLow = csrValue != null ? Math.min(Math.floor(csrValue / 100) * 100, 1900) : 1500;
      const bandHigh = bandLow >= 1900 ? 9999 : bandLow + 100;
      queryStr = `
        SELECT kd, win_rate, accuracy, avg_kills FROM player_snapshots
        WHERE csr_tier = $1 AND csr_value >= $2 AND csr_value < $3 AND kd IS NOT NULL
          AND ts > NOW() - INTERVAL '30 days'
        ORDER BY ts DESC LIMIT 1000
      `;
      params = [tier, bandLow, bandHigh];
    } else {
      queryStr = `
        SELECT kd, win_rate, accuracy, avg_kills FROM player_snapshots
        WHERE csr_tier = $1 AND csr_subtier = $2 AND kd IS NOT NULL
          AND ts > NOW() - INTERVAL '30 days'
        ORDER BY ts DESC LIMIT 1000
      `;
      params = [tier, subTier];
    }
    const res = await db.query(queryStr, params);
    return res.rows;
  } catch(e) { console.error('[DB] getSnapshotsByRank error:', e.message); return []; }
}

// ── Pro player management ────────────────────────────────────────────────────

async function addProPlayer(xuid, gamertag, label) {
  const db = await getDb();
  if (!db) return false;
  await db.query(
    `INSERT INTO pro_players (xuid, gamertag, label) VALUES ($1, $2, $3)
     ON CONFLICT (xuid) DO UPDATE SET gamertag=EXCLUDED.gamertag, label=EXCLUDED.label`,
    [xuid, gamertag, label || null]
  );
  return true;
}

async function removeProPlayer(xuid) {
  const db = await getDb();
  if (!db) return false;
  await db.query('DELETE FROM pro_players WHERE xuid = $1', [xuid]);
  return true;
}

async function getProPlayers() {
  const db = await getDb();
  if (!db) return [];
  const res = await db.query(`
    SELECT p.xuid, p.gamertag, p.label, p.added_at,
           s.csr_tier, s.csr_value, s.kd, s.win_rate, s.accuracy, s.avg_kills, s.ts AS last_snapshot
    FROM pro_players p
    LEFT JOIN LATERAL (
      SELECT csr_tier, csr_value, kd, win_rate, accuracy, avg_kills, ts
      FROM player_snapshots
      WHERE xuid = p.xuid AND kd IS NOT NULL
      ORDER BY ts DESC LIMIT 1
    ) s ON true
    ORDER BY p.added_at DESC
  `);
  return res.rows;
}

// Returns aggregate stats across all pro players using their most recent snapshot each.
// Includes std dev for each stat so callers can build rank-scaled acceptable deviation bands.
// Also returns staleness metadata so the client can warn when pro data is outdated.
async function getProStats() {
  const db = await getDb();
  if (!db) return null;
  // Quality filter: only include snapshots that look like legitimate pro-level play.
  // Thresholds match the refresh-pros validation in server.js:
  //   K/D >= 0.7, accuracy >= 28% (or null — not all matches record accuracy), avg_kills >= 5
  // This prevents inactive accounts, wrong gamertags, or smurf-level data from
  // skewing the pro aggregate used for benchmarks and aim thresholds.
  const res = await db.query(`
    SELECT s.kd, s.win_rate, s.accuracy, s.avg_kills, s.csr_tier, s.csr_value, s.ts,
           p.gamertag
    FROM pro_players p
    JOIN LATERAL (
      SELECT kd, win_rate, accuracy, avg_kills, csr_tier, csr_value, ts
      FROM player_snapshots
      WHERE xuid = p.xuid
        AND kd        IS NOT NULL
        AND kd        >= 0.7
        AND avg_kills >= 5
        AND (accuracy IS NULL OR accuracy >= 28)
      ORDER BY ts DESC LIMIT 1
    ) s ON true
  `);
  // Also count pros that have NO snapshot yet (so client can warn about gaps)
  const totalRes = await db.query('SELECT COUNT(*) AS total FROM pro_players');
  const totalPros = parseInt(totalRes.rows[0].total, 10);

  if (!res.rows.length) return { count: 0, totalAdded: totalPros, unsearched: totalPros };
  const rows = res.rows;
  const n = rows.length;

  const avg = key => rows.reduce((s, r) => s + (parseFloat(r[key]) || 0), 0) / n;
  const stddev = (key, m) => {
    if (n < 2) return null;
    return Math.sqrt(rows.reduce((s, r) => s + Math.pow((parseFloat(r[key]) || 0) - m, 2), 0) / (n - 1));
  };

  const avgKd  = avg('kd'),   avgWr  = avg('win_rate');
  const avgAcc = avg('accuracy'), avgKpg = avg('avg_kills');
  const sdKd   = stddev('kd', avgKd);
  const sdWr   = stddev('win_rate', avgWr);
  const sdAcc  = stddev('accuracy', avgAcc);
  const sdKpg  = stddev('avg_kills', avgKpg);

  // Staleness: oldest snapshot among active pros
  const timestamps = rows.map(r => new Date(r.ts)).filter(d => !isNaN(d));
  const oldestTs   = timestamps.length ? new Date(Math.min(...timestamps)) : null;
  const newestTs   = timestamps.length ? new Date(Math.max(...timestamps)) : null;
  const oldestDays = oldestTs ? Math.floor((Date.now() - oldestTs) / 86400000) : null;

  return {
    count:        n,
    totalAdded:   totalPros,
    unsearched:   totalPros - n,          // pros added but never searched on fragr
    oldestDays,                            // days since least-recently-updated pro was searched
    oldestTs:     oldestTs ? oldestTs.toISOString() : null,
    newestTs:     newestTs ? newestTs.toISOString() : null,
    kd:        +avgKd.toFixed(2),
    win_rate:  +avgWr.toFixed(1),
    accuracy:  +avgAcc.toFixed(1),
    avg_kills: +avgKpg.toFixed(1),
    kd_sd:        sdKd  != null ? +sdKd.toFixed(3)  : null,
    win_rate_sd:  sdWr  != null ? +sdWr.toFixed(2)  : null,
    accuracy_sd:  sdAcc != null ? +sdAcc.toFixed(2) : null,
    avg_kills_sd: sdKpg != null ? +sdKpg.toFixed(3) : null,
  };
}

// Batch check which XUIDs already have a recent snapshot (within last N days).
// Returns a Set of xuid strings that are already covered.
async function getRecentlySnapshotted(xuids, withinDays = 7) {
  if (!xuids || !xuids.length) return new Set();
  try {
    const db = await getDb();
    if (!db) return new Set();
    const res = await db.query(
      `SELECT DISTINCT xuid FROM player_snapshots
       WHERE xuid = ANY($1) AND ts > NOW() - INTERVAL '${withinDays} days'`,
      [xuids]
    );
    return new Set(res.rows.map(r => r.xuid));
  } catch(e) {
    console.error('[DB] getRecentlySnapshotted error:', e.message);
    return new Set();
  }
}

// Fetch refresh-tracking metadata for a batch of xuids. Returns a Map keyed
// by xuid → { lastRefreshTs, lastNoNewDataTs, lastMatchesPlayed,
// consecutiveEmptyRefreshes }. Missing xuids are absent from the map.
async function getRefreshMeta(xuids) {
  const out = new Map();
  if (!xuids || !xuids.length) return out;
  try {
    const db = await getDb();
    if (!db) return out;
    const res = await db.query(
      `SELECT xuid, last_refresh_ts, last_no_new_data_ts, last_matches_played, consecutive_empty_refreshes
       FROM player_refresh_meta WHERE xuid = ANY($1)`,
      [xuids.map(x => String(x))]
    );
    for (const r of res.rows) {
      out.set(String(r.xuid), {
        lastRefreshTs: r.last_refresh_ts ? new Date(r.last_refresh_ts) : null,
        lastNoNewDataTs: r.last_no_new_data_ts ? new Date(r.last_no_new_data_ts) : null,
        lastMatchesPlayed: r.last_matches_played != null ? Number(r.last_matches_played) : null,
        consecutiveEmptyRefreshes: r.consecutive_empty_refreshes != null ? Number(r.consecutive_empty_refreshes) : 0,
      });
    }
  } catch(e) {
    console.error('[DB] getRefreshMeta error:', e.message);
  }
  return out;
}

// Record that we attempted (or completed) a refresh for a player. Bumps
// last_refresh_ts, tracks consecutive empty refreshes so the queue can
// deprioritize accounts with no new data after the stale-rescan window.
async function markRefreshAttempt(xuid, gamertag, currentMatchesPlayed) {
  if (!xuid) return;
  try {
    const db = await getDb();
    if (!db) return;
    // Read prior to decide whether this is "new data" or not.
    const prior = await db.query(
      `SELECT last_matches_played, consecutive_empty_refreshes FROM player_refresh_meta WHERE xuid = $1`,
      [String(xuid)]
    );
    const priorRow = prior.rows[0];
    const priorMatches = priorRow ? Number(priorRow.last_matches_played) : null;
    const priorEmpty = priorRow ? Number(priorRow.consecutive_empty_refreshes || 0) : 0;
    // hadNewData = current matches played > last observed (when both known).
    // If we had no prior, treat it as new data so first observation counts.
    const cmp = currentMatchesPlayed != null ? Number(currentMatchesPlayed) : null;
    const hadNewData = priorMatches == null ? (cmp != null) : (cmp != null && cmp > priorMatches);
    const nextEmpty = hadNewData ? 0 : priorEmpty + 1;
    await db.query(
      `INSERT INTO player_refresh_meta (xuid, gamertag, last_refresh_ts, last_no_new_data_ts, last_matches_played, consecutive_empty_refreshes)
       VALUES ($1, $2, NOW(), $3, $4, $5)
       ON CONFLICT (xuid) DO UPDATE SET
         gamertag = COALESCE(EXCLUDED.gamertag, player_refresh_meta.gamertag),
         last_refresh_ts = NOW(),
         last_no_new_data_ts = CASE WHEN $6 THEN NULL ELSE NOW() END,
         last_matches_played = COALESCE(EXCLUDED.last_matches_played, player_refresh_meta.last_matches_played),
         consecutive_empty_refreshes = $5`,
      [String(xuid), gamertag || null, hadNewData ? null : new Date(), cmp, nextEmpty, hadNewData]
    );
    return { hadNewData, consecutiveEmptyRefreshes: nextEmpty };
  } catch(e) {
    console.error('[DB] markRefreshAttempt error:', e.message);
  }
}

// Leaderboard: top N players per metric using most recent snapshot per player
async function getLeaderboardData(limit = 100000) {
  try {
    const db = await getDb();
    if (!db) return { kd: [], winRate: [], csrArena: [], csrSlayer: [], csrLegacy: [] };

    // One row per player (most recent snapshot only), filtered for quality
    // kd < 2 and win_rate < 85 filter out obvious stat manipulators / cheaters
    const base = `
      SELECT DISTINCT ON (xuid)
        gamertag, kd, win_rate, accuracy, avg_kills,
        csr_tier, csr_subtier, csr_value, matches_played, wins, losses, ts, csr
      FROM player_snapshots
      WHERE kd IS NOT NULL AND kd > 0 AND kd < 2
        AND (win_rate IS NULL OR win_rate < 85)
        AND matches_played >= 25
      ORDER BY xuid, ts DESC
    `;

    // Top by K/D
    const kdRes = await db.query(
      `SELECT * FROM (${base}) t WHERE kd IS NOT NULL ORDER BY kd DESC LIMIT $1`,
      [limit]
    );

    // Top by Win Rate (min 50 matches to prevent small-sample flukes)
    const wrRes = await db.query(
      `SELECT * FROM (${base}) t WHERE win_rate IS NOT NULL AND matches_played >= 50 ORDER BY win_rate DESC LIMIT $1`,
      [limit]
    );

    // Per-playlist CSR queries — extract value/tier/subtier from JSONB csr column
    // Playlist key names must match what halo.js stores: 'Ranked Arena', 'Ranked Slayer', 'Ranked Legacy'
    const csrPlaylistQuery = (playlist) => `
      SELECT gamertag, kd, win_rate, matches_played,
        (csr->'${playlist}'->>'value')::int        AS csr_value,
        csr->'${playlist}'->>'tier'               AS csr_tier,
        (csr->'${playlist}'->>'subTier')::int     AS csr_subtier
      FROM (${base}) t
      WHERE csr->'${playlist}'->>'value' IS NOT NULL
        AND (csr->'${playlist}'->>'value')::int > 0
      ORDER BY (csr->'${playlist}'->>'value')::int DESC
      LIMIT $1
    `;

    const [arenaRes, slayerRes, legacyRes] = await Promise.all([
      db.query(csrPlaylistQuery('Ranked Arena'),  [limit]),
      db.query(csrPlaylistQuery('Ranked Slayer'), [limit]),
      db.query(csrPlaylistQuery('Ranked Legacy'), [limit]),
    ]);

    return {
      kd:         kdRes.rows,
      winRate:    wrRes.rows,
      csrArena:   arenaRes.rows,
      csrSlayer:  slayerRes.rows,
      csrLegacy:  legacyRes.rows,
    };
  } catch(e) {
    console.error('[DB] getLeaderboardData error:', e.message);
    return { kd: [], winRate: [], csrArena: [], csrSlayer: [], csrLegacy: [] };
  }
}

// ── Match participants (private-player fallback) ─────────────────────────────
// Persist a row per (match, roster slot) every time we fetch a public player's
// match details. Lets us reconstruct a partial match history for a private
// player by querying their xuid against rows sourced from public players.
//
// sourceXuid = the xuid of the player whose history we were fetching when we
// captured this match. Tracks provenance ("known from public match records").
async function saveMatchParticipants(matchRows, sourceXuid) {
  if (!matchRows || !matchRows.length) return 0;
  try {
    const db = await getDb();
    if (!db) return 0;
    let written = 0;
    for (const m of matchRows) {
      if (!m || !m.matchId || !m.teams || !m.teams.length) continue;
      const startTime = m.startTime ? new Date(m.startTime) : null;
      const durSec = typeof m.duration === 'string' ? null : (m.duration || null);
      const rows = [];
      for (const team of m.teams) {
        if (!team || !team.players) continue;
        const teamOutcome = team.outcome != null ? team.outcome : null;
        for (const pl of team.players) {
          const rawXu = pl.rawXuid && String(pl.rawXuid);
          if (!rawXu) continue;
          rows.push({
            match_id: m.matchId,
            xuid: rawXu,
            gamertag: pl.gamertag && !pl.gamertag.startsWith('Spartan ') ? pl.gamertag : null,
            team_id: team.teamId != null ? team.teamId : null,
            outcome: teamOutcome,
            kills:   pl.kills   != null ? pl.kills   : null,
            deaths:  pl.deaths  != null ? pl.deaths  : null,
            assists: pl.assists != null ? pl.assists : null,
            score:   pl.score   != null ? pl.score   : null,
            damage:  pl.damage  != null ? pl.damage  : null,
            is_ranked: !!m.isRanked,
            game_mode: m.gameMode || null,
            map_name:  m.mapName || null,
            map_image_url: m.mapImageUrl || null,
            start_time: startTime,
            duration_sec: typeof durSec === 'number' ? durSec : null,
            source_xuid: sourceXuid ? String(sourceXuid) : null,
          });
        }
      }
      if (!rows.length) continue;
      // Batch insert per match — small enough to fit a single statement
      const cols = ['match_id','xuid','gamertag','team_id','outcome','kills','deaths','assists','score','damage','is_ranked','game_mode','map_name','map_image_url','start_time','duration_sec','source_xuid'];
      const placeholders = rows.map((_, i) =>
        '(' + cols.map((__, j) => `$${i * cols.length + j + 1}`).join(',') + ')'
      ).join(',');
      const params = rows.flatMap(r => cols.map(c => r[c]));
      // ON CONFLICT: update gamertag/stats only if the new row brings non-null
      // information — never blow away a known gamertag with null.
      const setClauses = cols.filter(c => c !== 'match_id' && c !== 'xuid')
        .map(c => `${c} = COALESCE(EXCLUDED.${c}, match_participants.${c})`).join(',');
      try {
        await db.query(
          `INSERT INTO match_participants (${cols.join(',')}) VALUES ${placeholders}
           ON CONFLICT (match_id, xuid) DO UPDATE SET ${setClauses}, ts = NOW()`,
          params
        );
        written += rows.length;
      } catch(e) {
        console.warn('[DB] saveMatchParticipants insert failed:', e.message);
      }
    }
    if (written) console.log(`[DB] Persisted ${written} participant rows across ${matchRows.length} matches (source=${sourceXuid || '?'})`);
    return written;
  } catch(e) {
    console.error('[DB] saveMatchParticipants error:', e.message);
    return 0;
  }
}

// Reconstruct a partial match history for a player whose own /matches endpoint
// is private/empty, by aggregating rows we captured from OTHER public players'
// matches. Returns matches shaped roughly like fetchMatchHistory output so the
// frontend renderer can consume them directly.
async function reconstructMatchHistoryForXuid(xuid, limit = 100) {
  if (!xuid) return { matches: [], participantRowCount: 0 };
  try {
    const db = await getDb();
    if (!db) return { matches: [], participantRowCount: 0 };
    // 1) Pull every match this xuid appears in (sorted by start_time desc).
    const myRows = await db.query(
      `SELECT match_id, team_id, outcome, kills, deaths, assists, score, damage,
              is_ranked, game_mode, map_name, map_image_url, start_time, duration_sec, gamertag
       FROM match_participants
       WHERE xuid = $1
       ORDER BY start_time DESC NULLS LAST
       LIMIT $2`,
      [String(xuid), limit]
    );
    if (!myRows.rows.length) return { matches: [], participantRowCount: 0 };
    const matchIds = myRows.rows.map(r => r.match_id);
    // 2) Pull all participants for those matches in one query so we can rebuild teams.
    const allRows = await db.query(
      `SELECT match_id, xuid, gamertag, team_id, outcome, kills, deaths, assists, score, damage
       FROM match_participants
       WHERE match_id = ANY($1)`,
      [matchIds]
    );
    const byMatch = {};
    for (const r of allRows.rows) {
      if (!byMatch[r.match_id]) byMatch[r.match_id] = [];
      byMatch[r.match_id].push(r);
    }
    const matches = [];
    for (const my of myRows.rows) {
      const teamMap = {};
      for (const r of (byMatch[my.match_id] || [])) {
        const tid = r.team_id != null ? r.team_id : 0;
        if (!teamMap[tid]) teamMap[tid] = { teamId: tid, outcome: r.outcome, players: [] };
        teamMap[tid].players.push({
          gamertag: r.gamertag || ('Spartan ' + String(r.xuid).slice(-4)),
          rawXuid: r.xuid,
          kills: r.kills || 0,
          deaths: r.deaths || 0,
          assists: r.assists || 0,
          score: r.score || 0,
          kd: (r.deaths || 0) > 0 ? (r.kills / r.deaths).toFixed(2) : String(r.kills || 0),
          kda: ((r.kills || 0) - (r.deaths || 0) + (r.assists || 0) / 3).toFixed(1),
          damage: r.damage || 0,
        });
      }
      // Format duration in ISO 8601 (PT#M#S) so the frontend's existing
      // duration parsers (used by every Stats-tab module) accept reconstructed
      // matches alongside real ones. Without this, stats modules that filter
      // by min-duration would silently drop every reconstructed row.
      let durationIso = null;
      if (typeof my.duration_sec === 'number' && my.duration_sec > 0) {
        const totalSec = Math.round(my.duration_sec);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        durationIso = 'PT' + (h ? h + 'H' : '') + (m ? m + 'M' : '') + (s || (!h && !m) ? s + 'S' : '');
      }
      // Estimate damageTaken so the Damage Trends module can include this row
      // (it requires both damageDealt and damageTaken > 300). We have a rough
      // signal: sum of damage dealt by all enemy players in the same match.
      // It is not perfect (counts damage spread across teammates too) but it
      // is the best approximation we have from participant rows and is clearly
      // labelled as reconstructed in the UI banner.
      let estTaken = 0;
      const allInMatch = byMatch[my.match_id] || [];
      const myTeamId = my.team_id != null ? my.team_id : 0;
      const enemies = allInMatch.filter(r => r.xuid !== String(xuid) && (r.team_id != null ? r.team_id : 0) !== myTeamId);
      if (enemies.length) {
        const totalEnemyDmg = enemies.reduce((s, r) => s + (r.damage || 0), 0);
        // No friendly-fire in Halo Infinite, so all enemy damage was directed
        // at our team. Split evenly across teammates (incl. the target) as a
        // best-effort estimate.
        const myTeammates = allInMatch.filter(r => (r.team_id != null ? r.team_id : 0) === myTeamId).length || 1;
        estTaken = Math.round(totalEnemyDmg / myTeammates);
      }
      matches.push({
        matchId: my.match_id,
        outcome: my.outcome,
        startTime: my.start_time ? new Date(my.start_time).toISOString() : null,
        duration: durationIso,
        durationSec: typeof my.duration_sec === 'number' ? my.duration_sec : null,
        gameMode: my.game_mode,
        mapName: my.map_name,
        mapImageUrl: my.map_image_url,
        isRanked: !!my.is_ranked,
        kills: my.kills || 0,
        deaths: my.deaths || 0,
        assists: my.assists || 0,
        score: my.score || 0,
        damageDealt: my.damage || 0,
        // Approximated from enemy damage; renderer treats this as best-effort
        // for Damage Trends but never as authoritative for accuracy/KDA.
        damageTaken: estTaken,
        teams: Object.values(teamMap),
        // Marker so the frontend (and any downstream stats) can tell this row
        // came from the participant-table fallback rather than a direct fetch.
        reconstructed: true,
      });
    }
    return { matches, participantRowCount: allRows.rows.length };
  } catch(e) {
    console.error('[DB] reconstructMatchHistoryForXuid error:', e.message);
    return { matches: [], participantRowCount: 0 };
  }
}

// Find frequent teammates/opponents for an xuid — used by the background
// "expand coverage" hook so we can enqueue their public histories and grow the
// known-match pool around the private player.
async function getFrequentCoPlayers(xuid, limit = 20) {
  if (!xuid) return [];
  try {
    const db = await getDb();
    if (!db) return [];
    const res = await db.query(
      `SELECT p.xuid, MAX(p.gamertag) AS gamertag, COUNT(*)::int AS games
       FROM match_participants p
       JOIN match_participants me ON me.match_id = p.match_id AND me.xuid = $1
       WHERE p.xuid <> $1
         AND p.gamertag IS NOT NULL
       GROUP BY p.xuid
       ORDER BY games DESC
       LIMIT $2`,
      [String(xuid), limit]
    );
    return res.rows;
  } catch(e) {
    console.error('[DB] getFrequentCoPlayers error:', e.message);
    return [];
  }
}

// Resolve a gamertag → xuid using whichever caches we have.
async function lookupXuidByGamertag(gamertag) {
  if (!gamertag) return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const res = await db.query(
      `SELECT xuid FROM xuid_cache WHERE LOWER(gamertag) = LOWER($1) LIMIT 1`,
      [gamertag]
    );
    if (res.rows.length) return res.rows[0].xuid;
    // Fallback — search participants table (covers players we've only seen as
    // teammates/opponents and never directly searched).
    const res2 = await db.query(
      `SELECT xuid FROM match_participants WHERE LOWER(gamertag) = LOWER($1) LIMIT 1`,
      [gamertag]
    );
    return res2.rows.length ? res2.rows[0].xuid : null;
  } catch(e) {
    console.error('[DB] lookupXuidByGamertag error:', e.message);
    return null;
  }
}

module.exports = { getDb, loadXuidCache, flushXuidCache, loadEmblemCache, flushEmblemCache, savePlayerSnapshot, getRecentlySnapshotted, getSnapshotsByRank, addProPlayer, removeProPlayer, getProPlayers, getProStats, getLeaderboardData, saveMatchParticipants, reconstructMatchHistoryForXuid, getFrequentCoPlayers, lookupXuidByGamertag, getRefreshMeta, markRefreshAttempt };
