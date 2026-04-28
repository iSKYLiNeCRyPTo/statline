// db.js — shared Postgres helpers used by both server.js and halo.js
require('dotenv').config();
const { Pool } = require('pg');

let _dbPool = null;
const _dbPersistedXuids = new Set();

async function getDb() {
  if (!_dbPool && process.env.DATABASE_URL) {
    _dbPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      await _dbPool.query(`CREATE TABLE IF NOT EXISTS xuid_cache (xuid TEXT PRIMARY KEY, gamertag TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await _dbPool.query(`CREATE TABLE IF NOT EXISTS emblem_cache (xuid TEXT PRIMARY KEY, emblem_path TEXT, nameplate_path TEXT, ts TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    } catch(e) { console.error('[DB] schema error:', e.message); }
  }
  return _dbPool;
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
    let loaded = 0;
    result.rows.forEach(r => {
      if (r.emblem_path && !emblemPathCache[r.xuid]) { emblemPathCache[r.xuid] = r.emblem_path; loaded++; }
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

module.exports = { getDb, loadXuidCache, flushXuidCache, loadEmblemCache, flushEmblemCache };
