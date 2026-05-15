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
const { runBackfill } = require(path.join(__dirname, '..', 'src', 'backfillParticipants.js'));

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
      reconnectStrategy: retries => (retries >= 3 ? new Error('Redis unreachable') : retries * 500),
    },
  });
  client.on('error', err => console.warn('[Redis] error:', err.message));
  await client.connect();
  return client;
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
  if (!args.dryRun) {
    const pool = await db.getDb();
    if (!pool) {
      console.error('Could not open Postgres pool. Aborting.');
      await redis.disconnect();
      process.exit(2);
    }
  }

  let result;
  try {
    result = await runBackfill({
      redis,
      saveMatchParticipants: db.saveMatchParticipants,
      options: {
        dryRun: args.dryRun,
        limit: args.limit,
        batchSize: args.batchSize,
        keyPattern: args.keyPattern,
        scanCount: args.scanCount,
        verbose: args.verbose,
      },
      logger: console,
    });
  } finally {
    try { await redis.disconnect(); } catch {}
    try {
      const pool = !args.dryRun ? await db.getDb() : null;
      if (pool && typeof pool.end === 'function') await pool.end();
    } catch {}
  }

  console.log('[Backfill] complete', JSON.stringify(result));
}

main().catch(err => {
  console.error('[Backfill] FATAL:', err && err.stack || err);
  process.exit(1);
});
