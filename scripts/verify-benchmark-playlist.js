#!/usr/bin/env node
// Verify the playlist-aware peer-pool query in getSnapshotsByRank.
//
// Before the toggle work, /api/rank-comparison filtered peer snapshots by
// the top-level csr_tier/csr_subtier columns, which are always Arena because
// savePlayerSnapshot prefers Arena. That meant a Slayer/Legacy benchmark
// pulled Arena peers re-labeled as Slayer/Legacy.
//
// This script stubs pg and asserts:
//   1. getSnapshotsByRank(tier, sub, val) — legacy path: filters by columns.
//   2. getSnapshotsByRank(tier, sub, val, 'Ranked Slayer') — JSON path:
//      filters by csr->'Ranked Slayer'->>'tier' / 'subTier'.
//   3. Onyx + playlistKey uses csr->>'value' band filter, not csr_value.
//
// Run: node scripts/verify-benchmark-playlist.js

const path = require('path');
const Module = require('module');

let lastSql = '', lastParams = null;
const fakePg = {
  Pool: function FakePool() {
    this.query = async (sql, params) => {
      const s = sql.trim();
      if (/^CREATE TABLE|^CREATE INDEX|^ALTER TABLE/i.test(s)) return { rows: [] };
      lastSql = s; lastParams = params;
      return { rows: [] };
    };
  },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'pg') return 'pg_stub';
  return origResolve.call(this, req, parent, ...rest);
};
require.cache['pg_stub'] = { id: 'pg_stub', exports: fakePg, loaded: true };
process.env.DATABASE_URL = 'postgresql://stub';

const db = require(path.join(__dirname, '..', 'src', 'db.js'));

function assert(cond, msg) {
  if (!cond) { console.error('  ✗', msg, '\n   sql=', lastSql, '\n   params=', lastParams); process.exitCode = 1; }
  else console.log('  ✓', msg);
}

(async () => {
  console.log('Test 1: legacy call (no playlist key) filters by csr_tier column');
  await db.getSnapshotsByRank('Diamond', 3, 1300);
  assert(/csr_tier = \$1/.test(lastSql), 'uses csr_tier column');
  assert(/csr_subtier = \$2/.test(lastSql), 'uses csr_subtier column');
  assert(lastParams[0] === 'Diamond' && lastParams[1] === 3, 'params match');

  console.log('\nTest 2: with playlistKey, query uses JSON path');
  await db.getSnapshotsByRank('Diamond', 3, 1300, 'Ranked Slayer');
  assert(/csr->\$3->>'tier' = \$1/.test(lastSql),
    `JSON tier filter with playlistKey param (got: ${lastSql.slice(0, 200)})`);
  assert(/csr->\$3->>'subTier'/.test(lastSql), 'JSON subTier filter');
  assert(lastParams[2] === 'Ranked Slayer', `playlistKey param at $3 (got ${lastParams[2]})`);

  console.log('\nTest 3: Onyx + playlistKey uses JSON value bands');
  await db.getSnapshotsByRank('Onyx', 0, 1734, 'Ranked Legacy');
  assert(/csr->\$4->>'tier' = \$1/.test(lastSql), 'Onyx tier filter via JSON');
  assert(/\(csr->\$4->>'value'\)::int/.test(lastSql), 'Onyx band uses JSON value');
  assert(lastParams[0] === 'Onyx' && lastParams[3] === 'Ranked Legacy', 'Onyx params');
  // Band: 1734 → floor(1734/100)*100 = 1700, 1800
  assert(lastParams[1] === 1700 && lastParams[2] === 1800,
    `Onyx band 1700–1800 (got ${lastParams[1]}–${lastParams[2]})`);

  console.log('\nTest 4: Onyx >= 1900 caps band at 1900..9999');
  await db.getSnapshotsByRank('Onyx', 0, 1950, 'Ranked Arena');
  assert(lastParams[1] === 1900 && lastParams[2] === 9999, `Onyx 1900+ caps (got ${lastParams[1]}–${lastParams[2]})`);

  if (process.exitCode) {
    console.error('\n✗ verify-benchmark-playlist: failures');
    process.exit(1);
  }
  console.log('\n✓ verify-benchmark-playlist: all assertions passed');
})().catch(e => { console.error(e); process.exit(1); });
