// --- Favorites ---
var favorites = [];
try { favorites = JSON.parse(localStorage.getItem('haloFavorites') || '[]'); } catch(e) { favorites = []; }
// Merge any fragrFavs into haloFavorites on load (migration)
(function(){
  try {
    var ff=JSON.parse(localStorage.getItem('fragrFavs')||'[]');
    ff.forEach(function(gt){if(!favorites.some(function(f){return f.toLowerCase()===gt.toLowerCase();}))favorites.push(gt);});
    if(ff.length)try{localStorage.setItem('haloFavorites',JSON.stringify(favorites));}catch(e){}
  } catch(e) {}
})();
var favoritesData = {}; // gamertag -> player stats object (fetched from /api/search)
var favoritesLoading = {}; // gamertag -> bool
var favoritesError = {}; // gamertag -> bool
var favMatchInfo = {}; // gamertag -> { cached, total, complete }

function isFavorite(gt) {
  return favorites.some(function(f) { return f.toLowerCase() === (gt||'').toLowerCase(); });
}
function saveFavorites() {
  try { localStorage.setItem('haloFavorites', JSON.stringify(favorites)); } catch(e) {}
}
async function addFavorite(gt) {
  var cgt=canonicalGt(gt);
  if (isFavorite(cgt)) return;
  // Remove old casing entry if present
  favorites = favorites.filter(function(f){return f.toLowerCase()!==cgt.toLowerCase();});
  favorites.push(cgt);
  saveFavorites();
  // Sync fragrFavs
  fragrFavs=fragrFavs.filter(function(g){return g.toLowerCase()!==cgt.toLowerCase();});
  fragrFavs.unshift(cgt);
  if(fragrFavs.length>20)fragrFavs=fragrFavs.slice(0,20);
  _saveFragrFavs();
  renderPlayerBtns();
  // Fetch their stats so they show in the sidebar
  await loadFavoriteData(cgt);
}
function removeFavorite(gt) {
  var cgt=canonicalGt(gt);
  favorites = favorites.filter(function(f) { return f.toLowerCase() !== cgt.toLowerCase(); });
  // Clean up favoritesData for any casing variant
  Object.keys(favoritesData).forEach(function(k){if(k.toLowerCase()===cgt.toLowerCase())delete favoritesData[k];});
  saveFavorites();
  // Sync fragrFavs
  fragrFavs=fragrFavs.filter(function(g){return g.toLowerCase()!==cgt.toLowerCase();});
  _saveFragrFavs();
  // If currently viewing this favorite, switch back to player 0
  var allPlayers = getAllPlayers();
  if (selectedPlayer >= allPlayers.length) selectedPlayer = 0;
  renderPlayerBtns();
  render();
}
async function loadFavoriteData(gt) {
  if (favoritesData[gt] || favoritesLoading[gt]) return;
  favoritesLoading[gt] = true;
  delete favoritesError[gt];
  try {
    var res = await fetch('/api/search?gamertag=' + encodeURIComponent(gt));
    var d = await res.json();
    if (d.success && d.player) {
      favoritesData[gt] = d.player;
      favoritesLoading[gt] = false;
      renderPlayerBtns();
      render();
      fetchFavMatchInfo(gt);
    } else {
      console.error('[Fav] Bad response for', gt, d.error || 'no player');
      favoritesError[gt] = true;
      favoritesLoading[gt] = false;
      renderPlayerBtns();
    }
  } catch(e) {
    console.error('[Fav] Failed to load', gt, e.message);
    favoritesError[gt] = true;
    favoritesLoading[gt] = false;
    renderPlayerBtns();
  }
}
function getAllPlayers() {
  if(playerData) return [playerData];
  return (data && data.players) || [];
}
async function fetchFavMatchInfo(gt) {
  try {
    var res = await fetch('/api/match-cache-info?gamertags=' + encodeURIComponent(gt));
    var d = await res.json();
    if (d[gt]) { favMatchInfo[gt] = d[gt]; renderPlayerBtns(); }
  } catch(e) {}
}

