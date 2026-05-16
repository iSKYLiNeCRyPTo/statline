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
        // Richer per-participant fields — added in PR "rich match participants".
        // Each column is added independently so live deploys upgrade without
        // downtime; missing columns just stay null on legacy rows. Field
        // sources (Halo CoreStats / RankRecap / objective sub-stats) are
        // documented above saveMatchParticipants.
        const _participantColumns = [
          ['damage_taken',       'INT'],
          ['shots_fired',        'INT'],
          ['shots_landed',       'INT'],
          ['accuracy',           'FLOAT'],
          ['headshot_kills',     'INT'],
          ['melee_kills',        'INT'],
          ['grenade_kills',      'INT'],
          ['power_weapon_kills', 'INT'],
          ['placement',          'INT'],
          ['csr_tier',           'TEXT'],
          ['csr_subtier',        'INT'],
          ['csr_value',          'INT'],
          ['csr_pre_value',      'INT'],
          ['csr_delta',          'INT'],
          ['mmr',                'INT'],
          ['medals',             'JSONB'],
          ['obj_stats',          'JSONB'],
          // enrichment_version bumps whenever saveMatchParticipants begins
          // emitting a new field shape; lets backfills tell legacy rows apart.
          ['enrichment_version', 'INT'],
        ];
        for (const [col, type] of _participantColumns) {
          await _dbPool.query(`ALTER TABLE match_participants ADD COLUMN IF NOT EXISTS ${col} ${type}`);
        }
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
//
// When `playlistKey` is provided ('Ranked Arena' | 'Ranked Slayer' | 'Ranked Legacy'),
// the peer pool is selected from the snapshot's per-playlist CSR JSON instead of
// the top-level `csr_tier/csr_value` columns (which always reflect Arena because
// savePlayerSnapshot prefers Arena). This is what makes the benchmark toggle
// produce a per-playlist peer pool rather than the Arena peer pool re-labeled.
async function getSnapshotsByRank(tier, subTier, csrValue, playlistKey) {
  try {
    const db = await getDb();
    if (!db) return [];
    let queryStr, params;
    if (playlistKey) {
      // JSON path filter — Postgres `csr->'<key>'->>'tier'` etc.
      // The Arena-vs-non-Arena divergence the user reported only matters
      // here: when the toggle selects Slayer/Legacy, the peer pool must be
      // sampled by the player's CSR in THAT playlist.
      if (tier === 'Onyx') {
        const bandLow = csrValue != null ? Math.min(Math.floor(csrValue / 100) * 100, 1900) : 1500;
        const bandHigh = bandLow >= 1900 ? 9999 : bandLow + 100;
        queryStr = `
          SELECT kd, win_rate, accuracy, avg_kills FROM player_snapshots
          WHERE csr->$4->>'tier' = $1
            AND (csr->$4->>'value')::int >= $2
            AND (csr->$4->>'value')::int <  $3
            AND kd IS NOT NULL
            AND ts > NOW() - INTERVAL '30 days'
          ORDER BY ts DESC LIMIT 1000
        `;
        params = [tier, bandLow, bandHigh, playlistKey];
      } else {
        queryStr = `
          SELECT kd, win_rate, accuracy, avg_kills FROM player_snapshots
          WHERE csr->$3->>'tier' = $1
            AND (csr->$3->>'subTier')::int = $2
            AND kd IS NOT NULL
            AND ts > NOW() - INTERVAL '30 days'
          ORDER BY ts DESC LIMIT 1000
        `;
        params = [tier, subTier, playlistKey];
      }
    } else if (tier === 'Onyx') {
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

    // Per-playlist CSR query builder
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

    // Run all 5 queries in parallel — previously kd+winRate were sequential
    const [kdRes, wrRes, arenaRes, slayerRes, legacyRes] = await Promise.all([
      db.query(`SELECT * FROM (${base}) t WHERE kd IS NOT NULL ORDER BY kd DESC LIMIT $1`, [limit]),
      db.query(`SELECT * FROM (${base}) t WHERE win_rate IS NOT NULL AND matches_played >= 50 ORDER BY win_rate DESC LIMIT $1`, [limit]),
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

// ── Single-tab leaderboard query (lazy load) ────────────────────────────────
async function getLeaderboardTab(tab, limit = 100000) {
  try {
    const db = await getDb();
    if (!db) return [];
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
    let res;
    if (tab === 'kd') {
      res = await db.query(`SELECT * FROM (${base}) t WHERE kd IS NOT NULL ORDER BY kd DESC LIMIT $1`, [limit]);
    } else if (tab === 'winRate') {
      res = await db.query(`SELECT * FROM (${base}) t WHERE win_rate IS NOT NULL AND matches_played >= 50 ORDER BY win_rate DESC LIMIT $1`, [limit]);
    } else if (tab === 'csrSlayer') {
      res = await db.query(csrPlaylistQuery('Ranked Slayer'), [limit]);
    } else if (tab === 'csrLegacy') {
      res = await db.query(csrPlaylistQuery('Ranked Legacy'), [limit]);
    } else {
      res = await db.query(csrPlaylistQuery('Ranked Arena'), [limit]);
    }
    return res.rows;
  } catch(e) {
    console.error('[DB] getLeaderboardTab error:', e.message);
    return [];
  }
}

// ── Match participants (private-player fallback) ─────────────────────────────
// Persist a row per (match, roster slot) every time we fetch a public player's
// match details. Lets us reconstruct a partial match history for a private
// player by querying their xuid against rows sourced from public players.
//
// sourceXuid = the xuid of the player whose history we were fetching when we
// captured this match. Tracks provenance ("known from public match records").
//
// Field sources (Halo Infinite match-detail payload via halo.js fetchMatchHistory):
//   kills / deaths / assists / score / damage / damage_taken / shots_fired /
//     shots_landed / accuracy / headshot_kills / melee_kills / grenade_kills /
//     power_weapon_kills
//                                ← PlayerTeamStats[0].Stats.CoreStats.*
//   medals                       ← PlayerTeamStats[0].Stats.CoreStats.Medals
//                                  (filtered to {nameId, count} for non-zero counts)
//   placement                    ← player.Rank + 1 (post-game leaderboard position)
//   csr_tier / csr_subtier / csr_value / csr_pre_value / csr_delta
//                                ← PlayerTeamStats[0].RankRecap.{PostMatchCsr,PreMatchCsr}
//   mmr                          ← skill.svc TeamMmr at match time (best-effort)
//   obj_stats                    ← Oddball/Zones/CTF/Stockpile fields
//
// All rich fields are optional: rows that predate the schema (or were
// constructed from a cached blob missing a field) stay null. Backfills only
// COALESCE non-null values in so we never overwrite a richer prior write.
const PARTICIPANT_ENRICHMENT_VERSION = 1;

const PARTICIPANT_COLS = [
  'match_id','xuid','gamertag','team_id','outcome',
  'kills','deaths','assists','score','damage',
  'is_ranked','game_mode','map_name','map_image_url','start_time','duration_sec','source_xuid',
  // PR "rich match participants" — see column docs above. Field order matters
  // for legacy verify-* scripts that index params by position, but new tests
  // use buildParticipantRow() to avoid hard-coded offsets.
  'damage_taken','shots_fired','shots_landed','accuracy',
  'headshot_kills','melee_kills','grenade_kills','power_weapon_kills',
  'placement','csr_tier','csr_subtier','csr_value','csr_pre_value','csr_delta','mmr',
  'medals','obj_stats','enrichment_version',
];

function _numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _intOrNull(v) {
  const n = _numOrNull(v);
  return n == null ? null : Math.trunc(n);
}

// Build the row payload for one roster slot (team.players[i]). The match-level
// fields (gameMode, isRanked, etc.) come in via meta — separating concerns so
// the same function can be used both for fresh Halo fetches and for backfill
// from cached blobs that already nested everything per-match.
function buildParticipantRow(pl, team, meta) {
  const rawXu = pl.rawXuid && String(pl.rawXuid);
  if (!rawXu) return null;
  // Medals: only persist {nameId, count} for non-zero counts. The full Halo
  // payload includes a dozen extra fields per medal we don't need.
  let medalsJson = null;
  const rawMedals = pl.medals != null ? pl.medals : pl.topMedals;
  if (Array.isArray(rawMedals) && rawMedals.length) {
    const cleaned = rawMedals
      .map(mm => {
        if (!mm) return null;
        const id = mm.nameId != null ? mm.nameId : (mm.NameId != null ? mm.NameId : null);
        const ct = mm.count   != null ? mm.count   : (mm.Count   != null ? mm.Count   : null);
        if (id == null || !ct) return null;
        return { nameId: Number(id), count: Number(ct) };
      })
      .filter(x => x && x.count > 0);
    if (cleaned.length) medalsJson = JSON.stringify(cleaned);
  }
  const objStatsJson = pl.objStats && typeof pl.objStats === 'object'
    ? JSON.stringify(pl.objStats)
    : null;
  return {
    match_id: meta.matchId,
    xuid: rawXu,
    gamertag: pl.gamertag && !pl.gamertag.startsWith('Spartan ') ? pl.gamertag : null,
    team_id: team && team.teamId != null ? team.teamId : null,
    outcome: team && team.outcome != null ? team.outcome : null,
    kills:   _intOrNull(pl.kills),
    deaths:  _intOrNull(pl.deaths),
    assists: _intOrNull(pl.assists),
    score:   _intOrNull(pl.score),
    damage:  _intOrNull(pl.damage),
    is_ranked: !!meta.isRanked,
    game_mode: meta.gameMode || null,
    map_name:  meta.mapName || null,
    map_image_url: meta.mapImageUrl || null,
    start_time: meta.startTime,
    duration_sec: typeof meta.durationSec === 'number' ? meta.durationSec : null,
    source_xuid: meta.sourceXuid ? String(meta.sourceXuid) : null,
    // Rich fields — every one is null-safe.
    damage_taken:        _intOrNull(pl.damageTaken),
    shots_fired:         _intOrNull(pl.shotsFired),
    shots_landed:        _intOrNull(pl.shotsLanded != null ? pl.shotsLanded : pl.shotsHit),
    accuracy:            pl.accuracy != null ? _numOrNull(pl.accuracy) : null,
    headshot_kills:      _intOrNull(pl.headshotKills != null ? pl.headshotKills : (pl.weaponStats && pl.weaponStats.headshots)),
    melee_kills:         _intOrNull(pl.meleeKills    != null ? pl.meleeKills    : (pl.weaponStats && pl.weaponStats.melee)),
    grenade_kills:       _intOrNull(pl.grenadeKills  != null ? pl.grenadeKills  : (pl.weaponStats && pl.weaponStats.grenades)),
    power_weapon_kills:  _intOrNull(pl.powerWeaponKills != null ? pl.powerWeaponKills : (pl.weaponStats && pl.weaponStats.powerWeapon)),
    placement:           _intOrNull(pl.placement),
    // CSR fields persist ONLY when sourced from this match's RankRecap
    // (per-match, playlist-correct). Slots filled in by
    // enrichMatchTeamsWithCsr's snapshot-fallback path carry csrFromSnapshot:
    // those are the player's CURRENT rank, not their post-game rank, and writing
    // them here would poison match_participants with cross-playlist values
    // (e.g. the player's Arena CSR persisted on their Slayer match rows).
    csr_tier:            pl.csrFromSnapshot ? null : (pl.csrTier || null),
    csr_subtier:         pl.csrFromSnapshot ? null : _intOrNull(pl.csrSubTier),
    csr_value:           pl.csrFromSnapshot ? null : _intOrNull(pl.csrValue),
    csr_pre_value:       pl.csrFromSnapshot ? null : _intOrNull(pl.csrPreValue),
    csr_delta:           pl.csrFromSnapshot ? null : _intOrNull(pl.csrDelta),
    mmr:                 _intOrNull(pl.mmr),
    medals:              medalsJson,
    obj_stats:           objStatsJson,
    enrichment_version:  PARTICIPANT_ENRICHMENT_VERSION,
  };
}

async function saveMatchParticipants(matchRows, sourceXuid) {
  if (!matchRows || !matchRows.length) return 0;
  try {
    const db = await getDb();
    if (!db) return 0;
    let written = 0;
    for (const m of matchRows) {
      if (!m || !m.matchId || !m.teams || !m.teams.length) continue;
      const startTime = m.startTime ? new Date(m.startTime) : null;
      // duration may be ISO ("PT9M30S"), numeric seconds, or a numeric string —
      // tolerate all three. Anything else stays null.
      let durSec = null;
      if (typeof m.duration === 'number') durSec = m.duration;
      else if (typeof m.durationSec === 'number') durSec = m.durationSec;
      else if (typeof m.duration === 'string') {
        const parsed = m.duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/);
        if (parsed) {
          const h = parseInt(parsed[1] || 0, 10);
          const mm = parseInt(parsed[2] || 0, 10);
          const s = parseFloat(parsed[3] || 0);
          durSec = (h * 3600) + (mm * 60) + s;
          if (!Number.isFinite(durSec) || durSec <= 0) durSec = null;
        } else if (/^\d+(\.\d+)?$/.test(m.duration)) {
          durSec = parseFloat(m.duration);
        }
      }
      const meta = {
        matchId: m.matchId,
        isRanked: m.isRanked,
        gameMode: m.gameMode,
        mapName: m.mapName,
        mapImageUrl: m.mapImageUrl,
        startTime,
        durationSec: typeof durSec === 'number' ? Math.round(durSec) : null,
        sourceXuid,
      };
      const rows = [];
      for (const team of m.teams) {
        if (!team || !team.players) continue;
        for (const pl of team.players) {
          const r = buildParticipantRow(pl, team, meta);
          if (r) rows.push(r);
        }
      }
      if (!rows.length) continue;
      const cols = PARTICIPANT_COLS;
      const placeholders = rows.map((_, i) =>
        '(' + cols.map((__, j) => `$${i * cols.length + j + 1}`).join(',') + ')'
      ).join(',');
      const params = rows.flatMap(r => cols.map(c => r[c]));
      // ON CONFLICT: update each column only when the new value is non-null.
      // Never blow away a richer prior write (e.g. real damageTaken) with a
      // null from a thinner backfill source.
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

// Score a participant row by how much rich data it carries. Used to pick the
// "best" row when collapsing duplicates that share a match_id for one xuid.
// Counts non-null/non-empty values across the rich columns (CoreStats,
// RankRecap, objective stats, medals). Higher = richer.
function _participantRowRichness(r) {
  if (!r) return -1;
  let score = 0;
  const numFields = [
    'kills','deaths','assists','score','damage','damage_taken',
    'shots_fired','shots_landed','accuracy',
    'headshot_kills','melee_kills','grenade_kills','power_weapon_kills',
    'placement','csr_value','csr_pre_value','csr_delta','csr_subtier','mmr',
    'duration_sec',
  ];
  for (const f of numFields) if (r[f] != null) score++;
  if (r.csr_tier) score++;
  if (r.gamertag) score++;
  if (r.start_time) score++;
  if (r.team_id != null) score++;
  if (r.outcome != null) score++;
  if (r.medals) {
    try {
      const m = typeof r.medals === 'string' ? JSON.parse(r.medals) : r.medals;
      if (Array.isArray(m) && m.length) score++;
    } catch { /* malformed JSON — ignore */ }
  }
  if (r.obj_stats) {
    try {
      const o = typeof r.obj_stats === 'string' ? JSON.parse(r.obj_stats) : r.obj_stats;
      if (o && Object.keys(o).length) score++;
    } catch { /* malformed JSON — ignore */ }
  }
  return score;
}

// Collapse participant rows so each match_id appears at most once. The PK
// (match_id, xuid) already enforces this at the DB level, so this is a
// belt-and-suspenders guard for legacy data / future schema drift. When two
// rows share a match_id, prefer the richer one; ties → newer ts.
function _dedupeParticipantRowsByMatchId(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return rows || [];
  const seen = new Map();
  for (const r of rows) {
    if (!r || !r.match_id) continue;
    const prev = seen.get(r.match_id);
    if (!prev) { seen.set(r.match_id, r); continue; }
    const a = _participantRowRichness(prev);
    const b = _participantRowRichness(r);
    if (b > a) seen.set(r.match_id, r);
    else if (b === a) {
      const tsA = prev.ts ? new Date(prev.ts).getTime() : 0;
      const tsB = r.ts    ? new Date(r.ts).getTime()    : 0;
      if (tsB > tsA) seen.set(r.match_id, r);
    }
  }
  // Preserve original start_time DESC ordering from the SQL.
  const out = [];
  const emitted = new Set();
  for (const r of rows) {
    if (!r || !r.match_id || emitted.has(r.match_id)) continue;
    const winner = seen.get(r.match_id);
    if (winner) { out.push(winner); emitted.add(r.match_id); }
  }
  return out;
}

// Reconstruct a partial match history for a player whose own /matches endpoint
// is private/empty, by aggregating rows we captured from OTHER public players'
// matches. Returns matches shaped roughly like fetchMatchHistory output so the
// frontend renderer can consume them directly.
async function reconstructMatchHistoryForXuid(xuid, limit = 100) {
  if (!xuid) return { matches: [], participantRowCount: 0, enrichmentCoverage: {} };
  try {
    const db = await getDb();
    if (!db) return { matches: [], participantRowCount: 0, enrichmentCoverage: {} };
    // 1) Pull every match this xuid appears in (sorted by start_time desc).
    // SELECT *: column drift between schemas is handled at row-read time so
    // legacy deploys without the rich columns still respond.
    const myRows = await db.query(
      `SELECT * FROM match_participants
       WHERE xuid = $1
       ORDER BY start_time DESC NULLS LAST
       LIMIT $2`,
      [String(xuid), limit]
    );
    if (!myRows.rows.length) return { matches: [], participantRowCount: 0, enrichmentCoverage: {} };
    // Defense-in-depth dedupe by match_id. The (match_id, xuid) primary key
    // already guarantees one row per match for this xuid, but if any legacy
    // rows ever slipped in (pre-PK insert path, manual fixup, future schema
    // drift) we collapse to one. Prefer the richer row — most populated rich
    // fields wins, ties broken by newest ingest (ts).
    const dedupedMyRows = _dedupeParticipantRowsByMatchId(myRows.rows);
    const matchIds = dedupedMyRows.map(r => r.match_id);
    // 2) Pull all participants for those matches in one query so we can rebuild teams.
    const allRows = await db.query(
      `SELECT * FROM match_participants WHERE match_id = ANY($1)`,
      [matchIds]
    );
    const byMatch = {};
    for (const r of allRows.rows) {
      if (!byMatch[r.match_id]) byMatch[r.match_id] = [];
      byMatch[r.match_id].push(r);
    }
    // Coverage counters so callers (and tests) can tell which rich fields
    // were actually populated for this player vs. left null.
    const coverage = {
      total: dedupedMyRows.length,
      damageTaken: 0,
      accuracy: 0,
      headshotKills: 0,
      shotsFired: 0,
      csr: 0,
      objStats: 0,
      medals: 0,
      placement: 0,
    };
    const matches = [];
    for (const my of dedupedMyRows) {
      const teamMap = {};
      for (const r of (byMatch[my.match_id] || [])) {
        const tid = r.team_id != null ? r.team_id : 0;
        if (!teamMap[tid]) teamMap[tid] = { teamId: tid, outcome: r.outcome, players: [] };
        const weaponStats = (r.headshot_kills != null || r.melee_kills != null || r.grenade_kills != null || r.power_weapon_kills != null) ? {
          headshots:   r.headshot_kills || 0,
          melee:       r.melee_kills || 0,
          grenades:    r.grenade_kills || 0,
          powerWeapon: r.power_weapon_kills || 0,
        } : null;
        let medals = null;
        try {
          if (r.medals) medals = typeof r.medals === 'string' ? JSON.parse(r.medals) : r.medals;
        } catch { medals = null; }
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
          // Rich fields surface on team-roster players too so the match-detail
          // modal can render CSR badges, accuracy, headshots, etc. consistently
          // with a direct-fetched match.
          damageTaken: r.damage_taken != null ? r.damage_taken : null,
          accuracy: r.accuracy != null ? r.accuracy : null,
          shotsFired: r.shots_fired != null ? r.shots_fired : null,
          shotsLanded: r.shots_landed != null ? r.shots_landed : null,
          csrTier: r.csr_tier || null,
          csrSubTier: r.csr_subtier != null ? r.csr_subtier : null,
          csrValue: r.csr_value != null ? r.csr_value : null,
          csrDelta: r.csr_delta != null ? r.csr_delta : null,
          weaponStats,
          medals,
          placement: r.placement != null ? r.placement : null,
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
        const mn = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        durationIso = 'PT' + (h ? h + 'H' : '') + (mn ? mn + 'M' : '') + (s || (!h && !mn) ? s + 'S' : '');
      }
      // Real damageTaken if we have it from the Halo CoreStats payload; only
      // fall back to enemy-damage estimation when the column is null AND no
      // sibling row in this match supplies it either. Estimated values are
      // tagged so the UI can mark them as approximate.
      let damageTaken = null;
      let damageTakenEstimated = false;
      if (my.damage_taken != null) {
        damageTaken = my.damage_taken;
      } else {
        const allInMatch = byMatch[my.match_id] || [];
        const myTeamId = my.team_id != null ? my.team_id : 0;
        const enemies = allInMatch.filter(r => r.xuid !== String(xuid) && (r.team_id != null ? r.team_id : 0) !== myTeamId);
        if (enemies.length) {
          const totalEnemyDmg = enemies.reduce((s, r) => s + (r.damage || 0), 0);
          // No friendly-fire in Halo Infinite, so all enemy damage was directed
          // at our team. Split evenly across teammates (incl. the target) as a
          // best-effort estimate.
          const myTeammates = allInMatch.filter(r => (r.team_id != null ? r.team_id : 0) === myTeamId).length || 1;
          damageTaken = Math.round(totalEnemyDmg / myTeammates);
          damageTakenEstimated = damageTaken > 0;
        } else {
          damageTaken = 0;
        }
      }
      // Per-match weaponStats (top-level — used by Kill Breakdown when present).
      const myWeaponStats = (my.headshot_kills != null || my.melee_kills != null || my.grenade_kills != null || my.power_weapon_kills != null) ? {
        headshots:   my.headshot_kills || 0,
        melee:       my.melee_kills || 0,
        grenades:    my.grenade_kills || 0,
        powerWeapon: my.power_weapon_kills || 0,
      } : null;
      let myObjStats = null;
      try {
        if (my.obj_stats) myObjStats = typeof my.obj_stats === 'string' ? JSON.parse(my.obj_stats) : my.obj_stats;
      } catch { myObjStats = null; }
      let myMedals = null;
      try {
        if (my.medals) myMedals = typeof my.medals === 'string' ? JSON.parse(my.medals) : my.medals;
      } catch { myMedals = null; }
      // CSR badge for the player row — "Onyx 1500" / "Diamond 4" style label
      // matching halo.js csrAfter formatting.
      let csrAfter = null;
      if (my.csr_tier) {
        csrAfter = my.csr_tier === 'Onyx'
          ? 'Onyx ' + (my.csr_value || '')
          : my.csr_tier + (my.csr_subtier != null ? ' ' + my.csr_subtier : '');
        csrAfter = csrAfter.trim();
      }
      // Update coverage counters from the player's own row (not teammate rows).
      if (my.damage_taken != null) coverage.damageTaken++;
      if (my.accuracy != null) coverage.accuracy++;
      if (my.headshot_kills != null) coverage.headshotKills++;
      if (my.shots_fired != null) coverage.shotsFired++;
      if (my.csr_tier) coverage.csr++;
      if (myObjStats) coverage.objStats++;
      if (myMedals && myMedals.length) coverage.medals++;
      if (my.placement != null) coverage.placement++;

      // ── Outcome inference ─────────────────────────────────────────────────
      // Many older rows have outcome=NULL/0/1 (unknown/DNF from early ingest).
      // Strategy: if not a clear 2(win) or 3(loss), first try teammates' rows
      // (they were often ingested via a different path and have real outcomes),
      // then fall back to team-score comparison which is always reliable.
      let effectiveOutcome = my.outcome;
      if (effectiveOutcome !== 2 && effectiveOutcome !== 3) {
        const matchRows = byMatch[my.match_id] || [];
        // 1) Teammate with a real outcome
        const teammateRow = matchRows.find(r =>
          r.xuid !== my.xuid &&
          r.team_id != null && r.team_id === my.team_id &&
          (r.outcome === 2 || r.outcome === 3)
        );
        if (teammateRow) {
          effectiveOutcome = teammateRow.outcome;
        } else {
          // 2) Score comparison across teams
          const teamScores = {};
          for (const r of matchRows) {
            const tid = r.team_id != null ? r.team_id : -1;
            teamScores[tid] = (teamScores[tid] || 0) + (r.score || 0);
          }
          const myTid = my.team_id != null ? my.team_id : -1;
          const myScore = teamScores[myTid] || 0;
          const oppMax = Math.max(0, ...Object.entries(teamScores)
            .filter(([t]) => parseInt(t) !== myTid)
            .map(([, s]) => s));
          if (myScore > oppMax) effectiveOutcome = 2;
          else if (myScore < oppMax) effectiveOutcome = 3;
          else effectiveOutcome = my.outcome; // genuine draw or no data
        }
      }

      matches.push({
        matchId: my.match_id,
        outcome: effectiveOutcome,
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
        // Per-match KDA — matches the formula in halo.js so match cards render
        // a real number instead of "—" for reconstructed private-player rows.
        kda: ((my.kills || 0) - (my.deaths || 0) + (my.assists || 0) / 3).toFixed(1),
        score: my.score || 0,
        damageDealt: my.damage || 0,
        damageTaken,
        // Marker so the renderer can label the cell when this is an estimate
        // rather than the real CoreStats.DamageTaken value.
        damageTakenEstimated,
        // Shooting stats — null when not captured.
        accuracy: my.accuracy != null ? String(my.accuracy) : null,
        shotsFired: my.shots_fired,
        shotsHit:   my.shots_landed,
        // Per-match weaponStats + objective stats: the Stats tab modules
        // (Kill Breakdown, Objective Profile) gate on these being present.
        weaponStats: myWeaponStats,
        topMedals: myMedals,
        objStats: myObjStats,
        placement: my.placement != null ? my.placement : null,
        // CSR (per-match, post-game).
        csrAfter,
        csrDelta: my.csr_delta != null ? my.csr_delta : null,
        csrTier: my.csr_tier || null,
        csrSubTier: my.csr_subtier != null ? my.csr_subtier : null,
        csrValue: my.csr_value != null ? my.csr_value : null,
        // Pre-game CSR (numeric) — lets the CSR chart compute deltas even
        // when csr_delta is null on backfilled rows.
        csrPreValue: my.csr_pre_value != null ? my.csr_pre_value : null,
        // Skill-API MMR (best effort — may be null if backfilled from a blob
        // that didn't carry it).
        mmr: my.mmr != null ? my.mmr : null,
        teams: Object.values(teamMap),
        // Marker so the frontend (and any downstream stats) can tell this row
        // came from the participant-table fallback rather than a direct fetch.
        reconstructed: true,
      });
    }
    return { matches, participantRowCount: allRows.rows.length, enrichmentCoverage: coverage };
  } catch(e) {
    console.error('[DB] reconstructMatchHistoryForXuid error:', e.message);
    return { matches: [], participantRowCount: 0, enrichmentCoverage: {} };
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

// Recovery seeds for the private/reconstructed history pipeline.
// Returns co-players ranked by likelihood that pulling their full match
// history will reveal more shared matches with the target xuid.
//
// Preference order, encoded as the SQL ORDER BY:
//   1. shared_team — how many known matches we share with this co-player
//      on the SAME team (strong "they queue together" signal).
//   2. recent_shared — total shared matches in the last 60 days
//      (recency-weighted; old data may be stale rosters).
//   3. total_shared — fallback for sparse rosters where team_id wasn't
//      captured.
//
// Returns rows: { xuid, gamertag, total_shared, shared_team, recent_shared,
//                 latest_shared }
async function getRecoverySeeds(xuid, limit = 10) {
  if (!xuid) return [];
  try {
    const db = await getDb();
    if (!db) return [];
    const res = await db.query(
      `WITH me AS (
         SELECT match_id, team_id, start_time
         FROM match_participants
         WHERE xuid = $1
       )
       SELECT p.xuid,
              MAX(p.gamertag) AS gamertag,
              COUNT(*)::int AS total_shared,
              COUNT(*) FILTER (WHERE p.team_id IS NOT NULL
                                 AND me.team_id IS NOT NULL
                                 AND p.team_id = me.team_id)::int AS shared_team,
              COUNT(*) FILTER (WHERE me.start_time > NOW() - INTERVAL '60 days')::int AS recent_shared,
              MAX(me.start_time) AS latest_shared
       FROM match_participants p
       JOIN me ON me.match_id = p.match_id
       WHERE p.xuid <> $1
         AND p.gamertag IS NOT NULL
         AND p.gamertag NOT LIKE 'Spartan %'
       GROUP BY p.xuid
       ORDER BY shared_team DESC, recent_shared DESC, total_shared DESC, latest_shared DESC NULLS LAST
       LIMIT $2`,
      [String(xuid), limit]
    );
    return res.rows;
  } catch(e) {
    console.error('[DB] getRecoverySeeds error:', e.message);
    return [];
  }
}

// Count distinct matches stored for an xuid — used by the recovery pipeline
// to measure coverage gain before/after a fetch run.
async function countMatchesForXuid(xuid) {
  if (!xuid) return 0;
  try {
    const db = await getDb();
    if (!db) return 0;
    const res = await db.query(
      `SELECT COUNT(DISTINCT match_id)::int AS n FROM match_participants WHERE xuid = $1`,
      [String(xuid)]
    );
    return res.rows[0]?.n || 0;
  } catch(e) {
    console.error('[DB] countMatchesForXuid error:', e.message);
    return 0;
  }
}

// Map gameMode/playlist hints → 'arena' | 'slayer' | 'legacy' for the snapshot
// CSR JSON lookup. Returns null for unranked / unknown so the caller can skip
// the per-playlist fallback rather than show wrong rank.
function _playlistKindOf(m) {
  if (!m) return null;
  if (m.playlistKind) return m.playlistKind;
  if (m.isRanked === false) return null;
  const gm = (m.gameMode || '').toLowerCase();
  if (gm.includes('ranked slayer')) return 'slayer';
  if (gm.includes('ranked legacy')) return 'legacy';
  if (gm.includes('ranked arena'))  return 'arena';
  return null;
}
const PLAYLIST_KIND_TO_CSR_KEY = { arena: 'Ranked Arena', slayer: 'Ranked Slayer', legacy: 'Ranked Legacy' };

// Enrich a list of match objects with CSR/rank data on each team-roster
// player slot, so the expanded match-detail team table can always render
// rank badges next to player names. Three sources are consulted in order:
//
//   1. The per-match RankRecap already carried on the player slot
//      (csrTier/csrSubTier/csrValue) — set by halo.js for ranked matches we
//      fetched ourselves. Already correct; nothing to do.
//   2. The match_participants row for (match_id, xuid) — set whenever ANY
//      public player's history surfaced this match. Provides the post-game
//      CSR for that specific match (so it is always for the right playlist).
//   3. The most recent player_snapshots row for this xuid — provides the
//      player's CURRENT rank in THIS MATCH'S PLAYLIST (from the `csr` JSON
//      column). Tagged as `csrFromSnapshot:true` so the renderer can mark
//      the badge as approximate. Skipped if the player has no CSR for this
//      playlist — better to omit the badge than show Arena CSR on a Slayer
//      match row.
//
// Cached match blobs predating PR #5 carry no csrTier on team rosters; this
// function fills them in without re-fetching anything from Halo. Mutates
// `matches` in place. Safe to call on undefined / empty arrays.
async function enrichMatchTeamsWithCsr(matches) {
  if (!Array.isArray(matches) || !matches.length) return { perMatch: 0, snapshot: 0, missing: 0 };
  // First pass: collect (matchId, xuid) pairs missing per-match CSR.
  const matchIdToXuids = new Map();          // matchId -> Set of xuids
  const xuidToSlots = new Map();             // xuid -> array of player slot refs (mutated later)
  const allXuids = new Set();
  for (const m of matches) {
    if (!m || !Array.isArray(m.teams)) continue;
    const mid = m.matchId;
    for (const team of m.teams) {
      if (!team || !Array.isArray(team.players)) continue;
      for (const pl of team.players) {
        if (!pl) continue;
        const xu = pl.rawXuid || pl.xuid;
        if (!xu) continue;
        // Skip if already has rank data (either casing).
        const hasTier = (pl.csrTier != null && pl.csrTier !== '') || (pl.csr_tier != null && pl.csr_tier !== '');
        if (hasTier) continue;
        if (mid) {
          if (!matchIdToXuids.has(mid)) matchIdToXuids.set(mid, new Set());
          matchIdToXuids.get(mid).add(String(xu));
        }
        if (!xuidToSlots.has(String(xu))) xuidToSlots.set(String(xu), []);
        xuidToSlots.get(String(xu)).push(pl);
        allXuids.add(String(xu));
      }
    }
  }
  if (!allXuids.size) return { perMatch: 0, snapshot: 0, missing: 0 };

  let perMatchHits = 0, snapshotHits = 0;
  try {
    const db = await getDb();
    if (!db) return { perMatch: 0, snapshot: 0, missing: allXuids.size };

    // Pull most recent snapshot for every xuid we're enriching upfront so both
    // Step 2 (validate participant rows against snapshot) and Step 3 (fallback)
    // can consult it. DISTINCT ON respects ORDER BY ts DESC.
    const xuidArr = Array.from(allXuids);
    const snapRowsRes = await db.query(
      `SELECT DISTINCT ON (xuid) xuid, csr_tier, csr_subtier, csr_value, csr, ts
       FROM player_snapshots
       WHERE xuid = ANY($1) AND csr_tier IS NOT NULL
       ORDER BY xuid, ts DESC`,
      [xuidArr]
    );
    const snapByXuid = new Map();
    for (const r of snapRowsRes.rows) {
      let csrJson = r.csr;
      if (csrJson && typeof csrJson === 'string') {
        try { csrJson = JSON.parse(csrJson); } catch { csrJson = null; }
      }
      snapByXuid.set(String(r.xuid), { row: r, csr: csrJson || null });
    }

    // Pick the snapshot's playlist-specific CSR entry, or null if absent.
    function _snapEntryForKind(snap, kind) {
      if (!snap || !snap.csr || !kind) return null;
      const key = PLAYLIST_KIND_TO_CSR_KEY[kind];
      const entry = key ? snap.csr[key] : null;
      return entry && entry.tier ? entry : null;
    }
    // Detect "poisoned" participant rows from pre-fix deployments: the row's
    // tier matches a NON-match playlist's snapshot tier (typically Arena
    // bleeding into Slayer/Legacy rows) but disagrees with the snapshot's
    // entry for the match's actual playlist. Heuristic — not perfect, but the
    // alternative is keeping wrong badges on legacy rows.
    function _participantRowLooksPoisoned(row, snap, kind) {
      if (!snap || !snap.csr || !kind) return false;
      const matchEntry = _snapEntryForKind(snap, kind);
      // Player has Slayer CSR but row says Onyx 1820 (Arena number)?
      // Look across other playlists for a tier+value match.
      for (const otherKind of Object.keys(PLAYLIST_KIND_TO_CSR_KEY)) {
        if (otherKind === kind) continue;
        const otherEntry = _snapEntryForKind(snap, otherKind);
        if (!otherEntry) continue;
        const tierMatch = otherEntry.tier === row.csr_tier;
        const valueMatch = row.csr_value != null && otherEntry.value != null
          && Math.abs(otherEntry.value - row.csr_value) <= 5;
        // If the row data clearly belongs to a different playlist AND
        // disagrees with the actual match playlist's data, it's poisoned.
        if (tierMatch && valueMatch) {
          if (!matchEntry) return true;
          const matchTierDiffers = matchEntry.tier !== row.csr_tier;
          const matchValueDiffers = matchEntry.value != null && row.csr_value != null
            && Math.abs(matchEntry.value - row.csr_value) > 5;
          if (matchTierDiffers || matchValueDiffers) return true;
        }
      }
      return false;
    }

    // Step 2: per-match CSR from match_participants. Single query for ALL
    // (match_id, xuid) pairs missing rank data.
    const poisonedKeys = new Set(); // `${matchId}|${xuid}` of rows we rejected
    if (matchIdToXuids.size) {
      const mids = Array.from(matchIdToXuids.keys());
      const xuids = Array.from(new Set([].concat(...Array.from(matchIdToXuids.values()).map(s => Array.from(s)))));
      if (mids.length && xuids.length) {
        const rows = await db.query(
          `SELECT match_id, xuid, csr_tier, csr_subtier, csr_value, csr_delta, csr_pre_value
           FROM match_participants
           WHERE match_id = ANY($1) AND xuid = ANY($2) AND csr_tier IS NOT NULL`,
          [mids, xuids]
        );
        const byKey = new Map();
        for (const r of rows.rows) byKey.set(r.match_id + '|' + r.xuid, r);
        for (const m of matches) {
          if (!m || !m.matchId || !Array.isArray(m.teams)) continue;
          const kind = _playlistKindOf(m);
          for (const team of m.teams) {
            if (!team || !Array.isArray(team.players)) continue;
            for (const pl of team.players) {
              if (!pl) continue;
              if (pl.csrTier || pl.csr_tier) continue;
              const xu = pl.rawXuid || pl.xuid;
              if (!xu) continue;
              const key = m.matchId + '|' + String(xu);
              const row = byKey.get(key);
              if (!row) continue;
              // Reject participant rows poisoned by the pre-fix snapshot
              // fallback (e.g. Arena CSR persisted on Slayer match rows).
              // Fall through to Step 3, which will pick the snapshot's
              // playlist-specific CSR if available.
              const snap = snapByXuid.get(String(xu));
              if (_participantRowLooksPoisoned(row, snap, kind)) {
                poisonedKeys.add(key);
                continue;
              }
              pl.csrTier = row.csr_tier;
              if (row.csr_subtier != null) pl.csrSubTier = row.csr_subtier;
              if (row.csr_value != null) pl.csrValue = row.csr_value;
              if (row.csr_delta != null) pl.csrDelta = row.csr_delta;
              if (row.csr_pre_value != null) pl.csrPreValue = row.csr_pre_value;
              perMatchHits++;
            }
          }
        }
      }
    }

    // Step 3: snapshot fallback. Only for xuids still missing rank data.
    // Per-slot now: each slot has a playlist context (arena/slayer/legacy)
    // inherited from its parent match. We read the player's per-playlist CSR
    // from the snapshot's `csr` JSON column and use the one that matches the
    // match's playlist. If the player has no CSR for this playlist (e.g. a
    // Ranked Slayer match where the teammate has only ever played Ranked
    // Arena), the slot is left empty so the badge is omitted — never show
    // Arena CSR on a Slayer/Legacy row.
    // Build per-slot context so we can decide per-slot which playlist to pull.
    const slotsByXuid = new Map(); // xuid -> array of {pl, kind}
    for (const m of matches) {
      if (!m || !Array.isArray(m.teams)) continue;
      const kind = _playlistKindOf(m);
      for (const team of m.teams) {
        if (!team || !Array.isArray(team.players)) continue;
        for (const pl of team.players) {
          if (!pl) continue;
          if (pl.csrTier || pl.csr_tier) continue;
          const xu = pl.rawXuid || pl.xuid;
          if (!xu) continue;
          if (!slotsByXuid.has(String(xu))) slotsByXuid.set(String(xu), []);
          slotsByXuid.get(String(xu)).push({ pl, kind });
        }
      }
    }
    if (slotsByXuid.size) {
      for (const [xu, entries] of slotsByXuid.entries()) {
        const snap = snapByXuid.get(xu);
        if (!snap) continue;
        for (const { pl, kind } of entries) {
          if (pl.csrTier || pl.csr_tier) continue;
          const entry = _snapEntryForKind(snap, kind);
          if (!entry) continue;
          pl.csrTier = entry.tier;
          // halo.js stores subTier as 1-indexed in csrResults (already +1),
          // and value as the raw CSR int.
          if (entry.subTier != null) pl.csrSubTier = entry.subTier;
          if (entry.value != null) pl.csrValue = entry.value;
          pl.csrFromSnapshot = true;
          snapshotHits++;
        }
      }
    }
  } catch(e) {
    console.error('[DB] enrichMatchTeamsWithCsr error:', e.message);
  }
  // Coverage counters used by verification scripts + admin diagnostics.
  let stillMissingFinal = 0;
  for (const slots of xuidToSlots.values()) {
    for (const pl of slots) if (!pl.csrTier && !pl.csr_tier) stillMissingFinal++;
  }
  return { perMatch: perMatchHits, snapshot: snapshotHits, missing: stillMissingFinal };
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

// Lightweight: just start_times for activity heatmap (no full match objects)
async function getActivityTimes(xuid, limit = 1000) {
  const db = await getDb();
  const r = await db.query(
    `SELECT DISTINCT ON (match_id) start_time
     FROM match_participants
     WHERE xuid = $1 AND start_time IS NOT NULL
     ORDER BY match_id, start_time DESC
     LIMIT $2`,
    [String(xuid), limit]
  );
  return r.rows.map(row => row.start_time);
}

module.exports = { getDb, loadXuidCache, flushXuidCache, loadEmblemCache, flushEmblemCache, savePlayerSnapshot, getRecentlySnapshotted, getSnapshotsByRank, addProPlayer, removeProPlayer, getProPlayers, getProStats, getLeaderboardData, getLeaderboardTab, getActivityTimes, saveMatchParticipants, reconstructMatchHistoryForXuid, getFrequentCoPlayers, getRecoverySeeds, countMatchesForXuid, lookupXuidByGamertag, getRefreshMeta, markRefreshAttempt, enrichMatchTeamsWithCsr, PARTICIPANT_ENRICHMENT_VERSION, PARTICIPANT_COLS, buildParticipantRow, _dedupeParticipantRowsByMatchId, _participantRowRichness };
