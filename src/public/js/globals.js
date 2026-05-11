var playerData=null,data=null,medalMeta={},expandedMatches={},fullMatchCache={},MEDAL_SHEET='/api/medal-sheet',selectedPlayer=0,searchData=null,searchMode=false,activeTab='overview',matchHistoryPage=1,matchHistoryData=null,matchHistoryLoading=false;
var proStats=null; // aggregate stats from marked pro players — loaded once at startup
fetch('/api/pro-stats').then(function(r){return r.json();}).then(function(d){if(d.ok&&d.stats)proStats=d.stats;}).catch(function(){});
var _searchToken = 0; // incremented on every new doSearch — stale searches self-cancel

// ── Auto-refresh polling ─────────────────────────────────────────────────────
var _autoRefreshTimer = null;
var _autoRefreshKnownMatchId = null; // matchId of the most recent match when data was last loaded
var _autoRefreshGt = null;           // gamertag currently being polled
var _autoRefreshBanner = null;       // reference to the banner DOM node if visible
var AUTO_REFRESH_INTERVAL = 90000;   // poll every 90 seconds

function startAutoRefresh(gt, latestMatchId) {
  stopAutoRefresh();
  _autoRefreshGt = gt;
  _autoRefreshKnownMatchId = latestMatchId || null;
  _autoRefreshTimer = setInterval(_autoRefreshTick, AUTO_REFRESH_INTERVAL);
}

function stopAutoRefresh() {
  if (_autoRefreshTimer) { clearInterval(_autoRefreshTimer); _autoRefreshTimer = null; }
  _autoRefreshGt = null;
  _autoRefreshKnownMatchId = null;
  _dismissAutoRefreshBanner();
}

function _dismissAutoRefreshBanner() {
  if (_autoRefreshBanner && _autoRefreshBanner.parentNode) {
    _autoRefreshBanner.parentNode.removeChild(_autoRefreshBanner);
  }
  _autoRefreshBanner = null;
}

async function _autoRefreshTick() {
  if (!_autoRefreshGt) return;
  // Only poll when the tab is visible and we're on overview or matches
  if (document.visibilityState !== 'visible') return;
  if (activeTab !== 'overview' && activeTab !== 'matches') return;
  try {
    var r = await fetch('/api/latest-match?gamertag=' + encodeURIComponent(_autoRefreshGt));
    if (!r.ok) return;
    var d = await r.json();
    if (!d.ok) return;
    // New match detected — either a different matchId or more matches than before
    if (d.matchId && d.matchId !== _autoRefreshKnownMatchId) {
      _showAutoRefreshBanner();
    }
  } catch(e) { /* network blip — try again next tick */ }
}

function _showAutoRefreshBanner() {
  if (_autoRefreshBanner) return; // already showing
  var banner = document.createElement('div');
  banner.id = '_autoRefreshBanner';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:var(--accent);color:#000;font-family:Share Tech Mono,monospace;font-size:12px;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,0.4)';
  banner.innerHTML = '<span>⟳ New game detected — updating stats...</span><span style="font-size:10px;opacity:0.7">click to dismiss</span>';
  banner.addEventListener('click', function() { _dismissAutoRefreshBanner(); });
  document.body.appendChild(banner);
  _autoRefreshBanner = banner;
  // Auto-refresh after 3 seconds — force=true busts the server cache so we get the new match
  setTimeout(function() {
    _dismissAutoRefreshBanner();
    if (_autoRefreshGt) {
      doSearch(_autoRefreshGt, true, true).then(function() {
        var p = playerData;
        var m = p && (p.allMatches || p.recentMatches || []);
        if (m && m[0]) { _autoRefreshKnownMatchId = m[0].matchId; }
      });
    }
  }, 3000);
}

// Ad system removed — sponsor card no longer rendered. Stubs kept as no-ops so any
// stragglers that still reference these names don't blow up the page.
function _pickNewAd(){ /* no-op */ }
function _renderAdSlot(){ return ''; }

try{activeTab=localStorage.getItem('haloTab')||'overview';}catch(e){}
