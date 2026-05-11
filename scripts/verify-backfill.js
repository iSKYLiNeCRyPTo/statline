#!/usr/bin/env node
// Stub-driven smoke test for scripts/backfill-match-participants.js.
//
// We can't talk to a real Redis or Postgres in CI, so this test:
//   1. Intercepts require('redis') and require('pg') with in-memory fakes.
//   2. Seeds the fake Redis with representative player:* blobs covering the
//      good path, a malformed JSON blob, a payload missing xuid, and a
//      payload whose matches lack team rosters (the "old cached shape").
//   3. Spawns the backfill script as a child process with stubbed module
//      resolution so the fakes are used end-to-end.
//   4. Asserts the final progress JSON: matchesEligible counts only well-formed
//      matches, malformed/no-xuid blobs are skipped (not counted as parsed),
//      and rowsWrittenReported equals the sum of participant slots.
//
// Run:  node scripts/verify-backfill.js

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function assert(cond, msg) {
  if (!cond) { console.error('  ✗', msg); process.exitCode = 1; }
  else console.log('  ✓', msg);
}

// Build a tiny preload file that monkey-patches require('redis') and
// require('pg') for the child process.
const preload = `
const Module = require('module');
const origLoad = Module._load;

// ── Fake Redis ───────────────────────────────────────────────────────────────
const fakeStore = ${JSON.stringify(buildFakeRedisData())};

const fakeRedisClient = {
  isOpen: true,
  connect: async () => {},
  disconnect: async () => {},
  on: () => {},
  get: async (k) => fakeStore[k] != null ? fakeStore[k] : null,
  scanIterator: function* iter(opts) {
    const pat = (opts && opts.MATCH) || '*';
    const re = new RegExp('^' + pat.replace(/\\*/g, '.*') + '$');
    for (const k of Object.keys(fakeStore)) {
      if (re.test(k)) yield k;
    }
  },
};
const fakeRedis = { createClient: () => fakeRedisClient };

// ── Fake Postgres ────────────────────────────────────────────────────────────
const inserted = [];
class FakePool {
  async query(sql, params) {
    if (/^CREATE TABLE|^CREATE INDEX|^ALTER TABLE/i.test(sql.trim())) return { rows: [] };
    if (/^INSERT INTO match_participants/i.test(sql.trim())) {
      const cols = 17;
      for (let i = 0; i < params.length; i += cols) {
        inserted.push({
          match_id: params[i], xuid: params[i+1], gamertag: params[i+2],
          kills: params[i+5], deaths: params[i+6],
        });
      }
      return { rows: [] };
    }
    return { rows: [] };
  }
  end() { return Promise.resolve(); }
}
const fakePg = { Pool: FakePool };

// Print accumulated stats on exit so the parent can inspect.
process.on('exit', () => {
  try { process.stderr.write('__INSERTED_COUNT__=' + inserted.length + '\\n'); } catch {}
});

Module._load = function patched(req, parent, ...rest) {
  if (req === 'redis') return fakeRedis;
  if (req === 'pg')    return fakePg;
  return origLoad.call(this, req, parent, ...rest);
};
`;

function buildFakeRedisData() {
  const goodMatch1 = {
    matchId: 'm-good-1', isRanked: true, gameMode: 'Ranked Arena',
    mapName: 'Aquarius', startTime: '2026-05-09T01:02:03Z', duration: 600,
    teams: [
      { teamId: 0, outcome: 2, players: [
        { rawXuid: '2000000000000001', gamertag: 'Alpha', kills: 15, deaths: 8, assists: 4, score: 90, damage: 4000 },
        { rawXuid: '2000000000000002', gamertag: 'Bravo', kills: 10, deaths: 10, assists: 2 },
      ]},
      { teamId: 1, outcome: 3, players: [
        { rawXuid: '2000000000000003', gamertag: 'Charlie', kills: 12, deaths: 14, assists: 1 },
      ]},
    ],
  };
  const goodMatch2 = {
    matchId: 'm-good-2', isRanked: true, gameMode: 'Ranked Slayer',
    mapName: 'Recharge', startTime: '2026-05-10T03:04:05Z',
    teams: [
      { teamId: 0, outcome: 2, players: [
        { rawXuid: '2000000000000001', gamertag: 'Alpha', kills: 20, deaths: 9 },
      ]},
      { teamId: 1, outcome: 3, players: [
        { rawXuid: '2000000000000004', gamertag: 'Delta', kills: 11, deaths: 18 },
      ]},
    ],
  };
  // Old-shape match: no teams[] (the case where Redis blobs predate the new structure).
  const oldShapeMatch = {
    matchId: 'm-old-1', isRanked: true, gameMode: 'Ranked Arena',
    mapName: 'Live Fire', startTime: '2026-04-01T00:00:00Z',
    kills: 10, deaths: 5,  // top-level only, no roster
  };
  return {
    'player:alpha':   JSON.stringify({ xuid: '2000000000000001', gamertag: 'Alpha', allMatches: [goodMatch1, goodMatch2] }),
    'player:bravo':   JSON.stringify({ xuid: '2000000000000002', gamertag: 'Bravo', recentMatches: [goodMatch1] }),
    'player:oldcache': JSON.stringify({ xuid: '2000000000000099', gamertag: 'OldCache', allMatches: [oldShapeMatch] }),
    'player:noxuid':  JSON.stringify({ gamertag: 'Anonymous', allMatches: [goodMatch1] }),
    'player:broken':  '{not json at all',
    'not-a-player':   JSON.stringify({ xuid: 'x', allMatches: [goodMatch1] }), // filtered out by SCAN pattern
  };
}

const preloadPath = path.join(__dirname, '.verify-backfill-preload.js');
fs.writeFileSync(preloadPath, preload);

// Configure env for the child: dry-run-safe and with stub URLs so the script's
// own guards pass. We test dry-run AND live mode.
const baseEnv = {
  ...process.env,
  REDIS_URL: 'redis://stub',
  DATABASE_URL: 'postgresql://stub',
  NODE_OPTIONS: `--require ${preloadPath}`,
};

const script = path.join(__dirname, 'backfill-match-participants.js');

// Run from src/ so dotenv/pg/redis (under src/node_modules) resolve correctly,
// matching how the existing package.json scripts are invoked.
const srcDir = path.join(__dirname, '..', 'src');
function runScript(extraArgs) {
  return spawnSync(process.execPath, [script, ...extraArgs], {
    cwd: srcDir, env: baseEnv, encoding: 'utf8',
  });
}

try {
  console.log('Test 1: --dry-run completes and reports the right counters');
  const dry = runScript(['--dry-run', '--batch-size', '1']);
  if (dry.status !== 0) {
    console.error('STDOUT:\n', dry.stdout);
    console.error('STDERR:\n', dry.stderr);
  }
  assert(dry.status === 0, 'dry-run exited 0');
  const dryFinal = (dry.stdout.match(/\[Backfill\] complete (\{.*\})/) || [])[1];
  assert(!!dryFinal, 'dry-run printed final progress JSON');
  if (dryFinal) {
    const c = JSON.parse(dryFinal);
    assert(c.dryRun === true, 'dryRun flag echoed in summary');
    // 3 "good" player keys (alpha, bravo, oldcache) carry xuids; noxuid is skipped; broken is malformed.
    assert(c.playersParsed === 3, `playersParsed=3 (got ${c.playersParsed})`);
    assert(c.playersSkippedNoXuid === 1, `playersSkippedNoXuid=1 (got ${c.playersSkippedNoXuid})`);
    assert(c.playersSkippedMalformed === 1, `playersSkippedMalformed=1 (got ${c.playersSkippedMalformed})`);
    // alpha has 2 matches, bravo 1, oldcache's match is filtered (no teams) → 3 eligible
    assert(c.matchesEligible === 3, `matchesEligible=3 (got ${c.matchesEligible})`);
    assert(c.rowsWrittenReported === 0, 'dry-run wrote no rows');
  }

  console.log('\nTest 2: live mode (stubbed pg) writes participant rows');
  const live = runScript(['--batch-size', '1', '--verbose']);
  if (live.status !== 0) {
    console.error('STDOUT:\n', live.stdout);
    console.error('STDERR:\n', live.stderr);
  }
  assert(live.status === 0, 'live mode exited 0');
  const liveFinal = (live.stdout.match(/\[Backfill\] complete (\{.*\})/) || [])[1];
  assert(!!liveFinal, 'live mode printed final progress JSON');
  if (liveFinal) {
    const c = JSON.parse(liveFinal);
    assert(c.dryRun === false, 'dryRun=false in live mode');
    // alpha 2 matches: m-good-1 has 3 players + m-good-2 has 2 players = 5 rows
    // bravo 1 match: m-good-1 has 3 players = 3 rows
    // oldcache's match has no teams[] → 0 rows
    // Total reported writes = 5 + 3 = 8
    assert(c.rowsWrittenReported === 8, `rowsWrittenReported=8 (got ${c.rowsWrittenReported})`);
  }
  const insertedMatch = (live.stderr.match(/__INSERTED_COUNT__=(\d+)/) || [])[1];
  assert(insertedMatch && parseInt(insertedMatch, 10) === 8, `pg saw 8 inserted rows (got ${insertedMatch})`);

  console.log('\nTest 3: --limit caps players processed');
  const limited = runScript(['--limit', '1']);
  assert(limited.status === 0, '--limit 1 exited 0');
  const limFinal = (limited.stdout.match(/\[Backfill\] complete (\{.*\})/) || [])[1];
  if (limFinal) {
    const c = JSON.parse(limFinal);
    assert(c.playersParsed === 1, `playersParsed=1 under --limit (got ${c.playersParsed})`);
  }

  console.log('\nTest 4: refuses to write without DATABASE_URL');
  const env2 = { ...baseEnv };
  delete env2.DATABASE_URL;
  const r = spawnSync(process.execPath, [script], { env: env2, encoding: 'utf8' });
  assert(r.status === 2, `exit code 2 without DATABASE_URL (got ${r.status})`);
  assert(/DATABASE_URL/.test(r.stderr), 'error message mentions DATABASE_URL');

  console.log('\nDone.');
} finally {
  try { fs.unlinkSync(preloadPath); } catch {}
}
