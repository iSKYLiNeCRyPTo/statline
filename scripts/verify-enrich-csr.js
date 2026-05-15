#!/usr/bin/env node
// Verify enrichMatchTeamsWithCsr fills missing per-player CSR data on
// match.teams[].players[] from match_participants (per-match) and then
// player_snapshots (current rank). Covers the three branches the renderer
// depends on:
//
//   1. Slot ALREADY has csrTier (camelCase) — left untouched.
//   2. Slot ALREADY has csr_tier (snake_case from reconstruct path) — left
//      untouched (rankBadgeHtml accepts snake_case, so no enrichment needed).
//   3. Slot missing CSR but match_participants has a per-match row — filled
//      with the post-match CSR.
//   4. Slot missing CSR with no participant row but a recent snapshot — filled
//      with the snapshot CSR and tagged `csrFromSnapshot: true`.
//   5. Slot with no participant row and no snapshot — stays empty so the
//      renderer simply omits the badge.
//
// Stubs pg the same way other verify scripts do so this runs without a live
// database.
//
// Run: node scripts/verify-enrich-csr.js

const path = require('path');
const Module = require('module');

// In-memory test fixtures populated per-test.
let participantsByKey = new Map();   // `${match_id}|${xuid}` -> row
let snapshotsByXuid = new Map();     // xuid -> { csr_tier, csr_subtier, csr_value, ts }

const fakePg = {
  Pool: function FakePool() {
    this.query = async (sql, params) => {
      const s = sql.trim();
      if (/^CREATE TABLE|^CREATE INDEX|^ALTER TABLE/i.test(s)) return { rows: [] };
      // enrichMatchTeamsWithCsr's per-match query
      if (/FROM match_participants\s+WHERE match_id = ANY\(\$1\) AND xuid = ANY\(\$2\)/i.test(s)) {
        const mids = new Set(params[0]);
        const xuids = new Set(params[1]);
        const rows = [];
        for (const [key, r] of participantsByKey.entries()) {
          const [mid, xu] = key.split('|');
          if (mids.has(mid) && xuids.has(xu) && r.csr_tier) rows.push({ ...r, match_id: mid, xuid: xu });
        }
        return { rows };
      }
      // enrichMatchTeamsWithCsr's snapshot query
      if (/FROM player_snapshots\s+WHERE xuid = ANY\(\$1\) AND csr_tier IS NOT NULL/i.test(s)) {
        const xuids = new Set(params[0]);
        const rows = [];
        for (const [xu, r] of snapshotsByXuid.entries()) {
          if (xuids.has(xu)) rows.push({ xuid: xu, csr_tier: r.csr_tier, csr_subtier: r.csr_subtier, csr_value: r.csr_value, csr: r.csr || null, ts: r.ts });
        }
        return { rows };
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

(async () => {
  console.log('Test 1: per-match participant CSR fills missing rosters (camelCase)');
  participantsByKey = new Map([
    ['m1|x_target', { csr_tier: 'Diamond', csr_subtier: 3, csr_value: 1300, csr_delta: 12, csr_pre_value: 1288 }],
    ['m1|x_mate',   { csr_tier: 'Onyx',    csr_subtier: 1, csr_value: 1542 }],
  ]);
  snapshotsByXuid = new Map();
  const matches1 = [{
    matchId: 'm1',
    teams: [{ teamId: 0, players: [
      { rawXuid: 'x_target', gamertag: 'Target', kills: 13, deaths: 10, assists: 4 },
      { rawXuid: 'x_mate',   gamertag: 'Mate',   kills: 9,  deaths: 15, assists: 4 },
      { rawXuid: 'x_unknown',gamertag: 'Stranger',kills: 6, deaths: 12, assists: 6 },
    ]}],
  }];
  const r1 = await db.enrichMatchTeamsWithCsr(matches1);
  const t1Target = matches1[0].teams[0].players[0];
  const t1Mate   = matches1[0].teams[0].players[1];
  const t1Unk    = matches1[0].teams[0].players[2];
  assert(t1Target.csrTier === 'Diamond', `target enriched tier (got ${t1Target.csrTier})`);
  assert(t1Target.csrSubTier === 3, `target subTier (got ${t1Target.csrSubTier})`);
  assert(t1Target.csrValue === 1300, `target value`);
  assert(t1Target.csrDelta === 12, `target delta`);
  assert(t1Target.csrFromSnapshot !== true, `target NOT marked as snapshot fallback`);
  assert(t1Mate.csrTier === 'Onyx' && t1Mate.csrValue === 1542, `mate Onyx 1542 enriched`);
  assert(t1Unk.csrTier == null && t1Unk.csr_tier == null, `unknown stays empty (no row, no snapshot)`);
  assert(r1.perMatch === 2, `perMatch=2 (got ${r1.perMatch})`);
  assert(r1.snapshot === 0, `snapshot=0`);

  console.log('\nTest 2: snake_case csr_tier already on slot is preserved (reconstruct path)');
  participantsByKey = new Map();
  snapshotsByXuid = new Map();
  const matches2 = [{
    matchId: 'm2',
    teams: [{ teamId: 0, players: [
      // Snake_case already populated by db.reconstructMatchHistoryForXuid path.
      { rawXuid: 'x1', gamertag: 'PreFilled', csr_tier: 'Platinum', csr_subtier: 4, csr_value: 1100 },
    ]}],
  }];
  await db.enrichMatchTeamsWithCsr(matches2);
  const t2 = matches2[0].teams[0].players[0];
  assert(t2.csr_tier === 'Platinum', 'snake_case csr_tier untouched');
  assert(t2.csrTier == null, 'no spurious camelCase added');

  console.log('\nTest 3: snapshot fallback uses playlist-specific CSR for the match playlist');
  // The match is Ranked SLAYER. The target has CSR in Slayer; the mate has CSR
  // only in Ranked Arena. The fallback must pick Slayer for the target and
  // leave the mate empty rather than show Arena CSR on a Slayer match row.
  participantsByKey = new Map();
  snapshotsByXuid = new Map([
    ['x_target2', {
      csr_tier: 'Onyx', csr_subtier: 1, csr_value: 1750,
      csr: {
        'Ranked Arena':  { tier: 'Onyx',    subTier: 1, value: 1750 },
        'Ranked Slayer': { tier: 'Diamond', subTier: 6, value: 1490 },
      },
    }],
    ['x_mate2',   {
      csr_tier: 'Diamond', csr_subtier: 6, csr_value: 1499,
      csr: { 'Ranked Arena': { tier: 'Diamond', subTier: 6, value: 1499 } },
    }],
  ]);
  const matches3 = [{
    matchId: 'm3',
    isRanked: true,
    playlistKind: 'slayer',
    teams: [{ teamId: 0, players: [
      { rawXuid: 'x_target2', gamertag: 'Tgt2', kills: 10, deaths: 8, assists: 5 },
      { rawXuid: 'x_mate2',   gamertag: 'Mate2', kills: 7, deaths: 12, assists: 3 },
      { rawXuid: 'x_ghost',   gamertag: 'Ghost', kills: 3, deaths: 14, assists: 2 },
    ]}],
  }];
  const r3 = await db.enrichMatchTeamsWithCsr(matches3);
  const t3Tgt = matches3[0].teams[0].players[0];
  const t3Mate = matches3[0].teams[0].players[1];
  const t3Ghost = matches3[0].teams[0].players[2];
  assert(t3Tgt.csrTier === 'Diamond' && t3Tgt.csrValue === 1490,
    `Slayer-specific CSR used (Diamond 1490), NOT top-level Arena (got ${t3Tgt.csrTier} ${t3Tgt.csrValue})`);
  assert(t3Tgt.csrFromSnapshot === true, 'csrFromSnapshot flag set (current-rank fallback)');
  assert(t3Mate.csrTier == null,
    `mate has no Slayer CSR → badge omitted (NOT Diamond from Arena; got ${t3Mate.csrTier})`);
  assert(t3Ghost.csrTier == null, 'ghost (no row, no snapshot) stays empty');
  assert(r3.snapshot === 1, `snapshot=1 (only target enriched; got ${r3.snapshot})`);
  assert(r3.perMatch === 0, 'perMatch=0 (no per-match data)');

  console.log('\nTest 4: per-match wins over snapshot when both exist');
  participantsByKey = new Map([
    // Per-match: Diamond 3 (1300) at the time of the match
    ['m4|x_dual', { csr_tier: 'Diamond', csr_subtier: 3, csr_value: 1300 }],
  ]);
  snapshotsByXuid = new Map([
    // Current: Onyx 1700 (player has since climbed). Per-match must win.
    ['x_dual', {
      csr_tier: 'Onyx', csr_subtier: 1, csr_value: 1700,
      csr: { 'Ranked Arena': { tier: 'Onyx', subTier: 1, value: 1700 } },
    }],
  ]);
  const matches4 = [{
    matchId: 'm4',
    isRanked: true,
    playlistKind: 'arena',
    teams: [{ teamId: 0, players: [
      { rawXuid: 'x_dual', gamertag: 'Dual' },
    ]}],
  }];
  const r4 = await db.enrichMatchTeamsWithCsr(matches4);
  const t4 = matches4[0].teams[0].players[0];
  assert(t4.csrTier === 'Diamond' && t4.csrValue === 1300, `per-match Diamond beats snapshot Onyx`);
  assert(!t4.csrFromSnapshot, 'csrFromSnapshot NOT set (per-match source)');
  assert(r4.perMatch === 1 && r4.snapshot === 0, 'counters: perMatch=1, snapshot=0');

  console.log('\nTest 4b: legacy match w/ snapshot that has only Arena CSR — slot stays empty');
  // This is the original bug: a Ranked Legacy match should NOT inherit the
  // player's Ranked Arena rank from the snapshot fallback.
  participantsByKey = new Map();
  snapshotsByXuid = new Map([
    ['x_arena_only', {
      csr_tier: 'Onyx', csr_subtier: 1, csr_value: 1820,
      csr: { 'Ranked Arena': { tier: 'Onyx', subTier: 1, value: 1820 } },
    }],
  ]);
  const matches4b = [{
    matchId: 'm4b',
    isRanked: true,
    playlistKind: 'legacy',
    teams: [{ teamId: 0, players: [
      { rawXuid: 'x_arena_only', gamertag: 'ArenaOnly' },
    ]}],
  }];
  const r4b = await db.enrichMatchTeamsWithCsr(matches4b);
  const t4b = matches4b[0].teams[0].players[0];
  assert(t4b.csrTier == null,
    `legacy match leaves Arena-only player empty (got ${t4b.csrTier} ${t4b.csrValue})`);
  assert(r4b.snapshot === 0, 'snapshot=0 (no Legacy CSR available)');

  console.log('\nTest 4c: playlistKind inferred from gameMode for reconstructed matches');
  // Reconstructed matches (from match_participants) have no playlistKind on
  // the parent match object — only `gameMode`. Make sure _playlistKindOf
  // picks the right kind from the mode string.
  participantsByKey = new Map();
  snapshotsByXuid = new Map([
    ['x_recon', {
      csr_tier: 'Onyx', csr_subtier: 1, csr_value: 1750,
      csr: {
        'Ranked Arena':  { tier: 'Onyx',    subTier: 1, value: 1750 },
        'Ranked Slayer': { tier: 'Platinum',subTier: 2, value: 1080 },
      },
    }],
  ]);
  const matches4c = [{
    matchId: 'm4c',
    isRanked: true,
    gameMode: 'Ranked Slayer',
    teams: [{ teamId: 0, players: [{ rawXuid: 'x_recon', gamertag: 'Recon' }] }],
  }];
  await db.enrichMatchTeamsWithCsr(matches4c);
  const t4c = matches4c[0].teams[0].players[0];
  assert(t4c.csrTier === 'Platinum' && t4c.csrValue === 1080,
    `gameMode='Ranked Slayer' resolves to slayer (got ${t4c.csrTier} ${t4c.csrValue})`);

  console.log('\nTest 4d: poisoned participant row (Arena CSR on Slayer match) — heals from snapshot');
  // The exact bug from the screenshot: a pre-fix deployment saved snapshot-
  // derived Arena CSR onto match_participants for a Ranked Slayer match.
  // Now the snapshot's csr JSON shows the player has both Arena (P3 / 1450)
  // and Slayer (D5 / 1390) CSR. The poisoned row says Platinum 3 / 1450
  // (matches Arena, not Slayer). Expectation: enrich rejects the row and
  // falls back to the snapshot's Slayer CSR, with csrFromSnapshot:true.
  participantsByKey = new Map([
    ['mPoison|x_itz', { csr_tier: 'Platinum', csr_subtier: 3, csr_value: 1450, csr_delta: 0, csr_pre_value: 1450 }],
  ]);
  snapshotsByXuid = new Map([
    ['x_itz', {
      csr_tier: 'Platinum', csr_subtier: 3, csr_value: 1450,
      csr: {
        'Ranked Arena':  { tier: 'Platinum', subTier: 3, value: 1450 },
        'Ranked Slayer': { tier: 'Diamond',  subTier: 5, value: 1390 },
      },
    }],
  ]);
  const matches4d = [{
    matchId: 'mPoison',
    isRanked: true,
    playlistKind: 'slayer',
    gameMode: 'Ranked Slayer',
    teams: [{ teamId: 0, players: [
      { rawXuid: 'x_itz', gamertag: 'Itz7Shots' },
    ]}],
  }];
  const r4d = await db.enrichMatchTeamsWithCsr(matches4d);
  const t4d = matches4d[0].teams[0].players[0];
  assert(t4d.csrTier === 'Diamond' && t4d.csrSubTier === 5 && t4d.csrValue === 1390,
    `poisoned Arena row replaced by Slayer snapshot (got ${t4d.csrTier} ${t4d.csrSubTier} ${t4d.csrValue})`);
  assert(t4d.csrFromSnapshot === true, 'csrFromSnapshot tagged after heal');
  assert(r4d.snapshot === 1 && r4d.perMatch === 0,
    `counters: snapshot=1 perMatch=0 (got snapshot=${r4d.snapshot} perMatch=${r4d.perMatch})`);

  console.log('\nTest 4e: poisoned-row heal omits badge when snapshot has no match-playlist CSR');
  // Same shape as 4d but the player has only Arena CSR. The row is still
  // rejected (Arena CSR on a Slayer row); since the snapshot has no Slayer
  // entry, the slot stays empty rather than fall through to Arena.
  participantsByKey = new Map([
    ['mPoison2|x_arenaonly', { csr_tier: 'Onyx', csr_subtier: 1, csr_value: 1820, csr_pre_value: 1820 }],
  ]);
  snapshotsByXuid = new Map([
    ['x_arenaonly', {
      csr_tier: 'Onyx', csr_subtier: 1, csr_value: 1820,
      csr: { 'Ranked Arena': { tier: 'Onyx', subTier: 1, value: 1820 } },
    }],
  ]);
  const matches4e = [{
    matchId: 'mPoison2',
    isRanked: true,
    playlistKind: 'slayer',
    teams: [{ teamId: 0, players: [{ rawXuid: 'x_arenaonly', gamertag: 'ArenaOnly' }] }],
  }];
  await db.enrichMatchTeamsWithCsr(matches4e);
  const t4e = matches4e[0].teams[0].players[0];
  assert(t4e.csrTier == null,
    `Arena-only player on Slayer match stays empty even with poisoned row (got ${t4e.csrTier})`);

  console.log('\nTest 4f: matching participant row trusted — not flagged as poisoned');
  // Player on a Slayer match where the participant row genuinely contains the
  // player's Slayer CSR (matches the snapshot's Slayer entry). Must use the
  // row, not the snapshot fallback path.
  participantsByKey = new Map([
    ['mGood|x_good', { csr_tier: 'Diamond', csr_subtier: 5, csr_value: 1390, csr_pre_value: 1380 }],
  ]);
  snapshotsByXuid = new Map([
    ['x_good', {
      csr_tier: 'Onyx', csr_subtier: 1, csr_value: 1820,
      csr: {
        'Ranked Arena':  { tier: 'Onyx',    subTier: 1, value: 1820 },
        'Ranked Slayer': { tier: 'Diamond', subTier: 5, value: 1390 },
      },
    }],
  ]);
  const matches4f = [{
    matchId: 'mGood',
    isRanked: true,
    playlistKind: 'slayer',
    teams: [{ teamId: 0, players: [{ rawXuid: 'x_good', gamertag: 'GoodRow' }] }],
  }];
  const r4f = await db.enrichMatchTeamsWithCsr(matches4f);
  const t4f = matches4f[0].teams[0].players[0];
  assert(t4f.csrTier === 'Diamond' && t4f.csrValue === 1390,
    `genuine Slayer row preserved (got ${t4f.csrTier} ${t4f.csrValue})`);
  assert(!t4f.csrFromSnapshot, 'csrFromSnapshot NOT set (per-match source)');
  assert(r4f.perMatch === 1 && r4f.snapshot === 0,
    `counters: perMatch=1 snapshot=0 (got perMatch=${r4f.perMatch} snapshot=${r4f.snapshot})`);

  console.log('\nTest 5: no-op on empty / undefined input');
  const rE1 = await db.enrichMatchTeamsWithCsr([]);
  assert(rE1.perMatch === 0 && rE1.snapshot === 0 && rE1.missing === 0, 'empty matches → zeros');
  const rE2 = await db.enrichMatchTeamsWithCsr(undefined);
  assert(rE2.perMatch === 0 && rE2.snapshot === 0, 'undefined matches → zeros');

  console.log('\nTest 6: rankBadgeHtml on the enriched slot would produce a badge');
  // Simulate the renderer's helper. The rankBadgeHtml itself lives in the
  // browser-side utils.js (no Node export), so reimplement the same predicate
  // here: a badge is rendered iff (csrTier || csr_tier) is set.
  function wouldBadge(pl){
    var tier = pl.csrTier != null ? pl.csrTier : pl.csr_tier;
    return !!tier;
  }
  assert(wouldBadge(t1Target), 'm1 target produces a badge after enrichment');
  assert(wouldBadge(t1Mate),   'm1 mate produces a badge after enrichment');
  assert(!wouldBadge(t1Unk),   'm1 unknown produces NO badge');
  assert(wouldBadge(t3Tgt),    'm3 target (snapshot) produces a badge');

  console.log('\nTest 7: buildParticipantRow strips CSR fields when csrFromSnapshot is set');
  // saveMatchParticipants must NEVER persist a snapshot-derived CSR onto
  // match_participants — that's exactly what poisoned the table before.
  const goodMeta = { matchId: 'mB', isRanked: true, gameMode: 'Ranked Slayer', sourceXuid: 'x_src' };
  const goodTeam = { teamId: 0, outcome: 2 };
  const perMatchPl = {
    rawXuid: 'x_realmatch', gamertag: 'PerMatch',
    kills: 12, deaths: 8, assists: 4,
    csrTier: 'Diamond', csrSubTier: 5, csrValue: 1390, csrPreValue: 1380, csrDelta: 10,
  };
  const snapPl = {
    rawXuid: 'x_snap', gamertag: 'FromSnap',
    kills: 9, deaths: 12, assists: 3,
    csrTier: 'Diamond', csrSubTier: 5, csrValue: 1390,
    csrFromSnapshot: true,
  };
  const rowGood = db.buildParticipantRow(perMatchPl, goodTeam, goodMeta);
  const rowSnap = db.buildParticipantRow(snapPl, goodTeam, goodMeta);
  assert(rowGood.csr_tier === 'Diamond' && rowGood.csr_value === 1390,
    'per-match CSR persisted (Diamond 1390)');
  assert(rowGood.csr_subtier === 5 && rowGood.csr_pre_value === 1380 && rowGood.csr_delta === 10,
    'per-match CSR rich fields persisted');
  assert(rowSnap.csr_tier == null && rowSnap.csr_subtier == null && rowSnap.csr_value == null,
    `snapshot-derived CSR NOT persisted (got tier=${rowSnap.csr_tier} sub=${rowSnap.csr_subtier} val=${rowSnap.csr_value})`);
  assert(rowSnap.csr_pre_value == null && rowSnap.csr_delta == null,
    'snapshot-derived pre/delta also nulled out');
  // Non-CSR rich fields still flow through — only CSR is gated.
  assert(rowSnap.kills === 9 && rowSnap.deaths === 12,
    'non-CSR fields still persisted on csrFromSnapshot rows');

  if (process.exitCode) {
    console.error('\n✗ verify-enrich-csr: failures');
    process.exit(1);
  }
  console.log('\n✓ verify-enrich-csr: all assertions passed');
})().catch(e => { console.error(e); process.exit(1); });
