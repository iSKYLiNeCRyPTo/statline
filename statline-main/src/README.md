# StatLine — Halo Infinite Stats Tracker

Search any Halo Infinite player's stats including K/D, CSR rank, match history, map breakdowns, and more.

## Setup

### Environment Variables (set in Render dashboard)
| Variable | Description |
|---|---|
| `SPARTAN_TOKEN` | Your Xbox/Halo Spartan auth token |
| `REDIS_URL` | Redis connection string |

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
