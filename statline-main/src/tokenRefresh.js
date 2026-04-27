const https = require('https');

const CLIENT_ID = '000000004C12AE6F';
const REDIRECT  = 'https://login.live.com/oauth20_desktop.srf';
const SCOPE     = 'Xboxlive.signin Xboxlive.offline_access';

function post(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve(raw); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function refreshSpartanToken() {
  const refreshToken = process.env.MS_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('MS_REFRESH_TOKEN not set');

  console.log('[TokenRefresh] Refreshing Microsoft token...');

  // Step 1: Use refresh token to get new MS access token
  const msBody = `client_id=${CLIENT_ID}&refresh_token=${encodeURIComponent(refreshToken)}&grant_type=refresh_token&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent(SCOPE)}`;
  const msData = await post('login.live.com', '/oauth20_token.srf',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, msBody
  );
  if (!msData.access_token) throw new Error('MS refresh failed: ' + JSON.stringify(msData));
  console.log('[TokenRefresh] ✓ Microsoft access token refreshed');

  // Update refresh token in memory if a new one was issued
  if (msData.refresh_token && msData.refresh_token !== refreshToken) {
    process.env.MS_REFRESH_TOKEN = msData.refresh_token;
    console.log('[TokenRefresh] Refresh token rotated (new one saved in memory)');
  }

  // Step 2: Xbox Live
  const xblData = await post('user.auth.xboxlive.com', '/user/authenticate',
    { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    { Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msData.access_token}` }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' }
  );
  if (!xblData.Token) throw new Error('Xbox Live auth failed');
  console.log('[TokenRefresh] ✓ Xbox Live token obtained');

  // Step 3: XSTS
  const xstsData = await post('xsts.auth.xboxlive.com', '/xsts/authorize',
    { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    { Properties: { SandboxId: 'RETAIL', UserTokens: [xblData.Token] }, RelyingParty: 'https://prod.xsts.halowaypoint.com/', TokenType: 'JWT' }
  );
  if (!xstsData.Token) throw new Error('XSTS auth failed');
  console.log('[TokenRefresh] ✓ XSTS token obtained');

  // Step 4: Spartan token
  const spartanData = await post('settings.svc.halowaypoint.com', '/spartan-token',
    { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    { Audience: 'urn:343:s3:services', MinVersion: '4', Proof: [{ Token: xstsData.Token, TokenType: 'Xbox_XSTSv3' }] }
  );
  if (!spartanData.SpartanToken) throw new Error('Spartan token failed');

  // Update the env var so the rest of the app picks it up immediately
  process.env.SPARTAN_TOKEN = spartanData.SpartanToken;
  // Reset clearance cache so it gets re-fetched with new token
  // token updated in process.env — halo.js reads it fresh each call
  console.log(`[TokenRefresh] ✓ Spartan token refreshed at ${new Date().toISOString()}`);
  return spartanData.SpartanToken;
}

// Start the auto-refresh scheduler
function startAutoRefresh() {
  if (!process.env.MS_REFRESH_TOKEN) {
    console.log('[TokenRefresh] MS_REFRESH_TOKEN not set — auto-refresh disabled. Token will expire in ~4 hours.');
    return;
  }

  const INTERVAL_MS = 3.5 * 60 * 60 * 1000; // 3.5 hours

  // Do an immediate refresh on startup to ensure token is fresh
  setTimeout(async () => {
    try {
      await refreshSpartanToken();
    } catch(err) {
      console.error('[TokenRefresh] Initial refresh failed:', err.message);
    }
  }, 5000); // 5 second delay to let server start first

  // Then refresh every 3.5 hours
  setInterval(async () => {
    try {
      await refreshSpartanToken();
    } catch(err) {
      console.error('[TokenRefresh] Scheduled refresh failed:', err.message);
      // Retry after 5 minutes on failure
      setTimeout(async () => {
        try { await refreshSpartanToken(); }
        catch(e) { console.error('[TokenRefresh] Retry also failed:', e.message); }
      }, 5 * 60 * 1000);
    }
  }, INTERVAL_MS);

  console.log(`[TokenRefresh] Auto-refresh enabled — token will refresh every 3.5 hours`);
}

module.exports = { startAutoRefresh, refreshSpartanToken };
