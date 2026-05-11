# StatLine — Halo Infinite Stats Tracker

Search any Halo Infinite player's stats including K/D, CSR rank, match history, map breakdowns, and more.

## Setup

### Environment Variables (set in Render dashboard)
| Variable | Description |
|---|---|
| `SPARTAN_TOKEN` | Your Xbox/Halo Spartan auth token |
| `MS_REFRESH_TOKEN` | Microsoft refresh token used to auto-rotate `SPARTAN_TOKEN` |
| `REDIS_URL` | Redis connection string |
| `DATABASE_URL` | Postgres connection string (optional — falls back to in-memory) |
| `ADMIN_PASS` | **Required.** Password for `/api/admin*` routes. Must be ≥12 chars and not a known placeholder (e.g. `changeme`, `admin`, `password`). |
| `CALIBRATE_KEY` | **Required.** Key for the hidden `/calibrate` page and `/api/calibrate`. Same length/placeholder rules as `ADMIN_PASS`. |
| `NODE_ENV` | Set to `production` on live deploys. The server will refuse to start if `ADMIN_PASS`/`CALIBRATE_KEY` are missing or weak. |
| `ALLOW_DEV_INSECURE_SECRETS` | Local-dev escape hatch only. When `NODE_ENV != production`, setting this to `1` downgrades secret-validation errors to warnings. Ignored in production. |

Generate strong secrets with e.g. `openssl rand -base64 24`. Copy `.env.example` to `.env` for local dev.

### Getting your Spartan Token
Open `get_token_manual.html` in a browser and follow the steps. Copy the resulting `SPARTAN_TOKEN` into your Render environment variables.

### Deploy to Render
1. Push this repo to GitHub
2. Create a new **Web Service** on Render pointing to your repo
3. Set **Build Command**: `npm install`
4. Set **Start Command**: `npm start`
5. Add environment variables: `SPARTAN_TOKEN` and `REDIS_URL`
6. Add a **Redis** instance from Render dashboard and copy the Internal URL as `REDIS_URL`

### File Structure
```
server.js          # Express server — search API, rate limiting, image proxies
halo.js            # Halo API client — stats, match history, emblems
public/
  index.html       # Single-page app — landing page + player stats view
package.json
.env.example
```

## Notes
- Stats are cached for 15 minutes per player in Redis
- Match history is capped at 25 games (no backfill)
- Rate limited to 10 searches per IP per minute
- Not affiliated with 343 Industries or Microsoft

## Operations: backfill `match_participants` from cached data

The `match_participants` table powers the private-player history fallback
(PR #2). Existing `player:*` Redis cache entries already contain every match
they've served, with full team rosters — so we can backfill the table from
that cache without any new Halo API calls.

All commands run from `src/` (where `node_modules` lives).

### 1. Dry-run first (always)
```bash
npm run backfill:participants:dry
```
Scans every `player:*` key in Redis, parses the JSON, and reports counts —
**nothing is written**. Use this to confirm the cache contains usable data
before touching Postgres.

### 2. Real run
```bash
npm run backfill:participants
```
Writes are idempotent (PRIMARY KEY `(match_id, xuid)` + the existing
`ON CONFLICT DO UPDATE` that never overwrites non-nulls with nulls), so you
can safely re-run if it crashes.

Useful flags (pass after `--` so npm forwards them):
```bash
npm run backfill:participants -- --limit 50          # canary: process 50 players
npm run backfill:participants -- --batch-size 50     # progress line every 50 players
npm run backfill:participants -- --key-pattern 'player:*' --scan-count 200
npm run backfill:participants -- --verbose           # per-player log lines
```

Exit codes: `0` success, `1` fatal, `2` missing `REDIS_URL` / `DATABASE_URL`.

### 3. Running on Render

The Render free Web Service shell can run the script directly:
```bash
cd src && npm run backfill:participants:dry
cd src && npm run backfill:participants
```
`REDIS_URL` and `DATABASE_URL` are already set in the service environment,
so nothing extra is needed. **Never** pass credentials on the command line —
the script reads them from the env vars only and never logs them. Gamertags
in progress lines are truncated (`player:somelongname…name`) to keep logs
free of full PII at scale.

### 4. Fallback: rehydrate via public histories

If the dry-run reports `matchesEligible: 0` (old cached blobs predate the
`teams[].players[]` shape), use the rehydration script — but only after the
free Redis backfill cannot help:
```bash
npm run rehydrate:participants:dry                            # plan only
npm run rehydrate:participants -- --limit 25                  # safe canary
npm run rehydrate:participants -- --limit 200 \
  --i-understand-this-calls-halo                              # required guard
```
This **does** make live Halo API calls, throttled to 2.5s/request (matches
the SnapQueue cadence). It picks candidate xuids from `xuid_cache` that
don't already have recent rows in `match_participants`, so it is also
resumable across runs.

### 5. Verifying the script logic offline
```bash
npm run verify:backfill        # stubbed Redis + Postgres, 19 assertions
npm run verify:reconstruct     # PR #2 helpers
```
