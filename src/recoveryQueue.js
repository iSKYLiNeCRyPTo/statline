// Active match-history recovery for private/reconstructed players.
//
// When a player's official /matches endpoint is private, we serve a
// "reconstructed" history assembled from rows other public players have
// dropped into the match_participants table. Coverage there grows only as a
// side effect of unrelated searches, so it can stay near-zero indefinitely.
//
// This module fixes that by *actively* fetching the match histories of the
// target's most likely teammates. Each teammate fetch persists ALL roster
// rows (saveMatchParticipants), which includes the target xuid whenever the
// teammate played WITH the target — exactly the rows the reconstruction path
// queries on the next search.
//
// Design notes:
//   • Non-blocking. /api/search returns immediately with whatever rows are
//     already in the DB; this runs in the background and the next search
//     surfaces the freshly-recovered matches.
//   • Staged depth. First pass is shallow (100). Only seeds that produce a
//     non-trivial number of shared hits with the target are escalated to a
//     deeper (250, then 400) pass. This concentrates rate-limit budget on
//     friends-list teammates rather than spraying it across one-off pubstompers.
//   • Hard caps + cooldowns prevent runaway scans. Per-target re-runs are
//     gated by RECOVERY_PER_TARGET_COOLDOWN_HOURS. Per seed, the standard
//     SNAPSHOT_RECENT_TTL / no-new-data cooldown gates (PR #6/#14) still
//     apply for the snapshot pipeline that consumes these matches downstream.
//   • Pure background work — no caller awaits this. Failures are logged and
//     dropped, never thrown to the request path.

const DEFAULT = {
  // Trigger recovery only when reconstructed coverage is below this match count.
  LOW_COVERAGE_THRESHOLD: 40,
  // Cap on how many seeds we process per recovery run for a single target.
  MAX_SEEDS_PER_RUN: 5,
  // Number of co-player candidates we ask the DB for. We then pick the top
  // MAX_SEEDS_PER_RUN after de-duping against freshness gates.
  CANDIDATE_POOL_SIZE: 15,
  // Depth tiers (Halo /matches scan caps). Stage 1 runs for every seed;
  // stages 2+3 unlock only for seeds that produce shared hits with target.
  STAGE1_DEPTH: 100,
  STAGE2_DEPTH: 250,
  STAGE3_DEPTH: 400,
  // Shared-hit thresholds that promote a seed to the next stage.
  STAGE2_SHARED_THRESHOLD: 2,
  STAGE3_SHARED_THRESHOLD: 5,
  // Don't re-run recovery for the same xuid within this window.
  PER_TARGET_COOLDOWN_HOURS: 12,
  // Hard cap on total matches fetched per run across all seeds (safety net).
  HARD_CAP_MATCHES_PER_RUN: 1500,
  // Throttle between Halo match-detail fetches (handled by fetchMatchHistory
  // batching, but we additionally pause between seeds).
  INTER_SEED_DELAY_MS: 1500,
};

function _envInt(name, fallback) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const CFG = {
  LOW_COVERAGE_THRESHOLD:   _envInt('RECOVERY_LOW_COVERAGE_THRESHOLD',   DEFAULT.LOW_COVERAGE_THRESHOLD),
  MAX_SEEDS_PER_RUN:        _envInt('RECOVERY_MAX_SEEDS_PER_RUN',        DEFAULT.MAX_SEEDS_PER_RUN),
  CANDIDATE_POOL_SIZE:      _envInt('RECOVERY_CANDIDATE_POOL_SIZE',      DEFAULT.CANDIDATE_POOL_SIZE),
  STAGE1_DEPTH:             _envInt('RECOVERY_STAGE1_DEPTH',             DEFAULT.STAGE1_DEPTH),
  STAGE2_DEPTH:             _envInt('RECOVERY_STAGE2_DEPTH',             DEFAULT.STAGE2_DEPTH),
  STAGE3_DEPTH:             _envInt('RECOVERY_STAGE3_DEPTH',             DEFAULT.STAGE3_DEPTH),
  STAGE2_SHARED_THRESHOLD:  _envInt('RECOVERY_STAGE2_SHARED_THRESHOLD',  DEFAULT.STAGE2_SHARED_THRESHOLD),
  STAGE3_SHARED_THRESHOLD:  _envInt('RECOVERY_STAGE3_SHARED_THRESHOLD',  DEFAULT.STAGE3_SHARED_THRESHOLD),
  PER_TARGET_COOLDOWN_HOURS:_envInt('RECOVERY_PER_TARGET_COOLDOWN_HOURS',DEFAULT.PER_TARGET_COOLDOWN_HOURS),
  HARD_CAP_MATCHES_PER_RUN: _envInt('RECOVERY_HARD_CAP_MATCHES_PER_RUN', DEFAULT.HARD_CAP_MATCHES_PER_RUN),
  INTER_SEED_DELAY_MS:      _envInt('RECOVERY_INTER_SEED_DELAY_MS',      DEFAULT.INTER_SEED_DELAY_MS),
};

// In-memory state. Survives only as long as the process; that's fine — these
// are advisory cooldowns, not correctness-critical.
const _running = new Map();   // xuid -> { startedAt, stage, seedIndex, seeds, … }
const _lastRun = new Map();   // xuid -> { finishedAt, summary }
const _statusLog = [];        // ring buffer of recent runs for /api/admin/recovery-status

function _now() { return Date.now(); }
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _logRun(entry) {
  _statusLog.push(entry);
  if (_statusLog.length > 50) _statusLog.shift();
}

// Returns true when xuid is currently being recovered or finished within the
// per-target cooldown window.
function _isOnCooldown(xuid) {
  const last = _lastRun.get(String(xuid));
  if (!last) return false;
  const ageMs = _now() - last.finishedAt;
  return ageMs < CFG.PER_TARGET_COOLDOWN_HOURS * 3600 * 1000;
}

function getStatus(xuid) {
  const key = String(xuid);
  if (_running.has(key)) {
    const s = _running.get(key);
    return {
      state: 'running',
      stage: s.stage,
      seedIndex: s.seedIndex,
      seedCount: s.seeds ? s.seeds.length : 0,
      startedAt: new Date(s.startedAt).toISOString(),
      matchesFetched: s.matchesFetched || 0,
      sharedHitsAdded: s.sharedHitsAdded || 0,
    };
  }
  const last = _lastRun.get(key);
  if (last) {
    return {
      state: _isOnCooldown(key) ? 'cooldown' : 'idle',
      finishedAt: new Date(last.finishedAt).toISOString(),
      summary: last.summary,
      cooldownHours: CFG.PER_TARGET_COOLDOWN_HOURS,
    };
  }
  return { state: 'idle' };
}

function getRecentRuns(limit = 25) {
  return _statusLog.slice(-limit).reverse();
}

function getConfig() { return { ...CFG }; }

// Decide whether to kick off recovery. Returns a metadata object that the
// caller can attach to the search response so the UI knows what happened.
//
//   deps = {
//     fetchMatchHistory,          // halo.js
//     saveMatchParticipants,      // db.js
//     getRecoverySeeds,           // db.js
//     countMatchesForXuid,        // db.js
//     getRefreshMeta,             // db.js — for seed freshness checks
//     isRecentlyRefreshed,        // server.js predicate (24h TTL)
//     isInNoNewDataCooldown,      // server.js predicate (14d cooldown)
//   }
function maybeQueueRecovery({ xuid, gamertag, knownCount, deps }) {
  const key = String(xuid || '');
  if (!key) return { recoveryQueued: false, recoveryStatus: 'no_xuid' };

  if (knownCount >= CFG.LOW_COVERAGE_THRESHOLD) {
    return { recoveryQueued: false, recoveryStatus: 'sufficient_coverage', knownCount, threshold: CFG.LOW_COVERAGE_THRESHOLD };
  }
  if (_running.has(key)) {
    const s = _running.get(key);
    return {
      recoveryQueued: true,
      recoveryStatus: 'in_progress',
      recoverySeeds: s.seeds ? s.seeds.length : 0,
      recoveryDepth: s.stage,
      knownCount,
    };
  }
  if (_isOnCooldown(key)) {
    const last = _lastRun.get(key);
    return {
      recoveryQueued: false,
      recoveryStatus: 'recent_run',
      lastRun: last ? new Date(last.finishedAt).toISOString() : null,
      cooldownHours: CFG.PER_TARGET_COOLDOWN_HOURS,
      knownCount,
    };
  }

  // Kick off async — DO NOT await. Caller's request returns immediately.
  _run({ xuid: key, gamertag, deps }).catch(e => {
    console.warn('[Recovery] run crashed:', e && e.message);
  });

  return {
    recoveryQueued: true,
    recoveryStatus: 'queued',
    recoveryDepth: CFG.STAGE1_DEPTH,
    knownCount,
    threshold: CFG.LOW_COVERAGE_THRESHOLD,
  };
}

// Internal: actually run the recovery. Fire-and-forget; never re-thrown.
async function _run({ xuid, gamertag, deps }) {
  const key = String(xuid);
  const startedAt = _now();
  const state = {
    startedAt,
    stage: CFG.STAGE1_DEPTH,
    seedIndex: 0,
    seeds: [],
    matchesFetched: 0,
    sharedHitsAdded: 0,
  };
  _running.set(key, state);

  const summary = {
    xuid: key,
    gamertag: gamertag || null,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    durationMs: 0,
    coverageBefore: 0,
    coverageAfter: 0,
    seedsConsidered: 0,
    seedsRun: 0,
    seedsPromotedStage2: 0,
    seedsPromotedStage3: 0,
    matchesFetched: 0,
    matchesPersisted: 0,
    sharedHitsAdded: 0,
    skipped: { recentRefresh: 0, cooldown: 0, anonymous: 0 },
    perSeed: [],
    abortReason: null,
  };

  try {
    summary.coverageBefore = await deps.countMatchesForXuid(key);

    const candidates = await deps.getRecoverySeeds(key, CFG.CANDIDATE_POOL_SIZE);
    summary.seedsConsidered = candidates.length;
    if (!candidates.length) {
      summary.abortReason = 'no_candidates';
      return;
    }

    const refreshMeta = await deps.getRefreshMeta(candidates.map(c => String(c.xuid))).catch(() => new Map());

    const toRun = [];
    for (const c of candidates) {
      const xu = String(c.xuid);
      const gt = c.gamertag || '';
      if (!gt || /^Spartan\s/i.test(gt)) { summary.skipped.anonymous++; continue; }
      const meta = refreshMeta.get(xu);
      if (deps.isRecentlyRefreshed && deps.isRecentlyRefreshed(meta)) { summary.skipped.recentRefresh++; continue; }
      if (deps.isInNoNewDataCooldown && deps.isInNoNewDataCooldown(meta)) { summary.skipped.cooldown++; continue; }
      toRun.push({ xuid: xu, gamertag: gt, sharedTeam: c.shared_team || 0, totalShared: c.total_shared || 0 });
      if (toRun.length >= CFG.MAX_SEEDS_PER_RUN) break;
    }
    state.seeds = toRun;
    if (!toRun.length) {
      summary.abortReason = 'all_candidates_gated';
      return;
    }

    console.log(`[Recovery] ${gamertag || key} (${key}) — starting: coverage=${summary.coverageBefore}, ${toRun.length} seeds (${summary.seedsConsidered} considered)`);

    let totalFetchedMatches = 0;

    for (let i = 0; i < toRun.length; i++) {
      if (totalFetchedMatches >= CFG.HARD_CAP_MATCHES_PER_RUN) {
        summary.abortReason = 'hard_cap';
        break;
      }
      const seed = toRun[i];
      state.seedIndex = i;
      const perSeed = {
        xuid: seed.xuid,
        gamertag: seed.gamertag,
        sharedTeam: seed.sharedTeam,
        totalShared: seed.totalShared,
        stagesRun: [],
        sharedHitsByStage: {},
        matchesFetched: 0,
      };

      const stages = [
        { depth: CFG.STAGE1_DEPTH, label: 'stage1' },
      ];

      let promoteToStage2 = false;
      let promoteToStage3 = false;
      try {
        // Stage 1
        const s1 = await _runStage({ seed, depth: CFG.STAGE1_DEPTH, targetXuid: key, deps });
        perSeed.stagesRun.push('stage1');
        perSeed.sharedHitsByStage.stage1 = s1.sharedHits;
        perSeed.matchesFetched += s1.matchesFetched;
        state.matchesFetched += s1.matchesFetched;
        state.sharedHitsAdded += s1.sharedHits;
        summary.matchesFetched += s1.matchesFetched;
        summary.matchesPersisted += s1.matchesPersisted;
        summary.sharedHitsAdded += s1.sharedHits;
        totalFetchedMatches += s1.matchesFetched;

        promoteToStage2 = s1.sharedHits >= CFG.STAGE2_SHARED_THRESHOLD;

        if (promoteToStage2 && totalFetchedMatches < CFG.HARD_CAP_MATCHES_PER_RUN) {
          state.stage = CFG.STAGE2_DEPTH;
          summary.seedsPromotedStage2++;
          const s2 = await _runStage({ seed, depth: CFG.STAGE2_DEPTH, targetXuid: key, deps });
          perSeed.stagesRun.push('stage2');
          perSeed.sharedHitsByStage.stage2 = s2.sharedHits;
          perSeed.matchesFetched += s2.matchesFetched;
          state.matchesFetched += s2.matchesFetched;
          state.sharedHitsAdded += s2.sharedHits;
          summary.matchesFetched += s2.matchesFetched;
          summary.matchesPersisted += s2.matchesPersisted;
          summary.sharedHitsAdded += s2.sharedHits;
          totalFetchedMatches += s2.matchesFetched;

          promoteToStage3 = s2.sharedHits >= CFG.STAGE3_SHARED_THRESHOLD;

          if (promoteToStage3 && totalFetchedMatches < CFG.HARD_CAP_MATCHES_PER_RUN) {
            state.stage = CFG.STAGE3_DEPTH;
            summary.seedsPromotedStage3++;
            const s3 = await _runStage({ seed, depth: CFG.STAGE3_DEPTH, targetXuid: key, deps });
            perSeed.stagesRun.push('stage3');
            perSeed.sharedHitsByStage.stage3 = s3.sharedHits;
            perSeed.matchesFetched += s3.matchesFetched;
            state.matchesFetched += s3.matchesFetched;
            state.sharedHitsAdded += s3.sharedHits;
            summary.matchesFetched += s3.matchesFetched;
            summary.matchesPersisted += s3.matchesPersisted;
            summary.sharedHitsAdded += s3.sharedHits;
            totalFetchedMatches += s3.matchesFetched;
          }
        }
      } catch(e) {
        console.warn(`[Recovery] seed ${seed.gamertag} (${seed.xuid}) failed:`, e && e.message);
        perSeed.error = e && e.message;
      }

      summary.seedsRun++;
      summary.perSeed.push(perSeed);

      if (i < toRun.length - 1) await _sleep(CFG.INTER_SEED_DELAY_MS);
      // Reset to stage 1 for the next seed.
      state.stage = CFG.STAGE1_DEPTH;
    }

    summary.coverageAfter = await deps.countMatchesForXuid(key);
    if (!summary.abortReason) summary.abortReason = null;
  } catch(e) {
    console.warn('[Recovery] fatal:', e && e.message);
    summary.abortReason = 'fatal: ' + (e && e.message);
  } finally {
    const finishedAt = _now();
    summary.finishedAt = new Date(finishedAt).toISOString();
    summary.durationMs = finishedAt - startedAt;
    _running.delete(key);
    _lastRun.set(key, { finishedAt, summary });
    _logRun(summary);
    const gain = summary.coverageAfter - summary.coverageBefore;
    console.log(`[Recovery] ${gamertag || key} (${key}) — done: coverage ${summary.coverageBefore}→${summary.coverageAfter} (+${gain}), ${summary.matchesFetched} matches across ${summary.seedsRun} seeds, took ${summary.durationMs}ms${summary.abortReason ? ` (abort=${summary.abortReason})` : ''}`);
  }
}

// Run one depth tier for one seed. Fetches the seed's match history up to
// `depth`, persists rows via saveMatchParticipants, and counts how many of
// those matches contained the target xuid as a participant.
async function _runStage({ seed, depth, targetXuid, deps }) {
  const result = { matchesFetched: 0, matchesPersisted: 0, sharedHits: 0 };
  let hist;
  try {
    hist = await deps.fetchMatchHistory(seed.xuid, seed.gamertag, depth, null, null);
  } catch(e) {
    throw new Error(`fetchMatchHistory failed at depth=${depth}: ${e.message}`);
  }
  const matches = (hist && hist.matches) || [];
  result.matchesFetched = matches.length;

  // Count shared matches with target BEFORE persisting so the metric reflects
  // what this seed actually contributed.
  for (const m of matches) {
    if (!m || !m.teams) continue;
    let hit = false;
    for (const team of m.teams) {
      for (const pl of (team.players || [])) {
        if (String(pl.rawXuid || '') === String(targetXuid)) { hit = true; break; }
      }
      if (hit) break;
    }
    if (hit) result.sharedHits++;
  }

  if (matches.length) {
    try {
      const written = await deps.saveMatchParticipants(matches, seed.xuid);
      result.matchesPersisted = written || 0;
    } catch(e) {
      console.warn(`[Recovery] saveMatchParticipants failed for seed ${seed.xuid}:`, e.message);
    }
  }

  console.log(`[Recovery]   seed=${seed.gamertag} depth=${depth} → ${matches.length} matches, ${result.sharedHits} shared with target`);
  return result;
}

module.exports = {
  maybeQueueRecovery,
  getStatus,
  getRecentRuns,
  getConfig,
  // Exposed for tests:
  _internal: { CFG, _running, _lastRun, _statusLog, _run, _runStage },
};
