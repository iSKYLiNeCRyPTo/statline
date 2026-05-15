function applyTheme(t){
  var root=document.documentElement;
  root.removeAttribute('data-theme');
  if(t!=='mc117')root.setAttribute('data-theme',t);
  
  // Update CSR chart colors per theme
  var chartColors={
    mc117:['#378ADD','#85B7EB'],
    covenant:['#9b59f5','#e040fb'],
    forerunner:['#f0b030','#e05020'],
    oni:['#e8002a','#00c853'],
    flood:['#2aff7a','#aaff00'],
    onyx:['#00c8ff','#ffd740']
  };
  window._themeChartColors=chartColors[t]||chartColors.mc117;
}


// Set landing class on initial load
document.body.classList.add('on-landing');
// Apply saved or default theme on load
(function(){
  var saved='mc117';
  try{saved=localStorage.getItem('fragrTheme')||'mc117';}catch(e){}
  applyTheme(saved);
  })();

window.addEventListener('resize',function(){
  var dtb=document.getElementById('desktopTabBar');
  if(dtb&&dtb.style.display!=='none')dtb.style.display=window.innerWidth>=768?'flex':'none';
});
// ── Match History Pagination ──
function loadMatchHistory(page){
  if(matchHistoryLoading)return;
  // If in search mode, show searched player's matches directly
  if(searchMode&&searchData){
    // Route through /api/matches so we get full backfilled history + proper pagination
    var gt=searchData.gamertag;
    matchHistoryLoading=true;
    var container=document.getElementById('matchHistoryContainer');
    if(container)container.innerHTML='<div class="loading"><div class="spinner"></div><p>Loading match history...</p></div>';
    var url='/api/matches?gamertag='+encodeURIComponent(gt)+'&page=1&perPage=250';
    // Render immediately from searchData if available, fetch API in background
    var _sImmediate=searchData.allMatches||searchData.recentMatches||[];
    if(_sImmediate.length>0){
      var _si={matches:_sImmediate,page:1,totalPages:Math.max(1,Math.ceil(_sImmediate.length/25)),total:_sImmediate.length,_gamertag:gt};
      matchHistoryData=_si;
      matchHistoryLoading=false;
      renderMatchHistory(_si);
      fetch(url).then(function(r){return r.json();}).then(function(d){
        if(d.matches&&d.matches.length>0){d._gamertag=gt;matchHistoryData=d;renderMatchHistory(d,matchHistoryData._clientPage||1);}
      }).catch(function(){});
      return;
    }
    fetch(url).then(function(r){return r.json();}).then(function(d){
      // If server has no matches, fall back to what we have in searchData
      if(!d.matches||d.matches.length===0){
        var sMatches=searchData.allMatches||searchData.recentMatches||[];
        d={matches:sMatches,page:1,totalPages:1,total:sMatches.length};
      }
      d._gamertag=gt;
      matchHistoryData=d;
      matchHistoryLoading=false;
      renderMatchHistory(d);
    }).catch(function(e){
      var sMatches=searchData.allMatches||searchData.recentMatches||[];
      var d={matches:sMatches,page:1,totalPages:1,total:sMatches.length,_gamertag:gt};
      matchHistoryData=d;
      matchHistoryLoading=false;
      renderMatchHistory(d);
    });
    return;
  }
  matchHistoryLoading=true;
  matchHistoryPage=page||1;
  var container=document.getElementById('matchHistoryContainer');
  if(!container)return;
  var p=getAllPlayers()[selectedPlayer]||{};
  var gt=p.gamertag;
  if(!gt){container.innerHTML='<div class="empty-state"><div class="empty-state-icon"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"28\" height=\"28\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" style=\"vertical-align:-4px\"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 12h4m-2-2v4"/><circle cx="15" cy="11" r="1"/><circle cx="18" cy="13" r="1"/></svg></div><div class="empty-state-msg">No player selected</div></div>';matchHistoryLoading=false;return;}

  // Prefer the full match cache (populated by loadFullMatches with perPage=250)
  // This avoids a separate API call that would return fewer matches and shrink pagination
  var _cachedMatches=fullMatchCache[gt];
  if(_cachedMatches&&_cachedMatches.length>0){
    var _cd={matches:_cachedMatches,page:1,totalPages:Math.max(1,Math.ceil(_cachedMatches.length/25)),total:_cachedMatches.length,_gamertag:gt};
    matchHistoryData=_cd;
    matchHistoryLoading=false;
    renderMatchHistory(_cd,matchHistoryData._clientPage||1);
    return;
  }

  container.innerHTML='<div class="loading"><div class="spinner"></div><p>Loading page '+matchHistoryPage+'...</p></div>';
  var _mhTimeout=setTimeout(function(){
    if(!matchHistoryLoading)return;
    matchHistoryLoading=false;
    var fb=getAllPlayers()[selectedPlayer];
    var fbM=fb&&(fb.allMatches||fb.recentMatches)||[];
    if(fbM.length>0){matchHistoryData={matches:fbM,page:1,totalPages:Math.max(1,Math.ceil(fbM.length/25)),total:fbM.length,_gamertag:gt};renderMatchHistory(matchHistoryData);}
    else{container.innerHTML='<div class="error-card">Match history unavailable — try refreshing</div>';}
  },5000);
  // Fetch full history (matches the perPage used by loadFullMatches)
  var url='/api/matches?gamertag='+encodeURIComponent(gt)+'&page=1&perPage=250';
  // If we already have some matches in memory, render them immediately while the full fetch loads
  var _existing=getAllPlayers()[selectedPlayer];
  var _existingMatches=_existing&&(_existing.allMatches||_existing.recentMatches)||[];
  if(_existingMatches.length>0){
    var _d={matches:_existingMatches,page:1,totalPages:Math.max(1,Math.ceil(_existingMatches.length/25)),total:_existingMatches.length,_gamertag:gt};
    matchHistoryData=_d;
    matchHistoryLoading=false;
    renderMatchHistory(_d);
    // Fetch full history in background to expand pagination
    fetch(url).then(function(r){return r.json();}).then(function(d){
      if(d.matches&&d.matches.length>0){
        d.matches._fetchedAt=Date.now();
        fullMatchCache[gt]=d.matches;
        d._gamertag=gt;
        matchHistoryData=d;
        renderMatchHistory(d,matchHistoryData._clientPage||1);
      }
    }).catch(function(){});
    return;
  }
  fetch(url).then(function(r){return r.json();}).then(function(d){
    clearTimeout(_mhTimeout);
    if(!d.matches||d.matches.length===0){
      var fb=getAllPlayers()[selectedPlayer];
      var fbM=fb&&(fb.allMatches||fb.recentMatches)||[];
      if(fbM.length>0){d={matches:fbM,page:1,totalPages:Math.max(1,Math.ceil(fbM.length/25)),total:fbM.length};}
    } else {
      d.matches._fetchedAt=Date.now();
      fullMatchCache[gt]=d.matches;
    }
    d._gamertag=gt;
    matchHistoryData=d;
    matchHistoryLoading=false;
    renderMatchHistory(d);
  }).catch(function(e){
    clearTimeout(_mhTimeout);
    var fb=getAllPlayers()[selectedPlayer];
    var fbM=fb&&(fb.allMatches||fb.recentMatches)||[];
    if(fbM.length>0){
      var _fd={matches:fbM,page:1,totalPages:Math.max(1,Math.ceil(fbM.length/25)),total:fbM.length,_gamertag:gt};
      matchHistoryData=_fd;
      matchHistoryLoading=false;
      renderMatchHistory(_fd);
    } else {
      container.innerHTML='<div class="error-card">Failed to load matches: '+e.message+'</div>';
      matchHistoryLoading=false;
    }
  });
}

function renderMatchHistory(d,clientPage){
  var container=document.getElementById('matchHistoryContainer');
  if(!container)return;
  var allMatches=d.matches||[];
  var PER_PAGE=25; // full history paginated — all loaded matches shown
  var page=clientPage||1;
  var totalPages=Math.max(1,Math.ceil(allMatches.length/PER_PAGE));
  page=Math.min(page,totalPages);
  var matches=allMatches.slice((page-1)*PER_PAGE,page*PER_PAGE);
  var total=allMatches.length;
  // Store current client page on the data object for re-renders
  d._clientPage=page;
  
  // Build mode baselines from ALL matches (not just current page) with strict data quality filters
  function getDurSecs(m){if(!m.duration)return 0;var mm=String(m.duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);return mm?(parseInt(mm[1]||0)*3600)+(parseInt(mm[2]||0)*60)+parseFloat(mm[3]||0):0;}
  function isValidBaselineMatch(m){
    var s=getDurSecs(m);
    return s>=180&&m.damageDealt>=300&&m.damageTaken>=300&&(m.outcome===2||m.outcome===3);
  }
  function avg(arr){return arr.length?arr.reduce(function(a,b){return a+b;},0)/arr.length:0;}
  function trimmedAvg(arr){
    if(arr.length<6)return avg(arr);
    var s=arr.slice().sort(function(a,b){return a-b;});
    var cut=Math.max(1,Math.floor(s.length*0.1));
    return avg(s.slice(cut,s.length-cut));
  }
  var _baseSource=(allMatches||[]).filter(isValidBaselineMatch);
  var buckets={};
  _baseSource.forEach(function(m){
    var mode=m.gameMode||'Unknown';
    var _rawSecs=getDurSecs(m);
    var _objHold=m.objStats&&m.objStats.timeAsCarrier?m.objStats.timeAsCarrier:0;
    var mins=Math.max((_rawSecs-_objHold)/60,1);
    [mode,'__overall__'].forEach(function(k){
      if(!buckets[k])buckets[k]={dpmDealt:[],dpmTaken:[],acc:[],spk:[]};
      buckets[k].dpmDealt.push(m.damageDealt/mins);
      buckets[k].dpmTaken.push(m.damageTaken/mins);
      if(m.accuracy!=null)buckets[k].acc.push(parseFloat(m.accuracy));
      if(m.kills>0&&m.shotsFired>0)buckets[k].spk.push(m.shotsFired/m.kills);
    });
  });
  var baselines={};
  Object.keys(buckets).forEach(function(k){
    var b=buckets[k];
    baselines[k]={avgDpmDealt:trimmedAvg(b.dpmDealt),avgDpmTaken:trimmedAvg(b.dpmTaken),avgAcc:trimmedAvg(b.acc),avgSpk:trimmedAvg(b.spk),count:b.dpmDealt.length};
  });

  // Store globally so toggleMatch can access them
  window._matchHistoryBaselines=baselines;
  window.matchHistoryData=d;

  var html='';

  // Pagination header — prev/next with page numbers for 4-page view
  html+='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">';
  html+='<div style="font-family:Share Tech Mono,monospace;font-size:11px;color:var(--muted)">'+total+' matches · Page '+page+' of '+totalPages+'</div>';
  if(totalPages>1){
    html+='<div style="display:flex;gap:4px;align-items:center">';
    html+='<button onclick="renderMatchHistory(window.matchHistoryData,'+(page-1)+')" '+(page<=1?'disabled':'')+' style="'+paginationBtnStyle(page<=1)+'">‹</button>';
    for(var _pi=1;_pi<=totalPages;_pi++){
      var _active=_pi===page;
      html+='<button onclick="renderMatchHistory(window.matchHistoryData,'+_pi+')" style="background:'+(_active?'var(--accent)':'transparent')+';border:1px solid '+(_active?'var(--accent)':'var(--border)')+';color:'+(_active?'#000':'var(--muted)')+';padding:4px 10px;border-radius:4px;font-family:Share Tech Mono,monospace;font-size:10px;cursor:'+(_active?'default':'pointer')+';font-weight:'+(_active?'700':'400')+'">'+_pi+'</button>';
    }
    html+='<button onclick="renderMatchHistory(window.matchHistoryData,'+(page+1)+')" '+(page>=totalPages?'disabled':'')+' style="'+paginationBtnStyle(page>=totalPages)+'">›</button>';
    html+='</div>';
  }
  html+='</div>';

  if(!matches.length){
    html+='<div class="empty-state"><div class="empty-state-icon"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"28\" height=\"28\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" style=\"vertical-align:-4px\"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 12h4m-2-2v4"/><circle cx="15" cy="11" r="1"/><circle cx="18" cy="13" r="1"/></svg></div><div class="empty-state-msg">No matches on this page</div></div>';
  } else {
    html+='<div class="match-list">';
    matches.forEach(function(m,i){
      html+=renderMatchCard(m,(page-1)*PER_PAGE+i,baselines);
    });
    html+='</div>';
  }

  // Bottom pagination
  if(totalPages>1){
    html+='<div style="display:flex;justify-content:center;align-items:center;gap:4px;margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">';
    html+='<button onclick="renderMatchHistory(window.matchHistoryData,'+(page-1)+')" '+(page<=1?'disabled':'')+' style="'+paginationBtnStyle(page<=1)+'">‹</button>';
    for(var _pj=1;_pj<=totalPages;_pj++){
      var _activeJ=_pj===page;
      html+='<button onclick="renderMatchHistory(window.matchHistoryData,'+_pj+')" style="background:'+(_activeJ?'var(--accent)':'transparent')+';border:1px solid '+(_activeJ?'var(--accent)':'var(--border)')+';color:'+(_activeJ?'#000':'var(--muted)')+';padding:4px 10px;border-radius:4px;font-family:Share Tech Mono,monospace;font-size:10px;cursor:'+(_activeJ?'default':'pointer')+';font-weight:'+(_activeJ?'700':'400')+'">'+_pj+'</button>';
    }
    html+='<button onclick="renderMatchHistory(window.matchHistoryData,'+(page+1)+')" '+(page>=totalPages?'disabled':'')+' style="'+paginationBtnStyle(page>=totalPages)+'">›</button>';
    html+='</div>';
  }

  container.innerHTML=html;
  expandedMatches={};
}

function paginationBtnStyle(disabled){
  return 'background:transparent;border:1px solid var(--border);color:'+(disabled?'var(--muted2)':'var(--muted)')+';padding:4px 10px;border-radius:4px;font-family:Share Tech Mono,monospace;font-size:10px;cursor:'+(disabled?'not-allowed':'pointer')+';opacity:'+(disabled?'0.4':'1')+';';
}

// ── Tab time tracking ─────────────────────────────────────────────────────────
var _tabStart = Date.now();
var _tabCurrent = 'overview';
function flushTabTime(newTab) {
  var secs = (Date.now() - _tabStart) / 1000;
  if (secs >= 2) {
    var gt = (getAllPlayers()[selectedPlayer]||{}).gamertag || null;
    fetch('/api/analytics/tab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gamertag: gt, tab: _tabCurrent, seconds: Math.round(secs) })
    }).catch(function(){});
  }
  _tabCurrent = newTab;
  _tabStart = Date.now();
}
window.addEventListener('beforeunload', function(){ flushTabTime('__exit__'); });

function setTab(t){
  // Objectives tab was merged into Stats — redirect any stored/legacy references
  if(t==='objectives') t='charts';
  // Clear expanded match state for the tab we're leaving so cards render cleanly on return
  var _prevTab=activeTab;
  flushTabTime(t);
  activeTab=t;
  Object.keys(expandedMatches).forEach(function(k){
    if(k.indexOf(_prevTab+'__')===0) delete expandedMatches[k];
  });
  try{localStorage.setItem('haloTab',t);}catch(e){}
  // Update sidebar nav
  document.querySelectorAll('.sidebar-nav-item').forEach(function(b){
    b.classList.toggle('active', b.dataset.tab===t);
  });
  // Update mobile tab bar
  document.querySelectorAll('.mobile-tab[data-tab]').forEach(function(b){
    b.classList.toggle('active', b.dataset.tab===t);
  });
  // Update tab panels
  document.querySelectorAll('.tab-panel').forEach(function(p){
    p.classList.toggle('active', p.dataset.tab===t);
  });
  // Update topbar title
  var titles={overview:'// OVERVIEW',matches:'// MATCH HISTORY',bymap:'// MAPS',charts:'// STATS',opponents:'// RIVALS',sessions:'// SESSIONS',activity:'// ACTIVITY',weapons:'// WEAPONS',synergy:'// SYNERGY',compare:'// COMPARE',lastgame:'// LAST GAME'};
  var el=document.getElementById('topbarTitle');
  if(el)el.textContent=titles[t]||'// '+t.toUpperCase();
  // Close sidebar on mobile
  if(window.innerWidth<768){var sb=document.getElementById('sidebar');if(sb)sb.classList.remove('open');}
  // Load match history when switching to that tab
  if(t==='matches'){
    var _curGt=(getAllPlayers()[selectedPlayer]||searchData||{}).gamertag||'';
    // Wait for container to be in DOM before loading
    var _matchTabAttempts=0;
    var _matchTabCheck=setInterval(function(){
      var _mc=document.getElementById('matchHistoryContainer');
      if(!_mc&&_matchTabAttempts++<20){return;}
      clearInterval(_matchTabCheck);
      if(!_mc)return;
      if(matchHistoryData&&matchHistoryData.matches&&matchHistoryData.matches.length>0&&
         matchHistoryData._gamertag&&matchHistoryData._gamertag.toLowerCase()===_curGt.toLowerCase()){
        renderMatchHistory(matchHistoryData,matchHistoryData._clientPage||1);
      } else {
        matchHistoryPage=1;loadMatchHistory(1);
      }
    },50);
  }
  if(['bymap','charts','opponents','sessions','activity','weapons','synergy','lastgame'].indexOf(t)>-1){
    var _cp=getAllPlayers()[selectedPlayer];
    if(_cp&&_cp.gamertag) loadFullMatches(_cp.gamertag);
  }
  if(t==='charts'||t==='synergy') setTimeout(resolveSynergyGamertags, 150);
  if(t==='compare'&&typeof openCompare==='function') setTimeout(openCompare, 0);

  // Last Game — start live polling when on tab, stop when leaving
  if(t==='lastgame'){
    _startLastGamePoll();
  } else {
    _stopLastGamePoll();
  }

  // Update desktop tab active state
  document.querySelectorAll('.dtab').forEach(function(b){
    b.classList.toggle('active', b.dataset.tab===t);
  });
}

// ── Last Game live polling ────────────────────────────────────────────────────
var _lgPollTimer=null, _lgLastChecked=0, _lgCheckedAgoTimer=null;
function _startLastGamePoll(){
  _stopLastGamePoll(); // clear any existing
  _lgDoPoll(); // immediate first check
  _lgPollTimer=setInterval(_lgDoPoll, 30000);
  // "last checked X sec ago" ticker
  _lgCheckedAgoTimer=setInterval(function(){
    var el=document.getElementById('lg-checked-ago');
    if(!el)return;
    var secs=Math.round((Date.now()-_lgLastChecked)/1000);
    el.textContent = secs < 5 ? '· checked just now' : '· checked '+secs+'s ago';
  }, 5000);
}
function _stopLastGamePoll(){
  if(_lgPollTimer){clearInterval(_lgPollTimer);_lgPollTimer=null;}
  if(_lgCheckedAgoTimer){clearInterval(_lgCheckedAgoTimer);_lgCheckedAgoTimer=null;}
}
function _lgDoPoll(){
  var p=getAllPlayers()[selectedPlayer]||searchData;
  var gt=p&&p.gamertag;
  if(!gt) return;
  var allM=(p.allMatches||p.recentMatches||fullMatchCache[gt.toLowerCase()]||[]);
  var currentId=allM[0]&&allM[0].matchId;
  _lgLastChecked=Date.now();
  fetch('/api/latest-match?gamertag='+encodeURIComponent(gt))
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.ok) return;
      var statusEl=document.getElementById('lg-poll-status');
      var bannerEl=document.getElementById('lg-new-banner');
      if(!statusEl) return;
      _lgLastChecked=Date.now();
      if(d.matchId && currentId && d.matchId !== currentId){
        // New game detected
        statusEl.textContent='NEW GAME FOUND';
        statusEl.style.color='var(--accent)';
        if(bannerEl) bannerEl.style.display='inline';
        window._lgLoadNewGame=function(){
          if(bannerEl) bannerEl.style.display='none';
          statusEl.textContent='LOADING NEW GAME…';
          _stopLastGamePoll();
          doSearch(gt, true, true);
        };
      } else {
        statusEl.textContent='WATCHING FOR NEW GAME';
        statusEl.style.color='';
        if(bannerEl) bannerEl.style.display='none';
      }
    })
    .catch(function(){});
}

function toast(msg,type,duration){
  type=type||'info';duration=duration||3000;
  var tc=document.getElementById('toast-container');
  if(!tc)return;
  var t=document.createElement('div');
  t.className='toast '+type;
  var _svgCheck='<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polyline points="20 6 9 17 4 12"/></svg>';
  var _svgX='<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  var _svgInfo='<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
  var icon=type==='success'?_svgCheck:type==='error'?_svgX:_svgInfo;
  t.innerHTML='<span>'+icon+'</span><span>'+msg+'</span>';
  tc.appendChild(t);
  setTimeout(function(){
    t.style.animation='toastOut 0.3s ease forwards';
    setTimeout(function(){t.remove();},300);
  },duration);
}

// Keyboard shortcuts
document.addEventListener('keydown',function(e){
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA')return;
  if(e.key==='r'||e.key==='R'){refreshStats();}
  if(e.key==='1')setTab('overview');
  if(e.key==='2')setTab('history');
  if(e.key==='3')setTab('charts');
  if(e.key==='4')setTab('opponents');
  if(e.key==='/')setTimeout(function(){document.getElementById('searchInput')&&document.getElementById('searchInput').focus();},0);
});


var sessionStart=null; // snapshot of stats when page first loaded
async function loadMedalMeta(){try{var res=await fetch('/api/medal-meta');if(!res.ok)return;var d=await res.json();
  var arr=Array.isArray(d)?d:Array.isArray(d.Medals)?d.Medals:Array.isArray(d.medals)?d.medals:null;
  var columns=d.Columns||d.columns||16;
  if(arr&&arr.length){
    arr.forEach(function(m){
      var id=String(m.nameId||m.NameId||m.id||'');if(!id)return;
      var idx=m.spriteIndex!=null?m.spriteIndex:m.SpriteIndex!=null?m.SpriteIndex:null;
      medalMeta[id]={
        name:(m.name&&m.name.value)||m.name||String(id),
        difficulty:(['normal','heroic','legendary','mythic'][m.difficultyIndex])||'normal',
        spriteIndex:idx,
        columns:m.columns||columns
      };
    });
    console.log('[Medals] client loaded',Object.keys(medalMeta).length,'medals');
  } else if(typeof d==='object'){
    Object.entries(d).forEach(function(e){var id=e[0],info=e[1];if(!id||typeof info!=='object')return;
      medalMeta[id]={name:info.name||String(id),difficulty:info.difficulty||'normal',spriteIndex:info.spriteIndex!=null?info.spriteIndex:null,columns:info.columns||16};
    });
    console.log('[Medals] client loaded (map format)',Object.keys(medalMeta).length,'medals');
  }
}catch(e){console.warn('[Medals]',e.message);}}

function showLanding(){
  var el=document.getElementById('landing');
  if(el)el.style.display='flex';
  document.body.classList.add('on-landing');
  var mlb=document.getElementById('mobileLogoBar');if(mlb)mlb.style.display='none';
  var _app=document.getElementById('app');if(_app)_app.innerHTML='';
  var _csb=document.getElementById('clearSearchBtn');if(_csb)_csb.style.display='none';
  var _si=document.getElementById('searchInput');if(_si)_si.value='';
  document.title='fragr — Halo Infinite Stat Tracker';
  try{var url=new URL(window.location);url.searchParams.delete('player');url.searchParams.delete('search');
  window.history.pushState({},'',url);}catch(e){}
  renderFavChips();
}
function hideLanding(){
  var el=document.getElementById('landing');
  if(el)el.style.display='none';
  document.body.classList.remove('on-landing');
  var mlb=document.getElementById('mobileLogoBar');if(mlb)mlb.style.display='';
}
function goHome(){
  playerData=null; data=null; searchData=null; searchMode=false;
  var dtb=document.getElementById('desktopTabBar');if(dtb)dtb.style.display='none';
  var fb=document.getElementById('favHeaderBtn');if(fb)fb.style.display='none';
  showLanding();
}
async function landingSearchPlayer(){
  var gt=document.getElementById('landingSearch').value.trim();
  var errEl=document.getElementById('landingError');
  if(!gt){if(errEl)errEl.textContent='Please enter a gamertag.';return;}
  if(errEl)errEl.textContent='Searching...';
  document.getElementById('searchInput').value=gt;
  await doSearch(gt);
}

// ── Gamertag autocomplete ──────────────────────────────────────────────────
var _suggestTimer=null,_suggestIdx=-1,_suggestCache={};

function debounceSuggest(val,dropId,inputId){
  clearTimeout(_suggestTimer);
  var drop=document.getElementById(dropId);
  if(!val||val.length<2){if(drop)drop.classList.remove('open');return;}
  _suggestTimer=setTimeout(function(){fetchSuggest(val,dropId,inputId);},500);
}
function fetchSuggest(q,dropId,inputId){
  if(_suggestCache[q]){renderSuggest(_suggestCache[q],dropId,inputId);return;}
  fetch('/api/suggest?q='+encodeURIComponent(q))
    .then(function(r){return r.json();})
    .then(function(d){_suggestCache[q]=d.people||[];renderSuggest(_suggestCache[q],dropId,inputId);})
    .catch(function(){});
}
function renderSuggest(people,dropId,inputId){
  var drop=document.getElementById(dropId);
  if(!drop)return;
  _suggestIdx=-1;
  if(!people.length){drop.innerHTML='<div class="suggest-empty">No results</div>';drop.classList.add('open');return;}
  var html='';
  var userSvg='<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  people.forEach(function(p,i){
    var escapedGt=p.gamertag.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
    var pic=p.gamerpicUrl
      ? '<img class="suggest-pic" src="'+p.gamerpicUrl+'" alt="">'
      : '<div class="suggest-pic-placeholder">'+userSvg+'</div>';
    var gs=p.gamerScore!=null?'<div class="suggest-gs">'+Number(p.gamerScore).toLocaleString()+' GS</div>':'';
    html+='<div class="suggest-item" data-gt="'+escapedGt+'" data-dropid="'+dropId+'" data-inputid="'+inputId+'"'
      +' onclick="selectSuggest(this)">'
      +pic+'<div><div class="suggest-gt">'+p.gamertag+'</div>'+gs+'</div></div>';
  });
  drop.innerHTML=html;
  drop.classList.add('open');
}
function selectSuggest(el){
  var gt=el.dataset.gt,dropId=el.dataset.dropid,inputId=el.dataset.inputid;
  var drop=document.getElementById(dropId);
  if(drop)drop.classList.remove('open');
  var inp=document.getElementById(inputId);
  if(inp)inp.value=gt;
  if(inputId==='landingSearch'){landingSearchPlayer();return;}
  var si=document.getElementById('searchInput');
  if(si)si.value=gt;
  searchPlayer();
  if(inputId==='mobileSearchInput'){var ms=document.getElementById('mobileSearch');if(ms)ms.style.display='none';}
}
function handleSuggestKey(e,dropId){
  var drop=document.getElementById(dropId);
  if(!drop||!drop.classList.contains('open')){if(e.key==='Enter')searchPlayer();return;}
  var items=drop.querySelectorAll('.suggest-item');
  if(e.key==='ArrowDown'){e.preventDefault();_suggestIdx=Math.min(_suggestIdx+1,items.length-1);items.forEach(function(el,i){el.classList.toggle('active',i===_suggestIdx);});}
  else if(e.key==='ArrowUp'){e.preventDefault();_suggestIdx=Math.max(_suggestIdx-1,-1);items.forEach(function(el,i){el.classList.toggle('active',i===_suggestIdx);});}
  else if(e.key==='Enter'){if(_suggestIdx>=0&&items[_suggestIdx]){e.preventDefault();items[_suggestIdx].click();}else{drop.classList.remove('open');searchPlayer();}}
  else if(e.key==='Escape'){drop.classList.remove('open');}
}


window.addEventListener('resize',function(){
  var dtb=document.getElementById('desktopTabBar');
  if(dtb&&dtb.style.display!=='none')dtb.style.display=window.innerWidth>=768?'flex':'none';
});
document.addEventListener('click',function(e){
  ['suggestDropdown','mobileSuggestDropdown','landingSuggestDropdown'].forEach(function(id){
    var drop=document.getElementById(id);
    if(drop&&drop.parentElement&&!drop.parentElement.contains(e.target))drop.classList.remove('open');
  });
});
// ──────────────────────────────────────────────────────────────────────────

// ── Fragr local favorites (localStorage) ───────────────────────────────────
var fragrFavs = [];
try { fragrFavs = JSON.parse(localStorage.getItem('fragrFavs') || '[]'); } catch(e) {}

// Return the best-known canonical casing for a gamertag
function canonicalGt(gt) {
  // Check if playerData or favoritesData has this gt with known casing
  if(playerData&&playerData.gamertag&&playerData.gamertag.toLowerCase()===gt.toLowerCase()) return playerData.gamertag;
  var fd=favoritesData[gt]||favoritesData[Object.keys(favoritesData).find(function(k){return k.toLowerCase()===gt.toLowerCase();})||''];
  if(fd&&fd.gamertag) return fd.gamertag;
  // Update casing in fragrFavs if we already have it stored differently
  var stored=fragrFavs.find(function(g){return g.toLowerCase()===gt.toLowerCase();});
  return stored||gt;
}

function isFragrFav(gt) { return fragrFavs.some(function(g){return g.toLowerCase()===gt.toLowerCase();}); }
function _saveFragrFavs() { try { localStorage.setItem('fragrFavs', JSON.stringify(fragrFavs)); } catch(e) {} }
function toggleCurrentFav() {
  if(!playerData) return;
  var gt = canonicalGt(playerData.gamertag);
  if(isFragrFav(gt)) {
    fragrFavs = fragrFavs.filter(function(g){return g.toLowerCase()!==gt.toLowerCase();});
    // Also remove from haloFavorites
    favorites = favorites.filter(function(f){return f.toLowerCase()!==gt.toLowerCase();});
    saveFavorites();
  } else {
    // Update casing of any existing entry first
    fragrFavs = fragrFavs.filter(function(g){return g.toLowerCase()!==gt.toLowerCase();});
    fragrFavs.unshift(gt);
    if(fragrFavs.length > 20) fragrFavs = fragrFavs.slice(0,20);
    // Also add to haloFavorites with canonical casing
    if(!isFavorite(gt)) { favorites = favorites.filter(function(f){return f.toLowerCase()!==gt.toLowerCase();}); favorites.push(gt); saveFavorites(); }
  }
  _saveFragrFavs();
  updateFavBtn();
  renderFavChips();
}
function updateFavBtn() {
  if(!playerData) return;
  var fav = isFragrFav(playerData.gamertag);
  var _starF='<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  var _starE='<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  // Desktop header button
  var btn = document.getElementById('favHeaderBtn');
  if(btn) {
    btn.innerHTML = fav ? _starF : _starE;
    btn.style.color = fav ? '#ffc107' : 'var(--muted)';
    btn.style.borderColor = fav ? '#ffc107' : 'var(--border)';
    btn.title = fav ? 'Remove from favorites' : 'Add to favorites';
  }
  // Hero fav button (inline next to player name)
  var hbtn = document.getElementById('heroFavBtn');
  if(hbtn) {
    var _s22F='<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
    var _s22E='<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
    hbtn.innerHTML = fav ? _s22F : _s22E;
    hbtn.style.color = fav ? '#ffc107' : 'var(--muted)';
    hbtn.title = fav ? 'Remove from favorites' : 'Add to favorites';
  }
}
function renderFavChips() {
  var el = document.getElementById('favChips');
  if(!el) return;
  if(!fragrFavs.length) { el.style.display='none'; return; }
  el.style.display='flex';
  el.innerHTML = '';
  fragrFavs.forEach(function(gt) {
    var btn = document.createElement('button');
    btn.textContent = gt;
    btn.style.cssText = 'background:var(--surface);border:1px solid var(--border);color:var(--muted);padding:4px 12px;border-radius:20px;font-family:Share Tech Mono,monospace;font-size:10px;cursor:pointer;white-space:nowrap;transition:all 0.15s;letter-spacing:0.5px';
    btn.addEventListener('click', function(){ doSearch(gt); });
    btn.addEventListener('mouseover', function(){ this.style.borderColor='#85B7EB';this.style.color='#85B7EB'; });
    btn.addEventListener('mouseout', function(){ this.style.borderColor='var(--border)';this.style.color='var(--muted)'; });
    el.appendChild(btn);
  });
}
async function loadStats(){
  // Start medal meta fetch but don't block on it when a player is in the URL —
  // doSearch will show the loading screen immediately, and medals will be ready
  // long before the final render step.
  var medalMetaPromise=loadMedalMeta();
  fetch('/api/stats').then(function(r){return r.ok?r.json():null;}).then(function(d){
    if(!d)return;
    var el=document.getElementById('landingStats');
    if(!el)return;
    el.innerHTML='<div style="text-align:center"><div style="font-size:22px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--accent)">'+d.totalSearches.toLocaleString()+'</div><div style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace;margin-top:2px;letter-spacing:1px">SEARCHES</div></div>'
      +'<div style="width:1px;height:40px;background:var(--border)"></div>'
      +'<div style="text-align:center"><div style="font-size:22px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--accent)">'+d.uniquePlayers.toLocaleString()+'</div><div style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace;margin-top:2px;letter-spacing:1px">PLAYERS TRACKED</div></div>';
  }).catch(function(){});
  // Check URL for player param
  var params=new URLSearchParams(window.location.search);
  var gt=params.get('player')||params.get('search');
  if(gt){
    // Don't await medals first — doSearch shows the loading screen immediately.
    // Medals will finish loading in the background well before the final render.
    document.getElementById('searchInput').value=gt;
    await doSearch(gt, true); // isRefresh=true → shows the refresh page
  } else {
    await medalMetaPromise;
    showLanding();
  }
}
async function refreshStats(){
  var p=getAllPlayers()[selectedPlayer]||searchData;
  if(!p||!p.gamertag){toast('No player loaded','error');return;}
  matchHistoryData=null;
  await doSearch(p.gamertag, true, true);
}

// ── Feedback modal ────────────────────────────────────────────────────────────
var _fbCurrentTab = 'feedback';
function openFeedbackModal(tab) {
  _fbCurrentTab = tab || 'feedback';
  var modal = document.getElementById('feedbackModal');
  if (!modal) return;
  modal.style.display = 'flex';
  setFeedbackTab(_fbCurrentTab);
  // Focus the right textarea
  setTimeout(function(){
    var el = _fbCurrentTab === 'contact'
      ? document.getElementById('fbEmailContact')
      : document.getElementById('fbMessageFeedback');
    if (el) el.focus();
  }, 50);
}
function closeFeedbackModal() {
  var modal = document.getElementById('feedbackModal');
  if (modal) modal.style.display = 'none';
  document.getElementById('fbStatus').textContent = '';
  document.getElementById('fbMessageFeedback').value = '';
  document.getElementById('fbMessageContact').value = '';
  document.getElementById('fbEmailContact').value = '';
  var btn = document.getElementById('fbSubmitBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
}
function setFeedbackTab(tab) {
  _fbCurrentTab = tab;
  var accent = 'var(--accent)', surface2 = 'var(--surface2)', text = 'var(--text)', muted = 'var(--muted2)';
  var fbBtn = document.getElementById('fbTabFeedback');
  var ctBtn = document.getElementById('fbTabContact');
  var fbPane = document.getElementById('fbPaneFeedback');
  var ctPane = document.getElementById('fbPaneContact');
  if (!fbBtn) return;
  if (tab === 'feedback') {
    fbBtn.style.cssText = 'flex:1;padding:8px;font-family:Share Tech Mono,monospace;font-size:11px;letter-spacing:1px;border:none;cursor:pointer;background:'+accent+';color:#000;font-weight:700';
    ctBtn.style.cssText = 'flex:1;padding:8px;font-family:Share Tech Mono,monospace;font-size:11px;letter-spacing:1px;border:none;cursor:pointer;background:'+surface2+';color:'+muted+';border-left:1px solid var(--border)';
    fbPane.style.display = ''; ctPane.style.display = 'none';
  } else {
    ctBtn.style.cssText = 'flex:1;padding:8px;font-family:Share Tech Mono,monospace;font-size:11px;letter-spacing:1px;border:none;cursor:pointer;background:'+accent+';color:#000;font-weight:700;border-left:1px solid var(--border)';
    fbBtn.style.cssText = 'flex:1;padding:8px;font-family:Share Tech Mono,monospace;font-size:11px;letter-spacing:1px;border:none;cursor:pointer;background:'+surface2+';color:'+muted;
    ctPane.style.display = ''; fbPane.style.display = 'none';
  }
  document.getElementById('fbStatus').textContent = '';
}
async function submitFeedback() {
  var type = _fbCurrentTab;
  var msg = type === 'contact'
    ? (document.getElementById('fbMessageContact').value || '').trim()
    : (document.getElementById('fbMessageFeedback').value || '').trim();
  var email = type === 'contact' ? (document.getElementById('fbEmailContact').value || '').trim() : null;
  var status = document.getElementById('fbStatus');
  var btn = document.getElementById('fbSubmitBtn');
  if (!msg) { status.innerHTML = '<span style="color:var(--loss)">Message is required.</span>'; return; }
  if (type === 'contact' && email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    status.innerHTML = '<span style="color:var(--loss)">Enter a valid email or leave it blank.</span>'; return;
  }
  btn.disabled = true; btn.textContent = 'Sending...';
  status.textContent = '';
  try {
    var res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, message: msg, email: email || null })
    });
    var d = await res.json();
    if (d.success) {
      status.innerHTML = '<span style="color:var(--win)">✓ Sent — thanks!</span>';
      btn.textContent = 'Sent';
      setTimeout(closeFeedbackModal, 1400);
    } else {
      status.innerHTML = '<span style="color:var(--loss)">'+(d.error||'Something went wrong.')+'</span>';
      btn.disabled = false; btn.textContent = 'Send';
    }
  } catch(e) {
    status.innerHTML = '<span style="color:var(--loss)">Network error — try again.</span>';
    btn.disabled = false; btn.textContent = 'Send';
  }
}
