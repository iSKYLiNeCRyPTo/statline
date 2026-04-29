async function doSearch(gt, isRefresh, force){
  if(!gt||!gt.trim())return;
  gt=gt.trim();
  var myToken = ++_searchToken; // claim this search slot
  function isCurrent(){ return _searchToken === myToken; } // false = newer search started, bail
  hideLanding();
  var dtb=document.getElementById('desktopTabBar');if(dtb)dtb.style.display=window.innerWidth>=768?'flex':'none';
  var cb=document.getElementById('clearSearchBtn');if(cb)cb.style.display='inline';
  document.getElementById('searchInput').value=gt;
  matchHistoryData=null;
  _pickNewAd(); // rotate to a new sponsor each search

  // ── Loading page (new search) ────────────────────────────────────────────
  var _loadSteps=[
    {id:'s1',label:'Service record'},
    {id:'s2',label:'Match history'},
    {id:'s3',label:'Skill data'},
    {id:'s4',label:'Team data'},
    {id:'s5',label:'Analyzing data'}
  ];
  var _loadPlayer=null; // populated after step 1 returns
  function _renderLoadSteps(activeIdx,matchProgress){
    var _lsMobile=window.innerWidth<768;
    var pct=Math.round((activeIdx/5)*100);
    var p=_loadPlayer;

    // Step dots
    var dotsHtml='<div style="display:flex;flex-direction:column;gap:10px;margin-top:16px">';
    _loadSteps.forEach(function(step,i){
      var done=i<activeIdx,active=i===activeIdx,label=step.label;
      if(active&&i===1&&matchProgress) label='Match history · '+matchProgress.valid+' ranked'+(matchProgress.scanned?' / '+matchProgress.scanned+' scanned':'');
      var dotColor=done?'var(--win)':active?'var(--accent)':'var(--surface3)';
      var textColor=done?'var(--win)':active?'var(--text)':'var(--muted2)';
      var labelHtml=(active&&i===4)
        ?'Analyzing data<span class="load-dots"><span>.</span><span>.</span><span>.</span></span>'
        :(active&&i===2)
        ?'Skill data<span class="load-dots"><span>.</span><span>.</span><span>.</span></span>'
        :label+(done?' ✓':'');
      dotsHtml+='<div style="display:flex;align-items:center;gap:10px">'
        +'<div style="width:8px;height:8px;border-radius:50%;background:'+dotColor+';flex-shrink:0;'+(active?'box-shadow:0 0 6px var(--accent);animation:pulse 1.2s ease-in-out infinite':'')+';transition:all 0.3s"></div>'
        +'<div '+(active&&i===1?'id="_lc_step2lbl" ':'')+' style="font-family:Share Tech Mono,monospace;font-size:11px;color:'+textColor+';transition:color 0.3s">'+labelHtml+'</div>'
        +'</div>';
    });
    dotsHtml+='</div>';

    var leftHtml;
    if(p){
      // After step 1: show player card with nameplate, emblem, stats — same as refresh page
      var emblemSize=_lsMobile?'48px':'60px';
      var gtFontSize=_lsMobile?'clamp(20px,6vw,30px)':'34px';
      var statFontSize=_lsMobile?'18px':'20px';
      var initials=gt.replace(/\s+/g,'').slice(0,2).toUpperCase();
      var topCsr2=null;
      if(p.csr){var cv2=Object.values(p.csr);if(cv2.length)topCsr2=cv2.sort(function(a,b){return b.value-a.value;})[0];}
      var _npStyle2=p.nameplateUrl?'background-image:url(\''+p.nameplateUrl+'\');':'';
      leftHtml=''
        +'<div style="border-radius:12px;padding:20px;background:var(--surface2);border:1px solid var(--border)">'
        +'<div style="height:3px;background:var(--surface3);border-radius:2px;margin-bottom:18px;overflow:hidden">'
        +'<div id="_lc_prog" style="height:100%;background:var(--accent);border-radius:2px;width:'+pct+'%;transition:width 0.4s ease"></div>'
        +'</div>'
        +'<div style="position:relative;border-radius:8px;overflow:hidden;margin-bottom:18px">'
        +(_npStyle2?'<div style="position:absolute;inset:0;'+_npStyle2+'background-size:cover;background-position:center center;opacity:0.18;pointer-events:none"></div>':'')
        +'<div style="position:relative;display:flex;align-items:center;gap:12px;padding:12px 8px">'
        +(p.emblemUrl
          ?'<img src="'+p.emblemUrl+'" style="width:'+emblemSize+';height:'+emblemSize+';object-fit:contain;flex-shrink:0;filter:drop-shadow(0 0 8px rgba(var(--accent-r,56),var(--accent-g,138),var(--accent-b,221),0.5))" alt="">'
          :'<div style="width:'+emblemSize+';height:'+emblemSize+';background:var(--surface3);border:2px solid var(--border2);border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-family:Rajdhani,sans-serif;font-size:20px;font-weight:700;color:var(--accent)">'+initials+'</div>')
        +'<div style="min-width:0">'
        +'<div style="font-family:Rajdhani,sans-serif;font-size:'+gtFontSize+';font-weight:700;letter-spacing:2px;color:var(--text);line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+gt+'</div>'
        +(p&&p.serviceTag?'<div style="font-family:Share Tech Mono,monospace;font-size:10px;color:var(--muted2);margin-top:3px;letter-spacing:1.5px">['+p.serviceTag+']</div>':'')
        +'<div style="font-size:9px;font-family:Share Tech Mono,monospace;color:var(--muted2);margin-top:2px;letter-spacing:1px">HALO INFINITE · RANKED</div>'
        +'</div>'
        +'</div></div>'  // close position:relative content + nameplate row
        // Stat boxes
        +'<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:4px">';
      var statItems2=[
        {val:p.stats?(p.stats.kd||'—'):'—',lbl:'K/D',color:'var(--text)'},
        {val:topCsr2?(topCsr2.display||'—'):'—',lbl:'CSR',color:'var(--accent)'},
        {val:p.stats&&p.stats.winRate?(p.stats.winRate+'%'):'—',lbl:'WIN RATE',color:'var(--text)'}
      ];
      statItems2.forEach(function(s){
        leftHtml+='<div style="background:var(--surface3);border:1px solid var(--border);border-radius:6px;padding:10px 6px;text-align:center">'
          +'<div style="font-family:Rajdhani,sans-serif;font-size:'+statFontSize+';font-weight:700;color:'+s.color+';line-height:1">'+s.val+'</div>'
          +'<div style="font-size:8px;font-family:Share Tech Mono,monospace;color:var(--muted2);margin-top:3px;letter-spacing:1px">'+s.lbl+'</div>'
          +'</div>';
      });
      leftHtml+=''
        +'</div>'
        +dotsHtml
        +'</div>'; // close outer card
    } else {
      // Before step 1: plain gamertag + progress bar + dots
      leftHtml=''
        +'<div style="font-family:Rajdhani,sans-serif;font-size:22px;font-weight:700;color:var(--text);margin-bottom:6px;letter-spacing:1px">'+gt+'</div>'
        +'<div style="height:3px;background:var(--surface3);border-radius:2px;margin-bottom:22px;overflow:hidden">'
        +'<div style="height:100%;background:var(--accent);border-radius:2px;width:'+pct+'%;transition:width 0.4s ease"></div>'
        +'</div>'
        +dotsHtml;
    }

    // If the layout skeleton already exists, only swap the player section — leave the ad untouched
    var _existingPS=document.getElementById('_lc_playersect');
    if(_existingPS){
      _existingPS.innerHTML=leftHtml;
    } else {
      var html;
      if(_lsMobile){
        html='<div style="height:calc(100vh - 100px);display:flex;flex-direction:column;padding:20px 16px 12px;box-sizing:border-box;overflow:hidden">'
          +'<div id="_lc_playersect" style="margin-bottom:16px;flex-shrink:0">'+leftHtml+'</div>'
          +'<div style="flex:1;min-height:0;display:flex;flex-direction:column">'+_renderAdSlot('card')+'</div>'
          +'</div>';
      } else {
        html='<div style="min-height:calc(100vh - 100px);display:flex;align-items:center;justify-content:center;padding:32px 24px;box-sizing:border-box">'
          +'<div style="display:flex;align-items:flex-start;gap:32px;max-width:860px;width:100%">'
          +'<div id="_lc_playersect" style="flex:1;min-width:0">'+leftHtml+'</div>'
          +'<div style="width:340px;flex-shrink:0">'+_renderAdSlot('card')+'</div>'
          +'</div></div>';
      }
      document.getElementById('app').innerHTML=html;
    }
  }

  // ── Refresh page (page reload with existing player) ──────────────────────
  function _renderRefreshPage(player, status){
    var p=player;
    var isMobile=window.innerWidth<768;
    var topCsr=null;
    if(p&&p.csr){var cv=Object.values(p.csr);if(cv.length)topCsr=cv.sort(function(a,b){return b.value-a.value;})[0];}
    var initials=gt.replace(/\s+/g,'').slice(0,2).toUpperCase();

    // Responsive sizes
    var emblemSize = isMobile ? '48px' : '60px';
    var gtFontSize = isMobile ? 'clamp(20px, 6vw, 30px)' : '34px';
    var statFontSize = isMobile ? '18px' : '20px';

    // Player identity header — wrapped in nameplate container
    var _npStyle=p&&p.nameplateUrl?'background-image:url(\''+p.nameplateUrl+'\');':'';
    var playerSection=''
      +'<div style="border-radius:12px;padding:20px;background:var(--surface2);border:1px solid var(--border);margin-bottom:18px">'
      +'<div style="position:relative;border-radius:8px;overflow:hidden;margin-bottom:18px">'
      +(_npStyle?'<div style="position:absolute;inset:0;'+_npStyle+'background-size:cover;background-position:center center;opacity:0.18;pointer-events:none"></div>':'')
      +'<div style="position:relative;display:flex;align-items:center;gap:12px;padding:12px 8px">'
      +(p&&p.emblemUrl
        ?'<img src="'+p.emblemUrl+'" style="width:'+emblemSize+';height:'+emblemSize+';object-fit:contain;flex-shrink:0;filter:drop-shadow(0 0 8px rgba(var(--accent-r,56),var(--accent-g,138),var(--accent-b,221),0.5))" alt="">'
        :'<div style="width:'+emblemSize+';height:'+emblemSize+';background:var(--surface3);border:2px solid var(--border2);border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-family:Rajdhani,sans-serif;font-size:20px;font-weight:700;color:var(--accent)">'+initials+'</div>')
      +'<div style="min-width:0">'
      +'<div style="font-family:Rajdhani,sans-serif;font-size:'+gtFontSize+';font-weight:700;letter-spacing:2px;color:var(--text);line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+gt+'</div>'
      +(p&&p.serviceTag?'<div style="font-family:Share Tech Mono,monospace;font-size:10px;color:var(--muted2);margin-top:3px;letter-spacing:1.5px">['+p.serviceTag+']</div>':'')
      +'<div style="font-size:9px;font-family:Share Tech Mono,monospace;color:var(--muted2);margin-top:2px;letter-spacing:1px">HALO INFINITE · RANKED</div>'
      +'</div>'
      +'</div></div>'; // close content row + nameplate container

    // Stats grid
    if(p&&p.stats){
      playerSection+='<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:18px">';
      var statItems=[
        {val:p.stats.kd||'—',lbl:'K/D',color:'var(--text)'},
        {val:topCsr?(topCsr.display||'—'):'—',lbl:'CSR',color:'var(--accent)'},
        {val:p.stats.winRate?(p.stats.winRate+'%'):'—',lbl:'WIN RATE',color:'var(--text)'}
      ];
      statItems.forEach(function(s){
        playerSection+='<div style="background:var(--surface3);border:1px solid var(--border);border-radius:6px;padding:10px 6px;text-align:center">'
          +'<div style="font-family:Rajdhani,sans-serif;font-size:'+statFontSize+';font-weight:700;color:'+s.color+';line-height:1">'+s.val+'</div>'
          +'<div style="font-size:8px;font-family:Share Tech Mono,monospace;color:var(--muted2);margin-top:3px;letter-spacing:1px">'+s.lbl+'</div>'
          +'</div>';
      });
      playerSection+='</div>';
    } else {
      playerSection+='<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:18px">';
      for(var _i=0;_i<3;_i++) playerSection+='<div class="skeleton" style="height:52px;border-radius:6px"></div>';
      playerSection+='</div>';
    }

    // Status line
    var statusLabel=status==='analyzing'
      ?'Analyzing data<span class="load-dots"><span>.</span><span>.</span><span>.</span></span>'
      :status==='skilldata'
      ?'Fetching skill data<span class="load-dots"><span>.</span><span>.</span><span>.</span></span>'
      :status==='loading'
      ?'Updating stats<span class="load-dots"><span>.</span><span>.</span><span>.</span></span>'
      :'Connecting<span class="load-dots"><span>.</span><span>.</span><span>.</span></span>';
    playerSection+='<div style="display:flex;align-items:center;gap:8px">'
      +'<div style="width:7px;height:7px;border-radius:50%;background:var(--accent);animation:pulse 1.2s ease-in-out infinite;box-shadow:0 0 6px var(--accent);flex-shrink:0"></div>'
      +'<div style="font-family:Share Tech Mono,monospace;font-size:11px;color:var(--muted)">'+statusLabel+'</div>'
      +'</div>'
      +'</div>'; // close outer card

    // If the layout skeleton already exists, only swap the player section — leave the ad untouched
    var _existingPS2=document.getElementById('_lc_playersect');
    if(_existingPS2){
      _existingPS2.innerHTML=playerSection;
    } else {
      var html;
      if(isMobile){
        // Mobile: player info at top, ad card fills remaining screen — no scroll
        html='<div style="height:calc(100vh - 100px);display:flex;flex-direction:column;padding:20px 16px 12px;box-sizing:border-box;overflow:hidden">'
          +'<div id="_lc_playersect" style="margin-bottom:16px;flex-shrink:0">'+playerSection+'</div>'
          +'<div style="flex:1;min-height:0;display:flex;flex-direction:column">'+_renderAdSlot('card')+'</div>'
          +'</div>';
      } else {
        // Desktop: two-column — player left, ad right
        html='<div style="min-height:calc(100vh - 100px);display:flex;align-items:center;justify-content:center;padding:32px 24px;box-sizing:border-box">'
          +'<div style="display:flex;align-items:flex-start;gap:32px;max-width:860px;width:100%">'
          +'<div id="_lc_playersect" style="flex:1;min-width:0">'+playerSection+'</div>'
          +'<div style="width:340px;flex-shrink:0">'+_renderAdSlot('card')+'</div>'
          +'</div></div>';
      }
      document.getElementById('app').innerHTML=html;
    }
  }

  // ── Initial render ───────────────────────────────────────────────────────
  if(isRefresh){ _renderRefreshPage(null,'init'); }
  else { _renderLoadSteps(0,null); }

  try{
    // ── Step 1: Service record ───────────────────────────────────────────────
    var statsRes=await fetch('/api/search?gamertag='+encodeURIComponent(gt)+'&statsOnly=1'+(force?'&force=1':''));
    var statsD=await statsRes.json();
    if(!isCurrent()) return; // newer search started while we waited
    if(!statsD.success||!statsD.player){
      var errMsg=statsD.error||'Player not found. Check the spelling and try again.';
      document.getElementById('app').innerHTML='<div class="error-card">'+errMsg+'</div>';
      return;
    }
    playerData=statsD.player;
    data={players:[playerData],_searchOverride:true,lastUpdated:playerData.lastUpdated};
    searchData=playerData; searchMode=false; selectedPlayer=0;
    var url=new URL(window.location);url.searchParams.set('player',gt);window.history.pushState({},'',url);
    document.title=gt+' — fragr';
    var fb=document.getElementById('favHeaderBtn');if(fb)fb.style.display='flex';
    updateFavBtn();

    if(isRefresh){
      // Refresh page: show player identity + stats while full fetch runs
      _renderRefreshPage(statsD.player,'loading');
    } else {
      // Loading page: populate the card with step-1 data then keep showing progress
      _loadPlayer=statsD.player;
      _renderLoadSteps(1,null);
    }

    // ── Step 2: Match history ────────────────────────────────────────────────
    var _progressPoll=null;
    if(!isRefresh){
      _progressPoll=setInterval(function(){
        fetch('/api/search/progress?gamertag='+encodeURIComponent(gt))
          .then(function(r){return r.ok?r.json():null;})
          .then(function(p){
            if(!isCurrent()||!p||p.step!==2) return;
            // If the player card is already rendered, only update the match label
            // in-place — avoids destroying the <img> elements on every poll tick
            if(_loadPlayer&&document.getElementById('_lc_step2lbl')){
              var lbl=document.getElementById('_lc_step2lbl');
              if(p.retrying){
                lbl.innerHTML='<span style="color:var(--warning,#f59e0b)">⏳ Rate limit — retrying in '+p.retrying.secondsLeft+'s</span>'
                  +(p.retrying.attempt>1?' <span style="color:var(--muted2)">(attempt '+p.retrying.attempt+'/'+p.retrying.maxAttempts+')</span>':'');
              } else if(p.valid>=5){
                lbl.textContent='Match history · '+p.valid+' ranked'+(p.scanned?' / '+p.scanned+' scanned':'');
              }
              return;
            }
            _renderLoadSteps(1,p.valid>=5?{valid:p.valid,scanned:p.scanned||0}:null);
          }).catch(function(){});
      },400);
    }

    var fullRes=await fetch('/api/search?gamertag='+encodeURIComponent(gt)+(force?'&force=1':''));
    var fullD=await fullRes.json();
    if(_progressPoll) clearInterval(_progressPoll);
    if(!isCurrent()) return; // newer search started while match history was fetching
    // Cached result: match history + skill data already done — jump to team data step
    if(!isRefresh&&fullD.cached) _renderLoadSteps(3,null);

    if(fullD.success&&fullD.player){
      // Sync _loadPlayer with full data so the loading screen gets the correct emblemUrl/nameplateUrl
      // even if the statsOnly call resolved them as null (economy.svc can be flaky on first hit)
      if(!isRefresh) _loadPlayer=fullD.player;
      // ── Step 3: Skill data (background fetch in progress on server) ──────
      if(!isRefresh) _renderLoadSteps(2,null);

      // ── Step 4: Preload rival/nemesis pics (team data) ───────────────────
      var _rivals=(fullD.player.rivals||[]).concat(fullD.player.nemesisList||[],fullD.player.victimsList||[]);
      var _seenRiv={};
      _rivals=_rivals.filter(function(r){if(!r.gamertag||_seenRiv[r.gamertag.toLowerCase()])return false;_seenRiv[r.gamertag.toLowerCase()]=true;return true;});
      var _missingPics=_rivals.filter(function(r){return !r.gamerpicUrl&&r.gamertag&&!r.gamertag.startsWith('Spartan ');});
      if(_missingPics.length>0){
        try{
          var _gts=_missingPics.map(function(r){return r.gamertag;}).slice(0,30).join(',');
          var _prRes=await fetch('/api/rival-pics?gamertags='+encodeURIComponent(_gts));
          var _prData=await _prRes.json();
          _rivals.forEach(function(r){if(!r.gamerpicUrl&&_prData[r.gamertag])r.gamerpicUrl=_prData[r.gamertag];});
          ['rivals','nemesisList','victimsList'].forEach(function(key){
            (fullD.player[key]||[]).forEach(function(r){if(!r.gamerpicUrl&&_prData[r.gamertag])r.gamerpicUrl=_prData[r.gamertag];});
          });
        }catch(e){}
      }
      var _picPromises=_rivals.filter(function(r){return r.gamerpicUrl;}).slice(0,30).map(function(r){
        return new Promise(function(resolve){var img=new Image();img.onload=img.onerror=resolve;img.src=r.gamerpicUrl;});
      });
      if(!isRefresh) _renderLoadSteps(3,null); // skill data ✓, team data active
      await Promise.all(_picPromises);

      if(isRefresh){
        // ── Refresh: Skill data → Analyzing overlay ───────────────────────
        _renderRefreshPage(fullD.player,'skilldata');
        await new Promise(function(r){setTimeout(r,900);});
        _renderRefreshPage(fullD.player,'analyzing');
        await new Promise(function(r){setTimeout(r,3500);});
      } else {
        // ── Loading: Analyzing step (new search — 3.5s showcase) ─────────
        await new Promise(function(r){setTimeout(r,200);});
        _renderLoadSteps(4,null); // team data ✓, analyzing active
        await new Promise(function(r){setTimeout(r,3500);});
        _renderLoadSteps(5,null); // all done
        await new Promise(function(r){setTimeout(r,120);});
      }

      if(!isCurrent()) return; // user searched someone else during the analyzing delay
      playerData=fullD.player;
      data={players:[playerData],_searchOverride:true,lastUpdated:playerData.lastUpdated};
      searchData=playerData; searchMode=false; selectedPlayer=0;
      activeTab='overview'; render();
      loadFullMatches(gt);
      // Poll /api/skill-status until background enrichment is ≥95% done, then force-refresh
      // This is more reliable than a fixed 22s timer — enrichment speed varies with API load
      var _skillPollId=null,_skillPollN=0;
      function _stopSkillPoll(){if(_skillPollId){clearInterval(_skillPollId);_skillPollId=null;}}
      function _doSkillPoll(){
        if(!isCurrent()){_stopSkillPoll();return;}
        if(++_skillPollN>12){_stopSkillPoll();return;} // give up after ~85s (12 × 7s + 1st at 14s)
        fetch('/api/skill-status?gamertag='+encodeURIComponent(gt))
          .then(function(r){return r.ok?r.json():null;})
          .then(function(s){
            if(!s||!isCurrent())return;
            if(s.ready||s.pct>=95){
              _stopSkillPoll();
              loadFullMatches(gt,true,'Syncing skill data…');
            }
          }).catch(function(){});
      }
      // First check at 14s — fast machines finish well under 22s
      // If not ready, re-check every 7s up to ~85s total
      setTimeout(function(){
        if(!isCurrent())return;
        // Skip polling if full skill data already loaded (e.g. cached player)
        var _cc=fullMatchCache[gt]||[];
        var _rk=_cc.filter(function(m){return m.isRanked;});
        var _sk=_rk.filter(function(m){return m.expectedKills!=null;}).length;
        if(_rk.length>0&&_sk>=_rk.length*0.95){return;} // already complete
        _skillPollId=setInterval(_doSkillPoll,7000);
        _doSkillPoll(); // immediate first poll at t=14s
      },14000);
    }
  } catch(e){
    document.getElementById('app').innerHTML='<div class="error-card">Search failed: '+e.message+'</div>';
  }
}
async function searchPlayer(){
  var gt=(document.getElementById('searchInput').value||'').trim();
  if(gt)await doSearch(gt);
}
