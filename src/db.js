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
      snapMatchesPlayed = mValid.length;
      snapWins      = wins;
      snapLosses    = wlMatches.length - wins;
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

module.exports = { getDb, loadXuidCache, flushXuidCache, loadEmblemCache, flushEmblemCache, savePlayerSnapshot, getSnapshotsByRank, addProPlayer, removeProPlayer, getProPlayers, getProStats };
