#!/usr/bin/env node
// Smoke test for reconstructed-history stats compatibility.
//
// Verifies that reconstructMatchHistoryForXuid emits match objects in a shape
// the frontend stats modules (Playstyle Fingerprint, Consistency Score,
// Damage Trends, Kill Breakdown) can actually consume:
//
//   1. duration is ISO 8601 (PT#M#S) so duration parsers return >0 seconds.
//   2. durationSec is populated as a numeric fallback.
//   3. damageTaken is estimated (>0) so the Damage Trends filter doesn't
//      drop reconstructed rows for being all-zeros.
//   4. The `reconstructed: true` marker is present so the UI can label
//      sample-size and skip data points that would mislead.
//
// Stubs pg the same way verify-reconstruct.js does.
//
// Run:  node scripts/verify-reconstructed-stats.js

const path = require('path');
const Module = require('module');

const fakeRows = [];

const fakePg = {
  Pool: function FakePool() {
    this.query = async (sql, params) => {
      const s = sql.trim();
      if (/^CREATE TABLE|^CREATE INDEX|^ALTER TABLE/i.test(s)) return { rows: [] };
      if (/^INSERT INTO match_participants/i.test(s)) {
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
      if (/FROM match_participants\s+WHERE xuid = \$1\s+ORDER BY start_time/i.test(s)) {
        const xuid = params[0];
        const rows = fakeRows
          .filter(r => r.xuid === xuid)
          .sort((a, b) => (b.start_time?.getTime?.() || 0) - (a.start_time?.getTime?.() || 0))
          .slice(0, params[1] || 100);
        return { rows };
      }
      if (/FROM match_participants\s+WHERE match_id = ANY/i.test(s)) {
        const ids = new Set(params[0]);
        return { rows: fakeRows.filter(r => ids.has(r.match_id)) };
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

// Helpers borrowed from render.js so we can replay the same gating in pure JS.
function fpSecs(m) {
  if (typeof m.durationSec === 'number' && m.durationSec > 0) return m.durationSec;
  const s = String(m.duration || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  return s ? (parseInt(s[1] || 0) * 3600) + (parseInt(s[2] || 0) * 60) + parseFloat(s[3] || 0) : 0;
}

(async () => {
  const PRIVATE_XUID = '2000000000000001';
  const PUB1 = '2000000000000002';
  const PUB2 = '2000000000000003';
  const ENEMY1 = '2000000000000004';
  const ENEMY2 = '2000000000000005';

  // Build a small but representative reconstructed history: 12 matches,
  // varied K/D, win/loss spread, with damages on enemies so estimation
  // produces non-zero damageTaken.
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const win = i % 3 !== 0; // ~2/3 win rate
    const myK = win ? 14 + (i % 4) : 8 + (i % 3);
    const myD = win ? 9 + (i % 3) : 13 + (i % 4);
    samples.push({
      matchId: 'mx' + i,
      isRanked: true,
      gameMode: 'Ranked Arena: Slayer',
      mapName: 'Live Fire',
      mapImageUrl: 'https://example/livefire.png',
      startTime: new Date(Date.now() - (12 - i) * 86400000).toISOString(),
      duration: 600 + (i * 13), // numeric seconds, will be converted to ISO
      teams: [
        { teamId: 0, outcome: win ? 2 : 3, players: [
          { rawXuid: PUB1, gamertag: 'PubFriend', kills: myK + 1, deaths: myD - 1, assists: 3, damage: 4200 },
          { rawXuid: PRIVATE_XUID, gamertag: 'PrivateOne', kills: myK, deaths: myD, assists: 2, damage: 3800 },
        ]},
        { teamId: 1, outcome: win ? 3 : 2, players: [
          { rawXuid: ENEMY1, gamertag: 'EnemyA', kills: 12, deaths: 14, assists: 1, damage: 3500 },
          { rawXuid: ENEMY2, gamertag: 'EnemyB', kills: 11, deaths: 13, assists: 2, damage: 3400 },
        ]},
      ],
    });
  }
  await db.saveMatchParticipants(samples, PUB1);

  console.log('Test 1: reconstruct returns ISO duration + durationSec on every match');
  const recon = await db.reconstructMatchHistoryForXuid(PRIVATE_XUID, 50);
  assert(recon.matches.length === 12, `12 reconstructed matches (got ${recon.matches.length})`);
  const withDuration = recon.matches.filter(m => fpSecs(m) > 0);
  assert(withDuration.length === 12, `every reconstructed match parses to >0 seconds via duration / durationSec (got ${withDuration.length})`);
  const isoOk = recon.matches.every(m => typeof m.duration === 'string' && /^PT/.test(m.duration));
  assert(isoOk, 'every match has an ISO 8601 duration string (PT...)');
  const numOk = recon.matches.every(m => typeof m.durationSec === 'number' && m.durationSec > 0);
  assert(numOk, 'every match also exposes numeric durationSec');

  console.log('\nTest 2: every reconstructed match carries the `reconstructed: true` marker');
  const flagOk = recon.matches.every(m => m.reconstructed === true);
  assert(flagOk, 'flag set so the UI can render the partial-coverage banner + sample-size note');

  console.log('\nTest 3: damageTaken is estimated from enemy damage (>0, plausible range)');
  const dmgOk = recon.matches.every(m => m.damageTaken > 0 && m.damageTaken < 10000);
  assert(dmgOk, 'estimated damageTaken in plausible bounds for the Damage Trends filter');
  // Sanity: damageDealt comes from the participant row directly.
  const dealtOk = recon.matches.every(m => m.damageDealt > 0);
  assert(dealtOk, 'damageDealt from participant row preserved');

  console.log('\nTest 4: Playstyle Fingerprint gate passes with the reconstructed sample');
  // Replay the relaxed gate (validMs.length >= 5 when reconstructed, duration filter).
  const validMs = recon.matches.filter(m => {
    if (m.kills == null) return false;
    const s = fpSecs(m);
    if (s > 0) return s >= 180;
    return !!m.reconstructed;
  });
  assert(validMs.length >= 5, `>=5 matches pass the relaxed reconstructed-history gate (got ${validMs.length})`);

  console.log('\nTest 5: Damage Trends filter accepts reconstructed rows');
  // Replay the relaxed filter from render.js.
  const dmgSample = recon.matches.filter(m => {
    let secs = 0;
    const s = m.duration ? String(m.duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/) : null;
    if (s) secs = (parseInt(s[1] || 0) * 3600) + (parseInt(s[2] || 0) * 60) + parseFloat(s[3] || 0);
    if (secs === 0 && typeof m.durationSec === 'number') secs = m.durationSec;
    if (m.reconstructed) {
      if (secs > 0 && secs < 180) return false;
      return (m.damageDealt || 0) > 0 && (m.outcome === 2 || m.outcome === 3);
    }
    return secs >= 180 && m.damageDealt > 300 && m.damageTaken > 300 && (m.outcome === 2 || m.outcome === 3);
  });
  assert(dmgSample.length >= 3, `>=3 matches pass the Damage Trends filter (got ${dmgSample.length})`);

  console.log('\nTest 6: Kill Breakdown basic counts are available');
  const totalKills = recon.matches.reduce((s, m) => s + (m.kills || 0), 0);
  const totalDeaths = recon.matches.reduce((s, m) => s + (m.deaths || 0), 0);
  assert(totalKills > 0 && totalDeaths > 0, 'aggregate kills/deaths counts are non-zero for the basic Kill Breakdown card');

  console.log('\nDone.');
})();
