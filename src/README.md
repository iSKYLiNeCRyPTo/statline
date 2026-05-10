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
