#!/usr/bin/env node
// Backfill match_participants from cached player payloads.
//
// The /api/search Redis cache stores each searched player as
// `player:<lower-gamertag>` → JSON { xuid, gamertag, allMatches:[...], ... }
// where each match in allMatches already carries the full team rosters
// (teams[].players[] with rawXuid, kills/deaths/assists, score, damage).
// That is exactly the shape saveMatchParticipants() consumes when the live
// search code persists rows, so we can reuse it here to populate the new
// participant table from historical cached blobs alone — no new Halo API
// calls, no new auth required.
//
// Safety properties:
//   - Read-only on Redis (we only GET; never DEL/SET).
//   - Idempotent: match_participants has PRIMARY KEY (match_id, xuid) and the
//     existing INSERT … ON CONFLICT DO UPDATE never blows away non-null fields
//     with nulls, so running this twice is identical to running it once.
//   - Resumable: progress is tracked by Redis cursor (SCAN), so a crashed run
//     simply restarts SCAN from cursor 0 — and rows that were already written
//     no-op on the next pass.
//   - Dry-run: --dry-run scans, parses, and counts but never opens a DB write
//     transaction.
//   - Batched: --batch-size controls how many Redis keys are inspected before
//     a progress line; matches are flushed to Postgres per-player (a single
//     player's allMatches → one INSERT statement per match via existing
//     helper). Postgres write fan-out is bounded by the helper's own
//     per-match batching.
//   - Bounded: --limit caps total players processed (useful for canary runs).
//   - Secret-safe: nothing from process.env is logged. Connection strings are
//     read from DATABASE_URL / REDIS_URL the same way the server reads them.
//
// Usage:
//   node scripts/backfill-match-participants.js --dry-run
//   node scripts/backfill-match-participants.js --limit 50
//   node scripts/backfill-match-participants.js --batch-size 200
//   node scripts/backfill-match-participants.js --key-pattern 'player:*'
//   npm run backfill:participants -- --dry-run
//
// Exit codes: 0 success, 1 fatal error, 2 misconfiguration (no REDIS_URL).

try { require('dotenv').config(); } catch {} // optional — Render injects env directly
const path = require('path');
const db = require(path.join(__dirname, '..', 'src', 'db.js'));

function parseArgs(argv) {
  const args = {
    dryRun: false,
    limit: Infinity,
    batchSize: 100,
    keyPattern: 'player:*',
    scanCount: 200,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10) || Infinity;
    else if (a === '--batch-size') args.batchSize = Math.max(1, parseInt(argv[++i], 10) || 100);
    else if (a === '--key-pattern') args.keyPattern = String(argv[++i] || 'player:*');
    else if (a === '--scan-count') args.scanCount = Math.max(10, parseInt(argv[++i], 10) || 200);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error('Unknown argument:', a); printHelp(); process.exit(2); }
  }
  return args;
}

function printHelp() {
  console.log(`Backfill match_participants from cached player blobs in Redis.

Options:
  --dry-run, -n          Parse everything but don't write to Postgres.
  --limit N              Stop after processing N players.
  --batch-size N         Players per progress line (default 100).
  --key-pattern P        Redis SCAN match pattern (default 'player:*').
  --scan-count N         Redis SCAN COUNT hint (default 200).
  --verbose, -v          Log per-player counts.
  --help, -h             Print this help.

Environment:
  REDIS_URL              Required.
  DATABASE_URL           Required unless --dry-run.
`);
}

// We connect to Redis directly so we can SCAN without going through the
// server.js cache wrappers (which only expose GET-by-key). Same module the
// halo.js helper uses — keeps the connection options consistent.
async function connectRedis() {
  if (!process.env.REDIS_URL) {
    console.error('REDIS_URL is not set. Cached match data lives in Redis; aborting.');
    process.exit(2);
  }
  const { createClient } = require('redis');
  const url = process.env.REDIS_URL;
  const isTLS = url.startsWith('rediss://');
  const client = createClient({
    url,
    socket: {
      tls: isTLS,
      rejectUnauthorized: false,
      // Don't retry forever; the script should fail fast if Redis is down.
      reconnectStrategy: retries => (retries >= 3 ? new Error('Redis unreachable') : retries * 500),
    },
  });
  client.on('error', err => console.warn('[Redis] error:', err.message));
  await client.connect();
  return client;
}

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
    // Need at least one team with at least one player carrying a rawXuid.
    let usable = false;
    for (const t of m.teams) {
      if (!t || !Array.isArray(t.players)) continue;
      if (t.players.some(p => p && p.rawXuid)) { usable = true; break; }
    }
    if (usable) out.push(m);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log('[Backfill] starting', JSON.stringify({
    dryRun: args.dryRun,
    limit: args.limit === Infinity ? 'none' : args.limit,
    batchSize: args.batchSize,
    keyPattern: args.keyPattern,
  }));

  if (!args.dryRun && !process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Use --dry-run to test without a DB, or configure DATABASE_URL.');
    process.exit(2);
  }

  const redis = await connectRedis();
  // Eagerly initialize the Postgres pool so we fail fast on bad creds before
  // we start scanning Redis. In dry-run we skip this so the script works with
  // only REDIS_URL.
  if (!args.dryRun) {
    const pool = await db.getDb();
    if (!pool) {
      console.error('Could not open Postgres pool. Aborting.');
      await redis.disconnect();
      process.exit(2);
    }
  }

  const counters = {
    keysScanned: 0,
    playersParsed: 0,
    playersSkippedNoXuid: 0,
    playersSkippedMalformed: 0,
    matchesFound: 0,
    matchesEligible: 0,
    rowsWrittenReported: 0,   // sum of saveMatchParticipants() return values
    errors: 0,
  };
  const startMs = Date.now();
  let stopped = false;
  let lastLogAt = 0;

  // Redis SCAN with cursor — handles MILLIONs of keys safely and is resumable
  // in the trivial sense (each invocation starts from cursor 0; rows already
  // backfilled no-op via ON CONFLICT). MATCH filters server-side.
  const iter = redis.scanIterator({ MATCH: args.keyPattern, COUNT: args.scanCount });

  try {
    for await (const keyOrKeys of iter) {
      if (stopped) break;
      // node-redis v4 yields a single key per iteration, but some builds
      // yield an array per SCAN page — handle both for forward compatibility.
      const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];

      for (const key of keys) {
        counters.keysScanned++;

        let raw;
        try {
          raw = await redis.get(key);
        } catch (e) {
          counters.errors++;
          console.warn(`[Backfill] GET ${redactKey(key)} failed: ${e.message}`);
          continue;
        }
        const payload = safeParse(raw);
        if (!payload) {
          counters.playersSkippedMalformed++;
          if (args.verbose) console.warn(`[Backfill] malformed JSON at ${redactKey(key)}`);
          continue;
        }
        // Source xuid for provenance — without it saveMatchParticipants still
        // writes rows (source_xuid is nullable) but the audit trail is worse.
        const sourceXuid = payload.xuid ? String(payload.xuid) : null;
        if (!sourceXuid) {
          counters.playersSkippedNoXuid++;
          continue;
        }

        const matches = extractMatches(payload);
        counters.playersParsed++;
        counters.matchesFound += Array.isArray(payload.allMatches || payload.recentMatches)
          ? (payload.allMatches || payload.recentMatches).length : 0;
        counters.matchesEligible += matches.length;

        if (!matches.length) {
          if (args.verbose) console.log(`[Backfill] ${redactKey(key)} no usable matches`);
        } else if (args.dryRun) {
          if (args.verbose) console.log(`[Backfill] dry-run ${redactKey(key)} would write rows for ${matches.length} matches`);
        } else {
          try {
            const written = await db.saveMatchParticipants(matches, sourceXuid);
            counters.rowsWrittenReported += (written || 0);
            if (args.verbose) console.log(`[Backfill] ${redactKey(key)} wrote ${written} rows (${matches.length} matches)`);
          } catch (e) {
            counters.errors++;
            console.warn(`[Backfill] saveMatchParticipants failed for ${redactKey(key)}: ${e.message}`);
          }
        }

        if (counters.playersParsed >= args.limit) {
          console.log(`[Backfill] hit --limit ${args.limit}, stopping early.`);
          stopped = true;
          break;
        }

        if (counters.playersParsed - lastLogAt >= args.batchSize) {
          lastLogAt = counters.playersParsed;
          const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
          console.log(`[Backfill] progress: ${counters.playersParsed} players · ${counters.matchesEligible} usable matches · ${counters.rowsWrittenReported} rows · ${elapsed}s`);
        }
      }
    }
  } finally {
    try { await redis.disconnect(); } catch {}
    // Close the pool if we opened one.
    try {
      const pool = !args.dryRun ? await db.getDb() : null;
      if (pool && typeof pool.end === 'function') await pool.end();
    } catch {}
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log('[Backfill] complete', JSON.stringify({ ...counters, elapsedSeconds: Number(elapsed), dryRun: args.dryRun }));

  // If nothing eligible was found, surface that clearly — covers the case
  // where old cached blobs predate the team-roster shape and only contain
  // top-level match summaries. Caller can then decide on the rehydration
  // fallback (see README "Fallback: rehydrate via public histories").
  if (counters.playersParsed > 0 && counters.matchesEligible === 0) {
    console.warn('[Backfill] WARNING: cached blobs contained no team-roster match data. '
      + 'See README "Fallback: rehydrate via public histories" for next steps.');
  }
}

// Avoid leaking gamertags into logs at scale — show only a stable prefix.
function redactKey(k) {
  if (typeof k !== 'string') return String(k);
  if (k.length <= 20) return k;
  return k.slice(0, 12) + '…' + k.slice(-4);
}

main().catch(err => {
  console.error('[Backfill] FATAL:', err && err.stack || err);
  process.exit(1);
});
