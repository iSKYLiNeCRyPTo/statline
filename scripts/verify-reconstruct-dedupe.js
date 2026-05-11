#!/usr/bin/env node
// Verifies dedupe + uniqueness guarantees for reconstructed match history.
//
// What this proves end-to-end:
//   1. The DB schema enforces (match_id, xuid) uniqueness via the primary key.
//      saveMatchParticipants uses ON CONFLICT (match_id, xuid) DO UPDATE with
//      COALESCE so a thin re-ingest never overwrites a richer prior row.
//   2. When the same match for the same target xuid is discovered through two
//      separate source players, reconstructMatchHistoryForXuid surfaces ONE
//      match (not two), and aggregateStatsFromMatches counts it once.
//   3. If duplicates ever slipped past the DB constraint (legacy / drift), the
//      in-memory dedupe in _dedupeParticipantRowsByMatchId picks the richer
//      row (more populated rich fields wins), with ts as the tiebreaker.
//   4. aggregateStatsFromMatches collapses by matchId as a second guard so K/D,
//      matchesPlayed, kills, and win-rate are correct even if the caller hands
//      it a list with duplicate matchIds.
//
// Stubs pg so the test runs without Postgres. The stub enforces the PK
// constraint by overwriting on (match_id, xuid) collisions — same semantics
// as the real ON CONFLICT path.
//
// Run:  node scripts/verify-reconstruct-dedupe.js

const path = require('path');
const Module = require('module');

const fakeRows = [];
let PARTICIPANT_COLS = null;

function _stubUpsert(row) {
  // Honor the (match_id, xuid) primary key: replace on collision, but only
  // COALESCE non-null fields in (mirrors src/db.js's ON CONFLICT SET clause).
  const idx = fakeRows.findIndex(r => r.match_id === row.match_id && r.xuid === row.xuid);
  if (idx === -1) { fakeRows.push(row); return; }
  const prev = fakeRows[idx];
  const merged = { ...prev };
  for (const k of Object.keys(row)) {
    if (k === 'match_id' || k === 'xuid') continue;
    if (row[k] != null) merged[k] = row[k];
  }
  merged.ts = new Date();
  fakeRows[idx] = merged;
}

const fakePg = {
  Pool: function FakePool() {
    this.query = async (sql, params) => {
      const s = sql.trim();
      if (/^CREATE TABLE|^CREATE INDEX|^ALTER TABLE/i.test(s)) return { rows: [] };
      if (/^INSERT INTO match_participants/i.test(s)) {
        const colSize = PARTICIPANT_COLS ? PARTICIPANT_COLS.length : 17;
        for (let i = 0; i < params.length; i += colSize) {
          const row = {};
          for (let j = 0; j < colSize; j++) row[PARTICIPANT_COLS[j]] = params[i + j];
          if (!row.ts) row.ts = new Date();
          _stubUpsert(row);
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
PARTICIPANT_COLS = db.PARTICIPANT_COLS;

function assert(cond, msg) {
  if (!cond) { console.error('  ✗', msg); process.exitCode = 1; }
  else console.log('  ✓', msg);
}

// Inline copy of aggregateStatsFromMatches from src/server.js so the test can
// validate it without spinning up Express. If server.js drifts this test
// should be updated alongside.
function aggregateStatsFromMatches(matches, base) {
  let ms = Array.isArray(matches) ? matches : [];
  if (!ms.length) return base || {};
  if (ms.length > 1) {
    const seen = new Set();
    const out = [];
    for (const m of ms) {
      const id = m && m.matchId;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(m);
    }
    ms = out;
  }
  const kills   = ms.reduce((s, m) => s + (m.kills   || 0), 0);
  const deaths  = ms.reduce((s, m) => s + (m.deaths  || 0), 0);
  const assists = ms.reduce((s, m) => s + (m.assists || 0), 0);
  const wins    = ms.filter(m => m.outcome === 2).length;
  const losses  = ms.filter(m => m.outcome === 3).length;
  const matchesPlayed = ms.length;
  const kd = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
  return { matchesPlayed, wins, losses, kills, deaths, assists, kd,
    winRate: matchesPlayed > 0 ? ((wins / matchesPlayed) * 100).toFixed(1) : '0.0' };
}

(async () => {
  const TARGET   = '3000000000000001'; // the private/reconstructed player
  const SOURCE_A = '3000000000000010';
  const SOURCE_B = '3000000000000020';

  console.log('Test 1: same (target, match_id) discovered via two source players → one DB row, one reconstructed match');
  // Source A submits match m_shared with TARGET on the roster.
  await db.saveMatchParticipants([{
    matchId: 'm_shared',
    isRanked: true,
    gameMode: 'Ranked Arena: Slayer',
    mapName: 'Live Fire',
    startTime: '2026-05-10T18:00:00Z',
    duration: 600,
    teams: [
      { teamId: 0, outcome: 2, players: [
        { rawXuid: SOURCE_A, gamertag: 'SourceA',  kills: 18, deaths: 9,  assists: 4, score: 90, damage: 4200 },
        { rawXuid: TARGET,   gamertag: 'Target',   kills: 10, deaths: 12, assists: 3, score: 50, damage: 2500 },
      ]},
      { teamId: 1, outcome: 3, players: [
        { rawXuid: '3000000000000099', gamertag: 'EnemyA', kills: 8, deaths: 14, assists: 1, score: 40, damage: 2000 },
      ]},
    ],
  }], SOURCE_A);

  // Source B then submits the SAME match (same matchId) — same target xuid
  // appears in B's match-detail payload as a teammate / opponent. This is the
  // exact double-discovery the user is worried about.
  await db.saveMatchParticipants([{
    matchId: 'm_shared',
    isRanked: true,
    gameMode: 'Ranked Arena: Slayer',
    mapName: 'Live Fire',
    startTime: '2026-05-10T18:00:00Z',
    duration: 600,
    teams: [
      { teamId: 0, outcome: 2, players: [
        { rawXuid: SOURCE_B, gamertag: 'SourceB', kills: 11, deaths: 10, assists: 5, score: 55, damage: 3000 },
        { rawXuid: TARGET,   gamertag: 'Target',  kills: 10, deaths: 12, assists: 3, score: 50, damage: 2500 },
      ]},
      { teamId: 1, outcome: 3, players: [
        { rawXuid: '3000000000000098', gamertag: 'EnemyB', kills: 7, deaths: 13, assists: 2, score: 35, damage: 1800 },
      ]},
    ],
  }], SOURCE_B);

  // DB-level uniqueness: even though TARGET was discovered via two sources,
  // exactly one row should exist for (m_shared, TARGET).
  const dbRowsForTarget = fakeRows.filter(r => r.match_id === 'm_shared' && r.xuid === TARGET);
  assert(dbRowsForTarget.length === 1, `exactly 1 DB row for (m_shared, TARGET) (got ${dbRowsForTarget.length})`);

  const recon = await db.reconstructMatchHistoryForXuid(TARGET, 50);
  assert(recon.matches.length === 1, `reconstruction returns 1 match (got ${recon.matches.length})`);
  assert(recon.matches[0].matchId === 'm_shared', 'reconstructed match is m_shared');
  assert(recon.matches[0].kills === 10 && recon.matches[0].deaths === 12,
    'target stats match the single canonical row (10/12)');

  const agg = aggregateStatsFromMatches(recon.matches, {});
  assert(agg.matchesPlayed === 1, `aggregate matchesPlayed = 1 (got ${agg.matchesPlayed})`);
  assert(agg.kills === 10 && agg.deaths === 12,
    `KDA counted once: K=10 D=12 (got K=${agg.kills} D=${agg.deaths})`);
  assert(agg.kd === '0.83', `K/D computed once: 0.83 (got ${agg.kd})`);

  console.log('\nTest 2: ON CONFLICT preserves the richer row (thin then enriched arrives later)');
  // First, a thin write (no rich fields).
  await db.saveMatchParticipants([{
    matchId: 'm_rich',
    isRanked: true,
    gameMode: 'Ranked Arena: CTF',
    mapName: 'Aquarius',
    startTime: '2026-05-11T12:00:00Z',
    duration: 720,
    teams: [
      { teamId: 0, outcome: 2, players: [
        { rawXuid: SOURCE_A, gamertag: 'SourceA', kills: 15, deaths: 11, assists: 3 },
        { rawXuid: TARGET,   gamertag: 'Target',  kills: 9,  deaths: 14, assists: 2 },
      ]},
    ],
  }], SOURCE_A);

  // Then an enriched write for the same match (CSR, accuracy, headshots,
  // medals, damage). saveMatchParticipants's COALESCE upsert should merge
  // these rich fields onto the existing row without zeroing anything.
  await db.saveMatchParticipants([{
    matchId: 'm_rich',
    isRanked: true,
    gameMode: 'Ranked Arena: CTF',
    mapName: 'Aquarius',
    startTime: '2026-05-11T12:00:00Z',
    duration: 720,
    teams: [
      { teamId: 0, outcome: 2, players: [
        { rawXuid: SOURCE_A, gamertag: 'SourceA', kills: 15, deaths: 11, assists: 3,
          accuracy: 51.2, shotsFired: 350, shotsLanded: 179 },
        { rawXuid: TARGET,   gamertag: 'Target',  kills: 9,  deaths: 14, assists: 2,
          damage: 2100, damageTaken: 2900, accuracy: 47.5, shotsFired: 280, shotsLanded: 133,
          headshotKills: 4, csrTier: 'Diamond', csrSubTier: 3, csrValue: 1380, csrPreValue: 1372, csrDelta: 8,
          medals: [{ nameId: 1, count: 2 }] },
      ]},
    ],
  }], SOURCE_B);

  const rowsRich = fakeRows.filter(r => r.match_id === 'm_rich' && r.xuid === TARGET);
  assert(rowsRich.length === 1, `still exactly 1 row after enriched re-ingest (got ${rowsRich.length})`);
  const row = rowsRich[0];
  assert(row.csr_tier === 'Diamond' && row.csr_value === 1380,
    `enriched CSR carried through (got tier=${row.csr_tier}, value=${row.csr_value})`);
  assert(row.accuracy === 47.5, `enriched accuracy carried through (got ${row.accuracy})`);
  assert(row.damage === 2100 && row.damage_taken === 2900,
    `damage + damage_taken carried through (got ${row.damage} / ${row.damage_taken})`);

  console.log('\nTest 3: in-memory dedupe picks the richer row when duplicates slip past the PK');
  // Simulate a legacy / drift scenario where two rows somehow coexist for
  // (match_id, xuid) — e.g. data fed in via a path that bypassed the
  // constraint. The reconstruction helper should collapse them and prefer
  // the richer row. We exercise _dedupeParticipantRowsByMatchId directly so
  // we don't have to bypass the stub's upsert.
  const thinRow = {
    match_id: 'm_dup', xuid: TARGET, gamertag: 'Target', team_id: 0, outcome: 2,
    kills: 5, deaths: 5, assists: 1, score: 25, damage: 1000,
    is_ranked: true, game_mode: 'Ranked Arena: Slayer', map_name: 'Recharge',
    start_time: new Date('2026-05-09T10:00:00Z'), duration_sec: 480,
    csr_tier: null, csr_value: null, accuracy: null, headshot_kills: null,
    ts: new Date('2026-05-09T10:01:00Z'),
  };
  const richRow = {
    match_id: 'm_dup', xuid: TARGET, gamertag: 'Target', team_id: 0, outcome: 2,
    kills: 5, deaths: 5, assists: 1, score: 25, damage: 1000,
    damage_taken: 1200, accuracy: 48.0, headshot_kills: 2,
    is_ranked: true, game_mode: 'Ranked Arena: Slayer', map_name: 'Recharge',
    start_time: new Date('2026-05-09T10:00:00Z'), duration_sec: 480,
    csr_tier: 'Diamond', csr_subtier: 2, csr_value: 1320, csr_pre_value: 1315, csr_delta: 5,
    medals: JSON.stringify([{ nameId: 7, count: 1 }]),
    ts: new Date('2026-05-09T10:02:00Z'),
  };

  const dedup1 = db._dedupeParticipantRowsByMatchId([thinRow, richRow]);
  assert(dedup1.length === 1, `dedupe collapses two (match_id, xuid) rows to 1 (got ${dedup1.length})`);
  assert(dedup1[0].csr_tier === 'Diamond' && dedup1[0].csr_value === 1320,
    'dedupe keeps the richer (Diamond/1320) row');
  assert(dedup1[0].accuracy === 48.0 && dedup1[0].headshot_kills === 2,
    'dedupe keeps rich CoreStats (accuracy + headshots)');

  // Order independence: same outcome regardless of input order.
  const dedup2 = db._dedupeParticipantRowsByMatchId([richRow, thinRow]);
  assert(dedup2.length === 1 && dedup2[0].csr_tier === 'Diamond',
    'dedupe is order-independent (rich wins either way)');

  // Tie-break by ts when richness is identical: newest wins.
  const aRow = { ...thinRow, ts: new Date('2026-05-09T10:00:00Z') };
  const bRow = { ...thinRow, ts: new Date('2026-05-09T11:00:00Z') };
  const dedup3 = db._dedupeParticipantRowsByMatchId([aRow, bRow]);
  assert(dedup3.length === 1 && dedup3[0].ts.getTime() === bRow.ts.getTime(),
    'tie on richness → newest ts wins');

  console.log('\nTest 4: aggregateStatsFromMatches collapses duplicate matchIds passed in directly');
  const dupMatches = [
    { matchId: 'a', kills: 10, deaths: 5, assists: 2, outcome: 2 },
    { matchId: 'a', kills: 10, deaths: 5, assists: 2, outcome: 2 }, // duplicate
    { matchId: 'b', kills: 6,  deaths: 8, assists: 3, outcome: 3 },
  ];
  const aggDup = aggregateStatsFromMatches(dupMatches, {});
  assert(aggDup.matchesPlayed === 2, `matchesPlayed = 2 (got ${aggDup.matchesPlayed})`);
  assert(aggDup.kills === 16 && aggDup.deaths === 13,
    `K=16 D=13 not doubled to K=26 D=18 (got K=${aggDup.kills} D=${aggDup.deaths})`);
  assert(aggDup.wins === 1 && aggDup.losses === 1, `wins=1 losses=1 (got ${aggDup.wins}/${aggDup.losses})`);

  console.log('\nTest 5: two source players + one enriched, one thin duplicate of the same match → enriched wins, counted once');
  // Combined end-to-end: write thin first, then enriched, simulating
  // discovery order doesn't matter. Confirm reconstruction surfaces a single
  // enriched match and aggregate counts it once.
  await db.saveMatchParticipants([{
    matchId: 'm_combo', isRanked: true, gameMode: 'Ranked Arena: Slayer',
    mapName: 'Streets', startTime: '2026-05-12T15:00:00Z', duration: 540,
    teams: [{ teamId: 0, outcome: 2, players: [
      { rawXuid: TARGET, gamertag: 'Target', kills: 12, deaths: 8, assists: 3 },
    ]}],
  }], SOURCE_A);
  await db.saveMatchParticipants([{
    matchId: 'm_combo', isRanked: true, gameMode: 'Ranked Arena: Slayer',
    mapName: 'Streets', startTime: '2026-05-12T15:00:00Z', duration: 540,
    teams: [{ teamId: 0, outcome: 2, players: [
      { rawXuid: TARGET, gamertag: 'Target', kills: 12, deaths: 8, assists: 3,
        damage: 3100, damageTaken: 2200, accuracy: 53.1, headshotKills: 6,
        csrTier: 'Onyx', csrValue: 1502, csrPreValue: 1495, csrDelta: 7 },
    ]}],
  }], SOURCE_B);

  const recon2 = await db.reconstructMatchHistoryForXuid(TARGET, 50);
  const combo = recon2.matches.find(m => m.matchId === 'm_combo');
  assert(!!combo, 'm_combo present in reconstruction');
  assert(combo && combo.csrAfter === 'Onyx 1502',
    `combo carries enriched CSR (got ${combo && combo.csrAfter})`);
  assert(combo && combo.accuracy === '53.1',
    `combo carries enriched accuracy 53.1 (got ${combo && combo.accuracy})`);
  // Total reconstruction count = the 3 distinct matches we wrote (m_shared, m_rich, m_combo).
  const ids = new Set(recon2.matches.map(m => m.matchId));
  assert(ids.size === recon2.matches.length, 'no duplicate matchIds in reconstruction output');
  assert(ids.size === 3, `3 unique reconstructed matches (got ${ids.size})`);

  const aggAll = aggregateStatsFromMatches(recon2.matches, {});
  assert(aggAll.matchesPlayed === 3, `aggregate matchesPlayed = 3 (got ${aggAll.matchesPlayed})`);
  // K = 10 (m_shared) + 9 (m_rich) + 12 (m_combo) = 31
  // D = 12 (m_shared) + 14 (m_rich) + 8 (m_combo)  = 34
  assert(aggAll.kills === 31 && aggAll.deaths === 34,
    `aggregate K=31 D=34 counted once each (got K=${aggAll.kills} D=${aggAll.deaths})`);

  console.log('\nDone.');
})();
