var _origData=null;
function clearSearch(){
  searchMode=false;searchData=null;
  if(_origData){data=_origData;_origData=null;}
  selectedPlayer=0;
  var sb=document.getElementById('searchBanner');
  if(sb)sb.style.display='none';
  try{document.getElementById('searchInput').value='';}catch(e){}
  try{document.getElementById('mobileSearchInput').value='';}catch(e){}
  expandedMatches={};
  render();
}
function toggleFav(gt){
  var cgt=canonicalGt(gt);
  if(isFavorite(cgt)){ removeFavorite(cgt); } else { addFavorite(cgt); }
  // Sync fragrFavs
  if(isFragrFav(cgt)){
    fragrFavs=fragrFavs.filter(function(g){return g.toLowerCase()!==cgt.toLowerCase();});
    if(!isFavorite(cgt)){ /* already removed above */ }
  } else if(isFavorite(cgt)){
    fragrFavs=fragrFavs.filter(function(g){return g.toLowerCase()!==cgt.toLowerCase();});
    fragrFavs.unshift(cgt);
    if(fragrFavs.length>20)fragrFavs=fragrFavs.slice(0,20);
  }
  _saveFragrFavs();
  renderPlayerBtns();
  updateFavBtn();
  if(searchData&&searchData.gamertag.toLowerCase()===cgt.toLowerCase()){ updateBannerFavBtn(); renderSearch(); }
  render();
}
function toggleBannerFavorite(){ if(!searchData)return; toggleFav(searchData.gamertag); }
function updateBannerFavBtn(){
  var btn=document.getElementById('bannerFavBtn');
  if(!btn||!searchData)return;
  var fav=isFavorite(searchData.gamertag);
  var _starSvg='<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  var _starEmptySvg='<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  btn.innerHTML=fav?_starSvg+' FAVORITED':_starEmptySvg+' FAVORITE';
  btn.style.borderColor=fav?'#ffc107':'var(--border)';
  btn.style.color=fav?'#ffc107':'var(--muted)';
  btn.style.background=fav?'rgba(255,193,7,0.1)':'transparent';
}
function renderSearch(){
  if(!searchData)return;
  // Save original data so clearSearch can restore it
  if(!_origData&&data&&!data._searchOverride)_origData=data;
  data={players:[searchData],csrHistory:[],_searchOverride:true};
  selectedPlayer=0;
  var _isFavNow=isFavorite(searchData.gamertag);
  var _favBtn=_isFavNow
    ? '<button data-gt="'+searchData.gamertag.replace(/"/g,'&quot;')+'" onclick="toggleFav(this.dataset.gt)" style="background:rgba(255,193,7,0.15);border:1px solid #ffc107;color:#ffc107;padding:3px 10px;border-radius:4px;font-family:Share Tech Mono,monospace;font-size:10px;cursor:pointer;display:inline-flex;align-items:center;gap:4px"><svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"10\\" height=\\"10\\" viewBox=\\"0 0 24 24\\" fill=\\"currentColor\\" stroke=\\"currentColor\\" stroke-width=\\"1.5\\"><polygon points=\\"12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2\\"/></svg> Favorited</button>'
    : '<button data-gt="'+searchData.gamertag.replace(/"/g,'&quot;')+'" onclick="toggleFav(this.dataset.gt)" style="background:transparent;border:1px solid var(--border);color:var(--muted);padding:3px 10px;border-radius:4px;font-family:Share Tech Mono,monospace;font-size:10px;cursor:pointer;display:inline-flex;align-items:center;gap:4px" onmouseover="this.style.borderColor=\'#ffc107\';this.style.color=\'#ffc107\'" onmouseout="this.style.borderColor=\'var(--border)\';this.style.color=\'var(--muted)\'"><svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"10\\" height=\\"10\\" viewBox=\\"0 0 24 24\\" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"2\\"><polygon points=\\"12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2\\"/></svg> Favorite</button>';
  var banner='<div style="background:var(--surface2);border:1px solid var(--accent);border-radius:8px;padding:10px 16px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;gap:8px">'
    +'<span style="font-family:Share Tech Mono,monospace;font-size:11px;color:var(--accent)"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"12\" height=\"12\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><circle cx=\"11\" cy=\"11\" r=\"8\"/><line x1=\"21\" y1=\"21\" x2=\"16.65\" y2=\"16.65\"/></svg> Viewing: '+searchData.gamertag+'</span>'
    +'<div style="display:flex;gap:6px">'+_favBtn+'<button onclick="clearSearch()" style="background:transparent;border:1px solid var(--border);color:var(--muted);padding:3px 10px;border-radius:4px;font-family:Share Tech Mono,monospace;font-size:10px;cursor:pointer">✕ Back</button></div>'
    +'</div>';
  // Show persistent banner
  var sb=document.getElementById('searchBanner');
  var sbn=document.getElementById('searchBannerName');
  if(sb){sb.style.display='flex';}
  if(sbn)sbn.textContent=searchData.gamertag;
  updateBannerFavBtn();
  // Render with search player injected
  render();
}
async function loadFullMatches(gamertag, force, bannerLabel){
  if(!gamertag) return;
  var cached=fullMatchCache[gamertag];
  if(!force&&cached&&cached._fetchedAt&&Date.now()-cached._fetchedAt<300000) return;
  var _showBanner=function(){
    if(document.getElementById('_fullMatchBanner')) return;
    var b=document.createElement('div');
    b.id='_fullMatchBanner';
    b.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--surface2);border:1px solid var(--border2);border-radius:20px;padding:5px 14px;font-family:Share Tech Mono,monospace;font-size:11px;color:var(--muted);z-index:500;display:flex;align-items:center;gap:8px;pointer-events:none';
    b.innerHTML='<div style="width:8px;height:8px;border:1.5px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.7s linear infinite;flex-shrink:0"></div>'+(bannerLabel||'Loading full match history…');
    document.body.appendChild(b);
  };
  var _hideBanner=function(){
    var b=document.getElementById('_fullMatchBanner');if(b)b.remove();
  };
  var _safetyTimer=null,_abortCtrl=null,_abortTimer=null;
  try{
    _showBanner();
    _safetyTimer=setTimeout(_hideBanner,28000); // always hide after 28s (e.g. server restarts mid-deploy)
    _abortCtrl=new AbortController();
    _abortTimer=setTimeout(function(){_abortCtrl.abort();},25000);
    var res=await fetch('/api/matches?gamertag='+encodeURIComponent(gamertag)+'&page=1&perPage=250',{signal:_abortCtrl.signal});
    clearTimeout(_abortTimer);
    var d=await res.json();
    clearTimeout(_safetyTimer);
    _hideBanner();
    if(d.matches&&d.matches.length>0){
      d.matches._fetchedAt=Date.now();
      fullMatchCache[gamertag]=d.matches;
      render(); // re-render with full match data including hitreg and insights
      setTimeout(updateFavBtn, 0); // restore star state after render wipes heroFavBtn
      // Resolve gamertags for any match cards that were already open before the re-render
      setTimeout(function(){
        document.querySelectorAll('.match-card.expanded').forEach(function(card){
          resolveMatchGamertags(card);
        });
      }, 0);
      if(activeTab==='charts') setTimeout(resolveSynergyGamertags, 200);
      if(activeTab==='matches'&&matchHistoryData&&matchHistoryData._gamertag===gamertag){
        var _upd={matches:d.matches,page:1,totalPages:Math.max(1,Math.ceil(d.matches.length/25)),total:d.matches.length,_gamertag:gamertag};
        matchHistoryData=_upd;
        renderMatchHistory(_upd,matchHistoryData._clientPage||1);
      }
    }
  }catch(e){ clearTimeout(_abortTimer);clearTimeout(_safetyTimer);_hideBanner(); if(e.name!=='AbortError')console.warn('[loadFullMatches]',e.message); }
}
function switchPlayer(idx){
  selectedPlayer=idx;expandedMatches={};activeTab='overview';render();
  var _sp=getAllPlayers()[idx];
  if(_sp&&_sp.gamertag){
    loadFullMatches(_sp.gamertag);
    // Refresh backfill info for favorites so button shows correct state
    var _isFav=isFavorite(_sp.gamertag);
    var _isTracked=((data&&data.players)||[]).some(function(p){return p.gamertag===_sp.gamertag;});
    if(_isFav&&!_isTracked) fetchFavMatchInfo(_sp.gamertag);
  }
  var p=getAllPlayers()[idx];
  if(p&&!p._loading)document.title=p.gamertag+' — Halo Stats';
  var url=new URL(window.location);
  url.searchParams.set('player',getAllPlayers()[idx]?.gamertag||'');
  window.history.replaceState({},'',url);
}
function renderPlayerBtns(){
  // No sidebar in production — single player view
  var p=playerData;
  if(!p)return;
  var gt=document.getElementById('sidebarGt');
  var av=document.getElementById('sidebarAvatar');
  var rk=document.getElementById('sidebarRank');
  if(gt)gt.textContent=p.gamertag||'';
  if(av){var _avSrc=p.emblemUrl||(p.xuid?'/api/emblem?xuid='+p.xuid:null)||p.gamerpicUrl||'';av.src=_avSrc;av.setAttribute('data-emblem-xuid',p.xuid||'');av.style.display=_avSrc?'block':'none';}
  if(rk){var csr=p.csr;var topCsr=csr?Object.values(csr).filter(function(c){return c&&c.tier;}).sort(function(a,b){return b.value-a.value;})[0]:null;rk.textContent=topCsr?topCsr.display:'';}
}
function renderDuoSynergy(duo,gamertag){ return renderTeamSynergy(duo,gamertag); }

function renderTeamSynergy(duo,gamertag){
  var p=(data&&data.players||[]).find(function(x){return x.gamertag===gamertag;});
  if(!p)return'';
  var allM=p.allMatches||p.recentMatches||[];
  // Filter to matches with team data — teams array must have players
  var rankedM=allM.filter(function(m){
    return m.isRanked&&m.teams&&m.teams.length>0&&
      m.teams.some(function(t){return t.players&&t.players.length>0;});
  });
  // If no team data at all, show a helpful message
  if(!rankedM.length){
    return sectionHead('Team Synergy')
      +'<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:24px;font-family:Share Tech Mono,monospace;font-size:11px;color:var(--muted)">No team match data yet — run /api/backfill-matches to populate</div>';
  }

  // Build rich per-teammate data including individual stats per shared match
  var tmMap={};
  rankedM.forEach(function(m){
    var myTeam=m.teams.find(function(t){return t.players&&t.players.some(function(pl){return pl.gamertag&&pl.gamertag.toLowerCase()===gamertag.toLowerCase();});});
    if(!myTeam)return;
    var me=myTeam.players.find(function(pl){return pl.gamertag&&pl.gamertag.toLowerCase()===gamertag.toLowerCase();});
    myTeam.players.forEach(function(pl){
      if(pl.gamertag&&pl.gamertag.toLowerCase()===gamertag.toLowerCase())return;
      var gt=pl.gamertag;
      var gtKey=gt.toLowerCase();  // normalize case for deduplication
      if(!tmMap[gtKey])tmMap[gtKey]={wins:0,losses:0,games:0,csrDeltas:[],
        tmKills:[],tmDeaths:[],tmDamage:[],tmKd:[],
        myKills:[],myDeaths:[],myDamage:[],
        modes:{},maps:{},displayName:gt,gamerpicUrl:pl.gamerpicUrl||null,rawXuid:pl.rawXuid||null};
      if(pl.gamerpicUrl&&!tmMap[gtKey].gamerpicUrl)tmMap[gtKey].gamerpicUrl=pl.gamerpicUrl;
      if(pl.rawXuid&&!tmMap[gtKey].rawXuid)tmMap[gtKey].rawXuid=pl.rawXuid;
      var d=tmMap[gtKey];
      d.games++;
      if(m.outcome===2)d.wins++; else if(m.outcome===3)d.losses++;
      if(m.csrDelta!=null)d.csrDeltas.push(m.csrDelta);
      // Teammate stats this match
      if(pl.kills!=null)d.tmKills.push(pl.kills);
      if(pl.deaths!=null)d.tmDeaths.push(pl.deaths);
      if(pl.damage!=null)d.tmDamage.push(pl.damage);
      if(pl.kd!=null)d.tmKd.push(parseFloat(pl.kd));
      // My stats this match
      if(me){
        if(me.kills!=null)d.myKills.push(me.kills);
        if(me.deaths!=null)d.myDeaths.push(me.deaths);
        if(me.damage!=null)d.myDamage.push(me.damage);
      }
      // Mode and map breakdown
      var mode=(m.gameMode||'Unknown').replace(/Ranked /,'');
      if(!d.modes[mode])d.modes[mode]={wins:0,total:0};
      d.modes[mode].total++;if(m.outcome===2)d.modes[mode].wins++;
      var map=m.mapName||'Unknown';
      if(!d.maps[map])d.maps[map]={wins:0,total:0};
      d.maps[map].total++;if(m.outcome===2)d.maps[map].wins++;
    });
  });

  function avg(arr){return arr.length?arr.reduce(function(a,b){return a+b;},0)/arr.length:null;}
  function pct(arr,fn){return arr.length?Math.round(arr.filter(fn).length/arr.length*100):null;}

  var teammates=Object.entries(tmMap)
    .filter(function(e){return e[1].games>=4;})
    .sort(function(a,b){return b[1].games-a[1].games;})
    .slice(0,10)
    .map(function(e){return[e[1].displayName||e[0],e[1]];});  // use display name

  // Solo stats
  var soloM=rankedM.filter(function(m){
    if(!m.teams)return true;
    var myTeam=m.teams.find(function(t){return t.players&&t.players.some(function(pl){return pl.gamertag&&pl.gamertag.toLowerCase()===gamertag.toLowerCase();});});
    return !myTeam||myTeam.players.length===1;
  });
  var soloWR=soloM.length>=3?Math.round(soloM.filter(function(m){return m.outcome===2;}).length/soloM.length*100):null;

  // (All Tracked Together removed — no need to compute trioM)

  var html=sectionHead('Team Synergy');
  html+='<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:24px">';

  // Solo baseline card
  if(soloM.length>=3){
    html+=synCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" style=\"vertical-align:-1px\"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 12h4m-2-2v4"/><circle cx="15" cy="11" r="1"/><circle cx="18" cy="13" r="1"/></svg> Solo Queue',soloM.length,soloWR,null,'var(--muted2)',null,null,null);
  }

  // Per-teammate expandable cards
  teammates.forEach(function(e,idx){
    var gt=e[0],tm=e[1];
    var wr=Math.round(tm.wins/tm.games*100);
    var avgDelta=avg(tm.csrDeltas);
    var avgDeltaStr=avgDelta!=null?(avgDelta>0?'+':'')+avgDelta.toFixed(1):null;
    var vsLabel=soloWR!=null?(wr>soloWR?'▲ +'+(wr-soloWR)+'% vs solo':wr<soloWR?'▼ -'+(soloWR-wr)+'% vs solo':'= Same as solo'):null;
    var vsColor=soloWR!=null?(wr>soloWR?'var(--win)':wr<soloWR?'var(--loss)':'var(--muted)'):null;

    // Rich stats
    var tmAvgKills=avg(tm.tmKills);
    var tmAvgKd=avg(tm.tmKd);
    var tmAvgDmg=avg(tm.tmDamage);
    var myAvgKills=avg(tm.myKills);
    var myAvgDmg=avg(tm.myDamage);

    // Best mode and map together
    var bestMode=Object.entries(tm.modes).filter(function(e){return e[1].total>=2;})
      .sort(function(a,b){return(b[1].wins/b[1].total)-(a[1].wins/a[1].total);})[0];
    var bestMap=Object.entries(tm.maps).filter(function(e){return e[1].total>=2;})
      .sort(function(a,b){return(b[1].wins/b[1].total)-(a[1].wins/a[1].total);})[0];
    var worstMap=Object.entries(tm.maps).filter(function(e){return e[1].total>=2;})
      .sort(function(a,b){return(a[1].wins/a[1].total)-(b[1].wins/b[1].total);})[0];

    var panelId='syn_'+idx;
    var wrColor=wr>=55?'var(--win)':wr<=45?'var(--loss)':'var(--gold)';

    // Header row — always visible
    html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">';
    html+='<div onclick="toggleSynCard(\''+panelId+'\')" style="padding:12px 16px;display:flex;align-items:center;gap:14px;cursor:pointer">';
    html+='<div style="flex:1">';
    // Avatar — use emblem endpoint if xuid available, gamerpic if not, initials as last resort
    var _isSpartanFallback=/^Spartan\s+\d+$/i.test(gt);
    var _initials=_isSpartanFallback?'?':gt.split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
    var _synXuid=tm.rawXuid||null;
    var _synSrc=_synXuid?'/api/emblem?xuid='+_synXuid:(tm.gamerpicUrl||null);
    var _synPic=_synSrc
      ?'<div style="width:28px;height:28px;border-radius:4px;overflow:hidden;flex-shrink:0;background:var(--surface3);display:flex;align-items:center;justify-content:center"><img src="'+_synSrc+'" data-emblem-xuid="'+(tm.rawXuid||'')+'" style="width:100%;height:100%;object-fit:cover;display:block" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'flex\'"><span style="display:none;width:100%;height:100%;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:var(--accent);font-family:Rajdhani,sans-serif">'+_initials+'</span></div>'
      :'<span style="width:28px;height:28px;border-radius:4px;background:var(--surface3);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:var(--accent);font-family:Rajdhani,sans-serif;flex-shrink:0">'+_initials+'</span>';
    var _displayGt=_isSpartanFallback&&_synXuid?'<span class="syn-gt-skeleton" data-syn-xuid="'+_synXuid+'" style="display:inline-block;width:90px;height:11px;background:var(--surface3);border-radius:3px;vertical-align:middle;animation:gtpulse 1.2s ease-in-out infinite"></span>':(_isSpartanFallback?'<span style="color:var(--muted)">Unknown</span>':gt);
    html+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">'+_synPic+'<span style="font-size:12px;font-weight:700;color:var(--text)">'+_displayGt+'</span></div>';
    html+='<div style="font-size:11px;color:var(--muted);font-family:Share Tech Mono,monospace">'+tm.games+' games together</div>';
    html+='</div>';
    // Stats cluster
    html+='<div style="display:flex;gap:16px;align-items:center">';
    html+='<div style="text-align:right"><div style="font-size:20px;font-weight:700;font-family:Rajdhani,sans-serif;color:'+wrColor+'">'+wr+'%</div><div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace">WIN</div></div>';
    if(avgDeltaStr)html+='<div style="text-align:right"><div style="font-size:14px;font-weight:700;font-family:Rajdhani,sans-serif;color:'+(avgDelta>=0?'var(--win)':'var(--loss)')+'">'+avgDeltaStr+'</div><div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace">CSR/G</div></div>';
    if(vsLabel)html+='<div style="font-size:9px;color:'+vsColor+';font-family:Share Tech Mono,monospace;min-width:80px;text-align:right">'+vsLabel+'</div>';
    html+='<span id="'+panelId+'_arr" style="color:var(--muted2);font-size:10px;margin-left:4px">▼</span>';
    html+='</div></div>';

    // Expandable detail panel — clean readable layout
    html+='<div id="'+panelId+'" style="display:none;padding:16px;border-top:1px solid var(--border);background:var(--surface2)">';

    // Two-column stat comparison: Them vs Me
    html+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">';
    // Their column
    html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px 14px">';
    html+='<div style="font-size:11px;font-weight:700;color:var(--accent);font-family:Share Tech Mono,monospace;margin-bottom:10px;letter-spacing:1px">'+((_isSpartanFallback&&_synXuid)?'<span class="syn-gt-skeleton" data-syn-xuid="'+_synXuid+'">???</span>':gt.toUpperCase())+'</div>';
    if(tmAvgKills!=null)html+='<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border)"><span style="font-size:12px;color:var(--muted2)">Kills/game</span><span style="font-size:14px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--text)">'+tmAvgKills.toFixed(1)+'</span></div>';
    if(tmAvgKd!=null)html+='<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border)"><span style="font-size:12px;color:var(--muted2)">K/D</span><span style="font-size:14px;font-weight:700;font-family:Rajdhani,sans-serif;color:'+(tmAvgKd>=1?'var(--win)':'var(--loss)')+'">'+tmAvgKd.toFixed(2)+'</span></div>';
    if(tmAvgDmg!=null)html+='<div style="display:flex;justify-content:space-between;padding:5px 0"><span style="font-size:12px;color:var(--muted2)">Damage</span><span style="font-size:14px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--text)">'+Math.round(tmAvgDmg).toLocaleString()+'</span></div>';
    html+='</div>';
    // My column
    html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px 14px">';
    html+='<div style="font-size:11px;font-weight:700;color:var(--muted2);font-family:Share Tech Mono,monospace;margin-bottom:10px;letter-spacing:1px">MY STATS W/ THEM</div>';
    if(myAvgKills!=null)html+='<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border)"><span style="font-size:12px;color:var(--muted2)">Kills/game</span><span style="font-size:14px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--accent)">'+myAvgKills.toFixed(1)+'</span></div>';
    if(myAvgDmg!=null)html+='<div style="display:flex;justify-content:space-between;padding:5px 0"><span style="font-size:12px;color:var(--muted2)">Damage</span><span style="font-size:14px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--accent)">'+Math.round(myAvgDmg).toLocaleString()+'</span></div>';
    html+='</div>';
    html+='</div>';

    // Best mode / maps row
    if(bestMode||bestMap){
      html+='<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">';
      if(bestMode){
        var bmwr=Math.round(bestMode[1].wins/bestMode[1].total*100);
        html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 12px;flex:1;min-width:140px">';
        html+='<div style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace;margin-bottom:3px">BEST MODE</div>';
        html+='<div style="font-size:13px;font-weight:600;color:var(--text)">'+bestMode[0].replace('Ranked ','')+'</div>';
        html+='<div style="font-size:12px;color:'+(bmwr>=50?'var(--win)':'var(--loss)') +'">'+bmwr+'% WR ('+bestMode[1].total+' games)</div>';
        html+='</div>';
      }
      if(bestMap&&bestMap[0]){
        var bpwr=Math.round(bestMap[1].wins/bestMap[1].total*100);
        html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 12px;flex:1;min-width:120px">';
        html+='<div style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace;margin-bottom:3px">BEST MAP</div>';
        html+='<div style="font-size:13px;font-weight:600;color:var(--win)">'+bestMap[0]+'</div>';
        html+='<div style="font-size:12px;color:var(--win)">'+bpwr+'% WR</div>';
        html+='</div>';
      }
      if(worstMap&&worstMap[0]&&(!bestMap||worstMap[0]!==bestMap[0])){
        var wpwr=Math.round(worstMap[1].wins/worstMap[1].total*100);
        html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 12px;flex:1;min-width:120px">';
        html+='<div style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace;margin-bottom:3px">WORST MAP</div>';
        html+='<div style="font-size:13px;font-weight:600;color:var(--loss)">'+worstMap[0]+'</div>';
        html+='<div style="font-size:12px;color:var(--loss)">'+wpwr+'% WR</div>';
        html+='</div>';
      }
      html+='</div>';
    }

    // W/L record bar
    var wPct=Math.round(tm.wins/tm.games*100);
    html+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
    html+='<span style="font-size:12px;color:var(--muted2);font-family:Share Tech Mono,monospace">RECORD</span>';
    html+='<span style="font-size:12px;font-weight:700;color:var(--text);font-family:Rajdhani,sans-serif">'+tm.wins+'W &ndash; '+tm.losses+'L</span>';
    html+='</div>';
    html+='<div style="height:6px;background:var(--surface3);border-radius:3px;overflow:hidden"><div style="height:100%;width:'+wPct+'%;background:'+(wPct>=50?'var(--win)':'var(--loss)')+';border-radius:3px;transition:width 0.3s"></div></div>';

    html+='</div></div>'; // close detail + card
  });

  // (All Tracked Together removed — not meaningful as a summary stat)

  html+='</div>';
  return html;
}
