#!/usr/bin/env node
// Smoke test for the private-player reconstruction fallback.
//
// Hits the db.js helpers directly with a stubbed pg pool so the test runs
// without a real Postgres instance. Validates:
//   1. saveMatchParticipants explodes match.teams[].players[] into per-row
//      INSERTs against match_participants.
//   2. reconstructMatchHistoryForXuid returns matches in start_time DESC order
//      and rebuilds teams from sibling rows.
//   3. getFrequentCoPlayers ranks co-players by shared-match count.
//
// Run:  node scripts/verify-reconstruct.js

const path = require('path');

// Stub pg before requiring db.js so the module picks up our mock pool.
const Module = require('module');
const origResolve = Module._resolveFilename;
const fakePg = {
  Pool: function FakePool() {
    this.calls = [];
    this.query = async (sql, params) => {
      this.calls.push({ sql, params });
      // CREATE TABLE / CREATE INDEX / ALTER — return empty.
      if (/^CREATE TABLE|^CREATE INDEX|^ALTER TABLE/i.test(sql.trim())) {
        return { rows: [] };
      }
      // saveMatchParticipants INSERT path — just accept.
      if (/^INSERT INTO match_participants/i.test(sql.trim())) {
        for (let i = 0; i < params.length; i += 17) {
          fakeRows.push({
            match_id: params[i],
            xuid: params[i + 1],
            gamertag: params[i + 2],
            team_id: params[i + 3],
            outcome: params[i + 4],
            kills: params[i + 5], deaths: params[i + 6], assists: params[i + 7],
            score: params[i + 8], damage: params[i + 9],
            is_ranked: params[i + 10],
            game_mode: params[i + 11], map_name: params[i + 12], map_image_url: params[i + 13],
            start_time: params[i + 14], duration_sec: params[i + 15],
            source_xuid: params[i + 16],
          });
        }
        return { rows: [] };
      }
      // reconstructMatchHistoryForXuid: first query (own rows).
      if (/FROM match_participants\s+WHERE xuid = \$1\s+ORDER BY start_time/i.test(sql)) {
        const xuid = params[0];
        const lim = params[1] || 100;
        const rows = fakeRows
          .filter(r => r.xuid === xuid)
          .sort((a, b) => (b.start_time?.getTime?.() || 0) - (a.start_time?.getTime?.() || 0))
          .slice(0, lim);
        return { rows };
      }
      // reconstructMatchHistoryForXuid: second query (all participants for those matches).
      if (/FROM match_participants\s+WHERE match_id = ANY/i.test(sql)) {
        const ids = new Set(params[0]);
        return { rows: fakeRows.filter(r => ids.has(r.match_id)) };
      }
      // getFrequentCoPlayers
      if (/FROM match_participants p\s+JOIN match_participants me/i.test(sql)) {
        const xuid = params[0];
        const lim = params[1];
        const myMatches = new Set(fakeRows.filter(r => r.xuid === xuid).map(r => r.match_id));
        const counts = {};
        const names = {};
        for (const r of fakeRows) {
          if (r.xuid === xuid) continue;
          if (!myMatches.has(r.match_id)) continue;
          if (!r.gamertag) continue;
          counts[r.xuid] = (counts[r.xuid] || 0) + 1;
          names[r.xuid] = r.gamertag;
        }
        return { rows: Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, lim)
          .map(([xu, n]) => ({ xuid: xu, gamertag: names[xu], games: n })) };
      }
      // lookupXuidByGamertag
      if (/FROM xuid_cache\s+WHERE LOWER\(gamertag\)/i.test(sql)) {
        return { rows: [] };
      }
      if (/FROM match_participants WHERE LOWER\(gamertag\)/i.test(sql)) {
        const gt = params[0].toLowerCase();
        const hit = fakeRows.find(r => r.gamertag && r.gamertag.toLowerCase() === gt);
        return { rows: hit ? [{ xuid: hit.xuid }] : [] };
      }
      return { rows: [] };
    };
  },
};
const fakeRows = [];

// Force-require stubs by intercepting module resolution.
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'pg') return 'pg_stub';
  return origResolve.call(this, req, parent, ...rest);
};
require.cache['pg_stub'] = { id: 'pg_stub', exports: fakePg, loaded: true };

// Make db.js think DATABASE_URL is set so getDb() builds the pool.
process.env.DATABASE_URL = 'postgresql://stub';

const db = require(path.join(__dirname, '..', 'src', 'db.js'));

function assert(cond, msg) {
  if (!cond) { console.error('  ✗', msg); process.exitCode = 1; }
  else console.log('  ✓', msg);
}

(async () => {
  console.log('Test 1: saveMatchParticipants persists every team slot');
  const PRIVATE_XUID = '1000000000000001';
  const PUBLIC_XUID  = '1000000000000002';
  const OTHER_XUID   = '1000000000000003';
  const sample = [{
    matchId: 'm1',
    isRanked: true,
    gameMode: 'Ranked Arena: Strongholds',
    mapName: 'Live Fire',
    mapImageUrl: 'https://example/livefire.png',
    startTime: '2026-05-10T18:00:00Z',
    duration: 720,
    teams: [
      { teamId: 0, outcome: 2, players: [
        { rawXuid: PUBLIC_XUID, gamertag: 'PubPlayer', kills: 20, deaths: 10, assists: 5, score: 100, damage: 4500 },
        { rawXuid: PRIVATE_XUID, gamertag: 'PrivateOne', kills: 12, deaths: 14, assists: 3, score: 60, damage: 2800 },
      ]},
      { teamId: 1, outcome: 3, players: [
        { rawXuid: OTHER_XUID, gamertag: 'OppOne', kills: 9, deaths: 16, assists: 2, score: 45, damage: 2300 },
      ]},
    ],
  }, {
    matchId: 'm2',
    isRanked: true,
    gameMode: 'Ranked Slayer',
    mapName: 'Recharge',
    startTime: '2026-05-11T10:00:00Z',
    teams: [
      { teamId: 0, outcome: 3, players: [
        { rawXuid: PUBLIC_XUID, gamertag: 'PubPlayer', kills: 8, deaths: 12, assists: 4 },
        { rawXuid: PRIVATE_XUID, gamertag: 'PrivateOne', kills: 14, deaths: 11, assists: 2 },
      ]},
      { teamId: 1, outcome: 2, players: [
        { rawXuid: OTHER_XUID, gamertag: 'OppOne', kills: 15, deaths: 10, assists: 3 },
      ]},
    ],
  }];
  const written = await db.saveMatchParticipants(sample, PUBLIC_XUID);
  assert(written === 6, `6 rows written across 2 matches (got ${written})`);
  assert(fakeRows.some(r => r.xuid === PRIVATE_XUID && r.match_id === 'm1'), 'private player row persisted for m1');

  console.log('\nTest 2: reconstructMatchHistoryForXuid returns matches in DESC time order');
  const recon = await db.reconstructMatchHistoryForXuid(PRIVATE_XUID, 50);
  assert(recon.matches.length === 2, `2 reconstructed matches (got ${recon.matches.length})`);
  assert(recon.matches[0].matchId === 'm2', 'most-recent match comes first');
  assert(recon.matches[0].reconstructed === true, 'reconstructed flag set');
  assert(recon.matches[0].teams && recon.matches[0].teams.length === 2, 'teams rebuilt from sibling rows');
  assert(recon.matches[0].kills === 14 && recon.matches[0].deaths === 11, 'private player stats hydrated on the top-level match row');

  console.log('\nTest 3: getFrequentCoPlayers ranks shared-match counts');
  const co = await db.getFrequentCoPlayers(PRIVATE_XUID, 5);
  assert(co.length === 2, `2 co-players found (got ${co.length})`);
  assert(co[0].xuid === PUBLIC_XUID && co[0].games === 2, 'public teammate is top co-player with 2 shared games');

  console.log('\nTest 4: lookupXuidByGamertag falls back to participants table');
  const xu = await db.lookupXuidByGamertag('PrivateOne');
  assert(xu === PRIVATE_XUID, `gamertag→xuid via participants (got ${xu})`);

  console.log('\nDone.');
})();
