async function doSearch(gt, isRefresh, force){
  if(!gt||!gt.trim())return;
  gt=gt.trim();
  var myToken = ++_searchToken; // claim this search slot
  function isCurrent(){ return _searchToken === myToken; } // false = newer search started, bail
  stopAutoRefresh(); // cancel any existing poller before starting a new search
  hideLanding();
  expandedMatches={}; // clear any open match cards from the previous search
  var dtb=document.getElementById('desktopTabBar');if(dtb)dtb.style.display=window.innerWidth>=768?'flex':'none';
  var cb=document.getElementById('clearSearchBtn');if(cb)cb.style.display='inline';
  document.getElementById('searchInput').value=gt;
  matchHistoryData=null;

  // ── Phase timing ─────────────────────────────────────────────────────────
  // Tracks search-flow durations so slowness is visible in the console without
  // touching the server. Each mark logs delta from search start and from prev.
  var _phaseT0 = (typeof performance!=='undefined'&&performance.now)?performance.now():Date.now();
  var _phaseLast = _phaseT0;
  function _phase(label){
    var now=(typeof performance!=='undefined'&&performance.now)?performance.now():Date.now();
    var total=Math.round(now-_phaseT0), step=Math.round(now-_phaseLast);
    _phaseLast=now;
    try{ console.log('[search] '+label+' +'+step+'ms (t='+total+'ms)'); }catch(e){}
  }
  _phase(isRefresh?'refresh:start':'search:start');

  // ── Loading screen state ─────────────────────────────────────────────────
  // Step labels are short and match what the server is actually doing.
  // Skill data and team enrichment are background work — we no longer block
  // the whole screen on them, but we still show a brief module-level state.
  var _loadSteps=[
    {id:'s1',label:'Service record'},
    {id:'s2',label:'Match history'},
    {id:'s3',label:'Finalizing'}
  ];
  var _loadPlayer=null; // populated after step 1 returns
  function _renderLoadSteps(activeIdx,matchProgress){
    var _lsMobile=window.innerWidth<768;
    var pct=Math.round((activeIdx/_loadSteps.length)*100);
    var p=_loadPlayer;

    // Step dots — desktop shows all steps; mobile shows only the active step as one line
    var dotsHtml;
    function _stepLabel(step,i,active){
      var label=step.label;
      if(active&&i===1&&matchProgress){
        label='Match history · '+matchProgress.valid+' ranked'+(matchProgress.scanned?' / '+matchProgress.scanned+' scanned':'');
      }
      return label;
    }
    if(_lsMobile){
      var _activeStep=_loadSteps[activeIdx]||null;
      var _activeLabel=_activeStep?_stepLabel(_activeStep,activeIdx,true):'';
      var _activeLabelHtml=_activeLabel+'<span class="load-dots"><span>.</span><span>.</span><span>.</span></span>';
      dotsHtml=_activeStep
        ?'<div style="display:flex;align-items:center;gap:8px;margin-top:16px">'
          +'<div style="width:7px;height:7px;border-radius:50%;background:var(--accent);animation:pulse 1.2s ease-in-out infinite;box-shadow:0 0 6px var(--accent);flex-shrink:0"></div>'
          +'<div '+(activeIdx===1?'id="_lc_step2lbl" ':'')+' style="font-family:Share Tech Mono,monospace;font-size:11px;color:var(--muted)">'+_activeLabelHtml+'</div>'
          +'</div>'
        :'';
    } else {
      dotsHtml='<div style="display:flex;flex-direction:column;gap:10px;margin-top:16px">';
      _loadSteps.forEach(function(step,i){
        var done=i<activeIdx,active=i===activeIdx,label=_stepLabel(step,i,active);
        var dotColor=done?'var(--win)':active?'var(--accent)':'var(--surface3)';
        var textColor=done?'var(--win)':active?'var(--text)':'var(--muted2)';
        var labelHtml=active
          ?label+'<span class="load-dots"><span>.</span><span>.</span><span>.</span></span>'
          :label+(done?' ✓':'');
        dotsHtml+='<div style="display:flex;align-items:center;gap:10px">'
          +'<div style="width:8px;height:8px;border-radius:50%;background:'+dotColor+';flex-shrink:0;'+(active?'box-shadow:0 0 6px var(--accent);animation:pulse 1.2s ease-in-out infinite':'')+';transition:all 0.3s"></div>'
          +'<div '+(active&&i===1?'id="_lc_step2lbl" ':'')+' style="font-family:Share Tech Mono,monospace;font-size:11px;color:'+textColor+';transition:color 0.3s">'+labelHtml+'</div>'
          +'</div>';
      });
      dotsHtml+='</div>';
    }

    var leftHtml;
    if(p){
      // After step 1: show player card with nameplate, emblem, stats
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
        +'</div></div>'
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
        +'</div>';
    } else {
      // Before step 1: plain gamertag + progress bar + dots
      leftHtml=''
        +'<div style="font-family:Rajdhani,sans-serif;font-size:22px;font-weight:700;color:var(--text);margin-bottom:6px;letter-spacing:1px">'+gt+'</div>'
        +'<div style="height:3px;background:var(--surface3);border-radius:2px;margin-bottom:22px;overflow:hidden">'
        +'<div style="height:100%;background:var(--accent);border-radius:2px;width:'+pct+'%;transition:width 0.4s ease"></div>'
        +'</div>'
        +dotsHtml;
    }

    // Single-column layout: no sponsor card. If the player section already
    // exists from a prior tick, swap in place to avoid flashing.
    var _existingPS=document.getElementById('_lc_playersect');
    if(_existingPS){
      _existingPS.innerHTML=leftHtml;
    } else {
      var maxW=_lsMobile?'100%':'520px';
      var pad=_lsMobile?'20px 16px 12px':'32px 24px';
      var html='<div style="min-height:calc(100vh - 100px);display:flex;align-items:center;justify-content:center;padding:'+pad+';box-sizing:border-box">'
        +'<div id="_lc_playersect" style="width:100%;max-width:'+maxW+'">'+leftHtml+'</div>'
        +'</div>';
      document.getElementById('app').innerHTML=html;
    }
  }

  // ── Refresh page (existing player, force-refresh from URL or banner) ────
  function _renderRefreshPage(player, status){
    var p=player;
    var isMobile=window.innerWidth<768;
    var topCsr=null;
    if(p&&p.csr){var cv=Object.values(p.csr);if(cv.length)topCsr=cv.sort(function(a,b){return b.value-a.value;})[0];}
    var initials=gt.replace(/\s+/g,'').slice(0,2).toUpperCase();

    var emblemSize = isMobile ? '48px' : '60px';
    var gtFontSize = isMobile ? 'clamp(20px, 6vw, 30px)' : '34px';
    var statFontSize = isMobile ? '18px' : '20px';

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
      +'</div></div>';

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

    var statusLabel=status==='loading'
      ?'Updating stats<span class="load-dots"><span>.</span><span>.</span><span>.</span></span>'
      :'Connecting<span class="load-dots"><span>.</span><span>.</span><span>.</span></span>';
    playerSection+='<div style="display:flex;align-items:center;gap:8px">'
      +'<div style="width:7px;height:7px;border-radius:50%;background:var(--accent);animation:pulse 1.2s ease-in-out infinite;box-shadow:0 0 6px var(--accent);flex-shrink:0"></div>'
      +'<div style="font-family:Share Tech Mono,monospace;font-size:11px;color:var(--muted)">'+statusLabel+'</div>'
      +'</div>'
      +'</div>';

    var _existingPS2=document.getElementById('_lc_playersect');
    if(_existingPS2){
      _existingPS2.innerHTML=playerSection;
    } else {
      var maxW=isMobile?'100%':'520px';
      var pad=isMobile?'20px 16px 12px':'32px 24px';
      var html='<div style="min-height:calc(100vh - 100px);display:flex;align-items:center;justify-content:center;padding:'+pad+';box-sizing:border-box">'
        +'<div id="_lc_playersect" style="width:100%;max-width:'+maxW+'">'+playerSection+'</div>'
        +'</div>';
      document.getElementById('app').innerHTML=html;
    }
  }

  // ── Initial render ───────────────────────────────────────────────────────
  if(isRefresh){ _renderRefreshPage(null,'init'); }
  else { _renderLoadSteps(0,null); }

  try{
    // ── Step 1: Service record ───────────────────────────────────────────
    var statsRes=await fetch('/api/search?gamertag='+encodeURIComponent(gt)+'&statsOnly=1'+(force?'&force=1':''));
    var statsD=await statsRes.json();
    _phase('statsOnly response');
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
    var cb=document.getElementById('compareBtn');if(cb)cb.style.display='inline-flex';var mcb=document.getElementById('mobileCompareBtn');if(mcb)mcb.style.display='flex';
    updateFavBtn();

    if(isRefresh){
      _renderRefreshPage(statsD.player,'loading');
    } else {
      _loadPlayer=statsD.player;
      _renderLoadSteps(1,null);
    }

    // ── Step 2: Match history (this is the long one) ─────────────────────
    var _progressPoll=null;
    if(!isRefresh){
      _progressPoll=setInterval(function(){
        fetch('/api/search/progress?gamertag='+encodeURIComponent(gt))
          .then(function(r){return r.ok?r.json():null;})
          .then(function(p){
            if(!isCurrent()||!p||p.step!==2) return;
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
    _phase('match history response'+(fullD&&fullD.cached?' [cached]':''));
    if(!isCurrent()) return; // newer search started while match history was fetching

    if(fullD.success&&fullD.player){
      // Sync _loadPlayer with full data so emblem/nameplate reflect what server resolved
      if(!isRefresh) _loadPlayer=fullD.player;

      // Private/restricted history — show a one-line note in the step label
      var _isPrivate = !!(fullD.player.privateHistory || fullD.player.reconstructed);
      if(_isPrivate && !isRefresh){
        var _msg = (fullD.player.reconstructedCount>0)
          ? 'Reconstructed from public match records'
          : 'Searching public match records…';
        var _lbl=document.getElementById('_lc_step2lbl');
        if(_lbl) _lbl.innerHTML='<span style="color:var(--accent)">'+_msg+'</span>';
      }

      // Required data is now in hand. Everything below is best-effort polish:
      //   • Skill enrichment (server runs it async, we poll post-render)
      //   • Rival/nemesis gamerpic prefetch (cosmetic)
      //   • Co-player snapshot queue (background, server-side)
      // We jump straight to "Finalizing" and proceed to render.
      if(!isRefresh) _renderLoadSteps(2,null);

      var _canonicalGt=fullD.player.gamertag||gt;

      // Fire rival-pic prefetch but do NOT await — page must not wait for image bytes.
      var _rivals=(fullD.player.rivals||[]).concat(fullD.player.nemesisList||[],fullD.player.victimsList||[]);
      var _seenRiv={};
      _rivals=_rivals.filter(function(r){if(!r.gamertag||_seenRiv[r.gamertag.toLowerCase()])return false;_seenRiv[r.gamertag.toLowerCase()]=true;return true;});
      var _missingPics=_rivals.filter(function(r){return !r.gamerpicUrl&&r.gamertag&&!r.gamertag.startsWith('Spartan ');});
      if(_missingPics.length>0){
        fetch('/api/rival-pics?gamertags='+encodeURIComponent(_missingPics.map(function(r){return r.gamertag;}).slice(0,30).join(',')))
          .then(function(r){return r.ok?r.json():{};})
          .then(function(_prData){
            _rivals.forEach(function(r){if(!r.gamerpicUrl&&_prData[r.gamertag])r.gamerpicUrl=_prData[r.gamertag];});
            ['rivals','nemesisList','victimsList'].forEach(function(key){
              (fullD.player[key]||[]).forEach(function(r){if(!r.gamerpicUrl&&_prData[r.gamertag])r.gamerpicUrl=_prData[r.gamertag];});
            });
          }).catch(function(){});
      }

      if(!isCurrent()) return;
      _phase('about to render');
      playerData=fullD.player;
      data={players:[playerData],_searchOverride:true,lastUpdated:playerData.lastUpdated};
      searchData=playerData; searchMode=false; selectedPlayer=0;
      // Clear stale fullMatchCache so render() uses fresh data from the API response
      delete fullMatchCache[_canonicalGt];
      activeTab='overview';
      render();
      _phase('rendered');

      // Background poller: detect new matches without manual refresh
      var _allM=fullD.player.allMatches||fullD.player.recentMatches||[];
      startAutoRefresh(_canonicalGt, _allM[0]?_allM[0].matchId:null);

      // Sync tab button highlight to overview
      (function(){
        var _syncTab='overview';
        document.querySelectorAll('.dtab').forEach(function(b){b.classList.toggle('active',b.dataset.tab===_syncTab);});
        document.querySelectorAll('.sidebar-nav-item').forEach(function(b){b.classList.toggle('active',b.dataset.tab===_syncTab);});
        document.querySelectorAll('.mobile-tab[data-tab]').forEach(function(b){b.classList.toggle('active',b.dataset.tab===_syncTab);});
      })();

      loadFullMatches(_canonicalGt);

      // Poll skill status post-render and force-refresh as soon as enrichment is ready.
      // Checks every 3s for the first 30s, then gives up.
      {
        var _skillPollId=null,_skillPollN=0;
        function _stopSkillPoll(){if(_skillPollId){clearInterval(_skillPollId);_skillPollId=null;}}
        function _doSkillPoll(){
          if(!isCurrent()){_stopSkillPoll();return;}
          if(++_skillPollN>10){_stopSkillPoll();return;}
          fetch('/api/skill-status?gamertag='+encodeURIComponent(_canonicalGt))
            .then(function(r){return r.ok?r.json():null;})
            .then(function(s){
              if(!s||!isCurrent())return;
              if(s.ready||s.pct>=95||!s.total){
                _stopSkillPoll();
                _phase('skill data ready (pct='+(s.pct||0)+')');
                loadFullMatches(_canonicalGt,true,'Syncing skill data…');
              }
            }).catch(function(){});
        }
        setTimeout(function(){
          if(!isCurrent())return;
          var _cc=fullMatchCache[_canonicalGt]||[];
          var _rk=_cc.filter(function(m){return m.isRanked;});
          var _sk=_rk.filter(function(m){return m.expectedKills!=null||m.mmr!=null;}).length;
          var _recentMissing=_rk.slice(0,5).some(function(m){return m.expectedKills==null&&m.mmr==null;});
          if(_rk.length>0&&_sk>=_rk.length*0.95&&!_recentMissing){return;}
          _skillPollId=setInterval(_doSkillPoll,3000);
          _doSkillPoll();
        },3000);
      }
    }
  } catch(e){
    document.getElementById('app').innerHTML='<div class="error-card">Search failed: '+e.message+'</div>';
  }
}
async function searchPlayer(){
  var gt=(document.getElementById('searchInput').value||'').trim();
  if(gt)await doSearch(gt);
}
