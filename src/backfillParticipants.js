// Shared backfill logic for match_participants from cached player blobs.
//
// Used by both:
//   - scripts/backfill-match-participants.js (CLI, owns its own redis+pg conns)
//   - server.js POST /api/admin/backfill-participants (reuses server pools)
//
// The runner is intentionally I/O-injected: callers pass in a connected Redis
// client and a `saveMatchParticipants(matches, sourceXuid)` function. That
// keeps it trivially testable with stubs and avoids duplicate connection
// logic.

function safeParse(raw) {
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Extract a list of cached match objects from a player payload. Tolerates both
// shapes the server has used over time (allMatches preferred, recentMatches
// fallback) and skips anything that doesn't look like a real match row.
function extractMatches(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const src = Array.isArray(payload.allMatches)    ? payload.allMatches
            : Array.isArray(payload.recentMatches) ? payload.recentMatches
            : [];
  const out = [];
  for (const m of src) {
    if (!m || !m.matchId || !Array.isArray(m.teams)) continue;
    let usable = false;
    for (const t of m.teams) {
      if (!t || !Array.isArray(t.players)) continue;
      if (t.players.some(p => p && p.rawXuid)) { usable = true; break; }
    }
    if (usable) out.push(m);
  }
  return out;
}

function redactKey(k) {
  if (typeof k !== 'string') return String(k);
  if (k.length <= 20) return k;
  return k.slice(0, 12) + '…' + k.slice(-4);
}

function emptyCounters() {
  return {
    keysScanned: 0,
    playersParsed: 0,
    playersSkippedNoXuid: 0,
    playersSkippedMalformed: 0,
    matchesFound: 0,
    matchesEligible: 0,
    rowsWrittenReported: 0,
    errors: 0,
  };
}

// runBackfill({ redis, saveMatchParticipants, options, logger, onProgress })
//
//   redis                   — already-connected node-redis v4 client (must support .get and .scanIterator).
//   saveMatchParticipants   — async (matches, sourceXuid) → numRowsWritten. In dry-run we never call it.
//   options:
//     dryRun     boolean   default true  — when true, nothing is written.
//     limit      number    default Infinity — stop after N parsed players.
//     batchSize  number    default 100 — progress callback cadence.
//     keyPattern string    default 'player:*'.
//     scanCount  number    default 200 — Redis SCAN COUNT hint.
//     verbose    boolean   default false — log per-player lines.
//   logger                  — { log, warn } pair. Defaults to console.
//   onProgress              — optional (counters) => void, called every batchSize parsed players.
//
// Returns: { ...counters, elapsedSeconds, dryRun }
async function runBackfill({
  redis,
  saveMatchParticipants,
  options = {},
  logger = console,
  onProgress = null,
} = {}) {
  if (!redis) throw new Error('runBackfill: redis client is required');
  const dryRun = options.dryRun !== false; // default true — fail closed
  const limit = Number.isFinite(options.limit) ? options.limit : Infinity;
  const batchSize = Math.max(1, parseInt(options.batchSize, 10) || 100);
  const keyPattern = typeof options.keyPattern === 'string' && options.keyPattern ? options.keyPattern : 'player:*';
  const scanCount = Math.max(10, parseInt(options.scanCount, 10) || 200);
  const verbose = !!options.verbose;

  if (!dryRun && typeof saveMatchParticipants !== 'function') {
    throw new Error('runBackfill: saveMatchParticipants is required when dryRun=false');
  }

  const counters = emptyCounters();
  const startMs = Date.now();
  let stopped = false;
  let lastLogAt = 0;

  const iter = redis.scanIterator({ MATCH: keyPattern, COUNT: scanCount });

  try {
    for await (const keyOrKeys of iter) {
      if (stopped) break;
      const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];

      for (const key of keys) {
        counters.keysScanned++;

        let raw;
        try {
          raw = await redis.get(key);
        } catch (e) {
          counters.errors++;
          logger.warn && logger.warn(`[Backfill] GET ${redactKey(key)} failed: ${e.message}`);
          continue;
        }
        const payload = safeParse(raw);
        if (!payload) {
          counters.playersSkippedMalformed++;
          if (verbose) logger.warn && logger.warn(`[Backfill] malformed JSON at ${redactKey(key)}`);
          continue;
        }
        const sourceXuid = payload.xuid ? String(payload.xuid) : null;
        if (!sourceXuid) {
          counters.playersSkippedNoXuid++;
          continue;
        }

        const matches = extractMatches(payload);
        counters.playersParsed++;
        const totalListLen = Array.isArray(payload.allMatches || payload.recentMatches)
          ? (payload.allMatches || payload.recentMatches).length : 0;
        counters.matchesFound += totalListLen;
        counters.matchesEligible += matches.length;

        if (!matches.length) {
          if (verbose) logger.log && logger.log(`[Backfill] ${redactKey(key)} no usable matches`);
        } else if (dryRun) {
          if (verbose) logger.log && logger.log(`[Backfill] dry-run ${redactKey(key)} would write rows for ${matches.length} matches`);
        } else {
          try {
            const written = await saveMatchParticipants(matches, sourceXuid);
            counters.rowsWrittenReported += (written || 0);
            if (verbose) logger.log && logger.log(`[Backfill] ${redactKey(key)} wrote ${written} rows (${matches.length} matches)`);
          } catch (e) {
            counters.errors++;
            logger.warn && logger.warn(`[Backfill] saveMatchParticipants failed for ${redactKey(key)}: ${e.message}`);
          }
        }

        if (counters.playersParsed >= limit) {
          logger.log && logger.log(`[Backfill] hit limit ${limit}, stopping early.`);
          stopped = true;
          break;
        }

        if (counters.playersParsed - lastLogAt >= batchSize) {
          lastLogAt = counters.playersParsed;
          const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
          logger.log && logger.log(`[Backfill] progress: ${counters.playersParsed} players · ${counters.matchesEligible} usable matches · ${counters.rowsWrittenReported} rows · ${elapsed}s`);
          if (onProgress) {
            try { onProgress({ ...counters, elapsedSeconds: Number(elapsed) }); } catch {}
          }
        }
      }
    }
  } catch (e) {
    counters.errors++;
    logger.warn && logger.warn(`[Backfill] scan failed: ${e.message}`);
  }

  const elapsedSeconds = Number(((Date.now() - startMs) / 1000).toFixed(1));
  const result = { ...counters, elapsedSeconds, dryRun };

  if (counters.playersParsed > 0 && counters.matchesEligible === 0) {
    logger.warn && logger.warn('[Backfill] WARNING: cached blobs contained no team-roster match data. '
      + 'See README "Fallback: rehydrate via public histories" for next steps.');
  }

  return result;
}

module.exports = {
  runBackfill,
  // exported for tests / reuse
  _internals: { safeParse, extractMatches, redactKey, emptyCounters },
};
