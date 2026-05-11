#!/usr/bin/env node
// Smoke test for the private/reconstructed match-history active recovery
// queue (src/recoveryQueue.js).
//
// Verifies:
//   1. maybeQueueRecovery returns recoveryQueued=false when coverage is at or
//      above the LOW_COVERAGE_THRESHOLD.
//   2. maybeQueueRecovery returns recoveryQueued=true with status='queued'
//      when coverage is below threshold AND no run is in flight.
//   3. The returned metadata is synchronous — no awaiting the heavy work.
//   4. Seed selection: only co-players (not the target itself) are queried,
//      anonymous "Spartan ###" seeds are skipped, and the top
//      MAX_SEEDS_PER_RUN are taken.
//   5. Staged depth gating: a seed whose stage1 fetch yields >=
//      STAGE2_SHARED_THRESHOLD shared hits gets promoted to stage2; a seed
//      whose stage1 yields fewer does NOT.
//   6. saveMatchParticipants is called once per stage with the seed's xuid as
//      sourceXuid, so participant rows for the target accumulate.
//   7. After a run finishes, the per-target cooldown short-circuits subsequent
//      maybeQueueRecovery calls with status='recent_run'.
//
// Run:  node scripts/verify-recovery-queue.js

const path = require('path');

function assert(cond, msg) {
  if (!cond) { console.error('  ✗', msg); process.exitCode = 1; }
  else console.log('  ✓', msg);
}

// Force small cooldown / quick test cycle.
process.env.RECOVERY_LOW_COVERAGE_THRESHOLD = '40';
process.env.RECOVERY_MAX_SEEDS_PER_RUN = '3';
process.env.RECOVERY_CANDIDATE_POOL_SIZE = '10';
process.env.RECOVERY_STAGE1_DEPTH = '100';
process.env.RECOVERY_STAGE2_DEPTH = '250';
process.env.RECOVERY_STAGE3_DEPTH = '400';
process.env.RECOVERY_STAGE2_SHARED_THRESHOLD = '2';
process.env.RECOVERY_STAGE3_SHARED_THRESHOLD = '5';
process.env.RECOVERY_PER_TARGET_COOLDOWN_HOURS = '1';
process.env.RECOVERY_INTER_SEED_DELAY_MS = '1';

const recoveryQueue = require(path.join(__dirname, '..', 'src', 'recoveryQueue.js'));

// Fixtures —
// Target = the private player we're recovering for.
// Seeds: alpha (5 same-team), beta (3 same-team), gamma (1 same-team), delta (anonymous).
const TARGET = '3000000000000001';
const ALPHA  = '3000000000000002';
const BETA   = '3000000000000003';
const GAMMA  = '3000000000000004';
const DELTA  = '3000000000000005';

// Mock match-history generator. Returns N matches, where the first
// `withTarget` matches contain the target xuid on the same team.
function makeMatches(n, seedXuid, withTarget) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const players = [{ rawXuid: seedXuid, gamertag: 'Seed' + seedXuid }];
    if (i < withTarget) players.push({ rawXuid: TARGET, gamertag: 'Target' });
    out.push({
      matchId: `${seedXuid}-m${i}`,
      isRanked: true,
      gameMode: 'Ranked Arena: Slayer',
      mapName: 'Recharge',
      startTime: new Date(Date.now() - i * 60000).toISOString(),
      duration: 'PT9M0S',
      teams: [{ teamId: 0, outcome: i % 2 === 0 ? 2 : 3, players }],
    });
  }
  return out;
}

// Track calls for assertions.
const saveCalls = [];
const fetchCalls = [];
let countMatches = 5; // pre-recovery coverage (well below threshold)

const deps = {
  fetchMatchHistory: async (xuid, gamertag, depth /*, onProgress, stopAt */) => {
    fetchCalls.push({ xuid, gamertag, depth });
    // Configure shared-hit counts per seed so we can assert staged promotion.
    let shared = 0;
    if (xuid === ALPHA) shared = 8;   // beats both stage2 and stage3 thresholds → all 3 stages
    if (xuid === BETA)  shared = 3;   // beats stage2 only → stages 1 and 2
    if (xuid === GAMMA) shared = 1;   // misses stage2 → stage1 only
    return { matches: makeMatches(Math.min(depth, 12), xuid, shared) };
  },
  saveMatchParticipants: async (matchRows, sourceXuid) => {
    saveCalls.push({ count: matchRows.length, sourceXuid });
    // Simulate coverage growth: every match that contains TARGET adds a row.
    for (const m of matchRows) {
      const hasTarget = (m.teams || []).some(t =>
        (t.players || []).some(p => String(p.rawXuid) === TARGET)
      );
      if (hasTarget) countMatches++;
    }
    return matchRows.length;
  },
  getRecoverySeeds: async (xuid, limit) => {
    assert(String(xuid) === TARGET, 'getRecoverySeeds called with target xuid');
    // Returned in priority order. Note: delta has anonymous gamertag and
    // should be filtered out by the queue before being used as a seed.
    return [
      { xuid: ALPHA, gamertag: 'AlphaTag', shared_team: 5, total_shared: 12, recent_shared: 10 },
      { xuid: BETA,  gamertag: 'BetaTag',  shared_team: 3, total_shared: 6,  recent_shared: 4  },
      { xuid: GAMMA, gamertag: 'GammaTag', shared_team: 1, total_shared: 2,  recent_shared: 2  },
      { xuid: DELTA, gamertag: 'Spartan 1234', shared_team: 1, total_shared: 1, recent_shared: 1 },
    ].slice(0, limit);
  },
  countMatchesForXuid: async (xuid) => {
    assert(String(xuid) === TARGET, 'countMatchesForXuid called with target xuid');
    return countMatches;
  },
  getRefreshMeta: async () => new Map(),
  isRecentlyRefreshed: () => false,
  isInNoNewDataCooldown: () => false,
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('Test 1: sufficient coverage → no recovery queued');
  let meta = recoveryQueue.maybeQueueRecovery({ xuid: TARGET, gamertag: 'Target', knownCount: 100, deps });
  assert(meta.recoveryQueued === false, 'queued=false when knownCount >= threshold');
  assert(meta.recoveryStatus === 'sufficient_coverage', 'status=sufficient_coverage');

  console.log('\nTest 2: low coverage + no run in flight → queued synchronously');
  const t0 = Date.now();
  meta = recoveryQueue.maybeQueueRecovery({ xuid: TARGET, gamertag: 'Target', knownCount: 5, deps });
  const elapsed = Date.now() - t0;
  assert(meta.recoveryQueued === true, 'queued=true when coverage is low');
  assert(meta.recoveryStatus === 'queued', 'status=queued on first call');
  assert(meta.recoveryDepth === 100, 'recoveryDepth=STAGE1_DEPTH on initial queue');
  assert(elapsed < 50, `maybeQueueRecovery returned synchronously (${elapsed}ms)`);

  console.log('\nTest 3: second call while running → status=in_progress');
  const meta2 = recoveryQueue.maybeQueueRecovery({ xuid: TARGET, gamertag: 'Target', knownCount: 5, deps });
  assert(meta2.recoveryQueued === true, 'queued=true while running');
  assert(meta2.recoveryStatus === 'in_progress', 'status=in_progress for re-entry');

  // Wait for the run to finish. With 1ms inter-seed delay it should be quick.
  for (let i = 0; i < 100; i++) {
    if (recoveryQueue.getStatus(TARGET).state !== 'running') break;
    await sleep(20);
  }
  const finalStatus = recoveryQueue.getStatus(TARGET);
  assert(finalStatus.state !== 'running', 'run finished within timeout');

  console.log('\nTest 4: seed selection & anonymous filtering');
  // ALPHA, BETA, GAMMA all should have been fetched at least once at stage1.
  // DELTA (Spartan 1234) must be skipped entirely.
  const alphaFetches = fetchCalls.filter(c => c.xuid === ALPHA);
  const betaFetches  = fetchCalls.filter(c => c.xuid === BETA);
  const gammaFetches = fetchCalls.filter(c => c.xuid === GAMMA);
  const deltaFetches = fetchCalls.filter(c => c.xuid === DELTA);
  assert(alphaFetches.length >= 1, 'alpha fetched');
  assert(betaFetches.length  >= 1, 'beta fetched');
  assert(gammaFetches.length >= 1, 'gamma fetched');
  assert(deltaFetches.length === 0, 'delta (Spartan 1234) filtered out — anonymous seed skipped');

  console.log('\nTest 5: staged depth gating');
  // ALPHA: 8 shared hits → should run all three depths (100, 250, 400)
  const alphaDepths = alphaFetches.map(c => c.depth).sort((a,b)=>a-b);
  assert(alphaDepths.includes(100), 'alpha ran stage1 (depth=100)');
  assert(alphaDepths.includes(250), 'alpha promoted to stage2 (depth=250) — 8 shared >= 2');
  assert(alphaDepths.includes(400), 'alpha promoted to stage3 (depth=400) — 8 shared >= 5');
  // BETA: 3 shared hits → stage1 + stage2 (3 >= 2 but 3 < 5)
  const betaDepths = betaFetches.map(c => c.depth).sort((a,b)=>a-b);
  assert(betaDepths.includes(100), 'beta ran stage1');
  assert(betaDepths.includes(250), 'beta promoted to stage2');
  assert(!betaDepths.includes(400), 'beta NOT promoted to stage3 (3 shared < 5)');
  // GAMMA: 1 shared hit → stage1 only
  const gammaDepths = gammaFetches.map(c => c.depth).sort((a,b)=>a-b);
  assert(gammaDepths.includes(100), 'gamma ran stage1');
  assert(!gammaDepths.includes(250), 'gamma NOT promoted to stage2 (1 shared < 2)');
  assert(!gammaDepths.includes(400), 'gamma never reaches stage3');

  console.log('\nTest 6: saveMatchParticipants called per stage with seed as sourceXuid');
  const alphaSaves = saveCalls.filter(c => c.sourceXuid === ALPHA);
  const betaSaves  = saveCalls.filter(c => c.sourceXuid === BETA);
  const gammaSaves = saveCalls.filter(c => c.sourceXuid === GAMMA);
  assert(alphaSaves.length === 3, `alpha persisted 3 times (got ${alphaSaves.length})`);
  assert(betaSaves.length === 2,  `beta persisted 2 times (got ${betaSaves.length})`);
  assert(gammaSaves.length === 1, `gamma persisted once (got ${gammaSaves.length})`);

  console.log('\nTest 7: cooldown blocks subsequent runs');
  // Even though coverage is still low (the mock save grew countMatches but
  // typically still under threshold), the per-target cooldown should apply.
  meta = recoveryQueue.maybeQueueRecovery({ xuid: TARGET, gamertag: 'Target', knownCount: 5, deps });
  assert(meta.recoveryQueued === false, 'queued=false during cooldown window');
  assert(meta.recoveryStatus === 'recent_run', `status=recent_run (got ${meta.recoveryStatus})`);
  assert(meta.cooldownHours === 1, 'cooldownHours exposed for UI');

  console.log('\nTest 8: getStatus reflects cooldown state');
  const st = recoveryQueue.getStatus(TARGET);
  assert(st.state === 'cooldown', `state=cooldown after run (got ${st.state})`);
  assert(st.summary && st.summary.seedsRun === 3, `summary records seedsRun=3 (got ${st.summary && st.summary.seedsRun})`);
  assert(st.summary.seedsPromotedStage2 === 2, 'summary.seedsPromotedStage2=2 (alpha + beta)');
  assert(st.summary.seedsPromotedStage3 === 1, 'summary.seedsPromotedStage3=1 (alpha only)');

  console.log('\nTest 9: getRecentRuns returns the completed run');
  const recent = recoveryQueue.getRecentRuns(5);
  assert(recent.length === 1, 'recent runs ring buffer has 1 entry');
  assert(recent[0].xuid === TARGET, 'recent run is for target xuid');
  assert(recent[0].coverageAfter >= recent[0].coverageBefore, 'coverageAfter >= coverageBefore');

  console.log('\nDone.');
})().catch(e => {
  console.error('Test crashed:', e);
  process.exit(1);
});
