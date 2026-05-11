#!/usr/bin/env node
// Fallback rehydration: if the Redis backfill came up empty (cached blobs
// don't contain team rosters) we can rebuild participant rows by re-fetching
// match history for each player we already know about via xuid_cache.
// This DOES make live Halo API calls, so it is strictly opt-in, throttled,
// and bounded by --limit.
//
// Order of operations the user should follow:
//   1) node scripts/backfill-match-participants.js --dry-run   (free, fast)
//   2) node scripts/backfill-match-participants.js             (free, fast)
//   3) If (2) reported matchesEligible=0 or coverage is too thin, fall back
//      to this script with a small --limit to validate before running wider.
//
// Usage:
//   node scripts/rehydrate-match-participants.js --dry-run
//   node scripts/rehydrate-match-participants.js --limit 25
//   node scripts/rehydrate-match-participants.js --limit 200 --throttle-ms 2500
//
// Safety:
//   - --dry-run never calls Halo or writes to Postgres.
//   - Live mode requires --i-understand-this-calls-halo for any --limit > 50,
//     to make it impossible to accidentally run an unbounded API sweep.
//   - Throttle defaults to 2500ms between fetches (same cadence the live
//     SnapQueue uses).
//   - Resumable via --skip-recent: by default skips xuids that already have
//     participant rows recorded in the last 7 days.

try { require('dotenv').config(); } catch {} // optional — Render injects env directly
const path = require('path');
const db = require(path.join(__dirname, '..', 'src', 'db.js'));

function parseArgs(argv) {
  const args = {
    dryRun: false,
    limit: 25,                       // very small default — this hits the live API
    throttleMs: 2500,
    skipRecentDays: 7,
    confirm: false,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--limit') args.limit = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (a === '--throttle-ms') args.throttleMs = Math.max(250, parseInt(argv[++i], 10) || 2500);
    else if (a === '--skip-recent-days') args.skipRecentDays = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (a === '--i-understand-this-calls-halo') args.confirm = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error('Unknown argument:', a); printHelp(); process.exit(2); }
  }
  return args;
}

function printHelp() {
  console.log(`Rehydrate match_participants by re-fetching match history from the Halo API.

THIS SCRIPT MAKES LIVE API CALLS. Use only when the Redis-only backfill cannot
produce enough coverage. Always start with --dry-run.

Options:
  --dry-run, -n                       Plan only; no Halo calls, no DB writes.
  --limit N                           Max xuids to rehydrate (default 25).
  --throttle-ms MS                    Delay between fetches (default 2500).
  --skip-recent-days N                Skip xuids with recent participant rows (default 7).
  --i-understand-this-calls-halo      Required for --limit > 50 in live mode.
  --verbose, -v                       Log per-player counts.
  --help, -h                          Print this help.

Environment:
  SPARTAN_TOKEN, MS_REFRESH_TOKEN     Same as the running server.
  REDIS_URL, DATABASE_URL             Same as the running server.
`);
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.dryRun && args.limit > 50 && !args.confirm) {
    console.error('Refusing to run with --limit > 50 in live mode without --i-understand-this-calls-halo.');
    process.exit(2);
  }

  if (!args.dryRun && !process.env.SPARTAN_TOKEN) {
    console.error('SPARTAN_TOKEN is not set. Halo API calls will fail. Aborting.');
    process.exit(2);
  }

  console.log('[Rehydrate] starting', JSON.stringify({
    dryRun: args.dryRun, limit: args.limit, throttleMs: args.throttleMs,
    skipRecentDays: args.skipRecentDays,
  }));

  const pool = await db.getDb();
  if (!pool) {
    console.error('No DATABASE_URL — cannot identify candidate xuids. Aborting.');
    process.exit(2);
  }

  // Candidate set: every xuid we've ever resolved a gamertag for, that doesn't
  // already have recent participant rows. Order by xuid_cache.ts DESC so the
  // freshest players go first — same heuristic the live SnapQueue follows.
  const skipDays = args.skipRecentDays;
  const candRes = await pool.query(`
    SELECT x.xuid, x.gamertag
    FROM xuid_cache x
    WHERE x.gamertag NOT LIKE 'Spartan %'
      AND NOT EXISTS (
        SELECT 1 FROM match_participants mp
        WHERE mp.xuid = x.xuid AND mp.ts > NOW() - ($1::int || ' days')::interval
      )
    ORDER BY x.ts DESC
    LIMIT $2
  `, [skipDays, args.limit]);

  const candidates = candRes.rows;
  console.log(`[Rehydrate] ${candidates.length} candidate xuids (limit ${args.limit}, skip-recent ${skipDays}d)`);

  if (args.dryRun) {
    for (const c of candidates.slice(0, args.verbose ? candidates.length : 10)) {
      console.log(`[Rehydrate] dry-run would fetch ${c.gamertag} (${c.xuid})`);
    }
    if (!args.verbose && candidates.length > 10) {
      console.log(`[Rehydrate] (… ${candidates.length - 10} more not shown — re-run with --verbose to list all)`);
    }
    console.log('[Rehydrate] dry-run complete — no Halo calls, no writes.');
    try { if (pool.end) await pool.end(); } catch {}
    return;
  }

  // Lazy-require halo.js so dry-run works without auth env vars.
  const halo = require(path.join(__dirname, '..', 'src', 'halo.js'));

  const counters = { attempted: 0, fetched: 0, rowsWritten: 0, errors: 0 };
  const startMs = Date.now();
  for (const c of candidates) {
    counters.attempted++;
    try {
      const matches = await halo.fetchMatchHistory(c.xuid, c.gamertag, 25);
      if (!matches || !matches.length) {
        if (args.verbose) console.log(`[Rehydrate] ${c.gamertag} returned no matches (private or empty)`);
      } else {
        counters.fetched++;
        const written = await db.saveMatchParticipants(matches, c.xuid);
        counters.rowsWritten += (written || 0);
        if (args.verbose) console.log(`[Rehydrate] ${c.gamertag}: ${matches.length} matches → ${written} participant rows`);
      }
    } catch (e) {
      counters.errors++;
      console.warn(`[Rehydrate] ${c.gamertag} failed: ${e.message}`);
    }
    if (counters.attempted < candidates.length) {
      await new Promise(r => setTimeout(r, args.throttleMs));
    }
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log('[Rehydrate] complete', JSON.stringify({ ...counters, elapsedSeconds: Number(elapsed) }));
  try { if (pool.end) await pool.end(); } catch {}
}

main().catch(err => {
  console.error('[Rehydrate] FATAL:', err && err.stack || err);
  process.exit(1);
});
