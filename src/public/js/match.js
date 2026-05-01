function renderMatchDetail(m,matchCtx,modeBaselines,durSecs){
  var html='<div class="match-detail">';
  // Connection quality
  var cq=analyzeConnectionQuality(m,modeBaselines||{});
  if(cq)html+=renderConnectionDetail(cq);

  // Per-match stats (BR-normalized for Legacy)
  if(m.shotsFired>0&&m.kills>0){
    var _isLegacyMatch=m.gameMode&&m.gameMode.indexOf('Legacy')>-1;
    var _effectiveShotsFired=_isLegacyMatch?m.shotsFired/3:m.shotsFired;
    var _spkM=_effectiveShotsFired/m.kills;
    var _hsRateM=m.weaponStats&&m.kills>0?m.weaponStats.headshots/m.kills*100:null;
    var _spkColor='var(--muted)'; // SPK is mixed weapons so no colour judgment
    var _hsColor=_hsRateM!=null?(_hsRateM>=60?'var(--win)':_hsRateM>=35?'var(--muted)':'var(--loss)'):'var(--muted)';
    var _spkSub=_isLegacyMatch?'burst equiv (BR ÷3)':'all weapons';
    html+='<div style="display:flex;gap:12px;margin-bottom:10px;flex-wrap:wrap">';
    html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 12px;display:flex;flex-direction:column">'
      +'<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;letter-spacing:.8px">Shots / Kill</div>'
      +'<div style="font-size:18px;font-weight:700;color:'+_spkColor+'">'+_spkM.toFixed(1)+'</div>'
      +'<div style="font-size:9px;color:var(--muted)">'+_spkSub+'</div>'
      +'</div>';
    if(_hsRateM!=null){
      html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 12px;display:flex;flex-direction:column">'
        +'<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;letter-spacing:.8px">Headshot Finish %</div>'
        +'<div style="font-size:18px;font-weight:700;color:'+_hsColor+'">'+_hsRateM.toFixed(0)+'%</div>'
        +'<div style="font-size:9px;color:var(--muted)">aim for 50%+</div>'
        +'</div>';
    }

    html+='</div>';
  }

  // Performance vs expected panel
  if(m.expectedKills!=null||m.mmr){
    var overK=m.expectedKills!=null&&m.kills>m.expectedKills;
    var overD=m.expectedDeaths!=null&&m.deaths<m.expectedDeaths;
    var mmrDiff=m.mmr&&m.oppMmr?m.mmr-m.oppMmr:null;
    var underdog=mmrDiff!==null&&mmrDiff<0;
    var favored=mmrDiff!==null&&mmrDiff>0;

    html+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:12px">';

    if(m.expectedKills!=null){
      var kDiff=m.kills-m.expectedKills;
      html+='<div style="background:var(--surface);border:1px solid '+(overK?'rgba(0,230,118,0.3)':'rgba(255,61,87,0.3)')+';border-radius:6px;padding:8px 12px">'
        +'<div style="font-size:11px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;letter-spacing:.8px">Kills vs Expected</div>'
        +'<div style="font-size:20px;font-weight:700;color:'+(overK?'var(--win)':'var(--loss)')+';margin-top:2px">'+m.kills+'<span style="font-size:12px;color:var(--muted)"> / '+m.expectedKills.toFixed(1)+'</span></div>'
        +'<div style="font-size:10px;color:'+(overK?'var(--win)':'var(--loss)')+'">'+(kDiff>=0?'+':'')+kDiff.toFixed(1)+' vs expected</div>'
        +'</div>';
    }

    if(m.expectedDeaths!=null){
      var dDiff=m.deaths-m.expectedDeaths;
      html+='<div style="background:var(--surface);border:1px solid '+(overD?'rgba(0,230,118,0.3)':'rgba(255,61,87,0.3)')+';border-radius:6px;padding:8px 12px">'
        +'<div style="font-size:11px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;letter-spacing:.8px">Deaths vs Expected</div>'
        +'<div style="font-size:20px;font-weight:700;color:'+(overD?'var(--win)':'var(--loss)')+';margin-top:2px">'+m.deaths+'<span style="font-size:12px;color:var(--muted)"> / '+m.expectedDeaths.toFixed(1)+'</span></div>'
        +'<div style="font-size:10px;color:'+(overD?'var(--win)':'var(--loss)')+'">'+(dDiff<=0?'':'+')+(dDiff).toFixed(1)+' vs expected</div>'
        +'</div>';
    }

    if(m.mmr&&m.oppMmr){
      var winProb2=Math.round(100/(1+Math.pow(10,-mmrDiff/400)));
      var probColor=winProb2>=55?'var(--win)':winProb2<=45?'var(--loss)':'var(--muted)';
      html+='<div style="background:var(--surface);border:1px solid '+(underdog?'rgba(0,230,118,0.3)':favored?'rgba(255,61,87,0.3)':'var(--border)')+';border-radius:6px;padding:8px 12px">'
        +'<div style="font-size:11px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;letter-spacing:.8px">Win Probability</div>'
        +'<div style="font-size:20px;font-weight:700;color:'+probColor+';margin-top:2px">'+winProb2+'%<span style="font-size:12px;color:var(--muted)"> ('+m.mmr+' vs '+m.oppMmr+')</span></div>'
        +'<div style="font-size:10px;color:'+(underdog?'var(--win)':favored?'var(--loss)':'var(--muted)')+'">'+(underdog?'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"11\" height=\"11\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" style=\"vertical-align:-1px\"><polyline points=\"18 15 12 9 6 15\"/></svg> Underdog — harder match':(favored?'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"11\" height=\"11\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" style=\"vertical-align:-1px\"><polyline points=\"6 9 12 15 18 9\"/></svg> Favored — easier match':'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"11\" height=\"11\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" style=\"vertical-align:-1px\"><line x1=\"5\" y1=\"9\" x2=\"19\" y2=\"9\"/><line x1=\"5\" y1=\"15\" x2=\"19\" y2=\"15\"/></svg> Even match'))+'</div>'
        +'</div>';
    }

    // Overall performance verdict
    if(m.expectedKills!=null&&m.expectedDeaths!=null){
      var kDelta=m.kills-m.expectedKills;
      var dDelta=m.deaths-m.expectedDeaths; // negative = fewer deaths = good
      // Score: +1 for each kill above expected, -1 for each death above expected
      var perfScore=kDelta-dDelta;
      var overallGood=perfScore>0;
      var neutral=Math.abs(perfScore)<1;
      var borderColor=neutral?'var(--border)':overallGood?'rgba(0,230,118,0.3)':'rgba(255,61,87,0.3)';
      var verdict=neutral?'On Par':overallGood?'Above Expected':'Below Expected';
      var verdictColor=neutral?'var(--muted)':overallGood?'var(--win)':'var(--loss)';
      var reason='';
      if(kDelta>1&&dDelta<0) reason='More kills, fewer deaths ✓';
      else if(kDelta>1&&dDelta<=1) reason='Kills above expected';
      else if(kDelta>=-1&&dDelta<-1) reason='Deaths well below expected';
      else if(kDelta<-1&&dDelta<0) reason='Deaths below, but kills low';
      else if(kDelta<-1&&dDelta>1) reason='Both below expectations';
      else if(kDelta>1&&dDelta>1) reason='More kills but also more deaths';
      else reason='Close to expected';
      html+='<div style="background:var(--surface);border:1px solid '+borderColor+';border-radius:6px;padding:8px 12px">'
        +'<div style="font-size:11px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;letter-spacing:.8px">Performance</div>'
        +'<div style="font-size:16px;font-weight:700;color:'+verdictColor+';margin-top:4px">'+verdict+'</div>'
        +'<div style="font-size:10px;color:var(--muted)">'+reason+'</div>'
        +'</div>';
    }

    html+='</div>';
  }

  if(!m.teams||!m.teams.length){html+='<p style="color:var(--muted);font-size:12px">Team data loads on next Refresh.</p></div>';return html;}
  m.teams.forEach(function(team,ti){
    if(ti>0)html+='<hr class="team-divider">';
    var myGtTeam=(getAllPlayers()[selectedPlayer]||{}).gamertag;
    var isMyTeam=team.players&&team.players.some(function(p){return p.gamertag===myGtTeam;});
    var teamOutcome=team.outcome;
    // If team outcome is missing/draw but we know match outcome, derive it
    if((!teamOutcome||teamOutcome===0)&&m.outcome){
      teamOutcome=isMyTeam?m.outcome:(m.outcome===2?3:m.outcome===3?2:0);
    }
    var oc=teamOutcome===2?'<span style="color:var(--win)">Victory</span>':teamOutcome===3?'<span style="color:var(--loss)">Defeat</span>':'<span style="color:var(--muted)">Draw</span>';
    var _teamName=['Eagle','Cobra','Cobra','Eagle'][team.teamId]||('Team '+(team.teamId+1));
    html+='<div class="team-label">'+oc+' — '+_teamName+'</div><table><thead><tr><th>Player</th><th style="text-align:right">K</th><th style="text-align:right">D</th><th style="text-align:right">A</th><th style="text-align:right">K/D</th><th style="text-align:right">KDA</th><th style="text-align:right">Dmg</th></tr></thead><tbody>';
    (team.players||[]).forEach(function(pl){
      var isMe=pl.gamertag===(getAllPlayers()[selectedPlayer]||{}).gamertag;
      var myGtCheck=(getAllPlayers()[selectedPlayer]||{}).gamertag;
      var myTeamCheck=m&&m.teams?m.teams.find(function(t){return t.players&&t.players.some(function(p){return p.gamertag===myGtCheck;});}):null;
      var isOpponent=myTeamCheck?!myTeamCheck.players.some(function(p){return p.gamertag===pl.gamertag;}):true;
      var check=null;
      var checkBadge='';
      if(check){
        var cbColor=check.level==='high'?'var(--loss)':'var(--gold)';
        var cbIcon=check.level==='high'?'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"11\" height=\"11\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" style=\"vertical-align:-1px\"><path d=\"M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z\"/><line x1=\"12\" y1=\"9\" x2=\"12\" y2=\"13\"/><line x1=\"12\" y1=\"17\" x2=\"12.01\" y2=\"17\"/></svg>':'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"11\" height=\"11\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" style=\"vertical-align:-1px\"><path d=\"M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z\"/><line x1=\"12\" y1=\"9\" x2=\"12\" y2=\"13\"/><line x1=\"12\" y1=\"17\" x2=\"12.01\" y2=\"17\"/></svg>';
        checkBadge='<span title="'+check.reason.replace(/"/g,"'")+' — click to search" style="margin-left:4px;font-size:9px;cursor:pointer;color:'+cbColor+'" onclick="event.stopPropagation();quickSearch(\'' +pl.gamertag.replace(/'/g,"\\'")+'\')">'+cbIcon+'</span>';
      }
      var isSpartan=pl.gamertag&&pl.gamertag.startsWith('Spartan ');
      var displayGt=isSpartan?'<span class="gt-skeleton" style="display:inline-block;width:80px;height:10px;background:var(--surface3);border-radius:3px;vertical-align:middle;animation:gtpulse 1.2s ease-in-out infinite"></span>':pl.gamertag;
            var _gtFavBtn=(!isMe&&!isSpartan)?'<span data-gt="'+pl.gamertag.replace(/"/g,'&quot;')+'" onclick="event.stopPropagation();toggleFav(this.dataset.gt)" title="Toggle favorite" style="margin-left:3px;font-size:9px;cursor:pointer;opacity:0.4;color:#ffc107" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.4">'+( isFavorite(pl.gamertag)?'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"11\" height=\"11\" viewBox=\"0 0 24 24\" fill=\"currentColor\" stroke=\"currentColor\" stroke-width=\"1.5\" style=\"vertical-align:-1px\"><polygon points=\"12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2\"/></svg>':'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"11\" height=\"11\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" style=\"vertical-align:-1px\"><polygon points=\"12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2\"/></svg>')+'</span>':'';
      var gtLink=isMe?'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"11\" height=\"11\" viewBox=\"0 0 24 24\" fill=\"currentColor\" stroke=\"currentColor\" stroke-width=\"1.5\" style=\"vertical-align:-1px\"><polygon points=\"12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2\"/></svg> '+pl.gamertag:(isSpartan?displayGt:'<span style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted;color:inherit" onclick="quickSearch(\''+pl.gamertag.replace(/'/g,"\\\'")+'\')">'+pl.gamertag+'</span>'+checkBadge+_gtFavBtn);
      // Emblem/gamerpic — tracked players get Halo emblem, untracked get emblem via xuid if available, else gamerpic
      var _trackedP=(data&&data.players||[]).find(function(x){return x.gamertag===pl.gamertag;});
      var _rowEmb='';
      var _rowSrc=_trackedP
        ? (_trackedP.emblemUrl||(_trackedP.xuid?'/api/emblem?xuid='+_trackedP.xuid:null)||_trackedP.gamerpicUrl||null)
        : (pl.rawXuid?'/api/emblem?xuid='+pl.rawXuid:(pl.gamerpicUrl||null));
      if(_rowSrc&&!isSpartan){
        var _rowInitials=(pl.gamertag||'?').slice(0,2).toUpperCase();
        _rowEmb='<div style="display:inline-block;width:20px;height:20px;border-radius:3px;overflow:hidden;vertical-align:middle;margin-right:6px;background:var(--surface2);border:1px solid var(--border);position:relative">'
          +'<img src="'+_rowSrc+'" style="width:100%;height:100%;object-fit:cover;display:block" onerror="this.style.display=&quot;none&quot;;this.nextSibling.style.display=&quot;flex&quot;">'
          +'<span style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;font-size:8px;font-weight:700;color:var(--accent);font-family:Rajdhani,sans-serif">'+_rowInitials+'</span>'
          +'</div>';
      }
      var _plKda=pl.kda!=null?pl.kda:'—';
      var _plKdaColor=pl.kda!=null?(parseFloat(pl.kda)>=0?'var(--win)':'var(--loss)'):'var(--muted)';
      html+='<tr'+(isMe?' class="me-row"':'')+(pl.rawXuid?' data-xuid="'+pl.rawXuid+'"':'')+'><td>'+_rowEmb+gtLink+'</td><td style="text-align:right">'+pl.kills+'</td><td style="text-align:right">'+pl.deaths+'</td><td style="text-align:right">'+pl.assists+'</td><td style="text-align:right;color:'+(parseFloat(pl.kd)>=1?'var(--win)':'var(--loss)')+'">'+pl.kd+'</td><td style="text-align:right;color:'+_plKdaColor+'">'+_plKda+'</td><td style="text-align:right;color:var(--muted)">'+(pl.damage?pl.damage.toLocaleString():'—')+'</td></tr>';
    });
    html+='</tbody></table>';
  });

  // ── Objective stats ──────────────────────────────────────────────────
  if(m.objStats){
    var os=m.objStats;
    var objRows=[];
    function fmtDurS(s){if(!s&&s!==0)return null;var m=Math.floor(s/60),sec=Math.round(s%60);return m>0?m+'m '+sec+'s':sec+'s';}
    if(os.mode==='Oddball'){
      if(os.timeAsCarrier!=null)objRows.push(['Ball Hold Time',fmtDurS(os.timeAsCarrier)]);
      if(os.longestCarry!=null)objRows.push(['Longest Carry',fmtDurS(os.longestCarry)]);
      if(os.ballGrabs!=null)objRows.push(['Ball Grabs',os.ballGrabs]);
      if(os.killsAsCarrier!=null)objRows.push(['Kills as Carrier',os.killsAsCarrier]);
      if(os.carrierKills!=null)objRows.push(['Carrier Kills',os.carrierKills]);
      if(os.scoringTicks!=null)objRows.push(['Scoring Ticks',os.scoringTicks]);
    } else if(os.mode==='CTF'){
      if(os.flagCaptures!=null)objRows.push(['Flag Captures',os.flagCaptures]);
      if(os.flagGrabs!=null)objRows.push(['Flag Grabs',os.flagGrabs]);
      if(os.flagReturns!=null)objRows.push(['Flag Returns',os.flagReturns]);
      if(os.flagsStolen!=null)objRows.push(['Flag Steals',os.flagsStolen]);
      if(os.flagCarrierKills!=null)objRows.push(['Carriers Killed',os.flagCarrierKills]);
      if(os.timeAsCarrier!=null)objRows.push(['Carrier Time',fmtDurS(os.timeAsCarrier)]);
    } else if(os.mode==='Strongholds'||os.mode==='King of the Hill'||os.mode==='Land Grab'){
      var _isKoth=os.mode==='King of the Hill';
      var _isLand=os.mode==='Land Grab';
      var _occLabel=_isKoth?'Hill Hold Time':'Occupation Time';
      // KotH: skip captures/secures — hold time and kills are more meaningful
      // Strongholds: skip scoring ticks — captures/secures/kills are sufficient
      if(!_isKoth&&os.captures!=null)objRows.push([_isLand?'Zones Captured':'Zone Captures',os.captures]);
      if(!_isKoth&&!_isLand&&os.secures!=null)objRows.push(['Zone Secures',os.secures]);
      if(os.defensiveKills!=null)objRows.push(['Defensive Kills',os.defensiveKills]);
      if(os.offensiveKills!=null)objRows.push(['Offensive Kills',os.offensiveKills]);
      if(os.occupationTime)objRows.push([_occLabel,fmtDurS(os.occupationTime)]);
    } else if(os.mode==='Stockpile'){
      if(os.seedsDeposited!=null)objRows.push(['Seeds Deposited',os.seedsDeposited]);
      if(os.seedsStolen!=null)objRows.push(['Seeds Stolen',os.seedsStolen]);
      if(os.seedsPickedUp!=null)objRows.push(['Seeds Picked Up',os.seedsPickedUp]);
    }
    if(objRows.length){
      html+='<div style="margin-top:14px">'
        +'<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">'+os.mode+' Objectives</div>'
        +'<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:6px">';
      objRows.forEach(function(r){
        html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:6px 10px">'
          +'<div style="font-size:9px;color:var(--muted);font-family:Share Tech Mono,monospace;letter-spacing:.5px">'+r[0]+'</div>'
          +'<div style="font-size:15px;font-weight:700;color:var(--text);margin-top:2px">'+r[1]+'</div>'
          +'</div>';
      });
      html+='</div></div>';
    }
  }

  // ── Medals ───────────────────────────────────────────────────────────
  if(m.topMedals&&m.topMedals.length){
    html+='<div style="margin-top:14px">'
      +'<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Medals</div>'
      +'<div style="display:flex;flex-wrap:wrap;gap:8px">';
    m.topMedals.forEach(function(medal){
      var meta=medalMeta[String(medal.nameId)]||{};
      var name=(meta.name||String(medal.nameId));
      var cols=meta.columns||16;
      var idx=meta.spriteIndex!=null?meta.spriteIndex:null;
      var glow={normal:'#00e676',heroic:'#3b82f6',legendary:'#7c3aed',mythic:'#ff3d57'}[meta.difficulty||'normal'];
      var inner=idx!==null
        ?'<img src="'+MEDAL_SHEET+'" style="position:absolute;width:'+(cols*60)+'px;height:auto;top:-'+(Math.floor(idx/cols)*60)+'px;left:-'+((idx%cols)*60)+'px" onerror="this.parentNode.innerHTML=\'<span style=&quot;font-size:22px;line-height:60px&quot;>'+( '<svg xmlns=&quot;http://www.w3.org/2000/svg&quot; width=&quot;22&quot; height=&quot;22&quot; viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;2&quot;><circle cx=&quot;12&quot; cy=&quot;8&quot; r=&quot;6&quot;/><path d=&quot;M15.477 12.89L17 22l-5-3-5 3 1.523-9.11&quot;/></svg>' )+'</span>\'">'
        :'<span style="font-size:22px;line-height:60px"><svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11"/></svg></span>';
      var nameShort=name.length>14?name.slice(0,13)+'…':name;
      html+='<div style="display:flex;flex-direction:column;align-items:center;width:60px" title="'+name+' ×'+medal.count+'">'
        +'<div style="width:60px;height:60px;position:relative;overflow:hidden;border-radius:4px;box-shadow:0 0 6px '+glow+'44">'+inner+'</div>'
        +'<div style="font-size:9px;color:var(--muted);font-family:Share Tech Mono,monospace;margin-top:3px;text-align:center;line-height:1.2">'+nameShort+'</div>'
        +'<div style="font-size:9px;color:var(--accent);font-family:Share Tech Mono,monospace">×'+medal.count+'</div>'
        +'</div>';
    });
    html+='</div></div>';
  }


  // ── Match Insights ────────────────────────────────────────────────────────
  (function(){
    var insights = [];
    var myGt = (getAllPlayers()[selectedPlayer]||{}).gamertag;
    var myTeam = m.teams ? m.teams.find(function(t){ return t.players && t.players.some(function(p){ return p.gamertag&&p.gamertag.toLowerCase()===(myGt||'').toLowerCase(); }); }) : null;
    var oppTeam = m.teams ? m.teams.find(function(t){ return !t.players.some(function(p){ return p.gamertag&&p.gamertag.toLowerCase()===(myGt||'').toLowerCase(); }); }) : null;
    var me = myTeam ? myTeam.players.find(function(p){ return p.gamertag&&p.gamertag.toLowerCase()===(myGt||'').toLowerCase(); }) : null;
    function iCard(icon, title, body, color) {
      return '<div style="display:flex;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border)">'
        +'<div style="flex-shrink:0;margin-top:1px;color:'+color+'">'+icon+'</div>'
        +'<div><div style="font-size:11px;font-weight:700;color:'+color+';font-family:Share Tech Mono,monospace;letter-spacing:.5px">'+title+'</div>'
        +'<div style="font-size:11px;color:var(--muted);margin-top:2px;line-height:1.4">'+body+'</div></div>'
        +'</div>';
    }
    var icoWarn='<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    var icoOk='<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
    var icoInfo='<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
    if (me && myTeam && myTeam.players.length > 1) {
      var teammates = myTeam.players.filter(function(p){ return p.gamertag !== myGt; });
      var teamKda = myTeam.players.map(function(p){ return (p.kills||0) - (p.deaths||0) + (p.assists||0)/3; });
      var myKda = (me.kills||0) - (me.deaths||0) + (me.assists||0)/3;
      var teamAvgKda = teamKda.reduce(function(a,b){return a+b;},0) / teamKda.length;
      var kd = me.deaths > 0 ? me.kills / me.deaths : me.kills;
      if (kd < 0.6 && me.deaths >= 8) insights.push(iCard(icoWarn,'High Death Count','You died '+me.deaths+'x with only '+me.kills+' kills. Focus on positioning — trade gunfights only when you have shield advantage or high ground.','var(--loss)'));
      if (me.kills > 0 && me.damage > 0) {
        var dmgPerKill = me.damage / me.kills;
        if (dmgPerKill > 800) insights.push(iCard(icoWarn,'Low Damage Efficiency',Math.round(dmgPerKill)+' dmg/kill — you\'re finishing enemies your teammates already weakened. Try to open fights rather than clean up.','var(--gold)'));
        else if (dmgPerKill < 300 && me.kills >= 5) insights.push(iCard(icoOk,'Clean Kills',Math.round(dmgPerKill)+' dmg/kill — you\'re winning gunfights efficiently and finishing opponents quickly.','var(--win)'));
      }
      if (m.objStats && m.outcome === 3) {
        var os = m.objStats;
        if (os.mode==='Oddball'&&(os.timeAsCarrier||0)<10&&me.kills<8) insights.push(iCard(icoWarn,'Low Oddball Contribution','Only '+(os.timeAsCarrier||0)+'s ball time in a loss. Prioritize contesting and holding the ball.','var(--loss)'));
        if ((os.mode==='Strongholds'||os.mode==='King of the Hill')&&(os.captures||0)===0&&(os.secures||0)===0&&(os.occupationTime||0)<15) insights.push(iCard(icoWarn,'No Zone Contribution','Zero captures or secures in a '+os.mode+' loss. Push zones after winning a fight.','var(--loss)'));
        if (os.mode==='CTF'&&(os.flagGrabs||0)===0&&(os.flagReturns||0)===0) insights.push(iCard(icoWarn,'No CTF Participation','No flag grabs or returns. In CTF you need to grab the flag or defend yours.','var(--loss)'));
      }
      if (me.assists > me.kills * 1.5 && me.assists >= 6) insights.push(iCard(icoInfo,'Assist Heavy',me.assists+' assists vs '+me.kills+' kills — you\'re dealing damage but not finishing fights.','var(--gold)'));
      var worstTm = teammates.slice().sort(function(a,b){ return ((a.kills||0)-(a.deaths||0)+(a.assists||0)/3)-((b.kills||0)-(b.deaths||0)+(b.assists||0)/3); })[0];
      var worstKda = worstTm?(worstTm.kills||0)-(worstTm.deaths||0)+(worstTm.assists||0)/3:null;
      if (m.outcome===3&&myKda>teamAvgKda+4&&myKda>2) insights.push(iCard(icoInfo,'You Out-Performed Your Team','Your KDA of '+myKda.toFixed(1)+' was well above your team\'s average of '+teamAvgKda.toFixed(1)+'. The loss wasn\'t on you.','var(--accent)'));
      if (m.outcome===2&&myKda<teamAvgKda-4&&myKda<0) insights.push(iCard(icoInfo,'Teammates Carried This One','Your KDA of '+myKda.toFixed(1)+' was below the team average of '+teamAvgKda.toFixed(1)+'.','var(--accent)'));
      if (worstTm&&worstKda!==null&&worstKda<-6&&worstTm.deaths>=10) {
        var tmName=worstTm.gamertag&&worstTm.gamertag.startsWith('Spartan ')?'A teammate':worstTm.gamertag;
        insights.push(iCard(icoWarn,'Teammate Struggled',tmName+' went '+worstTm.kills+'/'+worstTm.deaths+'/'+worstTm.assists+' (KDA '+worstKda.toFixed(1)+'). Their deaths likely gave the enemy free map control.','var(--gold)'));
      }
      if (oppTeam&&oppTeam.players.length) {
        var oppBest=oppTeam.players.slice().sort(function(a,b){ return ((b.kills||0)-(b.deaths||0)+(b.assists||0)/3)-((a.kills||0)-(a.deaths||0)+(a.assists||0)/3); })[0];
        var oppBestKda=(oppBest.kills||0)-(oppBest.deaths||0)+(oppBest.assists||0)/3;
        if (oppBestKda>myKda+8&&oppBest.kills>=16) {
          var oppName=oppBest.gamertag&&oppBest.gamertag.startsWith('Spartan ')?'An opponent':oppBest.gamertag;
          insights.push(iCard(icoWarn,'Dominant Opponent',oppName+' went '+oppBest.kills+'/'+oppBest.deaths+' and dominated this lobby.','var(--loss)'));
        }
      }
    }
    if (!insights.length) return;
    html += '<div style="margin-top:14px;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">';
    html += '<div style="padding:8px 14px;border-bottom:1px solid var(--border);font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;letter-spacing:1px">Match Insights</div>';
    insights.forEach(function(card,i){
      if(i===insights.length-1) card=card.replace('border-bottom:1px solid var(--border)','border-bottom:none');
      html+=card;
    });
    html += '</div>';
  })();

  return html+'</div>';
}
function analyzeConnectionQuality(m, modeBaselines) {
  // Require a real competitive game — filter out early quits, draws, forfeit games
  var dm=String(m.duration||'').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  var secs=dm?(parseInt(dm[1]||0)*3600)+(parseInt(dm[2]||0)*60)+parseFloat(dm[3]||0):0;
  var mins=secs/60;
  if(mins<3) return null;                          // under 3 min — meaningless data
  if(!m.damageDealt||m.damageDealt<300) return null;
  if(!m.damageTaken||m.damageTaken<300) return null;
  if(m.outcome!==2&&m.outcome!==3) return null;   // draws unreliable

  // Subtract objective carry time — can't shoot while holding ball/flag
  var objHoldSecs=0;
  if(m.objStats&&m.objStats.timeAsCarrier) objHoldSecs=m.objStats.timeAsCarrier;
  else if(m.timeAsCarrier) objHoldSecs=m.timeAsCarrier;
  var effectiveMins=Math.max((secs-objHoldSecs)/60,1);
  // Always subtract carry time — effectiveMins is actual shooting time
  // Objective modes handled by effectiveMins subtraction above
  var dpmDealt=m.damageDealt/effectiveMins;
  var dpmTaken=m.damageTaken/effectiveMins;
  var acc=m.accuracy!=null?parseFloat(m.accuracy):null;
  var kd=m.deaths>0?m.kills/m.deaths:m.kills;
  // Get baseline — for DPM only use Slayer baseline (objective modes vary too much)
  // SPK and accuracy use __overall__ — weapon mechanics don't change by mode
  var mode=m.gameMode||'Unknown';
  // BR (Legacy) fires 3 rounds per trigger pull — normalize to trigger-pull equivalents
  // so SPK is comparable to Bandit Evo. Must match the normalization used in baseline building.
  var isLegacy=mode.indexOf('Legacy')>-1;
  var effectiveShotsFired=isLegacy&&m.shotsFired>0?m.shotsFired/3:m.shotsFired;
  var spk=m.kills>0&&effectiveShotsFired>0?effectiveShotsFired/m.kills:null;
  var _isObjMode=/oddball|ctf|capture|stronghold|stockpile|koth|king/i.test(mode);
  var blOverall=modeBaselines['__overall__'];
  if(!blOverall||blOverall.count<5) return null;
  // For objective modes, skip DPM signals — use Slayer overall as baseline only for acc/SPK
  var bl=_isObjMode?null:(modeBaselines[mode]||blOverall);
  var dpmDealtRatio=(!_isObjMode&&bl&&bl.avgDpmDealt>0)?dpmDealt/bl.avgDpmDealt:1;
  var dpmTakenRatio=(!_isObjMode&&bl&&bl.avgDpmTaken>0)?dpmTaken/bl.avgDpmTaken:1;
  // Accuracy and SPK always vs overall — weapon is the same regardless of mode
  var accDelta=acc!=null&&blOverall.avgAcc>0?acc-blOverall.avgAcc:null;
  var spkDelta=spk!=null&&blOverall.avgSpk>0?spk-blOverall.avgSpk:null;

  // ── Pro-calibrated thresholds ────────────────────────────────────────
  // When pro stats are available, scale thresholds by rank.
  // Rank multiplier: Onyx=1.5×, Diamond=2×, Platinum=2.5×, Gold=3×, Silver/Bronze=3.5×
  // Falls back to hardcoded values if no pros are tracked yet.
  var _tier=(typeof playerData!=='undefined'&&playerData&&playerData.csr)
    ? (function(){var _plPref=['Ranked Arena','Ranked Slayer','Ranked Legacy'];for(var _i=0;_i<_plPref.length;_i++){if(playerData.csr[_plPref[_i]]&&playerData.csr[_plPref[_i]].tier)return playerData.csr[_plPref[_i]].tier;}return null;})()
    : null;
  var _rankMult = {Onyx:1.5,Diamond:2,Platinum:2.5,Gold:3,Silver:3.5,Bronze:3.5}[_tier]||2.5;
  var _proAcc = (typeof proStats!=='undefined'&&proStats&&proStats.accuracy_sd!=null) ? proStats : null;
  // Acceptable accuracy deviation = pro SD × rank multiplier
  var _accBandMild   = _proAcc ? _proAcc.accuracy_sd * _rankMult        : 8;   // "Off Baseline" threshold
  var _accBandStrong = _proAcc ? _proAcc.accuracy_sd * _rankMult * 1.5  : 12;  // "Poor Session" threshold
  var _accGoodMild   = _proAcc ? _proAcc.accuracy_sd * _rankMult        : 6;   // "Good" threshold
  var _accGoodStrong = _proAcc ? _proAcc.accuracy_sd * _rankMult * 1.5  : 10;  // "Great" threshold
  // Pro accuracy reference note for signal messages
  var _proAccNote = _proAcc ? ' (pro acceptable: ≥'+(proStats.accuracy - _accBandMild).toFixed(1)+'%)' : '';

  var signals=[];
  var score=0;

  // ── GOOD CONNECTION signals ──────────────────────────────────────────
  // Accuracy well above your norm
  if(!_isObjMode&&accDelta!=null&&accDelta>=_accGoodStrong&&kd>=1.5){
    signals.push({bad:false,msg:'Accuracy '+acc.toFixed(1)+'% vs your '+blOverall.avgAcc.toFixed(1)+'% avg (+'+accDelta.toFixed(1)+'%) — shots landing cleanly'});
    score+=2;
  } else if(!_isObjMode&&accDelta!=null&&accDelta>=_accGoodMild&&kd>=1.8){
    signals.push({bad:false,msg:'Accuracy '+acc.toFixed(1)+'% (+'+accDelta.toFixed(1)+'% above your overall avg) — shots landing above your baseline'});
    score+=1;
  }
  // DPM well above baseline with good K/D
  if(!_isObjMode&&dpmDealtRatio>1.35&&kd>=1.8){
    signals.push({bad:false,msg:Math.round(dpmDealt)+' dmg/min vs your '+Math.round(bl.avgDpmDealt)+' avg (+'+Math.round((dpmDealtRatio-1)*100)+'%) — shots registering'});
    score+=1;
  }
  // Bandit SPK: well below your own average (cleaner kills than usual)
  if(spkDelta!=null&&spkDelta<=-1.5&&spk<=7){
    signals.push({bad:false,msg:spk.toFixed(1)+' shots/kill vs your '+blOverall.avgSpk.toFixed(1)+' overall avg — winning gunfights faster than usual'});
    score+=1;
  }
  // MMR expectation significantly beaten
  if(m.expectedKills!=null&&m.kills>m.expectedKills+4&&dpmDealtRatio>1.1){
    signals.push({bad:false,msg:'+'+(m.kills-Math.round(m.expectedKills))+' kills above MMR expectation — above baseline for this lobby'});
    score+=1;
  }

  // ── POOR CONNECTION signals ──────────────────────────────────────────
  // Accuracy well below your norm — strongest signal
  if(!_isObjMode&&accDelta!=null&&accDelta<=-_accBandStrong){
    signals.push({bad:true,msg:'Accuracy '+acc.toFixed(1)+'% vs your '+blOverall.avgAcc.toFixed(1)+'% avg ('+accDelta.toFixed(1)+'%) — well below your baseline'+_proAccNote});
    score-=3;
  } else if(!_isObjMode&&accDelta!=null&&accDelta<=-_accBandMild){
    signals.push({bad:true,msg:'Accuracy '+acc.toFixed(1)+'% ('+accDelta.toFixed(1)+'% below your overall avg) — off your baseline'+_proAccNote});
    score-=2;
  }
  // DPM tanked AND taking more damage — lag comp against you
  if(!_isObjMode&&dpmDealtRatio<0.6&&dpmTakenRatio>1.5){
    signals.push({bad:true,msg:'Damage output '+Math.round((1-dpmDealtRatio)*100)+'% below your avg while taking '+Math.round((dpmTakenRatio-1)*100)+'% more — damage ratio well off your baseline'});
    score-=3;
  } else if(!_isObjMode&&dpmDealtRatio<0.65){
    signals.push({bad:true,msg:Math.round(dpmDealt)+' dmg/min ('+Math.round((1-dpmDealtRatio)*100)+'% below your '+mode.replace('Ranked ','')+' avg) — shots not registering'});
    score-=2;
  }
  // Bandit SPK: significantly above your own baseline (forced to fire more to kill)
  if(spkDelta!=null&&spkDelta>=2.5&&spk>=10){
    signals.push({bad:true,msg:spk.toFixed(1)+' shots/kill vs your '+blOverall.avgSpk.toFixed(1)+' overall avg — taking far more shots to finish kills, shots may not be registering'});
    score-=2;
  }
  // MMR expected much more kills
  if(m.expectedKills!=null&&m.kills<m.expectedKills-5&&m.kills<=5){
    signals.push({bad:true,msg:Math.round(m.expectedKills-m.kills)+' fewer kills than MMR expected — below your capability'});
    score-=1;
  }

  if(signals.length===0) return null;
  var verdict=
    score<=-4?{level:'bad', label:'Poor Session',    color:'var(--loss)'}:
    score<=-2?{level:'warn',label:'Off Baseline',    color:'var(--gold)'}:
    score>=3 ?{level:'good',label:'Above Baseline',  color:'var(--win)'}:
    null;
  if(!verdict) return null;

  // Build the wifi SVG icon
  var wifiSvg='<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>';
  verdict.label=wifiSvg+' '+verdict.label;
  return{verdict:verdict,signals:signals,score:score};
}

function renderMatchCard(m,idx,modeBaselines,durSecs,noThumb){
  var _rawKey=m.matchId?m.matchId.replace(/[^a-zA-Z0-9]/g,'_'):('idx_'+idx);
  var _tabPrefix=(typeof activeTab!=="undefined"?activeTab:"")+"__";
  var _mkey=_tabPrefix+_rawKey;
  var isOpen=!!expandedMatches[_mkey];
  var oc=m.outcome===2?'win-card':m.outcome===3?'loss-card':'draw-card';
  var word=m.outcome===2?'WIN':m.outcome===3?'LOSS':'DRAW';
  var pillClass=m.outcome===2?'outcome-win':m.outcome===3?'outcome-loss':'outcome-draw';
  var kd=m.deaths>0?(m.kills/m.deaths).toFixed(2):String(m.kills);
  var maxDmg=Math.max(m.damageDealt||0,m.damageTaken||1,1);
  var dp=Math.round(((m.damageDealt||0)/maxDmg)*100);
  var tp=Math.round(((m.damageTaken||0)/maxDmg)*100);
  var sub=[m.mapName,formatDur(m.duration)].filter(Boolean).join(' \xb7 ');
  var mmrStr=null;
  if(m.mmr&&m.oppMmr){
    var mmrDiff=m.mmr-m.oppMmr;
    var winProb=Math.round(100/(1+Math.pow(10,-mmrDiff/400)));
    mmrStr=winProb+'% win prob';
  }
  var cq=analyzeConnectionQuality(m,modeBaselines||{});
  var cqBadge=cq?'<span class="cq-badge-desktop" style="font-size:10px;color:'+cq.verdict.color+';font-family:Share Tech Mono,monospace;margin-left:4px;white-space:nowrap">'+cq.verdict.label+'</span>':'';
  var detail=isOpen?'<div class="match-detail-panel">'+renderMatchDetail(m,m,modeBaselines,durSecs||0)+'</div>':'';
  // Build as DOM element so no quoting issues, then capture outerHTML AFTER all setup
  var el=document.createElement('div');
  el.className='match-card '+oc+(isOpen?' expanded':'');
  el.id='match_'+_mkey;
  el.setAttribute('data-mkey',_mkey);
  el.setAttribute('data-rawkey',_rawKey);
  // Build innerHTML with _mkey and idx baked directly into onclick
  var safeKey=_mkey.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  // Map image banner
  var imgUrl=(!noThumb&&m.mapImageUrl)?'/api/map-image?url='+encodeURIComponent(m.mapImageUrl):null;
  var bannerHtml=imgUrl
    ?'<div class="match-map-thumb">'+
       '<img src="'+imgUrl+'" alt="" loading="lazy" onerror="this.style.display=String.fromCharCode(110,111,110,101)">'+
       '<div class="match-map-thumb-overlay"></div>'+
       '<div class="match-map-thumb-label">'+
         '<span class="match-map-name">'+(m.mapName||'')+'</span>'+
         '<div style="display:flex;align-items:center;gap:4px;margin-top:2px">'+
         '<span class="match-map-outcome '+(m.outcome===2?'win':m.outcome===3?'loss':'draw')+'">'+(m.outcome===2||m.outcome===3?(m.placement||word):word)+'</span>'+
         (cq?'<span class="cq-badge-mobile" style="font-size:9px;color:'+cq.verdict.color+';font-family:Share Tech Mono,monospace;text-shadow:0 1px 3px rgba(0,0,0,1);font-weight:700">'+cq.verdict.label+'</span>':'')+
         '</div>'+
       '</div>'+
     '</div>'
    :'';
  el.setAttribute('onclick','toggleMatch("'+_mkey+'",'+idx+',"'+_rawKey+'")');
  el.setAttribute('data-tab-ctx', typeof activeTab!=='undefined'?activeTab:'overview');
  el.style.cursor='pointer';
  if(bannerHtml)el.classList.add('has-banner');
  el.innerHTML=
    (bannerHtml?bannerHtml:'')+
    '<div class="match-main" data-mkey="'+_mkey+'" data-rawkey="'+_rawKey+'" data-idx="'+idx+'">'+
      (bannerHtml?'':'<span class="outcome-pill '+pillClass+'">'+(m.outcome===2||m.outcome===3?(m.placement||word):word)+'</span>')+
      '<div class="match-info">'+
        '<div class="match-mode">'+(m.gameMode||'Unknown Mode').replace(/Capture the Flag/gi,'CTF')+cqBadge+'</div>'+
        '<div class="match-sub">'+(bannerHtml?[formatDur(m.duration),mmrStr].filter(Boolean).join(' \xb7 '):sub+(mmrStr?' \xb7 '+mmrStr:''))+'</div>'+
      '</div>'+
      '<div class="match-kda">'+
        '<div class="match-kda-big">'+m.kills+'&thinsp;/&thinsp;'+m.deaths+'&thinsp;/&thinsp;'+m.assists+'</div>'+
        '<div class="match-kda-sub">KDA '+(m.kda!=null?m.kda:'—')+'</div>'+
      '</div>'+
      '<div class="match-dmg">'+
        '<div class="dmg-label">Damage</div>'+
        '<div class="dmg-bar-row"><span style="color:var(--win);width:40px;text-align:right">'+(m.damageDealt?Math.round(m.damageDealt).toLocaleString():'—')+'</span><div class="dmg-bar-track"><div class="dmg-bar-fill" style="width:'+dp+'%;background:var(--win)"></div></div></div>'+
        '<div class="dmg-bar-row"><span style="color:var(--loss);width:40px;text-align:right">'+(m.damageTaken?Math.round(m.damageTaken).toLocaleString():'—')+'</span><div class="dmg-bar-track"><div class="dmg-bar-fill" style="width:'+tp+'%;background:var(--loss)"></div></div></div>'+
      '</div>'+
      '<div class="match-right">'+
        '<span class="match-time">'+timeAgo(m.startTime)+'</span>'+
        (m.csrDelta!=null?'<span class="match-csr" style="color:'+(m.csrDelta>=0?'var(--win)':'var(--loss)')+'\">'+(m.csrDelta>0?'+':'')+m.csrDelta+' CSR</span>':(m.csrAfter?'<span class="match-csr">'+m.csrAfter+'</span>':''))+
        '<span class="match-arrow">'+(isOpen?'▲':'▼')+'</span>'+
      '</div>'+
    '</div>'+
    ((m.damageDealt||m.damageTaken)?
      (function(){
        var d=m.damageDealt||0,t=m.damageTaken||0,tot=d+t||1;
        var gPct=Math.round((d/tot)*100);
        var rPct=100-gPct;
        return '<div class="match-dmg-mobile">'
          +'<span style="color:var(--loss);font-family:Share Tech Mono,monospace;font-size:9px">'+Math.round(t).toLocaleString()+'</span>'
          +'<div style="flex:1;height:4px;border-radius:2px;overflow:hidden;display:flex;margin:0 6px">'
          +'<div style="width:'+rPct+'%;background:var(--loss);opacity:0.8"></div>'
          +'<div style="width:'+gPct+'%;background:var(--win);opacity:0.8"></div>'
          +'</div>'
          +'<span style="color:var(--win);font-family:Share Tech Mono,monospace;font-size:9px">'+Math.round(d).toLocaleString()+'</span>'
          +'</div>';
      })()
    :'')+
    detail;
  return el.outerHTML;
}
