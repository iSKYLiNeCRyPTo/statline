function sectionHead(t,sub){return'<div class="section-head"><div class="section-head-line"></div><span style="font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted2);font-family:Share Tech Mono,monospace;white-space:nowrap">'+t+(sub?' <span style="font-weight:400;color:var(--muted);text-transform:none;letter-spacing:0">· '+sub+'</span>':'')+'</span><div class="section-head-line"></div></div>';}
function statCard(label,value,cls,sub){return'<div class="stat-card"><div class="stat-label">'+label+'</div><div class="stat-value'+(cls?' '+cls:'')+'">'+value+'</div>'+(sub?'<div class="stat-sub">'+sub+'</div>':'')+'</div>';}

function playerEmblem(p,size){
  size=size||36;
  var initials=(p.gamertag||'?').split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
  var fs=Math.round(size*0.38);
  var fallback='<div style="width:'+size+'px;height:'+size+'px;border-radius:4px;background:var(--surface2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-family:Rajdhani,sans-serif;font-size:'+fs+'px;font-weight:700;color:var(--accent);flex-shrink:0">'+initials+'</div>';
  // Always use the emblem endpoint — it serves the Halo emblem when cached, gamerpic otherwise
  var src=p.emblemUrl||(p.xuid?'/api/emblem?xuid='+p.xuid:null)||p.gamerpicUrl||null;
  if(!src)return fallback;
  // data-emblem-xuid lets the retry pass upgrade gamerpics to emblems after server caches them
  // Only attach retry attr when we're NOT already using a resolved emblem path — prevents scheduleEmblemRetry from swapping a good emblem for a gamerpic
  var xuidAttr=(!p.emblemUrl&&p.xuid)?' data-emblem-xuid="'+p.xuid+'"':'';
  return'<div style="width:'+size+'px;height:'+size+'px;border-radius:4px;overflow:hidden;border:1px solid var(--border);flex-shrink:0;background:var(--surface2);display:flex;align-items:center;justify-content:center"><img src="'+src+'"'+xuidAttr+' style="width:100%;height:100%;object-fit:cover;display:block" onerror="this.style.display=&quot;none&quot;;this.nextSibling.style.display=&quot;flex&quot;"><span style="display:none;width:100%;height:100%;align-items:center;justify-content:center;font-family:Rajdhani,sans-serif;font-size:'+fs+'px;font-weight:700;color:var(--accent)">'+initials+'</span></div>';
}

// After render, retry emblem images that loaded a gamerpic placeholder before the server had the path cached
function scheduleEmblemRetry(){
  clearTimeout(window._emblemRetryTimer);
  window._emblemRetryTimer=setTimeout(function(){
    document.querySelectorAll('img[data-emblem-xuid]').forEach(function(img){
      var xuid=img.getAttribute('data-emblem-xuid');
      if(!xuid)return;
      // Already showing a proper emblem endpoint — don't downgrade to a gamerpic redirect
      var curSrc=img.currentSrc||img.src||'';
      if(curSrc.indexOf('/api/emblem-img')!==-1)return;
      // Re-request the emblem endpoint — server should have the path cached by now
      var retryUrl='/api/emblem?xuid='+xuid+'&_r='+Date.now();
      var probe=new Image();
      probe.onload=function(){
        // Only swap if still showing a non-emblem src (e.g. gamerpic) — re-check in case img changed
        var nowSrc=img.currentSrc||img.src||'';
        if(nowSrc.indexOf('/api/emblem-img')!==-1)return;
        img.src=retryUrl;
      };
      probe.src=retryUrl;
    });
  },3500);
}

function toggleMatch(matchKey,idx,rawKeyArg){
  var key=matchKey!=null?String(matchKey):('overview__idx_'+(idx||0));
  var rawKey=rawKeyArg||key.replace(/^[^_]+__/,'');
  var card=document.querySelector('.match-card[data-mkey="'+key+'"]');
  if(!card){var activePanel=document.querySelector('.tab-panel.active');if(activePanel)card=activePanel.querySelector('.match-card[data-rawkey="'+rawKey+'"]');}
  expandedMatches[key]=!expandedMatches[key];
  if(!card){expandedMatches[key]=false;return;}

  // Toggle arrow
  var arrow=card.querySelector('.match-arrow');
  if(arrow)arrow.textContent=expandedMatches[key]?'▲':'▼';

  // Find or create detail panel
  var existing=card.querySelector('.match-detail-panel');
  if(existing){existing.remove();card.classList.remove('expanded');return;}

  // Need to render the detail — find match data from current filtered list
  var p=getAllPlayers()[selectedPlayer]||(data.players||[])[0];
  if(!p)return;
  function _gds(m){if(!m.duration)return 0;var mm=String(m.duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);return mm?(parseInt(mm[1]||0)*3600)+(parseInt(mm[2]||0)*60)+parseFloat(mm[3]||0):0;}
  var allM=p.allMatches||p.recentMatches||[];
  var displayM=(p.recentMatches||[]);
  // Find match — check player matches and matchHistoryData (paginated API results)
  var _histMatches=(window.matchHistoryData&&window.matchHistoryData.matches)||[];
  var m=allM.find(function(x){return x.matchId&&x.matchId.replace(/[^a-zA-Z0-9]/g,'_')===rawKey;})
    ||_histMatches.find(function(x){return x.matchId&&x.matchId.replace(/[^a-zA-Z0-9]/g,'_')===rawKey;})
    ||null;
  if(!m){expandedMatches[key]=false;if(arrow)arrow.textContent='▼';return;}

  // Use pre-computed baselines — prefer match-history-specific ones if available
  var baselines=window._matchHistoryBaselines||window._fragrBaselines||{};
  var _gdsF=function(m){
    if(!m.duration)return 0;
    var mm=String(m.duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
    return mm?(parseInt(mm[1]||0)*3600)+(parseInt(mm[2]||0)*60)+parseFloat(mm[3]||0):0;
  };

  var panel=document.createElement('div');
  panel.className='match-detail-panel';
  panel.innerHTML=renderMatchDetail(m,m,baselines,_gdsF(m));
  card.appendChild(panel);
  card.classList.add('expanded');
  resolveMatchGamertags(card);
}





async function resolveSynergyGamertags() {
  var panel = document.querySelector('.tab-panel[data-tab="objectives"]');
  if (!panel) return;
  var skeletons = panel.querySelectorAll('.syn-gt-skeleton[data-syn-xuid]');
  var xuids = [];
  skeletons.forEach(function(el) {
    var x = el.getAttribute('data-syn-xuid');
    if (x && xuids.indexOf(x) === -1) xuids.push(x);
  });
  if (!xuids.length) return;
  try {
    var res = await fetch('/api/resolve-gamertags?xuids=' + xuids.join(','));
    var d = await res.json();
    var gt = d.gamertags || {};
    panel.querySelectorAll('.syn-gt-skeleton[data-syn-xuid]').forEach(function(el) {
      var xuid = el.getAttribute('data-syn-xuid');
      if (!gt[xuid]) return;
      var name = gt[xuid];
      if (el.style.animation) {
        var span = document.createElement('span');
        span.style.cssText = 'cursor:pointer;text-decoration:underline;text-decoration-style:dotted;color:inherit';
        span.onclick = function(){ quickSearch(name); };
        span.textContent = name;
        el.parentNode.replaceChild(span, el);
      } else {
        el.textContent = name.toUpperCase();
        el.removeAttribute('data-syn-xuid');
        el.className = '';
      }
    });
  } catch(e) {}
}

async function resolveMatchGamertags(card) {
  var unknownRows = card.querySelectorAll('tr[data-xuid]');
  var xuids = [];
  unknownRows.forEach(function(row) {
    var xuid = row.getAttribute('data-xuid');
    if (xuid && row.querySelector('.gt-skeleton')) xuids.push(xuid);
  });
  if (!xuids.length) return;
  try {
    var res = await fetch('/api/resolve-gamertags?xuids=' + xuids.join(','));
    var data = await res.json();
    var gt = data.gamertags || {};
    unknownRows.forEach(function(row) {
      var xuid = row.getAttribute('data-xuid');
      if (xuid && gt[xuid]) {
        var skeleton = row.querySelector('.gt-skeleton');
        if (skeleton) skeleton.outerHTML = '<span style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted;color:inherit" onclick="quickSearch(\'' + gt[xuid].replace(/'/g, "\\'") + '\')">' + gt[xuid] + '</span>';
      }
    });
  } catch(e) {}
}
function toggleMapExpand(id){
  var panel=document.getElementById(id);
  var arr=document.getElementById(id+'_arr');
  if(!panel)return;
  var open=panel.style.display==='block';
  panel.style.display=open?'none':'block';
  if(arr)arr.textContent=open?'▼':'▲';
}
function quickSearch(gt){
  document.getElementById('searchInput').value=gt;
  searchPlayer();
}
