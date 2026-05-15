#!/usr/bin/env node
// Verifies the two reconstructed-player fixes:
//
//   A) CSR History chart consumes per-match csrValue (numeric) instead of
//      parsing the csrAfter label ("Diamond 4") which is the sub-tier index,
//      not a CSR number. With only csr_tier/csr_subtier present the chart
//      must render nothing rather than plot tier indices.
//
//   B) Reconstructed players get aggregate overview stats (KDA / KD / kills /
//      win rate) computed from match counters when the service-record path
//      returns 0 — so the Overview KDA tile is numeric, not "—".
//
// Mirrors verify-reconstruct.js: stubs `pg` with an in-memory pool so the
// test runs without a real Postgres.

const path = require('path');
const Module = require('module');

const fakeRows = [];
let PARTICIPANT_COLS = null;

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
          fakeRows.push(row);
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

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  ✗', msg); failures++; process.exitCode = 1; }
  else console.log('  ✓', msg);
}

// Inline copy of charts.js _csrFrom so we exercise the same selection logic
// the chart uses to decide whether a match contributes a real CSR point.
function _csrFromChart(m) {
  if (m.csrValue != null) return +m.csrValue;
  if (m.csr_value != null) return +m.csr_value;
  if (m.csrAfter) {
    const s = String(m.csrAfter);
    if (/^Onyx/i.test(s)) {
      const n = parseInt(s.match(/\d+/));
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

// Inline copy of server.js aggregateStatsFromMatches so this test doesn't have
// to boot the express server. Keep this in sync with the real one.
function aggregateStatsFromMatches(matches, base) {
  const ms = Array.isArray(matches) ? matches : [];
  if (!ms.length) return base || {};
  const kills   = ms.reduce((s, m) => s + (m.kills   || 0), 0);
  const deaths  = ms.reduce((s, m) => s + (m.deaths  || 0), 0);
  const assists = ms.reduce((s, m) => s + (m.assists || 0), 0);
  const wins    = ms.filter(m => m.outcome === 2).length;
  const losses  = ms.filter(m => m.outcome === 3).length;
  const matchesPlayed = ms.length;
  const kd = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
  const kda = matchesPlayed > 0
    ? ((kills - deaths + assists / 3) / matchesPlayed).toFixed(2)
    : (kills - deaths + assists / 3).toFixed(2);
  return {
    ...(base || {}),
    matchesPlayed, wins, losses,
    winRate: matchesPlayed > 0 ? ((wins / matchesPlayed) * 100).toFixed(1) : '0.0',
    kills, deaths, assists,
    kd, kda,
    avgKillsPerGame: matchesPlayed > 0 ? (kills / matchesPlayed).toFixed(1) : '0.0',
  };
}

(async () => {
  const PRIVATE_XUID = '2000000000000099';
  const PUB1 = '2000000000000098';

  // ── Test A1: per-match csr_value flows through reconstructed matches ─────
  console.log('Test A1: reconstructed rows expose numeric csrValue (1500 → 1512)');
  const samples = [];
  for (let i = 0; i < 5; i++) {
    samples.push({
      matchId: 'csrA' + i,
      isRanked: true,
      gameMode: 'Ranked Arena',
      mapName: 'Live Fire',
      startTime: new Date(Date.now() - (5 - i) * 86400000).toISOString(),
      duration: 600,
      teams: [
        { teamId: 0, outcome: 2, players: [
          { rawXuid: PUB1, gamertag: 'PubA', kills: 16, deaths: 10, assists: 3, damage: 4000 },
          {
            rawXuid: PRIVATE_XUID, gamertag: 'PrivOne',
            kills: 14, deaths: 9, assists: 2, damage: 3700,
            // Real per-match RankRecap: Diamond 4 with CSR 1500 + i*3
            csrTier: 'Diamond', csrSubTier: 4, csrValue: 1500 + i * 3,
            csrPreValue: 1497 + i * 3, csrDelta: 3,
          },
        ]},
        { teamId: 1, outcome: 3, players: [
          { rawXuid: '2000000000000200' + i, gamertag: 'EnemyA' + i,
            kills: 11, deaths: 14, assists: 1, damage: 3300 },
        ]},
      ],
    });
  }
  await db.saveMatchParticipants(samples, PUB1);
  const recon = await db.reconstructMatchHistoryForXuid(PRIVATE_XUID, 50);
  assert(recon.matches.length === 5, `5 reconstructed matches (got ${recon.matches.length})`);
  const csrVals = recon.matches.map(m => m.csrValue).sort((a, b) => a - b);
  assert(JSON.stringify(csrVals) === JSON.stringify([1500, 1503, 1506, 1509, 1512]),
    `numeric csrValue series preserved (got ${JSON.stringify(csrVals)})`);
  const chartVals = recon.matches.map(_csrFromChart).sort((a, b) => a - b);
  assert(JSON.stringify(chartVals) === JSON.stringify([1500, 1503, 1506, 1509, 1512]),
    `chart selector returns real CSR (1500..1512), NOT subTier (got ${JSON.stringify(chartVals)})`);
  // Sanity: csrAfter still encodes the label so badges keep working.
  assert(recon.matches.every(m => m.csrAfter === 'Diamond 4'),
    `csrAfter label intact for badge rendering (got ${recon.matches[0].csrAfter})`);

  // ── Test A2: rows with only tier/subtier (no value) do NOT chart ─────────
  console.log('\nTest A2: rows with only csr_tier/subTier (no value) emit no chart points');
  const PRIV2 = '2000000000000077';
  const PUB2 = '2000000000000076';
  const tierOnlySamples = [];
  for (let i = 0; i < 4; i++) {
    tierOnlySamples.push({
      matchId: 'csrB' + i,
      isRanked: true,
      gameMode: 'Ranked Arena',
      mapName: 'Recharge',
      startTime: new Date(Date.now() - (4 - i) * 86400000).toISOString(),
      duration: 600,
      teams: [
        { teamId: 0, outcome: 2, players: [
          { rawXuid: PUB2, gamertag: 'PubB', kills: 12, deaths: 11, assists: 4, damage: 3500 },
          { rawXuid: PRIV2, gamertag: 'PrivTwo',
            kills: 10, deaths: 12, assists: 3, damage: 3200,
            // Only the badge fields — no csrValue.
            csrTier: 'Diamond', csrSubTier: 4 },
        ]},
        { teamId: 1, outcome: 3, players: [
          { rawXuid: '2000000000000300' + i, gamertag: 'EnemyB' + i,
            kills: 9, deaths: 13, assists: 1, damage: 3100 },
        ]},
      ],
    });
  }
  await db.saveMatchParticipants(tierOnlySamples, PUB2);
  const recon2 = await db.reconstructMatchHistoryForXuid(PRIV2, 50);
  assert(recon2.matches.length === 4, `4 reconstructed matches (got ${recon2.matches.length})`);
  const chartVals2 = recon2.matches.map(_csrFromChart);
  assert(chartVals2.every(v => v === null),
    `chart selector returns null when only tier/subtier present (got ${JSON.stringify(chartVals2)})`);
  // Confirm the badge data IS still available — only the chart is suppressed.
  assert(recon2.matches.every(m => m.csrTier === 'Diamond' && m.csrSubTier === 4),
    'badge fields still present even when chart suppressed');

  // ── Test A3: Onyx csrAfter still works as a fallback when csrValue absent
  console.log('\nTest A3: Onyx csrAfter ("Onyx 1542") falls back to its number');
  const onyxMatch = { csrAfter: 'Onyx 1542' };
  assert(_csrFromChart(onyxMatch) === 1542, 'Onyx csrAfter parses to 1542');
  const nonOnyxMatch = { csrAfter: 'Diamond 4' };
  assert(_csrFromChart(nonOnyxMatch) === null,
    'Non-Onyx csrAfter ("Diamond 4") does NOT parse — would otherwise plot subTier as CSR');

  // ── Test B1: aggregate KDA from reconstructed matches (sample 32/15/7) ───
  console.log('\nTest B1: aggregate KDA from reconstructed matches (32 K / 15 D / 7 A across 1 game)');
  const oneGame = [{ kills: 32, deaths: 15, assists: 7, outcome: 2 }];
  const agg1 = aggregateStatsFromMatches(oneGame, {});
  // K - D + A/3 = 32 - 15 + 2.33 = 19.33; matches=1 → kda = '19.33'
  assert(agg1.kda === '19.33', `kda='19.33' from 32/15/7 (got ${agg1.kda})`);
  assert(agg1.kd === '2.13', `kd='2.13' from 32/15 (got ${agg1.kd})`);
  assert(agg1.kills === 32 && agg1.deaths === 15 && agg1.assists === 7, 'raw totals preserved');

  // ── Test B2: zero deaths handled — uses raw kills, not Infinity / "—" ────
  console.log('\nTest B2: zero-death handling — kd falls back to kill count, kda still real');
  const zeroDeath = [{ kills: 18, deaths: 0, assists: 2, outcome: 2 }];
  const agg2 = aggregateStatsFromMatches(zeroDeath, {});
  assert(agg2.kd === '18.00', `kd='18.00' for 18 kills / 0 deaths (got ${agg2.kd})`);
  // kda = (18 - 0 + 0.67) / 1 = 18.67
  assert(agg2.kda === '18.67', `kda='18.67' for 18/0/2 (got ${agg2.kda})`);

  // ── Test B3: empty / null match list returns base unchanged ──────────────
  console.log('\nTest B3: empty match list leaves base stats untouched');
  const base = { kd: '1.50', kda: '0.30', matchesPlayed: 0 };
  const agg3 = aggregateStatsFromMatches([], base);
  assert(agg3 === base, 'returns the same base reference when no matches');

  // ── Test B4: realistic 12-match reconstructed history aggregates cleanly
  console.log('\nTest B4: realistic 12-match reconstructed history aggregates to numeric KDA (not "—")');
  const synthetic = [];
  for (let i = 0; i < 12; i++) {
    const win = i % 3 !== 0;
    synthetic.push({
      kills: win ? 16 : 9,
      deaths: win ? 10 : 14,
      assists: 3,
      outcome: win ? 2 : 3,
    });
  }
  const agg4 = aggregateStatsFromMatches(synthetic, {});
  assert(agg4.matchesPlayed === 12, '12 matches counted');
  assert(parseFloat(agg4.kda) > 0, `kda is positive non-zero number (got ${agg4.kda})`);
  assert(parseFloat(agg4.kd) > 0,  `kd is positive non-zero number (got ${agg4.kd})`);
  assert(agg4.kd !== '—' && agg4.kda !== '—' && agg4.kd !== null && agg4.kda !== null,
    'kd/kda are real values, never dash placeholders');

  // ── Test C1: cache-read repair — stale stats on a reconstructed cache entry
  // get recomputed from current matches, and match rows get re-projected with
  // the new csrValue/csrPreValue fields. Simulates a payload cached before the
  // PR12 db.js change (matches lack csrValue) with zero service-record stats.
  console.log('\nTest C1: cached reconstructed payload — stats recomputed + matches re-projected on read');
  const cached = {
    xuid: PRIVATE_XUID,
    reconstructed: true,
    privateHistory: true,
    // Old service-record stats — all dashes/zeros for private profiles.
    stats: { kills: 0, deaths: 0, assists: 0, kd: '—', kda: '—', matchesPlayed: 0, winRate: '0.0' },
    // Old cached match rows: lack csrValue / csrPreValue (the fields PR12 added
    // to db.js). They still carry kills/deaths/assists so per-match cards work,
    // but the chart would have nothing real to plot.
    recentMatches: recon.matches.map(m => ({
      matchId: m.matchId, isRanked: m.isRanked, gameMode: m.gameMode,
      kills: m.kills, deaths: m.deaths, assists: m.assists, outcome: m.outcome,
      csrAfter: m.csrAfter, csrTier: m.csrTier, csrSubTier: m.csrSubTier,
      // csrValue / csrPreValue intentionally omitted — simulates pre-PR12 cache.
    })),
  };
  cached.allMatches = cached.recentMatches;
  // Simulate the cache-repair branch: re-run reconstruct, re-project match
  // rows, re-aggregate stats. This mirrors src/server.js cached-path code.
  const fresh = await db.reconstructMatchHistoryForXuid(PRIVATE_XUID, 100);
  if (fresh && fresh.matches.length) {
    cached.recentMatches = fresh.matches;
    cached.allMatches = fresh.matches;
    cached.stats = aggregateStatsFromMatches(fresh.matches, cached.stats);
  }
  assert(cached.stats.kd !== '—' && cached.stats.kda !== '—',
    `cached stats no longer dashes after repair (kd=${cached.stats.kd}, kda=${cached.stats.kda})`);
  assert(parseFloat(cached.stats.kda) > 0, `cached kda is real number (${cached.stats.kda})`);
  assert(cached.recentMatches[0].csrValue != null,
    'cached match rows now carry csrValue after re-projection');
  assert(cached.recentMatches[0].csrPreValue != null,
    'cached match rows now carry csrPreValue after re-projection');
  const repairedChartVals = cached.recentMatches.map(_csrFromChart).sort((a, b) => a - b);
  assert(JSON.stringify(repairedChartVals) === JSON.stringify([1500, 1503, 1506, 1509, 1512]),
    `repaired cache plots real CSR series (got ${JSON.stringify(repairedChartVals)})`);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL (' + failures + ')'}`);
})();
