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
    const PREFERRED = ['ranked_arena', 'ranked_slayer', 'ranked_slayer_2'];
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

    const s = player.stats || {};
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
        kd=EXCLUDED.kd, kda=EXCLUDED.kda, win_rate=EXCLUDED.win_rate,
        accuracy=EXCLUDED.accuracy, avg_kills=EXCLUDED.avg_kills
    `, [
      player.xuid, player.gamertag, primaryPlaylist, csrTier, csrSubtier, csrValue,
      JSON.stringify(csr),
      s.matchesPlayed || null, s.wins || null, s.losses || null,
      parseFloat(s.kd) || null, parseFloat(s.kda) || null,
      parseFloat(s.winRate) || null, parseFloat(s.accuracy) || null,
      parseFloat(s.avgKillsPerGame) || null
    ]);
    console.log(`[DB] Snapshot saved for ${player.gamertag} (${csrTier} ${csrSubtier})`);
  } catch(e) { console.error('[DB] savePlayerSnapshot error:', e.message); }
}

// Fetch stats rows for players at a given rank tier+subtier (last 30 days, up to 1000 rows)
async function getSnapshotsByRank(tier, subTier) {
  try {
    const db = await getDb();
    if (!db) return [];
    const isOnyx = tier === 'Onyx';
    const params = isOnyx ? [tier] : [tier, subTier];
    const subFilter = isOnyx ? '' : 'AND csr_subtier = $2';
    const res = await db.query(`
      SELECT kd, win_rate, accuracy, avg_kills FROM player_snapshots
      WHERE csr_tier = $1 ${subFilter} AND kd IS NOT NULL
        AND ts > NOW() - INTERVAL '30 days'
      ORDER BY ts DESC LIMIT 1000
    `, params);
    return res.rows;
  } catch(e) { console.error('[DB] getSnapshotsByRank error:', e.message); return []; }
}

module.exports = { getDb, loadXuidCache, flushXuidCache, loadEmblemCache, flushEmblemCache, savePlayerSnapshot, getSnapshotsByRank };
