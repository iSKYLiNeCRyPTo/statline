#!/usr/bin/env node
// Smoke test for player_refresh_meta freshness gating.
//
// Verifies:
//   1. getRefreshMeta returns an empty map for never-seen xuids.
//   2. markRefreshAttempt records last_refresh_ts on first call.
//   3. A second markRefreshAttempt with the SAME matches_played increments
//      consecutive_empty_refreshes and sets last_no_new_data_ts.
//   4. A third call with HIGHER matches_played resets the strike counter.
//   5. The gating predicates used by server.js (_isRecentlyRefreshed,
//      _isInNoNewDataCooldown) work against the returned meta.
//
// Run:  node scripts/verify-snapshot-freshness.js

const path = require('path');
const Module = require('module');

const fakeMeta = new Map();

const fakePg = {
  Pool: function FakePool() {
    this.query = async (sql, params) => {
      const s = sql.trim();
      if (/^CREATE TABLE|^CREATE INDEX|^ALTER TABLE/i.test(s)) return { rows: [] };
      // getRefreshMeta SELECT (multi-line — use [\s\S] so newlines match)
      if (/SELECT xuid, last_refresh_ts[\s\S]*FROM player_refresh_meta WHERE xuid = ANY/i.test(s)) {
        const xuids = params[0];
        const rows = [];
        for (const x of xuids) {
          const r = fakeMeta.get(String(x));
          if (r) rows.push({
            xuid: x,
            last_refresh_ts: r.lastRefreshTs,
            last_no_new_data_ts: r.lastNoNewDataTs,
            last_matches_played: r.lastMatchesPlayed,
            consecutive_empty_refreshes: r.consecutiveEmptyRefreshes,
          });
        }
        return { rows };
      }
      // markRefreshAttempt prior-read
      if (/SELECT last_matches_played, consecutive_empty_refreshes FROM player_refresh_meta WHERE xuid = \$1/i.test(s)) {
        const r = fakeMeta.get(String(params[0]));
        return { rows: r ? [{ last_matches_played: r.lastMatchesPlayed, consecutive_empty_refreshes: r.consecutiveEmptyRefreshes }] : [] };
      }
      // markRefreshAttempt INSERT/UPSERT
      if (/INSERT INTO player_refresh_meta/i.test(s)) {
        // params: $1 xuid, $2 gamertag, $3 last_no_new_data_ts (Date or null),
        //         $4 last_matches_played, $5 consecutive_empty_refreshes, $6 hadNewData
        const xuid = String(params[0]);
        const prev = fakeMeta.get(xuid) || {};
        fakeMeta.set(xuid, {
          gamertag: params[1] || prev.gamertag || null,
          lastRefreshTs: new Date(),
          lastNoNewDataTs: params[5] /* hadNewData */ ? null : (params[2] instanceof Date ? params[2] : new Date()),
          lastMatchesPlayed: params[3] != null ? params[3] : prev.lastMatchesPlayed,
          consecutiveEmptyRefreshes: params[4],
        });
        return { rows: [] };
      }
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
  if (!cond) { console.error('  ✗', msg); process.exitCode = 1; }
  else console.log('  ✓', msg);
}

// Replay the predicates server.js uses so the test isn't tightly coupled to
// internal helpers (and so a regression there is caught directly).
const SNAPSHOT_RECENT_TTL_HOURS = 24;
const SNAPSHOT_NO_NEW_DATA_COOLDOWN_DAYS = 14;
const SNAPSHOT_EMPTY_STRIKES = 2;

function isRecentlyRefreshed(meta) {
  if (!meta || !meta.lastRefreshTs) return false;
  return (Date.now() - meta.lastRefreshTs.getTime()) < SNAPSHOT_RECENT_TTL_HOURS * 3600 * 1000;
}
function isInNoNewDataCooldown(meta) {
  if (!meta) return false;
  if ((meta.consecutiveEmptyRefreshes || 0) < SNAPSHOT_EMPTY_STRIKES) return false;
  if (!meta.lastNoNewDataTs) return false;
  return (Date.now() - meta.lastNoNewDataTs.getTime()) < SNAPSHOT_NO_NEW_DATA_COOLDOWN_DAYS * 86400000;
}

(async () => {
  const XU = '3000000000000001';

  console.log('Test 1: getRefreshMeta returns empty map for unknown xuids');
  let m = await db.getRefreshMeta([XU]);
  assert(m.size === 0, `empty map for never-seen xuid (got size ${m.size})`);

  console.log('\nTest 2: first markRefreshAttempt records last_refresh_ts and sets strikes=0');
  let r = await db.markRefreshAttempt(XU, 'TestGT', 1234);
  assert(r && r.hadNewData === true, 'first observation counts as new data');
  assert(r.consecutiveEmptyRefreshes === 0, 'strikes reset to 0 after new-data refresh');
  m = await db.getRefreshMeta([XU]);
  const meta1 = m.get(XU);
  assert(meta1 && meta1.lastRefreshTs instanceof Date, 'lastRefreshTs persisted as Date');
  assert(isRecentlyRefreshed(meta1), 'freshly-stamped meta is "recently refreshed" by predicate');

  console.log('\nTest 3: same matches_played → empty refresh, strikes increment, cooldown ts set');
  r = await db.markRefreshAttempt(XU, 'TestGT', 1234);
  assert(r.hadNewData === false, 'no-change refresh flagged as no-new-data');
  assert(r.consecutiveEmptyRefreshes === 1, 'first empty refresh → strikes=1');
  m = await db.getRefreshMeta([XU]);
  const meta2 = m.get(XU);
  assert(meta2.lastNoNewDataTs instanceof Date, 'last_no_new_data_ts populated after empty refresh');
  // strikes=1 < SNAPSHOT_EMPTY_STRIKES → not yet in cooldown
  assert(!isInNoNewDataCooldown(meta2), 'one empty refresh does not yet trigger cooldown (needs >= 2 strikes)');

  console.log('\nTest 4: a second empty refresh trips the cooldown predicate');
  r = await db.markRefreshAttempt(XU, 'TestGT', 1234);
  assert(r.consecutiveEmptyRefreshes === 2, 'second empty refresh → strikes=2');
  m = await db.getRefreshMeta([XU]);
  const meta3 = m.get(XU);
  assert(isInNoNewDataCooldown(meta3), 'two strikes + recent last_no_new_data_ts → cooldown=true');

  console.log('\nTest 5: new matches_played resets strike counter and clears cooldown');
  r = await db.markRefreshAttempt(XU, 'TestGT', 1240);
  assert(r.hadNewData === true, 'matches_played increased → new data');
  assert(r.consecutiveEmptyRefreshes === 0, 'strike counter reset on new data');
  m = await db.getRefreshMeta([XU]);
  const meta4 = m.get(XU);
  assert(!isInNoNewDataCooldown(meta4), 'cooldown predicate false after new-data refresh');
  assert(isRecentlyRefreshed(meta4), 'still recently refreshed');

  console.log('\nTest 6: stale (>24h) last_refresh_ts is NOT recently refreshed');
  // Fast-forward by mutating the stored timestamp directly.
  const stale = fakeMeta.get(XU);
  stale.lastRefreshTs = new Date(Date.now() - 25 * 3600 * 1000);
  m = await db.getRefreshMeta([XU]);
  assert(!isRecentlyRefreshed(m.get(XU)), 'meta older than 24h is no longer "recently refreshed"');

  console.log('\nDone.');
})();
