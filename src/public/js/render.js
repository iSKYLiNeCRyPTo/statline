function toggleSynCard(id){
  var panel=document.getElementById(id);
  var arr=document.getElementById(id+'_arr');
  if(!panel)return;
  var open=panel.style.display==='block';
  panel.style.display=open?'none':'block';
  if(arr)arr.textContent=open?'▼':'▲';
}

function synCard(label,games,wr,avgDelta,accentColor,vsLabel){
  var wrColor=wr!=null?(wr>=55?'var(--win)':wr<=45?'var(--loss)':'var(--gold)'):'var(--muted)';
  var h='<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px;display:flex;align-items:center;gap:16px">';
  h+='<div style="flex:1"><div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:2px">'+label+'</div>';
  h+='<div style="font-size:11px;color:var(--muted);font-family:Share Tech Mono,monospace">'+games+' ranked games</div></div>';
  h+='<div style="text-align:right">';
  if(wr!=null)h+='<div style="font-size:20px;font-weight:700;font-family:Rajdhani,sans-serif;color:'+wrColor+'">'+wr+'%</div>';
  h+='<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace">WIN RATE</div>';
  if(vsLabel)h+='<div style="font-size:9px;color:'+(accentColor||'var(--muted)')+';font-family:Share Tech Mono,monospace;margin-top:2px">'+vsLabel+'</div>';
  h+='</div></div>';
  return h;
}

function fmtDuration(sec){
  if(!sec&&sec!==0)return'—';
  if(sec===0)return'0m 0s';
  var s=Math.round(sec),m=Math.floor(s/60);
  return m+'m '+(s%60)+'s';
}

function renderObjectiveStats(matches){
  var objMatches=matches.filter(function(m){return m.objStats;});
  if(!objMatches.length)return'';
  var MODE_KEYS={
    'Oddball':['timeAsCarrier','longestCarry','ballGrabs','killsAsCarrier','carrierKills','scoringTicks'],
    'CTF':['flagCaptures','flagGrabs','flagReturns','flagCarrierKills','flagsStolen'],
    'Strongholds':['captures','secures','defensiveKills','offensiveKills','occupationTime'],
    'King of the Hill':['captures','secures','defensiveKills','offensiveKills','occupationTime'],
    'Land Grab':['captures','secures','defensiveKills','offensiveKills'],
    'Stockpile':['seedsDeposited','seedsStolen','seedsPickedUp']
  };
  var LABELS={
    timeAsCarrier:'Ball Hold Time',longestCarry:'Longest Carry',ballGrabs:'Ball Grabs',
    killsAsCarrier:'Kills as Carrier',carrierKills:'Carrier Kills',scoringTicks:'Scoring Ticks',
    captures:'Zone Captures',secures:'Zone Secures',
    defensiveKills:'Defensive Kills',offensiveKills:'Offensive Kills',occupationTime:'Time in Zone',
    flagCaptures:'Flag Captures',flagGrabs:'Flag Pulls',flagReturns:'Flag Returns',
    flagCarrierKills:'Carrier Kills',flagsStolen:'Flags Stolen',
    seedsDeposited:'Seeds Deposited',seedsStolen:'Seeds Stolen',seedsPickedUp:'Seeds Picked Up'
  };
  var TIME_FIELDS={timeAsCarrier:1,longestCarry:1,occupationTime:1};
  var MODE_ORDER=['Oddball','CTF','Strongholds','King of the Hill','Land Grab','Stockpile'];
  var MODE_ICON={'Oddball':'<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><circle cx="12" cy="11" r="5"/><path d="M9 17v2M15 17v2M7 11a5 5 0 0 1 10 0v2H7v-2z"/></svg>','CTF':'<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>','Strongholds':'<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>','King of the Hill':'<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><path d="M2 19h20v2H2zM2 9l5 3 5-7 5 7 5-3v8H2z"/></svg>','Land Grab':'<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>','Stockpile':'<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>'};
  var byMode={};
  objMatches.forEach(function(m){
    var mode=m.objStats.mode; if(!mode)return;
    if(!byMode[mode])byMode[mode]={wins:0,losses:0,stats:{}};
    var entry=byMode[mode];
    if(m.outcome===2)entry.wins++; else if(m.outcome===3)entry.losses++;
    var allowed=MODE_KEYS[mode]||[];
    allowed.forEach(function(k){
      var v=m.objStats[k];
      if(v!=null&&typeof v==='number'&&v>0){
        if(!entry.stats[k])entry.stats[k]={total:0,count:0};
        entry.stats[k].total+=v; entry.stats[k].count++;
      }
    });
  });
  var modes=Object.keys(byMode); if(!modes.length)return'';
  modes.sort(function(a,b){var ai=MODE_ORDER.indexOf(a),bi=MODE_ORDER.indexOf(b);if(ai===-1)ai=999;if(bi===-1)bi=999;return ai-bi;});
  var html=sectionHead('Objective Stats');
  html+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin-bottom:24px">';
  modes.forEach(function(mode){
    var entry=byMode[mode]; var total=entry.wins+entry.losses; if(total<1)return;
    var wr=Math.round(entry.wins/total*100); var icon=MODE_ICON[mode]||'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" style=\"vertical-align:-1px\"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>';
    html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px">';
    html+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">';
    html+='<span style="font-size:13px;font-weight:700;color:var(--text)">'+icon+' '+mode+'</span>';
    html+='<span style="font-size:11px;color:'+(wr>=50?'var(--win)':'var(--loss)')+';font-family:Share Tech Mono,monospace">'+wr+'% <span style="color:var(--muted);font-size:9px">('+total+'g)</span></span>';
    html+='</div>';
    var allowed=MODE_KEYS[mode]||[]; var hasStats=false;
    allowed.forEach(function(k){
      var val=entry.stats[k]; if(!val||val.count===0)return;
      hasStats=true;
      var avg=val.total/val.count;
      var isTime=!!TIME_FIELDS[k];
      var display=isTime?fmtDuration(avg):avg.toFixed(1);
      var totalDisplay=isTime?fmtDuration(val.total):(val.total%1===0?Math.round(val.total).toLocaleString():val.total.toFixed(0));
      html+='<div style="display:flex;justify-content:space-between;align-items:baseline;font-size:11px;padding:5px 0;border-top:1px solid var(--border)">'
        +'<span style="color:var(--muted2)">'+LABELS[k]+'</span>'
        +'<div style="text-align:right">'
          +'<span style="color:var(--text);font-weight:600">'+display+'</span>'
          +'<span style="color:var(--muted2);font-size:9px;font-family:Share Tech Mono,monospace;margin-left:6px">avg · '+totalDisplay+' total</span>'
        +'</div></div>';
    });
    if(!hasStats)html+='<div style="font-size:10px;color:var(--muted);font-family:Share Tech Mono,monospace">Stats build over new matches</div>';
    html+='</div>';
  });
  html+='</div>'; return html;
}

function renderCsrEfficiency(matches){
  var cm=matches.filter(function(m){return m.csrDelta!=null&&m.csrDelta!==0&&m.isRanked;}).slice(0,100);
  if(cm.length<3)return'';

  var wins=cm.filter(function(m){return m.csrDelta>0;});
  var losses=cm.filter(function(m){return m.csrDelta<0;});
  var totalGained=wins.reduce(function(s,m){return s+m.csrDelta;},0);
  var totalLost=Math.abs(losses.reduce(function(s,m){return s+m.csrDelta;},0));
  var netCSR=totalGained-totalLost;
  var avgGain=wins.length?totalGained/wins.length:0;
  var avgLoss=losses.length?totalLost/losses.length:0;
  var ratio=avgLoss>0?(avgGain/avgLoss):0;
  var netColor=netCSR>=0?'var(--win)':'var(--loss)';
  var ratioColor=ratio>=1.1?'var(--win)':ratio>=0.9?'var(--gold)':'var(--loss)';

  // MMR analysis
  var cmWithMmr=cm.filter(function(m){return m.mmr&&m.oppMmr;});
  var p=(getAllPlayers()[selectedPlayer]||{});
  var arenaCsr=p.csr&&p.csr['Ranked Arena']?p.csr['Ranked Arena'].value:null;
  var slayerCsr=p.csr&&p.csr['Ranked Slayer']?p.csr['Ranked Slayer'].value:null;

  // ── CSR SETTLEMENT DETECTION ─────────────────────────────────────────────
  // Signs you are CSR-settled (system has high confidence in your rank):
  //   1. Avg gain significantly less than avg loss
  //   2. Your MMR ≈ your CSR (small gap)
  //   3. You are consistently the lowest MMR player in your lobby
  var settlementSignals=[];
  var isSettled=false;
  var settledExplanation='';

  var gainLossGap=avgLoss-avgGain; // positive = losing more than gaining
  if(gainLossGap>=1.5) settlementSignals.push('asymmetric');

  // Detect lobby MMR vs your CSR
  var arenaMatches=cmWithMmr.filter(function(m){return m.gameMode&&m.gameMode.indexOf('Arena')>-1;});
  var slayerMatches=cmWithMmr.filter(function(m){return m.gameMode&&/^Ranked Slayer$/i.test(m.gameMode.trim());});

  function analysisForPlaylist(plMatches, label, currentCsr){
    if(!plMatches.length) return null;
    var avgMyMmr=Math.round(plMatches.reduce(function(s,m){return s+m.mmr;},0)/plMatches.length);
    var avgOppMmr=Math.round(plMatches.reduce(function(s,m){return s+m.oppMmr;},0)/plMatches.length);
    var mmrVsCsr=currentCsr?avgMyMmr-currentCsr:null;

    // Win rate vs expected
    var expectedWins=plMatches.reduce(function(s,m){return s+(1/(1+Math.pow(10,-(m.mmr-m.oppMmr)/400)));},0);
    var actualWins=plMatches.filter(function(m){return m.outcome===2;}).length;
    var expWR=Math.round(expectedWins/plMatches.length*100);
    var actWR=Math.round(actualWins/plMatches.length*100);
    var wrDelta=actWR-expWR;

    // Favored vs underdog breakdown
    var favoredGames=plMatches.filter(function(m){return m.mmr>m.oppMmr;});
    var underdogGames=plMatches.filter(function(m){return m.mmr<m.oppMmr;});
    var favoredWins=favoredGames.filter(function(m){return m.outcome===2;});
    var underdogWins=underdogGames.filter(function(m){return m.outcome===2;});
    var favoredWR=favoredGames.length?Math.round(favoredWins.length/favoredGames.length*100):null;
    var underdogWR=underdogGames.length?Math.round(underdogWins.length/underdogGames.length*100):null;

    // Avg gain/loss by favored vs underdog
    var favWins_csr=favoredWins.reduce(function(s,m){return s+m.csrDelta;},0);
    var favLoss_csr=Math.abs(plMatches.filter(function(m){return m.outcome===3&&m.mmr>m.oppMmr;}).reduce(function(s,m){return s+m.csrDelta;},0));
    var dogWins_csr=underdogWins.reduce(function(s,m){return s+m.csrDelta;},0);
    var dogLoss_csr=Math.abs(plMatches.filter(function(m){return m.outcome===3&&m.mmr<m.oppMmr;}).reduce(function(s,m){return s+m.csrDelta;},0));

    var avgFavGain=favoredWins.length?favWins_csr/favoredWins.length:null;
    var avgFavLoss=plMatches.filter(function(m){return m.outcome===3&&m.mmr>m.oppMmr;}).length?favLoss_csr/plMatches.filter(function(m){return m.outcome===3&&m.mmr>m.oppMmr;}).length:null;
    var avgDogGain=underdogWins.length?dogWins_csr/underdogWins.length:null;

    return{label,avgMyMmr,avgOppMmr,mmrVsCsr,expWR,actWR,wrDelta,
      favoredGames:favoredGames.length,underdogGames:underdogGames.length,
      favoredWR,underdogWR,
      avgFavGain,avgFavLoss,avgDogGain,
      count:plMatches.length};
  }

  var arenaAnalysis=analysisForPlaylist(arenaMatches,'Ranked Arena',arenaCsr);
  var slayerAnalysis=analysisForPlaylist(slayerMatches,'Ranked Slayer',slayerCsr);

  // Determine settlement state from primary playlist
  var primaryAnalysis=arenaAnalysis||slayerAnalysis;
  if(primaryAnalysis){
    var mmrGap=primaryAnalysis.mmrVsCsr;
    // MMR below CSR = system pushing you down = settled/over-placed
    if(mmrGap!==null&&mmrGap<-30) settlementSignals.push('mmr_below_csr');
    // MMR close to CSR = settled at true rank
    if(mmrGap!==null&&Math.abs(mmrGap)<40) settlementSignals.push('mmr_at_csr');
    // Consistent underdog in lobbies despite being the rank you are
    if(primaryAnalysis.underdogGames>primaryAnalysis.favoredGames*1.5) settlementSignals.push('mostly_underdog');
  }

  isSettled=settlementSignals.indexOf('asymmetric')>-1&&
    (settlementSignals.indexOf('mmr_below_csr')>-1||settlementSignals.indexOf('mmr_at_csr')>-1);

  // Build the settlement explanation
  if(isSettled&&primaryAnalysis){
    var gap=primaryAnalysis.mmrVsCsr;
    if(gap!==null&&gap<-30){
      settledExplanation='Your hidden MMR ('+primaryAnalysis.avgMyMmr+') is '+Math.abs(gap)+' below your CSR — the system thinks you\'re slightly over-placed and is applying a downward correction. It will offer smaller gains until your MMR rises to meet your CSR. Focus on win rate, not individual performance.';
    } else {
      settledExplanation='Your MMR and CSR are closely aligned — the system has high confidence in your rank and has tightened the gain/loss window. This is normal at your true rank. To move up you need to exceed expected performance consistently, not just win.';
    }
    if(settlementSignals.indexOf('mostly_underdog')>-1){
      settledExplanation+=' You\'re also consistently the lowest-ranked player in your lobby — wins in these lobbies pay less because the system already expects you to lose, so it discounts your wins and maintains the same loss penalty.';
    }
  }

  // Overperforming individually but losing
  var overPerfLoss=cm.filter(function(m){return m.csrDelta<0&&m.expectedKills!=null&&m.kills>m.expectedKills&&m.deaths<=(m.expectedDeaths+1||999);}).length;

  var html=sectionHead('CSR Efficiency');
  html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 20px;margin-bottom:24px">';

  // Top stat row
  html+='<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px">';
  html+=csrStatMini('Net CSR',(netCSR>=0?'+':'')+netCSR,netColor,'last '+cm.length+' games');
  html+=csrStatMini('Avg Gain','+'+avgGain.toFixed(1),'var(--win)');
  html+=csrStatMini('Avg Loss','-'+avgLoss.toFixed(1),'var(--loss)');
  html+=csrStatMini('Ratio',ratio.toFixed(2)+'x',ratioColor,'gain / loss');
  html+='</div>';

  // Settlement banner — most important thing to communicate
  if(isSettled){
    var bannerColor=primaryAnalysis&&primaryAnalysis.mmrVsCsr<-30?'var(--loss)':'var(--gold)';
    html+='<div style="padding:12px 14px;border-left:3px solid '+bannerColor+';background:var(--surface2);border-radius:0 6px 6px 0;margin-bottom:16px">';
    html+='<div style="font-size:10px;color:'+bannerColor+';font-family:Share Tech Mono,monospace;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">CSR Settled — Why Gains Are Small</div>';
    html+='<div style="font-size:12px;color:var(--text);line-height:1.6">'+settledExplanation+'</div>';
    html+='</div>';
  }

  // Per-playlist MMR breakdown
  [arenaAnalysis,slayerAnalysis].forEach(function(pa){
    if(!pa||pa.count<3) return;
    html+='<div style="margin-bottom:14px">';
    html+='<div style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px">'+pa.label+' ('+pa.count+' games)</div>';
    html+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:8px">';
    html+=csrStatMini('Your Avg MMR',String(pa.avgMyMmr),'var(--accent)');
    html+=csrStatMini('Opp Avg MMR',String(pa.avgOppMmr),'var(--muted)');
    if(pa.mmrVsCsr!==null){
      var gapColor=pa.mmrVsCsr>30?'var(--win)':pa.mmrVsCsr<-30?'var(--loss)':'var(--muted)';
      html+=csrStatMini('MMR vs CSR',(pa.mmrVsCsr>=0?'+':'')+pa.mmrVsCsr,gapColor,'hidden vs visible rank');
    }
    html+=csrStatMini('Expected WR',pa.expWR+'%','var(--muted)');
    var wrColor=pa.wrDelta>=3?'var(--win)':pa.wrDelta<=-3?'var(--loss)':'var(--muted)';
    html+=csrStatMini('Actual WR',pa.actWR+'%',wrColor,(pa.wrDelta>=0?'+':'')+pa.wrDelta+'% vs expected');
    html+='</div>';

    // Favored vs underdog CSR breakdown
    if(pa.favoredGames||pa.underdogGames){
      html+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">';
      // Favored games
      if(pa.favoredGames>0){
        html+='<div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px 12px">';
        html+='<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px">Favored Lobbies ('+pa.favoredGames+'g)</div>';
        if(pa.favoredWR!==null) html+='<div style="font-size:13px;color:'+(pa.favoredWR>=50?'var(--win)':'var(--loss)')+'">'+pa.favoredWR+'% WR</div>';
        if(pa.avgFavGain!==null) html+='<div style="font-size:11px;color:var(--muted)">+'+pa.avgFavGain.toFixed(1)+' gain / '+(pa.avgFavLoss!=null?'-'+pa.avgFavLoss.toFixed(1)+' loss':'—')+'</div>';
        html+='<div style="font-size:10px;color:var(--muted2);margin-top:4px;line-height:1.4">Win expected — small gain, big penalty if you lose</div>';
        html+='</div>';
      }
      // Underdog games
      if(pa.underdogGames>0){
        html+='<div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px 12px">';
        html+='<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px">Underdog Lobbies ('+pa.underdogGames+'g)</div>';
        if(pa.underdogWR!==null) html+='<div style="font-size:13px;color:'+(pa.underdogWR>=50?'var(--win)':'var(--loss)')+'">'+pa.underdogWR+'% WR</div>';
        if(pa.avgDogGain!==null) html+='<div style="font-size:11px;color:var(--muted)">+'+pa.avgDogGain.toFixed(1)+' gain per win</div>';
        html+='<div style="font-size:10px;color:var(--muted2);margin-top:4px;line-height:1.4">Win unexpected — highest CSR gains, smaller penalty if you lose</div>';
        html+='</div>';
      }
      html+='</div>';
    }
    html+='</div>';
  });

  // Individual insights
  html+='<div style="display:flex;flex-direction:column;gap:6px;font-size:12px;margin-top:4px">';
  if(primaryAnalysis){
    var wrDelta=primaryAnalysis.wrDelta;
    var wrColor=wrDelta>=5?'var(--win)':wrDelta<=-5?'var(--loss)':'var(--muted)';
    html+=csrInsight(wrColor,'Win rate vs MMR expectation: '+primaryAnalysis.expWR+'% expected, '+primaryAnalysis.actWR+'% actual ('+(wrDelta>=0?'+':'')+wrDelta+'%). '+(wrDelta>=5?'Outperforming — MMR will rise and gains will improve.':wrDelta<=-5?'Underperforming vs matchmaker expectation — this is why CSR is hard to gain.':'Performing at expectation — consistent but won\'t accelerate rank gain.'));
  }
  if(overPerfLoss>0) html+=csrInsight('var(--gold)',overPerfLoss+' game'+(overPerfLoss>1?'s':'')+' where you outperformed individually but the team lost. These are the most tilting — your stats earn the win but the CSR doesn\'t follow.');
  if(!isSettled&&ratio<0.9) html+=csrInsight('var(--loss)','Gaining '+avgGain.toFixed(1)+' CSR per win but losing '+avgLoss.toFixed(1)+' per loss. To break even you need to win '+(avgLoss/avgGain*100).toFixed(0)+'% of games.');
  html+='</div>';

  html+='</div>';
  return html;
}

function csrStatMini(label,val,color,sub){
  return'<div><div style="font-size:11px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;letter-spacing:.8px">'+label+'</div>'
    +'<div style="font-size:24px;font-weight:700;color:'+color+'">'+val+'</div>'
    +(sub?'<div style="font-size:11px;color:var(--muted)">'+sub+'</div>':'')+'</div>';
}
function csrInsight(color,msg){
  return'<div style="padding:8px 12px;border-left:3px solid '+color+';border-radius:0 4px 4px 0;background:var(--surface2);color:var(--text);font-size:12px;margin-bottom:4px">'+msg+'</div>';
}
function render(){
  if(!data)return;
  if(searchMode&&!data._searchOverride){renderSearch();return;}
  renderPlayerBtns();
  // Show stale data warning
  var staleDiv=document.getElementById('staleBanner');
  var staleBanner=document.getElementById('staleBanner');
  if(!staleBanner){
    staleBanner=document.createElement('div');staleBanner.id='staleBanner';
    var _app=document.getElementById('app');if(_app&&_app.parentNode)_app.parentNode.insertBefore(staleBanner,_app);
  }
  var age=data.lastUpdated?(Date.now()-new Date(data.lastUpdated).getTime())/60000:0;
  var sb2=document.getElementById('staleBanner');
  if(sb2)sb2.innerHTML=age>40?'<div class="stale-banner"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Data is '+Math.round(age)+' minutes old — hit Refresh for latest stats <span class="kbd">R</span></div>':'';
  var p=getAllPlayers()[selectedPlayer]||(data.players||[])[0];
  var updated=data.lastUpdated?new Date(data.lastUpdated).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+' · '+new Date(data.lastUpdated).toLocaleDateString():'—';
  document.getElementById('lastUpdated').textContent=updated;
  if(!p||!p.stats){document.getElementById('app').innerHTML=p&&p._loading?'<div class="loading"><div class="spinner"></div><p>Loading stats for <strong>'+p.gamertag+'</strong>...</p></div>':p&&p.error?'<div class="error-card">'+p.error+'<br><small style="color:var(--muted)">Token may have expired — auto-refresh should fix this shortly.</small></div>':'<div class="loading"><p>No stats yet — click <strong>REFRESH</strong> to load.</p></div>';return;}
  // Show a non-blocking warning banner if last fetch failed but we have cached data
  var fetchErrBanner = data.fetchError ? '<div style="background:rgba(255,61,87,0.08);border:1px solid rgba(255,61,87,0.3);border-radius:8px;padding:10px 16px;color:var(--loss);font-size:12px;margin-bottom:16px"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Last refresh failed: '+data.fetchError+' — showing cached data from '+updated+'</div>' : '';
  var s=p.stats;
  var PVE_MODES=['Mode 41','Mode 42','Firefight','Gruntpocalypse','Attrition'];
  var BAD_MAPS=['Launch Site','Yuletide','Octagon','AIMBOTZ'];
  var filterMatch=function(m){
    if(m.isCustom||m.gameMode==='Custom Game'||m.gameMode==='PvE')return false;
    if(m.gameMode==='Unknown Mode'&&!m.kills&&!m.deaths)return false;
    if(m.gameMode&&PVE_MODES.some(function(p){return m.gameMode.indexOf(p)>-1;}))return false;
    if(m.mapName&&BAD_MAPS.some(function(p){return m.mapName.toUpperCase().indexOf(p.toUpperCase())>-1;}))return false;
    return true;
  };
  // Debug — log filter breakdown once
  if(!window._filterLogged&&matches){
    var all=p.allMatches||p.recentMatches||[];
    var byReason={total:all.length,custom:0,pve:0,badMap:0,unknownMode:0,kept:0};
    all.forEach(function(m){
      if(m.isCustom||m.gameMode==='Custom Game'||m.gameMode==='PvE'){byReason.custom++;return;}
      if(m.gameMode==='Unknown Mode'&&!m.kills&&!m.deaths){byReason.unknownMode++;return;}
      if(m.gameMode&&PVE_MODES.some(function(p){return m.gameMode.indexOf(p)>-1;})){byReason.pve++;return;}
      if(m.mapName&&BAD_MAPS.some(function(p){return m.mapName.toUpperCase().indexOf(p.toUpperCase())>-1;})){byReason.badMap++;return;}
      byReason.kept++;
    });
    console.log('[Filter]',JSON.stringify(byReason));
    window._filterLogged=true;
  }
  // Use fullMatchCache if available (loaded from /api/matches), else fall back to p.allMatches/recentMatches
  var _fullMatches=fullMatchCache[p.gamertag]||(p.allMatches||p.recentMatches||[]);
  var _rawMatches=_fullMatches.filter(filterMatch);
  var matches=_rawMatches;
  var allMatches=_rawMatches;
  var displayMatches=_rawMatches; // same 25 matches
  var filtered=displayMatches;
  // Compute nemeses/victims from current match data
  var nemeses, victims;
  var _rivalMap={};
  _rawMatches.forEach(function(m){
    if(!m.teams) return;
    var myTeam=m.teams.find(function(t){return t.players&&t.players.some(function(pl){return pl.gamertag&&pl.gamertag.toLowerCase()===p.gamertag.toLowerCase();});});
    if(!myTeam) return;
    m.teams.forEach(function(t){
      if(t===myTeam) return;
      (t.players||[]).forEach(function(pl){
        if(!pl.gamertag||pl.gamertag.toLowerCase()===p.gamertag.toLowerCase()||pl.gamertag.startsWith('Spartan ')) return;
        var _rKey=pl.gamertag.toLowerCase();
          if(!_rivalMap[_rKey]) _rivalMap[_rKey]={gamertag:pl.gamertag,wins:0,losses:0,total:0,gamerpicUrl:pl.gamerpicUrl||null,xuid:pl.rawXuid||null};
          if(pl.gamerpicUrl&&!_rivalMap[_rKey].gamerpicUrl)_rivalMap[_rKey].gamerpicUrl=pl.gamerpicUrl;
          if(pl.rawXuid&&!_rivalMap[_rKey].xuid)_rivalMap[_rKey].xuid=pl.rawXuid;
          _rivalMap[_rKey].total++;
          if(m.outcome===2) _rivalMap[_rKey].wins++;
          else if(m.outcome===3) _rivalMap[_rKey].losses++;
      });
    });
  });
  var _rivals=Object.values(_rivalMap).filter(function(r){return r.total>=1;});
  var _sorted=_rivals.sort(function(a,b){return b.total-a.total;});
  nemeses=_sorted.filter(function(r){return r.losses>=r.wins;}).slice(0,10);
  victims=_sorted.filter(function(r){return r.wins>r.losses;}).slice(0,10);

  // Compute mode baselines — use allMatches with strict quality filters, trimmed mean
  (function(){
    function _gdsR(m){if(!m.duration)return 0;var mm=String(m.duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);return mm?(parseInt(mm[1]||0)*3600)+(parseInt(mm[2]||0)*60)+parseFloat(mm[3]||0):0;}
    function _validBL(m){var s=_gdsR(m);return s>=180&&m.damageDealt>=300&&m.damageTaken>=300&&(m.outcome===2||m.outcome===3);}
    function _avgR(arr){return arr.length?arr.reduce(function(a,b){return a+b;},0)/arr.length:0;}
    function _trimR(arr){if(arr.length<6)return _avgR(arr);var s=arr.slice().sort(function(a,b){return a-b;});var cut=Math.max(1,Math.floor(s.length*0.1));return _avgR(s.slice(cut,s.length-cut));}
    var _vM=(allMatches||displayMatches).filter(_validBL);
    var _bk={};
    _vM.forEach(function(m){
      var mode=m.gameMode||'Unknown';
      var _rs=_gdsR(m);
      var _oh=m.objStats&&m.objStats.timeAsCarrier?m.objStats.timeAsCarrier:0;
      var mins=Math.max((_rs-_oh)/60,1);
      [mode,'__overall__'].forEach(function(k){
        if(!_bk[k])_bk[k]={dpmDealt:[],dpmTaken:[],acc:[],spk:[]};
        _bk[k].dpmDealt.push(m.damageDealt/mins);
        _bk[k].dpmTaken.push(m.damageTaken/mins);
        if(m.accuracy!=null)_bk[k].acc.push(parseFloat(m.accuracy));
        if(m.kills>0&&m.shotsFired>0)_bk[k].spk.push(m.shotsFired/m.kills);
      });
    });
    var bl={};
    Object.keys(_bk).forEach(function(mode){
      var b=_bk[mode];
      bl[mode]={avgDpmDealt:_trimR(b.dpmDealt),avgDpmTaken:_trimR(b.dpmTaken),avgAcc:_trimR(b.acc),avgSpk:_trimR(b.spk),count:b.dpmDealt.length};
    });
    window._fragrBaselines=bl;
    window._fragrGds=_gdsR;
  })();
  var html=fetchErrBanner||'';
  html+='<div class="tab-panel'+(activeTab==='overview'?' active':'')+'" data-tab="overview">';
  html+='<div class="hero">'
    +(p.nameplateUrl?'<div class="hero-nameplate" style="background-image:url(\''+p.nameplateUrl+'\')"></div>':'')
    +'<div style="display:flex;align-items:flex-start;gap:14px;position:relative">'+playerEmblem(p,72)+'<div><div style="display:flex;align-items:center;gap:8px"><div class="hero-name">'+(function(){var gt=p.gamertag,sp=gt.indexOf(' ');return sp>-1?gt.slice(0,sp)+' <span>'+gt.slice(sp+1)+'</span>':'<span>'+gt+'</span>';}())+'</div><button id="heroFavBtn" onclick="toggleCurrentFav()" title="Favorite" style="background:transparent;border:none;padding:2px;cursor:pointer;color:var(--muted);flex-shrink:0;line-height:1" onmouseover="this.style.color=\'#ffc107\'" onmouseout="updateFavBtn()"><svg id="heroFavIcon" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></button></div>'+(p.serviceTag?'<div style="font-family:Share Tech Mono,monospace;font-size:10px;color:var(--muted2);letter-spacing:1.5px;margin-top:2px;margin-bottom:2px">['+p.serviceTag+']</div>':'')+'<div class="hero-sub">Halo Infinite · '+s.matchesPlayed.toLocaleString()+' matches · '+s.wins+'W / '+s.losses+'L'+'</div><div class="win-bar-wrap"><div class="win-bar-label"><span>Win rate</span><span>'+s.winRate+'%</span></div><div class="win-bar"><div class="win-bar-fill" style="width:'+s.winRate+'%"></div></div></div></div></div>'
    +'<div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;position:relative">'
    +(p.careerRank&&p.careerRank.adornmentUrl?'<img class="hero-adornment" src="'+p.careerRank.adornmentUrl+'" alt="Career Rank" onerror="this.style.display=\'none\'">':'')
    +'<div><div class="hero-kd-val">'+s.kd+'</div><div class="hero-kd-label">K / D Ratio</div></div>'
    +'</div>'
    +'</div>';
  // Stat row — moved up directly below hero
  var _formCount=window.innerWidth<768?14:10;
  var streak=0,streakChar='';
  for(var si=0;si<matches.length;si++){var mo=matches[si].outcome;if(si===0){streakChar=mo===2?'W':mo===3?'L':'D';}var mc=mo===2?'W':mo===3?'L':'D';if(mc===streakChar)streak++;else break;}
  var streakDots=matches.slice(0,_formCount).map(function(m){var oc=m.outcome===2?'w':m.outcome===3?'l':'d';var lbl=m.outcome===2?'W':m.outcome===3?'L':'D';return'<div class="streak-dot '+oc+'">'+lbl+'</div>';}).join('');
  function _drSecs(m){if(!m.duration)return 0;var mm=String(m.duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);return mm?(parseInt(mm[1]||0)*3600)+(parseInt(mm[2]||0)*60)+parseFloat(mm[3]||0):0;}
  var _dmgMatches=matches.filter(function(m){return(m.outcome===2||m.outcome===3)&&_drSecs(m)>=180;});
  var totalDealt=_dmgMatches.reduce(function(a,m){return a+(m.damageDealt||0);},0);
  var totalTaken=_dmgMatches.reduce(function(a,m){return a+(m.damageTaken||0);},0);
  var dmgRatio=totalTaken>0?(totalDealt/totalTaken).toFixed(2):'—';
  var dmgRatioColor=parseFloat(dmgRatio)>=1?'var(--win)':'var(--loss)';
  html+='<div class="stat-row">'
    +statCard('Kills',s.kills.toLocaleString(),'',s.avgKillsPerGame+' per game')
    +statCard('Deaths',s.deaths.toLocaleString(),'','')
    +statCard('Assists',s.assists.toLocaleString(),'','')
    +statCard('KDA',s.kda,'accent','')
    +statCard('Accuracy',s.accuracy!==null?s.accuracy+'%':'N/A','','')
    +statCard('Total Medals',s.totalMedals.toLocaleString(),'gold','')
    +'<div class="stat-card"><div class="stat-label">Damage Ratio</div><div class="stat-value" style="color:'+dmgRatioColor+'">'+dmgRatio+'</div><div class="stat-sub">dealt / taken</div></div>'
    +'<div class="stat-card"><div class="stat-label">Current Form</div><div class="stat-value" style="font-size:22px">'+(streakChar==='W'?'<span style="color:var(--win)">'+streak+'W</span>':streakChar==='L'?'<span style="color:var(--loss)">'+streak+'L</span>':'<span style="color:var(--muted)">'+streak+'D</span>')+'</div><div class="streak-dots">'+streakDots+'</div></div>'
    +'</div>';
  // Career rank card + CSR cards in same row
  var careerCardHtml='';
  if(p.careerRank){
    var cr=p.careerRank;
    // Parse name into parts: "Staff Sergeant Onyx Grade 1"
    var crParts=cr.name.match(/^(.+?)\s+(Bronze|Silver|Gold|Platinum|Diamond|Onyx)\s+(Grade \d+)$/i);
    var crRank=crParts?crParts[1]:cr.name;
    var crTier=crParts?crParts[2]:'';
    var crGrade=crParts?crParts[3]:'';
    var crStyle=CSR_STYLES[crTier]||{bg:'rgba(175,169,236,0.12)',border:'#AFA9EC',text:'#AFA9EC'};
    // XP progress — PartialProgress out of some total per grade
    // Each grade requires different XP but we can show partial progress as a bar
    // We don't have total per grade but can show the rank number as progress through 272
    // Progress within current grade (xp earned / total needed)
    var rankPct=cr.xpToNext!=null&&cr.xp!=null?Math.round((cr.xp/(cr.xp+cr.xpToNext))*100):Math.round((cr.rank/272)*100);
    careerCardHtml='<div class="csr-card" style="border-color:'+crStyle.border+'33;background:'+crStyle.bg+'">'
      +'<div class="csr-icon" style="background:'+crStyle.bg+';border:2px solid '+crStyle.border+';color:'+crStyle.text+'">'
      +careerIcon(crTier,crRank,crStyle,cr.rank)
      +'</div>'
      +'<div class="csr-info">'
      +'<div class="csr-tier" style="color:'+crStyle.text+'">'+crRank+'</div>'
      +'<div class="csr-detail" style="color:'+crStyle.text+'">'+(crTier?crTier+' ':'')+crGrade+' · Rank '+cr.rank+'/272</div>'
      +'<div class="csr-bar-wrap"><div class="csr-bar-fill" style="width:'+rankPct+'%;background:'+crStyle.border+'"></div></div>'
      +'<div class="csr-bar-labels"><span style="color:'+crStyle.text+'">Career Rank</span><span>'+rankPct+'%</span><span style="color:var(--muted)">to Hero</span></div>'
      +(cr.xpToNext!=null?'<div style="margin-top:6px;font-size:10px;font-family:Share Tech Mono,monospace;color:var(--muted)">+'+cr.xpToNext.toLocaleString()+' XP to next grade</div>':cr.xp?'<div style="margin-top:6px;font-size:10px;font-family:Share Tech Mono,monospace;color:var(--muted)">'+cr.xp.toLocaleString()+' XP earned</div>':'')
      +'</div></div>';
  }
  var csrHtml=renderCsrCards(p.csr,matches);
  if(careerCardHtml||csrHtml)html+='<div class="csr-row">'+careerCardHtml+csrHtml+'</div>';

  // Daily session — count today's matches from recent match history
  var todayStr=new Date().toDateString();
  var todayMatches=matches.filter(function(m){return m.startTime&&new Date(m.startTime).toDateString()===todayStr;});
  if(todayMatches.length>0){
    // Filter to real competitive games for K/D — exclude draws and sub-3-min games
    function _tgSecs(m){if(!m.duration)return 0;var mm=String(m.duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);return mm?(parseInt(mm[1]||0)*3600)+(parseInt(mm[2]||0)*60)+parseFloat(mm[3]||0):0;}
    var _validToday=todayMatches.filter(function(m){return(m.outcome===2||m.outcome===3)&&_tgSecs(m)>=180;});
    var sk=_validToday.reduce(function(a,m){return a+(m.kills||0);},0);
    var sd=_validToday.reduce(function(a,m){return a+(m.deaths||0);},0);
    var sw=todayMatches.filter(function(m){return m.outcome===2;}).length;
    var sl=todayMatches.filter(function(m){return m.outcome===3;}).length;
    var skd=sd>0?(sk/sd).toFixed(2):sk>0?String(sk):'—';
    // Arena = any ranked mode with 'Arena' in name (includes "Ranked Arena: Slayer")
    // Slayer = only "Ranked Slayer" exactly (not Arena: Slayer)
    var arenaToday=todayMatches.filter(function(m){return m.isRanked&&m.csrDelta!=null&&m.gameMode&&m.gameMode.indexOf('Arena')>-1;});
    var slayerToday=todayMatches.filter(function(m){return m.isRanked&&m.csrDelta!=null&&m.gameMode&&/^Ranked Slayer$/.test(m.gameMode.trim());});
    var arenaDelta=arenaToday.reduce(function(a,m){return a+m.csrDelta;},0);
    var slayerDelta=slayerToday.reduce(function(a,m){return a+m.csrDelta;},0);

    // Session fatigue — compare first half vs second half K/D
    var fatigueMsg='';var fatigueColor='var(--muted)';
    if(todayMatches.length>=4){
      var half=Math.floor(todayMatches.length/2);
      // matches are newest first — reverse for chronological
      var chron=todayMatches.slice().reverse();
      var early=chron.slice(0,half);
      var late=chron.slice(half);
      var earlyK=early.reduce(function(a,m){return a+(m.kills||0);},0);
      var earlyD=early.reduce(function(a,m){return a+(m.deaths||0);},0);
      var lateK=late.reduce(function(a,m){return a+(m.kills||0);},0);
      var lateD=late.reduce(function(a,m){return a+(m.deaths||0);},0);
      var earlyKD=earlyD>0?(earlyK/earlyD):earlyK;
      var lateKD=lateD>0?(lateK/lateD):lateK;
      var drop=earlyKD-lateKD;
      var earlyWR=Math.round(early.filter(function(m){return m.outcome===2;}).length/early.length*100);
      var lateWR=Math.round(late.filter(function(m){return m.outcome===2;}).length/late.length*100);
      if(drop>0.2){
        fatigueColor='var(--loss)';
        fatigueMsg='<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"11\" height=\"11\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" style=\"vertical-align:-1px\"><path d=\"M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z\"/><line x1=\"12\" y1=\"9\" x2=\"12\" y2=\"13\"/><line x1=\"12\" y1=\"17\" x2=\"12.01\" y2=\"17\"/></svg> Fatigue detected — K/D dropped from '+earlyKD.toFixed(2)+' to '+lateKD.toFixed(2)+' and win rate from '+earlyWR+'% to '+lateWR+'% as session progressed. Consider a break.';
      } else if(lateKD>earlyKD+0.2){
        fatigueColor='var(--win)';
        fatigueMsg='<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" style=\"vertical-align:-1px\"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg> Warming up — K/D improved from '+earlyKD.toFixed(2)+' to '+lateKD.toFixed(2)+' through the session.';
      } else {
        fatigueColor='var(--muted)';
        fatigueMsg='Consistent performance throughout today\'s session ('+earlyKD.toFixed(2)+' → '+lateKD.toFixed(2)+' K/D).';
      }
    }

    // Consecutive loss streak today
    var streak=0;
    for(var si=0;si<todayMatches.length;si++){
      if(todayMatches[si].outcome===3)streak++;
      else break;
    }

    html+='<div class="session-bar">';
    html+='<div class="session-label">⚡ Today<br><span style="font-size:11px;color:var(--muted2)">'+todayMatches.length+' games</span></div>';
    html+='<div class="session-stats">';
    html+='<div class="session-stat"><div class="session-stat-val" style="color:var(--accent)">'+sk+'</div><div class="session-stat-lbl">Kills</div></div>';
    html+='<div class="session-stat"><div class="session-stat-val">'+sd+'</div><div class="session-stat-lbl">Deaths</div></div>';
    html+='<div class="session-stat"><div class="session-stat-val" style="color:'+(parseFloat(skd)>=1?'var(--win)':'var(--loss)')+'">'+skd+'</div><div class="session-stat-lbl">K/D</div></div>';
    html+='<div class="session-stat"><div class="session-stat-val" style="color:var(--win)">'+sw+'W</div><div class="session-stat-lbl">Wins</div></div>';
    html+='<div class="session-stat"><div class="session-stat-val" style="color:var(--loss)">'+sl+'L</div><div class="session-stat-lbl">Losses</div></div>';
    if(arenaToday.length){var ac=arenaDelta>=0?'+'+arenaDelta:String(arenaDelta);html+='<div class="session-stat"><div class="session-stat-val" style="color:'+(arenaDelta>=0?'var(--win)':'var(--loss)')+'">'+ac+'</div><div class="session-stat-lbl">Arena CSR</div></div>';}
    if(slayerToday.length){var sc2=slayerDelta>=0?'+'+slayerDelta:String(slayerDelta);html+='<div class="session-stat"><div class="session-stat-val" style="color:'+(slayerDelta>=0?'var(--win)':'var(--loss)')+'">'+sc2+'</div><div class="session-stat-lbl">Slayer CSR</div></div>';}
    if(streak>=3)html+='<div class="session-stat"><div class="session-stat-val" style="color:var(--loss)">'+streak+'L</div><div class="session-stat-lbl">Streak <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-3px\"><path d=\"M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z\"/><line x1=\"12\" y1=\"9\" x2=\"12\" y2=\"13\"/><line x1=\"12\" y1=\"17\" x2=\"12.01\" y2=\"17\"/></svg></div></div>';
    html+='</div>';
    if(fatigueMsg)html+='<div style="margin-top:8px;padding:6px 10px;border-left:3px solid '+fatigueColor+';font-size:11px;font-family:Share Tech Mono,monospace;color:'+fatigueColor+';background:var(--surface2);border-radius:0 4px 4px 0">'+fatigueMsg+'</div>';
    html+='</div>';
  }

  // ── Daily Recap (last 14 days) ────────────────────────────────────────────
  (function(){
    function _parseSecs(dur){if(!dur||dur==='PT0S')return 0;var mm=String(dur).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);return mm?(parseInt(mm[1]||0)*3600)+(parseInt(mm[2]||0)*60)+parseFloat(mm[3]||0):0;}
    // Group matches by local date string
    var dayMap={};
    allMatches.forEach(function(m){
      if(!m.startTime)return;
      var ds=new Date(m.startTime).toDateString();
      if(!dayMap[ds])dayMap[ds]={ds:ds,date:new Date(m.startTime),matches:[]};
      dayMap[ds].matches.push(m);
    });
    // Sort days newest first, keep up to 14
    var days=Object.values(dayMap).sort(function(a,b){return b.date-a.date;}).slice(0,14);
    // Need at least 2 days of data to show the section
    if(days.length<2)return;

    var todayDs=new Date().toDateString();
    var yesterDs=new Date(Date.now()-86400000).toDateString();
    function dayLabel(d){
      if(d.ds===todayDs)return'Today';
      if(d.ds===yesterDs)return'Yesterday';
      return d.date.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
    }

    // Compute stats per day
    var dayStats=days.map(function(d){
      var ms=d.matches;
      var valid=ms.filter(function(m){return(m.outcome===2||m.outcome===3)&&_parseSecs(m.duration)>=180;});
      var wins=ms.filter(function(m){return m.outcome===2;}).length;
      var losses=ms.filter(function(m){return m.outcome===3;}).length;
      var k=valid.reduce(function(a,m){return a+(m.kills||0);},0);
      var dth=valid.reduce(function(a,m){return a+(m.deaths||0);},0);
      var kd=dth>0?(k/dth):k;
      var arenaMs=ms.filter(function(m){return m.isRanked&&m.csrDelta!=null&&m.gameMode&&m.gameMode.indexOf('Arena')>-1;});
      var slayerMs=ms.filter(function(m){return m.isRanked&&m.csrDelta!=null&&m.gameMode&&/^Ranked Slayer$/i.test(m.gameMode.trim());});
      var arenaCsr=arenaMs.reduce(function(a,m){return a+m.csrDelta;},0);
      var slayerCsr=slayerMs.reduce(function(a,m){return a+m.csrDelta;},0);
      var bestKda=0;var bestGame=null;
      ms.forEach(function(m){var v=parseFloat(m.kda||0);if(v>bestKda){bestKda=v;bestGame=m;}});
      var dmgDealt=valid.reduce(function(a,m){return a+(m.damageDealt||0);},0);
      var dmgTaken=valid.reduce(function(a,m){return a+(m.damageTaken||0);},0);
      return{label:dayLabel(d),ds:d.ds,matches:ms,games:ms.length,wins:wins,losses:losses,k:k,dth:dth,kd:kd,
        arenaCsr:arenaMs.length?arenaCsr:null,slayerCsr:slayerMs.length?slayerCsr:null,
        bestKda:bestKda,bestGame:bestGame};
    });

    // Find best day by net CSR (or KDA if no CSR data)
    var hasCsr=dayStats.some(function(d){return d.arenaCsr!=null||d.slayerCsr!=null;});
    var bestDayIdx=0;
    dayStats.forEach(function(d,i){
      var score=hasCsr?(d.arenaCsr||0)+(d.slayerCsr||0):d.kd;
      var best=hasCsr?(dayStats[bestDayIdx].arenaCsr||0)+(dayStats[bestDayIdx].slayerCsr||0):dayStats[bestDayIdx].kd;
      if(score>best)bestDayIdx=i;
    });

    html+=sectionHead('Daily Recap');
    html+='<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px">';
    dayStats.forEach(function(d,i){
      var isToday=d.ds===todayDs;
      var isBest=i===bestDayIdx&&!isToday;
      var wr=d.games>0?Math.round(d.wins/d.games*100):0;
      var wrColor=wr>=60?'var(--win)':wr>=40?'var(--gold)':'var(--loss)';
      var kdColor=d.kd>=1.2?'var(--win)':d.kd>=0.8?'var(--gold)':'var(--loss)';
      var kdStr=d.dth>0?d.kd.toFixed(2):(d.k>0?String(d.k):'--');

      // W/L/D dot string — green=win, red=loss, gray=draw
      var draws=d.matches.filter(function(m){return m.outcome!==2&&m.outcome!==3;}).length;
      var wlDots=d.matches.slice(0,14).map(function(m){
        var c=m.outcome===2?'var(--win)':m.outcome===3?'var(--loss)':'#444';
        var size=m.outcome===2||m.outcome===3?'9px':'7px'; // draws slightly smaller
        return'<span style="display:inline-block;width:'+size+';height:'+size+';border-radius:50%;background:'+c+';margin:0 1.5px;vertical-align:middle;flex-shrink:0"></span>';
      }).join('');

      // CSR pills
      var csrBits='';
      if(d.arenaCsr!=null){var ac=d.arenaCsr>=0?'+'+d.arenaCsr:String(d.arenaCsr);csrBits+='<span style="font-size:11px;padding:2px 8px;border-radius:4px;background:'+(d.arenaCsr>=0?'rgba(76,175,80,0.13)':'rgba(244,67,54,0.13)')+';color:'+(d.arenaCsr>=0?'var(--win)':'var(--loss)')+'">Arena '+ac+'</span>';}
      if(d.slayerCsr!=null){var sc=d.slayerCsr>=0?'+'+d.slayerCsr:String(d.slayerCsr);csrBits+='<span style="font-size:11px;padding:2px 8px;border-radius:4px;background:'+(d.slayerCsr>=0?'rgba(76,175,80,0.13)':'rgba(244,67,54,0.13)')+';color:'+(d.slayerCsr>=0?'var(--win)':'var(--loss)')+'">Slayer '+sc+'</span>';}
      if(isBest)csrBits+='<span style="font-size:11px;padding:2px 8px;border-radius:4px;background:rgba(255,193,7,0.13);color:var(--gold)">best day</span>';

      var drawBit=draws?'<span style="color:#555;font-size:11px;margin-left:3px">'+draws+'D</span>':'';
      html+='<div style="display:flex;align-items:center;gap:14px;padding:13px 18px;background:var(--surface2);border-radius:8px;border:1px solid '+(isToday?'var(--accent2)':'var(--border)')+';flex-wrap:wrap">'
        +'<div style="min-width:95px;font-size:13px;font-family:Share Tech Mono,monospace;color:'+(isToday?'var(--accent)':'var(--text)')+';font-weight:'+(isToday?'700':'400')+'">'+d.label+'</div>'
        +'<div style="font-size:11px;color:var(--muted);min-width:52px;white-space:nowrap">'+d.games+' game'+(d.games!==1?'s':'')+'</div>'
        +'<div style="display:flex;align-items:center;flex-wrap:nowrap">'+wlDots+'</div>'
        +'<div style="font-size:14px;font-family:Share Tech Mono,monospace;white-space:nowrap"><span style="color:var(--win)">'+d.wins+'W</span><span style="color:var(--muted2);margin:0 3px">/</span><span style="color:var(--loss)">'+d.losses+'L</span>'+drawBit+'</div>'
        +'<div style="font-size:14px;font-family:Share Tech Mono,monospace;color:'+kdColor+';white-space:nowrap">'+kdStr+' K/D</div>'
        +(csrBits?'<div style="display:flex;gap:6px;flex-wrap:wrap">'+csrBits+'</div>':'')
        +(d.bestGame?'<div style="margin-left:auto;font-size:11px;color:var(--muted);white-space:nowrap">best <span style="color:var(--text)">'+d.bestKda.toFixed(1)+' KDA</span> &middot; '+(d.bestGame.mapName||'')+'</div>':'')
        +'</div>';
    });
    html+='</div>';
  })();

  // ── ACTIVITY HEATMAP ─────────────────────────────────────────────────────────
  // Hidden — not enough historical data to fill the grid meaningfully yet
  html+='<div style="display:none">';
  (function(){
    if(!allMatches.length) return;
    // Build day → count map from all available matches
    var dayMap={};
    allMatches.forEach(function(m){
      if(!m.startTime) return;
      var d=new Date(m.startTime);
      var key=d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate();
      dayMap[key]=(dayMap[key]||0)+1;
    });
    var keys=Object.keys(dayMap);
    if(keys.length<3) return;
    // Determine date range: oldest match to today, capped at 26 weeks
    var now=new Date(); now.setHours(23,59,59,0);
    var oldest=keys.reduce(function(mn,k){var p=k.split('-');var t=new Date(+p[0],+p[1]-1,+p[2]).getTime();return t<mn?t:mn;},Infinity);
    var rangeStart=new Date(Math.max(oldest,now.getTime()-26*7*86400000));
    // Align to Sunday
    var startDate=new Date(rangeStart);
    startDate.setDate(startDate.getDate()-startDate.getDay());
    // Build weeks array
    var weeks=[]; var cur=new Date(startDate);
    while(cur<=now){
      var week=[];
      for(var _d=0;_d<7;_d++){
        var dd=new Date(cur); dd.setDate(dd.getDate()+_d);
        if(dd>now){week.push(null);}
        else{var k2=dd.getFullYear()+'-'+(dd.getMonth()+1)+'-'+dd.getDate();week.push({date:new Date(dd),count:dayMap[k2]||0});}
      }
      weeks.push(week); cur.setDate(cur.getDate()+7);
    }
    var totalGames=Object.values(dayMap).reduce(function(a,v){return a+v;},0);
    var activeDays=keys.length;
    // Best day
    var bestDayKey=keys.reduce(function(bk,k){return(dayMap[k]||0)>(dayMap[bk]||0)?k:bk;},keys[0]);
    var bestDayCount=dayMap[bestDayKey]||0;
    // Longest streak
    var sortedTs=keys.map(function(k){var p=k.split('-');return new Date(+p[0],+p[1]-1,+p[2]).getTime();}).sort(function(a,b){return a-b;});
    var bestStreak=1,curSt=1;
    for(var si=1;si<sortedTs.length;si++){if(sortedTs[si]-sortedTs[si-1]===86400000)curSt++;else curSt=1;if(curSt>bestStreak)bestStreak=curSt;}
    // SVG dimensions
    var cellSz=11,cellGap=2,step=cellSz+cellGap,leftPad=22,topPad=16;
    var svgW=leftPad+weeks.length*step+4, svgH=topPad+7*step+4;
    // Color scale
    function heatColor(n){if(!n)return'style="fill:var(--surface3)"';if(n===1)return'style="fill:rgba(56,138,221,0.28)"';if(n<=3)return'style="fill:rgba(56,138,221,0.52)"';if(n<=5)return'style="fill:rgba(56,138,221,0.76)"';return'style="fill:rgba(56,138,221,0.95)"';}
    var svgBody='';
    var DAY_LBLS=['S','M','T','W','T','F','S'];
    // Day labels
    [1,3,5].forEach(function(di){svgBody+='<text x="'+(leftPad-3)+'" y="'+(topPad+di*step+cellSz*0.75)+'" text-anchor="end" font-family="Share Tech Mono,monospace" font-size="7" style="fill:rgba(133,183,235,0.45)">'+DAY_LBLS[di]+'</text>';});
    // Month labels
    var MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var lastMo=-1;
    weeks.forEach(function(wk,wi){var first=wk.find(function(c){return c;});if(first){var mo=first.date.getMonth();if(mo!==lastMo){lastMo=mo;svgBody+='<text x="'+(leftPad+wi*step)+'" y="'+(topPad-4)+'" font-family="Share Tech Mono,monospace" font-size="7" style="fill:rgba(133,183,235,0.45)">'+MONTHS[mo]+'</text>';}}});
    // Cells
    weeks.forEach(function(wk,wi){
      wk.forEach(function(cell,di){
        if(!cell) return;
        var x=leftPad+wi*step, y=topPad+di*step;
        var tip=cell.date.toLocaleDateString(undefined,{month:'short',day:'numeric'})+(cell.count?' · '+cell.count+' game'+(cell.count!==1?'s':''):'');
        svgBody+='<rect x="'+x+'" y="'+y+'" width="'+cellSz+'" height="'+cellSz+'" rx="2" '+heatColor(cell.count)+'><title>'+tip+'</title></rect>';
      });
    });
    var spanMonths=Math.round((now.getTime()-startDate.getTime())/(30*86400000));
    html+=sectionHead('Activity Heatmap',spanMonths+' months of data');
    html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 20px;margin-bottom:24px">';
    html+='<div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:14px">';
    html+='<div><div style="font-size:22px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--text)">'+totalGames+'</div><div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px">GAMES LOGGED</div></div>';
    html+='<div><div style="font-size:22px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--accent)">'+activeDays+'</div><div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px">ACTIVE DAYS</div></div>';
    if(bestStreak>1)html+='<div><div style="font-size:22px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--gold)">'+bestStreak+'<span style="font-size:12px;color:var(--muted2)"> days</span></div><div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px">BEST STREAK</div></div>';
    if(bestDayCount>=4)html+='<div><div style="font-size:22px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--loss)">'+bestDayCount+'<span style="font-size:12px;color:var(--muted2)"> games</span></div><div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px">MOST IN A DAY</div></div>';
    html+='</div>';
    html+='<div style="overflow-x:auto;-webkit-overflow-scrolling:touch">';
    html+='<svg xmlns="http://www.w3.org/2000/svg" width="'+svgW+'" height="'+svgH+'" viewBox="0 0 '+svgW+' '+svgH+'" style="display:block">'+svgBody+'</svg>';
    html+='</div>';
    html+='<div style="display:flex;align-items:center;gap:5px;margin-top:10px">';
    html+='<span style="font-size:8px;color:rgba(133,183,235,0.4);font-family:Share Tech Mono,monospace">Less</span>';
    ['var(--surface3)','rgba(56,138,221,0.28)','rgba(56,138,221,0.52)','rgba(56,138,221,0.76)','rgba(56,138,221,0.95)'].forEach(function(c){html+='<div style="width:10px;height:10px;background:'+c+';border-radius:2px"></div>';});
    html+='<span style="font-size:8px;color:rgba(133,183,235,0.4);font-family:Share Tech Mono,monospace">More</span>';
    html+='</div>';
    html+='</div>';
  })();
  html+='</div>'; // end heatmap hidden wrapper

  // Tabs handled by sidebar nav
  if(s.topMedals&&s.topMedals.length){html+=sectionHead('Top Medals')+'<div class="medals-grid">';s.topMedals.forEach(function(m){html+=medalImg(m);});html+='</div>';}

  // Last 10 matches on overview — skip if in search mode (they have their own matches shown)
  if(displayMatches.length>0){
    html+=sectionHead('Recent Matches','last 10');
    var _last10=displayMatches.slice(0,10);
    html+='<div class="match-list">';
    _last10.forEach(function(m,i){
      html+=renderMatchCard(m,i,window._fragrBaselines||{},0,false);
    });
    html+='</div>';
    html+='<div style="text-align:center;margin-top:8px"><button onclick="setTab(\'matches\')" style="background:transparent;border:1px solid var(--border);color:var(--muted);padding:6px 18px;border-radius:4px;font-family:Share Tech Mono,monospace;font-size:10px;cursor:pointer;letter-spacing:1px">VIEW ALL MATCHES →</button></div>';
  }
  html+='</div>'; // end overview tab

  // MATCHES TAB — baselines already computed at render start in window._fragrBaselines
  var _modeBaselines=window._fragrBaselines||{};

  html+='<div class="tab-panel'+(activeTab==='matches'?' active':'')+'" data-tab="matches">';
  html+='<div id="matchHistoryContainer"><div class="loading"><div class="spinner"></div><p>Loading match history...</p></div></div>';
  html+='</div>'; // end matches tab

  // BY MAP TAB
  html+='<div class="tab-panel'+(activeTab==='bymap'?' active':'')+'" data-tab="bymap">';
  // Build rich per-map data including mode breakdown and streaks
  var mapData={};
  function _mapDurSecs(m){if(!m.duration)return 0;var mm=String(m.duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);return mm?(parseInt(mm[1]||0)*3600)+(parseInt(mm[2]||0)*60)+parseFloat(mm[3]||0):0;}
  allMatches.forEach(function(m){
    var map=m.mapName||'Unknown';
    if(!mapData[map])mapData[map]={map:map,wins:0,losses:0,kills:0,deaths:0,count:0,assists:0,dmgDealt:0,dmgTaken:0,
      accGames:0,accTotal:0,csrGames:0,csrTotal:0,hsKills:0,totalKillsHs:0,
      shotsFired:0,shotsHit:0,modes:{},recentResults:[],imageUrl:null,
      totalSecs:0,winDmgDealt:0,lossDmgDealt:0,winDmgGames:0,lossDmgGames:0,
      peakDmg:0,dmgGames:0};
    if(!mapData[map].imageUrl&&m.mapImageUrl)mapData[map].imageUrl=m.mapImageUrl;
    var d=mapData[map];
    var secs=_mapDurSecs(m);
    var validGame=(m.outcome===2||m.outcome===3)&&secs>=180;
    d.count++;
    if(validGame){
      d.kills+=m.kills||0;d.deaths+=m.deaths||0;d.assists+=m.assists||0;
      d.dmgDealt+=m.damageDealt||0;d.dmgTaken+=m.damageTaken||0;
      d.totalSecs+=secs;
      if(m.damageDealt>300){
        d.dmgGames++;
        if(m.damageDealt>d.peakDmg)d.peakDmg=m.damageDealt;
        if(m.outcome===2){d.winDmgDealt+=m.damageDealt;d.winDmgGames++;}
        else if(m.outcome===3){d.lossDmgDealt+=m.damageDealt;d.lossDmgGames++;}
      }
      if(m.accuracy!=null){d.accGames++;d.accTotal+=parseFloat(m.accuracy);}
      if(m.csrDelta!=null){d.csrGames++;d.csrTotal+=m.csrDelta;}
      if(m.weaponStats){d.hsKills+=m.weaponStats.headshots||0;d.totalKillsHs+=m.kills||0;}
      if(m.shotsFired){d.shotsFired+=m.shotsFired||0;d.shotsHit+=m.shotsHit||0;}
    }
    if(m.outcome===2)d.wins++;else if(m.outcome===3)d.losses++;
    var mode=(m.gameMode||'Unknown').replace(/Ranked Arena:/i,'').replace(/Ranked /i,'').trim();
    if(!d.modes[mode])d.modes[mode]={wins:0,losses:0,count:0,kills:0,deaths:0,accTotal:0,accGames:0};
    d.modes[mode].count++;
    if(m.outcome===2)d.modes[mode].wins++;else if(m.outcome===3)d.modes[mode].losses++;
    if(validGame){
      d.modes[mode].kills+=m.kills||0;d.modes[mode].deaths+=m.deaths||0;
      if(m.accuracy!=null){d.modes[mode].accTotal+=parseFloat(m.accuracy);d.modes[mode].accGames++;}
    }
    if(d.recentResults.length<10)d.recentResults.push(m.outcome===2?'W':m.outcome===3?'L':'D');
  });
  var mapRows=Object.values(mapData).filter(function(m){return m.count>=1;}).sort(function(a,b){return b.count-a.count;});

  if(!mapRows.length){html+='<div class="empty-state"><div class="empty-state-icon"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"28\" height=\"28\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" style=\"vertical-align:-4px\"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg></div><div class="empty-state-msg">Not enough map data yet</div><div class="empty-state-sub">Load more match history to see map breakdowns</div></div>';}
  else{
    var _qualMaps=mapRows.filter(function(e){return e.count>=2;});
    var bestMapWR=_qualMaps.length?Math.max.apply(null,_qualMaps.map(function(e){return e.wins/e.count;})):-1;
    var worstMapWR=_qualMaps.length?Math.min.apply(null,_qualMaps.map(function(e){return e.wins/e.count;})):2;
    html+=sectionHead('By Map', allMatches.length+' games');
    html+='<div style="display:flex;flex-direction:column;gap:6px">';
    mapRows.forEach(function(e,idx){
      var wr=Math.round((e.wins/e.count)*100);
      var wrRaw=e.wins/e.count;
      var kd=e.deaths>0?(e.kills/e.deaths).toFixed(2):'—';
      var avgKills=(e.kills/e.count).toFixed(1);
      var avgDeaths=(e.deaths/e.count).toFixed(1);
      var dmgRatio=e.dmgTaken>0?(e.dmgDealt/e.dmgTaken).toFixed(2):'—';
      var wrColor=wr>=55?'var(--win)':wr<=40?'var(--loss)':'var(--gold)';
      var isBest=e.count>=2&&bestMapWR>=0&&Math.abs(wrRaw-bestMapWR)<0.0001&&bestMapWR>worstMapWR;
      var isWorst=e.count>=2&&worstMapWR<=1&&Math.abs(wrRaw-worstMapWR)<0.0001&&bestMapWR>worstMapWR;
      var panelId='mapexp_'+idx;
      // Mode breakdown string
      var topModes=Object.entries(e.modes).sort(function(a,b){return b[1].count-a[1].count;}).slice(0,3);
      var _abbrevMode=function(n){return n.replace('King of the Hill','KotH').replace('Strongholds','Holds').replace('Oddball','Oddball').replace('Total Control','TC');};
      var modeStr=topModes.map(function(m){return _abbrevMode(m[0])+'('+m[1].count+')';}).join(', ');
      // Recent form dots
      var formDots=e.recentResults.map(function(r){return'<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'+(r==='W'?'var(--win)':r==='L'?'var(--loss)':'var(--muted)')+';margin:0 1px"></span>';}).join('');
      // Win streak
      var streak=0;var streakType=e.recentResults[0];
      for(var ri=0;ri<e.recentResults.length;ri++){if(e.recentResults[ri]===streakType)streak++;else break;}
      var streakStr=streak>1?(streakType==='W'?'<span style="color:var(--win)">'+streak+'W streak</span>':'<span style="color:var(--loss)">'+streak+'L streak</span>'):'';

      var _mapImgUrl=e.imageUrl?'/api/map-image?url='+encodeURIComponent(e.imageUrl):null;
      html+='<div style="background:var(--surface);border:1px solid '+(isBest?'rgba(0,230,118,0.3)':isWorst?'rgba(255,61,87,0.3)':'var(--border)')+';border-radius:8px;overflow:hidden">';
      // Collapsed row — always visible, click anywhere to expand
      html+='<div onclick="toggleMapExpand(\''+panelId+'\')" style="display:flex;align-items:stretch;cursor:pointer;transition:background 0.15s" onmouseover="this.style.background=\'var(--surface2)\'" onmouseout="this.style.background=\'\'">';
      // Map thumbnail
      if(_mapImgUrl){
        html+='<div class="map-collapsed-thumb" style="width:120px;height:70px;flex-shrink:0;position:relative;overflow:hidden;background:var(--surface3)">'
          +'<img src="'+_mapImgUrl+'" style="width:100%;height:100%;object-fit:cover;object-position:center;display:block" alt="" loading="lazy">'
          +'<div style="position:absolute;inset:0;background:linear-gradient(to right,rgba(0,0,0,0) 50%,var(--surface) 100%);pointer-events:none"></div>'
          +'<div class="map-name-overlay" style="display:none;position:absolute;bottom:5px;left:6px;right:6px">'
          +'<span style="font-family:Share Tech Mono,monospace;font-size:9px;color:rgba(255,255,255,0.95);font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,1);letter-spacing:0.5px;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block">'+e.map+'</span>'
          +'</div>'
          +'</div>';
      }
      // Name + modes
      html+='<div style="flex:1;min-width:0;padding:12px 16px;display:flex;flex-direction:column;justify-content:center">';
      html+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">';
      html+='<span class="map-name-inline" style="font-size:13px;font-weight:700;color:var(--text)">'+e.map+'</span>';
      if(isBest)html+='<span style="font-size:8px;color:var(--win);font-family:Share Tech Mono,monospace;background:rgba(0,230,118,0.1);padding:1px 6px;border-radius:3px"><svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-1px"><polyline points="20 6 9 17 4 12"/></svg> BEST</span>';
      if(isWorst)html+='<span style="font-size:8px;color:var(--loss);font-family:Share Tech Mono,monospace;background:rgba(255,61,87,0.1);padding:1px 6px;border-radius:3px"><svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> WORST</span>';
      html+='</div>';
      html+='<div class="map-mode-str" style="font-size:11px;color:var(--muted2);font-family:Share Tech Mono,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+modeStr+'</div>';
      html+='</div>';
      // Summary stats — win%, K/D, games count
      html+='<div style="display:flex;gap:20px;align-items:center;padding:12px 16px;flex-shrink:0">';
      html+='<div style="text-align:center"><div style="font-size:18px;font-weight:700;font-family:Rajdhani,sans-serif;color:'+wrColor+'">'+wr+'%</div><div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace">WIN</div></div>';
      html+='<div style="text-align:center"><div style="font-size:18px;font-weight:700;font-family:Rajdhani,sans-serif;color:'+(parseFloat(kd)>=1?'var(--win)':'var(--loss)')+'">'+kd+'</div><div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace">K/D</div></div>';
      html+='<div style="text-align:center"><div style="font-size:12px;color:var(--muted);font-family:Share Tech Mono,monospace">'+e.count+'</div><div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace">GAMES</div></div>';
      html+='<span style="color:var(--muted2);font-size:10px;margin-left:4px" id="'+panelId+'_arr">▼</span>';
      html+='</div>';
      html+='</div>'; // end collapsed row

      // Expanded panel — two column desktop, stacked mobile
      html+='<div id="'+panelId+'" style="display:none;border-top:1px solid var(--border)">';
      html+='<div class="mapexp-inner">';

      // Left — large map image
      if(e.imageUrl){
        html+='<div class="mapexp-img" style="position:relative;overflow:hidden;min-height:160px;background:var(--surface3)">'
          +'<img src="'+_mapImgUrl+'" style="width:100%;height:100%;object-fit:cover;object-position:center;display:block" alt="" loading="lazy">'
          +'<div style="position:absolute;inset:0;background:linear-gradient(to right,rgba(0,0,0,0) 60%,var(--surface2) 100%)"></div>'
          +'</div>';
      }

      // Right — rich stats
      var _mapAcc=e.accGames>0?(e.accTotal/e.accGames).toFixed(1):null;
      var _mapCsrAvg=e.csrGames>0?(e.csrTotal/e.csrGames).toFixed(1):null;
      var _mapHsRate=e.totalKillsHs>0?Math.round(e.hsKills/e.totalKillsHs*100):null;
      var _mapAssistRatio=e.kills+e.assists>0?Math.round(e.assists/(e.kills+e.assists)*100):null;
      var _validGames=e.wins+e.losses;

      html+='<div style="padding:20px 24px;background:var(--surface2)">';

      // Row 1 — core stats
      html+='<div class="mapexp-stats-row">';
      function _mStat(label,val,color){return'<div><div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px;margin-bottom:4px">'+label+'</div><div style="font-size:30px;font-weight:700;font-family:Rajdhani,sans-serif;line-height:1;color:'+(color||'var(--text)')+'">'+val+'</div></div>';}
      html+=_mStat('AVG KILLS',avgKills);
      html+=_mStat('AVG DEATHS',avgDeaths);
      html+=_mStat('AVG ASSISTS',e.assists&&_validGames?(e.assists/_validGames).toFixed(1):'—');
      html+=_mStat('K/D',kd,parseFloat(kd)>=1?'var(--win)':'var(--loss)');
      html+='</div>';

      // Row 2 — accuracy, CSR, headshot rate, damage ratio
      html+='<div class="mapexp-stats-row">';
      html+=_mStat('ACCURACY',_mapAcc!=null?_mapAcc+'%':'—',_mapAcc!=null&&parseFloat(_mapAcc)>=50?'var(--win)':_mapAcc!=null&&parseFloat(_mapAcc)<40?'var(--loss)':'var(--text)');
      html+=_mStat('HS FINISH %',_mapHsRate!=null?_mapHsRate+'%':'—',_mapHsRate!=null&&_mapHsRate>=50?'var(--win)':_mapHsRate!=null&&_mapHsRate<30?'var(--loss)':'var(--text)');
      html+=_mStat('DMG RATIO',dmgRatio,parseFloat(dmgRatio)>=1?'var(--win)':'var(--loss)');
      html+='<div><div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px;margin-bottom:4px">RECORD</div><div style="font-size:30px;font-weight:700;font-family:Rajdhani,sans-serif;line-height:1"><span style="color:var(--win)">'+e.wins+'W</span><span style="color:var(--muted)"> / </span><span style="color:var(--loss)">'+e.losses+'L</span></div></div>';
      html+='</div>';

      // CSR net bar if we have data
      if(e.csrGames>=2){
        var _csrNet=Math.round(e.csrTotal);
        var _csrPos=_csrNet>=0;
        html+='<div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;padding:12px 16px;background:var(--surface);border-radius:8px;border:1px solid var(--border)">';
        html+='<div style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px;flex-shrink:0">CSR ON MAP</div>';
        html+='<div style="font-size:22px;font-weight:700;font-family:Rajdhani,sans-serif;color:'+(_csrPos?'var(--win)':'var(--loss)')+'">'+(_csrPos?'+':'')+_csrNet+'</div>';
        html+='<div style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace">'+_mapCsrAvg+' avg / game &nbsp;·&nbsp; '+e.csrGames+' ranked games</div>';
        html+='</div>';
      }

      // Win rate bar
      html+='<div style="margin-bottom:20px">';
      html+='<div style="display:flex;justify-content:space-between;margin-bottom:7px">';
      html+='<span style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px">WIN RATE</span>';
      html+='<span style="font-size:11px;font-family:Share Tech Mono,monospace;color:'+wrColor+'">'+wr+'% &nbsp;('+e.wins+'W / '+e.losses+'L)</span>';
      html+='</div>';
      html+='<div style="height:7px;background:var(--surface3);border-radius:4px;overflow:hidden">';
      html+='<div style="height:100%;width:'+wr+'%;background:'+wrColor+';border-radius:4px;transition:width .4s"></div>';
      html+='</div>';
      html+='</div>';

      // Damage dealt vs taken bars
      if(e.dmgDealt>0&&e.dmgTaken>0&&e.dmgGames>=1){
        var _games=e.wins+e.losses||1;
        var _avgDealt=Math.round(e.dmgDealt/_games);
        var _avgTaken=Math.round(e.dmgTaken/_games);
        var _dmgMax=Math.max(_avgDealt,_avgTaken)||1;
        var _dPct=Math.round((_avgDealt/_dmgMax)*100);
        var _tPct=Math.round((_avgTaken/_dmgMax)*100);
        html+='<div style="margin-bottom:20px">';
        html+='<div style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px;margin-bottom:8px">AVG DAMAGE</div>';
        html+='<div style="display:flex;flex-direction:column;gap:7px">';
        html+='<div style="display:flex;align-items:center;gap:10px">'
          +'<div style="width:40px;font-size:10px;color:var(--win);font-family:Share Tech Mono,monospace;text-align:right;flex-shrink:0">dealt</div>'
          +'<div style="flex:1;height:7px;background:var(--surface3);border-radius:4px;overflow:hidden"><div style="height:100%;width:'+_dPct+'%;background:var(--win);border-radius:4px"></div></div>'
          +'<div style="font-size:14px;font-weight:700;color:var(--win);font-family:Rajdhani,sans-serif;min-width:58px;text-align:right">'+_avgDealt.toLocaleString()+'</div>'
          +'</div>';
        html+='<div style="display:flex;align-items:center;gap:10px">'
          +'<div style="width:40px;font-size:10px;color:var(--loss);font-family:Share Tech Mono,monospace;text-align:right;flex-shrink:0">taken</div>'
          +'<div style="flex:1;height:7px;background:var(--surface3);border-radius:4px;overflow:hidden"><div style="height:100%;width:'+_tPct+'%;background:var(--loss);border-radius:4px;opacity:0.85"></div></div>'
          +'<div style="font-size:14px;font-weight:700;color:var(--loss);font-family:Rajdhani,sans-serif;min-width:58px;text-align:right">'+_avgTaken.toLocaleString()+'</div>'
          +'</div>';
        html+='</div>';
        html+='</div>';
      }

      // Damage: Wins vs Losses
      if(e.winDmgGames>=2&&e.lossDmgGames>=2){
        var _avgWinDmg=Math.round(e.winDmgDealt/e.winDmgGames);
        var _avgLossDmg=Math.round(e.lossDmgDealt/e.lossDmgGames);
        var _wlMax=Math.max(_avgWinDmg,_avgLossDmg)||1;
        var _wPct=Math.round((_avgWinDmg/_wlMax)*100);
        var _lPct=Math.round((_avgLossDmg/_wlMax)*100);
        var _wlDiff=_avgWinDmg-_avgLossDmg;
        var _wlInsight=_wlDiff<-150?'High damage loser — dealing more in losses. Fights going long, not converting.':(_wlDiff>150?'Damage rises with wins — you\'re controlling fights here.':'');
        html+='<div style="margin-bottom:20px">';
        html+='<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">';
        html+='<span style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px">DAMAGE: WINS VS LOSSES</span>';
        html+='<span style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace">'
          +((_wlDiff>=0?'<span style="color:var(--win)">+'+_wlDiff.toLocaleString()+'</span>':'<span style="color:var(--loss)">'+_wlDiff.toLocaleString()+'</span>')+' diff')
          +'</span>';
        html+='</div>';
        html+='<div style="display:flex;flex-direction:column;gap:7px">';
        html+='<div style="display:flex;align-items:center;gap:10px">'
          +'<div style="width:12px;font-size:10px;color:var(--win);font-family:Share Tech Mono,monospace;flex-shrink:0">W</div>'
          +'<div style="flex:1;height:7px;background:var(--surface3);border-radius:4px;overflow:hidden"><div style="height:100%;width:'+_wPct+'%;background:var(--win);border-radius:4px;opacity:0.85"></div></div>'
          +'<div style="font-size:14px;font-weight:700;color:var(--win);font-family:Rajdhani,sans-serif;min-width:58px;text-align:right">'+_avgWinDmg.toLocaleString()+'</div>'
          +'</div>';
        html+='<div style="display:flex;align-items:center;gap:10px">'
          +'<div style="width:12px;font-size:10px;color:var(--muted);font-family:Share Tech Mono,monospace;flex-shrink:0">L</div>'
          +'<div style="flex:1;height:7px;background:var(--surface3);border-radius:4px;overflow:hidden"><div style="height:100%;width:'+_lPct+'%;background:var(--muted);border-radius:4px;opacity:0.7"></div></div>'
          +'<div style="font-size:14px;font-weight:700;color:var(--muted);font-family:Rajdhani,sans-serif;min-width:58px;text-align:right">'+_avgLossDmg.toLocaleString()+'</div>'
          +'</div>';
        html+='</div>';
        if(_wlInsight)html+='<div style="margin-top:8px;font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace;line-height:1.5">'+_wlInsight+'</div>';
        html+='</div>';
      }

      // Recent form
      html+='<div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">';
      html+='<span style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px;white-space:nowrap">RECENT FORM</span>';
      html+=formDots;
      if(streakStr)html+='<span style="font-size:10px;font-family:Share Tech Mono,monospace;margin-left:4px">'+streakStr+'</span>';
      html+='</div>';

      // Mode pills with mini win rate bars
      if(topModes.length>=1){
        html+='<div style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px;margin-bottom:8px">MODES ON THIS MAP</div>';
        html+='<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px">';
        topModes.forEach(function(md){
          var mwr=Math.round((md[1].wins/md[1].count)*100);
          var mwrColor=mwr>=55?'var(--win)':mwr<=40?'var(--loss)':'var(--gold)';
          html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;min-width:110px">';
          html+='<div style="font-size:11px;color:var(--text);font-family:Share Tech Mono,monospace;margin-bottom:6px">'+md[0]+'</div>';
          html+='<div style="display:flex;justify-content:space-between;margin-bottom:5px">';
          html+='<span style="font-size:13px;font-family:Rajdhani,sans-serif;color:'+mwrColor+';font-weight:700">'+mwr+'%</span>';
          html+='<span style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace;align-self:flex-end">'+md[1].wins+'W '+md[1].losses+'L</span>';
          html+='</div>';
          html+='<div style="height:4px;background:var(--surface3);border-radius:2px;overflow:hidden">';
          html+='<div style="height:100%;width:'+mwr+'%;background:'+mwrColor+'"></div>';
          html+='</div>';
          html+='</div>';
        });
        html+='</div>';
      }

      // ── Per-map insights ──────────────────────────────────────────────────
      var _mapInsights=[];
      var _mList=Object.entries(e.modes).filter(function(md){return md[1].count>=2;});

      // Best and worst mode on this map
      if(_mList.length>=2){
        var _sorted=_mList.slice().sort(function(a,b){return(b[1].wins/b[1].count)-(a[1].wins/a[1].count);});
        var _best=_sorted[0];var _worst=_sorted[_sorted.length-1];
        var _bestWR=Math.round(_best[1].wins/_best[1].count*100);
        var _worstWR=Math.round(_worst[1].wins/_worst[1].count*100);
        if(_bestWR-_worstWR>=20){
          _mapInsights.push({color:'var(--win)',text:_best[0]+' is your best mode here ('+_bestWR+'% WR).'});
          if(_worstWR<=35) _mapInsights.push({color:'var(--loss)',text:'Struggling in '+_worst[0]+' on this map ('+_worstWR+'% WR) — consider your approach or positioning for this mode here.'});
        }
      }

      // Low headshot rate on this map — missing finishers
      if(_mapHsRate!=null&&_mapHsRate<30&&e.totalKillsHs>=10){
        _mapInsights.push({color:'var(--gold)',text:'Only '+_mapHsRate+'% headshot finishes here. The sightlines on this map may be throwing off your aim — focus on pre-aiming head level at common corners.'});
      } else if(_mapHsRate!=null&&_mapHsRate>=55){
        var _slayerForHs=e.modes['Slayer'];
        var _slayKDForHs=_slayerForHs&&_slayerForHs.deaths>=5?(_slayerForHs.kills/_slayerForHs.deaths):null;
        if(_slayKDForHs===null||_slayKDForHs>=1.0){
          _mapInsights.push({color:'var(--win)',text:_mapHsRate+'% headshot finish rate — your aim translates well to this map\'s sightlines.'});
        }
      }

      // Accuracy vs overall average
      if(_mapAcc!=null&&window._fragrBaselines){
        var _overallAcc=(window._fragrBaselines['__overall__']||{}).avgAcc||0;
        if(_overallAcc>0){
          var _accDelta=parseFloat(_mapAcc)-_overallAcc;
          if(_accDelta<=-6) _mapInsights.push({color:'var(--loss)',text:'Accuracy '+_mapAcc+'% here vs your '+_overallAcc.toFixed(1)+'% average — this map geometry is not suiting your playstyle. Study the key angles.'});
          else if(_accDelta>=6) _mapInsights.push({color:'var(--win)',text:'Accuracy '+_mapAcc+'% here vs your '+_overallAcc.toFixed(1)+'% average — this map layout works in your favour.'});
        }
      }

      // Per-mode K/D comparison — slayer-specific
      var _slayer=e.modes['Slayer'];
      if(_slayer&&_slayer.deaths>=5){
        var _slayKD=(_slayer.kills/_slayer.deaths).toFixed(2);
        if(parseFloat(_slayKD)<0.7) _mapInsights.push({color:'var(--loss)',text:'Slayer K/D here is '+_slayKD+' — you are losing the raw gunfights on this map. Try holding power positions rather than pushing open sightlines.'});
        else if(parseFloat(_slayKD)>=1.2) _mapInsights.push({color:'var(--win)',text:'Slayer K/D '+_slayKD+' on this map — you win gunfights here consistently.'});
      }

      // CSR trend — net positive or negative
      if(e.csrGames>=4){
        var _csrPerGame=e.csrTotal/e.csrGames;
        if(_csrPerGame<=-3) _mapInsights.push({color:'var(--loss)',text:'Losing '+Math.abs(_csrPerGame).toFixed(1)+' CSR per game here on average — this map is actively costing you rank. Focus on survival and objective play over fighting for kills.'});
        else if(_csrPerGame>=3) _mapInsights.push({color:'var(--win)',text:'Gaining '+_csrPerGame.toFixed(1)+' CSR per game here on average — this is one of your best rank-climbing maps.'});
      }

      // Low win rate but positive K/D — not converting into wins
      if(wr<=40&&parseFloat(kd)>=1.0&&e.count>=4){
        _mapInsights.push({color:'var(--gold)',text:'Positive K/D ('+kd+') but only '+wr+'% wins — you are performing individually but the team is not converting. Focus on objective pressure and calling out.'});
      }

      // Low assists — not sharing damage
      if(_mapAssistRatio!=null&&_mapAssistRatio<6&&e.kills>=15){
        _mapInsights.push({color:'var(--muted)',text:'Low assist rate ('+_mapAssistRatio+'%) on this map — you are going for solo kills. Softening enemies for teammates can open better trade opportunities here.'});
      }

      if(_mapInsights.length){
        html+='<div style="margin-top:16px;display:flex;flex-direction:column;gap:8px">';
        html+='<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px;margin-bottom:2px">MAP INSIGHTS</div>';
        _mapInsights.forEach(function(ins){
          html+='<div style="padding:10px 14px;border-left:3px solid '+ins.color+';background:var(--surface);border-radius:0 4px 4px 0;font-size:11px;color:var(--text);line-height:1.6">'+ins.text+'</div>';
        });
        html+='</div>';
      }

      html+='</div>'; // end right column
      html+='</div>'; // end mapexp-inner
      html+='</div>'; // end expanded panel
      html+='</div>'; // end map card
    });
    html+='</div>'; // end map list

    // By Mode section
    var modeData={};
    allMatches.forEach(function(m){
      var mode=(m.gameMode||'Unknown').replace(/Ranked Arena:/i,'').replace(/Ranked /i,'').trim();
      if(!modeData[mode])modeData[mode]={mode:mode,wins:0,losses:0,kills:0,deaths:0,count:0};
      var md=modeData[mode];md.count++;md.kills+=m.kills||0;md.deaths+=m.deaths||0;
      if(m.outcome===2)md.wins++;else if(m.outcome===3)md.losses++;
    });
    var modeRows=Object.values(modeData).sort(function(a,b){return b.count-a.count;}).filter(function(m){return m.count>=2;});
    if(modeRows.length){
      var bestMWR2=Math.max.apply(null,modeRows.map(function(m){return m.wins/m.count;}));
      var worstMWR2=Math.min.apply(null,modeRows.map(function(m){return m.wins/m.count;}));
      html+=sectionHead('By Game Mode', allMatches.length+' games');
      html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden"><table class="mode-table"><thead><tr><th>Mode</th><th style="text-align:right">Games</th><th style="text-align:right">W</th><th style="text-align:right">L</th><th style="text-align:right">Win%</th><th style="text-align:right">K/D</th></tr></thead><tbody>';
      modeRows.forEach(function(md){
        var wr=Math.round((md.wins/md.count)*100);
        var wrRaw=md.wins/md.count;
        var kd=md.deaths>0?(md.kills/md.deaths).toFixed(2):'—';
        var isBest=wrRaw===bestMWR2&&md.count>=3;
        var isWorst=wrRaw===worstMWR2&&md.count>=3;
        var badge=isBest?' <span style="font-size:9px;color:var(--win)"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"9\" height=\"9\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" style=\"vertical-align:-1px\"><polyline points=\"20 6 9 17 4 12\"/></svg> BEST</span>':isWorst?' <span style="font-size:9px;color:var(--loss)"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"9\" height=\"9\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\"><line x1=\"18\" y1=\"6\" x2=\"6\" y2=\"18\"/><line x1=\"6\" y1=\"6\" x2=\"18\" y2=\"18\"/></svg> WORST</span>':'';
        html+='<tr style="'+(isBest?'background:rgba(0,230,118,0.05)':isWorst?'background:rgba(255,61,87,0.05)':'')+'"><td>'+md.mode+badge+'</td><td style="text-align:right;color:var(--muted)">'+md.count+'</td><td style="text-align:right;color:var(--win)">'+md.wins+'</td><td style="text-align:right;color:var(--loss)">'+md.losses+'</td><td style="text-align:right;color:'+(wr>=50?'var(--win)':'var(--loss)')+'">'+wr+'%</td><td style="text-align:right;color:'+(parseFloat(kd)>=1?'var(--win)':'var(--loss)')+'">'+kd+'</td></tr>';
      });
      html+='</tbody></table></div>';
    }

    // ── Damage Efficiency + Peak Game ─────────────────────────────────────────
    var effRows=mapRows.filter(function(r){return r.dmgGames>=2&&r.dmgDealt>0&&r.dmgTaken>0;})
      .map(function(r){
        var games=r.wins+r.losses;
        var eff=Math.round((r.dmgDealt/(r.dmgDealt+r.dmgTaken))*100);
        var dpk=r.kills>0?Math.round(r.dmgDealt/r.kills):null;
        return {map:r.map,eff:eff,dpk:dpk,peak:r.peakDmg,games:games};
      }).sort(function(a,b){return b.eff-a.eff;});

    if(effRows.length>=2){
      html+=sectionHead('Damage Efficiency by Map','% of total damage you dealt vs taken · lower DPK = cleaner kills');
      html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:24px">';
      html+='<table style="width:100%;border-collapse:collapse;font-family:Share Tech Mono,monospace;font-size:11px">';
      html+='<thead><tr style="border-bottom:1px solid var(--border)">';
      html+='<th style="text-align:left;padding:10px 16px;font-size:9px;color:var(--muted2);letter-spacing:.8px;font-weight:400">MAP</th>';
      html+='<th style="text-align:center;padding:10px 8px;font-size:9px;color:var(--muted2);letter-spacing:.8px;font-weight:400">EFFICIENCY</th>';
      html+='<th style="text-align:right;padding:10px 8px;font-size:9px;color:var(--muted2);letter-spacing:.8px;font-weight:400">DMG / KILL</th>';
      html+='<th style="text-align:right;padding:10px 16px;font-size:9px;color:var(--muted2);letter-spacing:.8px;font-weight:400">PEAK GAME</th>';
      html+='</tr></thead><tbody>';
      effRows.forEach(function(row,i){
        var effColor=row.eff>=55?'var(--win)':row.eff<=45?'var(--loss)':'var(--gold)';
        var dpkColor=row.dpk&&row.dpk<=500?'var(--win)':row.dpk&&row.dpk>=700?'var(--loss)':'var(--text)';
        var isBest=i===0;var isWorst=i===effRows.length-1&&effRows.length>2;
        html+='<tr style="border-bottom:1px solid var(--border2);'+(isBest?'background:rgba(0,230,118,0.04)':isWorst?'background:rgba(255,61,87,0.04)':'')+'">';
        html+='<td style="padding:10px 16px;color:var(--text);font-family:Rajdhani,sans-serif;font-weight:700;font-size:13px">'
          +row.map
          +(isBest?' <span style="font-size:9px;color:var(--win);font-family:Share Tech Mono,monospace">BEST</span>':'')
          +(isWorst?' <span style="font-size:9px;color:var(--loss);font-family:Share Tech Mono,monospace">WORST</span>':'')
          +'</td>';
        html+='<td style="padding:10px 8px;text-align:center">'
          +'<div style="display:flex;align-items:center;gap:6px;justify-content:center">'
          +'<div style="width:48px;height:5px;background:var(--surface3);border-radius:3px;overflow:hidden"><div style="height:100%;width:'+row.eff+'%;background:'+effColor+';border-radius:3px"></div></div>'
          +'<span style="color:'+effColor+';font-weight:700">'+row.eff+'%</span>'
          +'</div></td>';
        html+='<td style="padding:10px 8px;text-align:right;color:'+dpkColor+'">'+(row.dpk?row.dpk.toLocaleString():'—')+'</td>';
        html+='<td style="padding:10px 16px;text-align:right;color:var(--accent);font-weight:700">'+(row.peak?Math.round(row.peak).toLocaleString():'—')+'</td>';
        html+='</tr>';
      });
      html+='</tbody></table>';
      html+='<div style="padding:8px 16px;font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;border-top:1px solid var(--border2)">'
        +'Efficiency = dealt ÷ (dealt + taken) · DMG/Kill: &lt;500 clean, &gt;700 slugfest'
        +'</div>';
      html+='</div>';
    }

  }
  html+='</div>'; // end bymap tab



  // PERFORMANCE TAB
  html+='<div class="tab-panel'+(activeTab==='charts'?' active':'')+'" data-tab="charts">';
  var _cc=window._themeChartColors||['#378ADD','#85B7EB'];

  // ── PLAYSTYLE FINGERPRINT + CONSISTENCY SCORE ─────────────────────────────────
  (function(){
    function _fpSecs(m){var s=String(m.duration||'').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);return s?(parseInt(s[1]||0)*3600)+(parseInt(s[2]||0)*60)+parseFloat(s[3]||0):0;}
    var validMs=allMatches.filter(function(m){return(m.outcome===2||m.outcome===3)&&_fpSecs(m)>=180&&m.kills!=null;});
    if(validMs.length<10) return;

    var totalK=validMs.reduce(function(a,m){return a+(m.kills||0);},0);
    var totalD=validMs.reduce(function(a,m){return a+(m.deaths||0);},0);
    var totalA=validMs.reduce(function(a,m){return a+(m.assists||0);},0);

    // 1. Aggression: K/D — 0.5→0, 2.5→100
    var kd=totalD>0?totalK/totalD:Math.min(totalK,2.5);
    var aggrScore=Math.round(Math.min(100,Math.max(0,(kd-0.5)/2.0*100)));

    // 2. Support: assists/(kills+assists) — 0→0, 40%→100
    var assistPct=(totalK+totalA)>0?totalA/(totalK+totalA):0;
    var supportScore=Math.round(Math.min(100,assistPct/0.40*100));

    // 3. Consistency: inverse KDA std dev — low variance = high score
    var kdas=validMs.map(function(m){return m.deaths>0?(m.kills+(m.assists||0)*0.3)/m.deaths:(m.kills+(m.assists||0)*0.3);});
    var kdaMean=kdas.reduce(function(a,v){return a+v;},0)/kdas.length;
    var kdaStdDev=Math.sqrt(kdas.reduce(function(a,v){return a+Math.pow(v-kdaMean,2);},0)/kdas.length);
    var consScore=Math.round(Math.max(0,Math.min(100,(1-kdaStdDev/1.6)*100)));
    var consLabel=consScore>=80?'Laser-focused':consScore>=60?'Steady':consScore>=40?'Streaky':'Coin flip';
    var consColor=consScore>=80?'var(--win)':consScore>=60?'var(--accent)':consScore>=40?'var(--gold)':'var(--loss)';

    // 4. Carry: % of games above personal median kill count
    var sortedK=validMs.map(function(m){return m.kills||0;}).sort(function(a,b){return a-b;});
    var medK=sortedK[Math.floor(sortedK.length/2)];
    var carryPct=validMs.filter(function(m){return(m.kills||0)>medK;}).length/validMs.length;
    var carryScore=Math.round(Math.min(100,carryPct/0.65*100));

    // 5. Objective: objective stat contribution, or win-rate proxy
    var objMs=validMs.filter(function(m){return m.objStats;});
    var objScore;
    if(objMs.length>=5){
      var objTotal=0,objMax=objMs.length*7;
      objMs.forEach(function(m){
        var o=m.objStats;
        objTotal+=(o.flagCaptures||0)*4+(o.flagGrabs||0)*0.5+(o.captures||0)*2+(o.secures||0)*0.5
          +Math.min((o.timeAsCarrier||0)/60,3)+(o.seedsDeposited||0)*0.3+(o.flagReturns||0)*0.5;
      });
      objScore=Math.round(Math.min(100,objTotal/objMax*100));
    } else {
      objScore=Math.round(validMs.filter(function(m){return m.outcome===2;}).length/validMs.length*100);
    }

    var axes=[
      {label:'AGGRESSION',score:aggrScore},
      {label:'CONSISTENCY',score:consScore},
      {label:'CARRY',score:carryScore},
      {label:'SUPPORT',score:supportScore},
      {label:'OBJECTIVE',score:objScore}
    ];

    // Determine archetype from highest axis
    var sorted=axes.slice().sort(function(a,b){return b.score-a.score;});
    var spread=sorted[0].score-sorted[sorted.length-1].score;
    var archetypes={
      'AGGRESSION':{name:'The Slayer',desc:'Elimination-first. You prioritise kills over everything and win gunfights at a high rate.'},
      'CONSISTENCY':{name:'The Machine',desc:'Reliable every single game. No huge spikes, no collapses — you just show up.'},
      'CARRY':{name:'The Carry',desc:'Your best games are dominant. You raise your ceiling higher than most.'},
      'SUPPORT':{name:'The Enabler',desc:'You set teammates up, share damage, and make the team function better as a unit.'},
      'OBJECTIVE':{name:'The Obj Player',desc:'You win games through smart objective play rather than raw gunfighting.'}
    };
    var archetype=spread<18?{name:'The All-Rounder',desc:'Balanced across all dimensions — no glaring weakness, no dominant signature. Versatile and adaptable.'}:(archetypes[sorted[0].label]||{name:'Balanced',desc:''});

    // SVG radar chart
    var cx=140,cy=115,maxR=75;
    var nAx=5;
    function fpAng(i){return i*2*Math.PI/nAx-Math.PI/2;}
    function fpPt(i,frac){var a=fpAng(i);return{x:+(cx+Math.cos(a)*maxR*frac).toFixed(1),y:+(cy+Math.sin(a)*maxR*frac).toFixed(1)};}

    var svgInner='';
    // Grid rings
    [0.25,0.5,0.75,1].forEach(function(f){
      var pp=[];for(var i=0;i<nAx;i++){var p=fpPt(i,f);pp.push(p.x+','+p.y);}
      svgInner+='<polygon points="'+pp.join(' ')+'" fill="none" stroke="rgba(255,255,255,0.055)" stroke-width="1"/>';
    });
    // Ring percent labels (25/50/75)
    [0.25,0.5,0.75].forEach(function(f){
      svgInner+='<text x="'+(cx+1)+'" y="'+(cy-maxR*f-3)+'" font-family="Share Tech Mono,monospace" font-size="6" style="fill:rgba(133,183,235,0.25)" text-anchor="middle">'+Math.round(f*100)+'</text>';
    });
    // Spokes
    for(var _si=0;_si<nAx;_si++){var _ep=fpPt(_si,1);svgInner+='<line x1="'+cx+'" y1="'+cy+'" x2="'+_ep.x+'" y2="'+_ep.y+'" stroke="rgba(255,255,255,0.055)" stroke-width="1"/>';}
    // Player polygon
    var poly=axes.map(function(ax,i){var p=fpPt(i,Math.max(0.04,ax.score/100));return p.x+','+p.y;}).join(' ');
    svgInner+='<polygon points="'+poly+'" style="fill:rgba(56,138,221,0.14);stroke:rgba(56,138,221,0.82);stroke-width:1.5;stroke-linejoin:round"/>';
    // Vertex dots
    axes.forEach(function(ax,i){var p=fpPt(i,Math.max(0.04,ax.score/100));svgInner+='<circle cx="'+p.x+'" cy="'+p.y+'" r="3" style="fill:#378ADD;stroke:#0b1929;stroke-width:1.5"/>';});
    // Axis labels + score
    var lblR=maxR+26;
    axes.forEach(function(ax,i){
      var a=fpAng(i);
      var lx=+(cx+Math.cos(a)*lblR).toFixed(1);
      var ly=+(cy+Math.sin(a)*lblR).toFixed(1);
      var ta=Math.abs(Math.cos(a))<0.18?'middle':Math.cos(a)>0?'start':'end';
      svgInner+='<text x="'+lx+'" y="'+(ly-5)+'" text-anchor="'+ta+'" font-family="Share Tech Mono,monospace" font-size="7" style="fill:rgba(133,183,235,0.65)" letter-spacing="0.5">'+ax.label+'</text>';
      svgInner+='<text x="'+lx+'" y="'+(ly+9)+'" text-anchor="'+ta+'" font-family="Rajdhani,sans-serif" font-size="14" font-weight="700" style="fill:rgba(230,241,251,0.92)">'+ax.score+'</text>';
    });
    var radarSvg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 284 230" width="284" height="230" style="flex-shrink:0;display:block">'+svgInner+'</svg>';

    html+=sectionHead('Playstyle Fingerprint',validMs.length+' games analysed');
    html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px 24px;margin-bottom:16px;display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap">';
    html+=radarSvg;
    html+='<div style="flex:1;min-width:180px;display:flex;flex-direction:column;gap:0">';
    html+='<div style="font-size:24px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--text);line-height:1.1;margin-bottom:6px">'+archetype.name+'</div>';
    html+='<div style="font-size:12px;color:var(--muted);line-height:1.55;margin-bottom:18px">'+archetype.desc+'</div>';
    axes.forEach(function(ax){
      var barCol=ax.score>=72?'var(--win)':ax.score>=44?'var(--accent)':'var(--muted)';
      html+='<div style="margin-bottom:9px">';
      html+='<div style="display:flex;justify-content:space-between;margin-bottom:3px">';
      html+='<span style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px">'+ax.label+'</span>';
      html+='<span style="font-size:10px;font-family:Rajdhani,sans-serif;font-weight:700;color:'+barCol+'">'+ax.score+'</span>';
      html+='</div>';
      html+='<div style="height:4px;background:var(--surface3);border-radius:2px;overflow:hidden"><div style="height:100%;width:'+ax.score+'%;background:'+barCol+';border-radius:2px"></div></div>';
      html+='</div>';
    });
    html+='</div>';
    html+='</div>';

    // ── CONSISTENCY SCORE — dedicated card ──────────────────────────────────────
    // Mini sparkline of KDA per game (last 30 games)
    var sparkSample=validMs.slice(0,30).reverse();
    var sparkMax=Math.max.apply(null,sparkSample.map(function(m){return m.deaths>0?(m.kills+(m.assists||0)*0.3)/m.deaths:(m.kills+(m.assists||0)*0.3);}));
    sparkMax=Math.max(sparkMax,1);
    var sparkW=Math.min(sparkSample.length*10,300),sparkH=40;
    var sparkBars=sparkSample.map(function(m,i){
      var v=m.deaths>0?(m.kills+(m.assists||0)*0.3)/m.deaths:(m.kills+(m.assists||0)*0.3);
      var h=Math.max(2,Math.round((v/sparkMax)*sparkH));
      var c=m.outcome===2?'rgba(76,175,130,0.75)':'rgba(224,80,80,0.65)';
      return '<rect x="'+(i*10)+'" y="'+(sparkH-h)+'" width="8" height="'+h+'" rx="1" style="fill:'+c+'"/>';
    }).join('');
    // Avg KDA line
    var avgKdaY=Math.round((1-kdaMean/sparkMax)*sparkH);
    avgKdaY=Math.max(1,Math.min(sparkH-1,avgKdaY));
    var sparkSvg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+sparkW+' '+sparkH+'" width="'+sparkW+'" height="'+sparkH+'" style="display:block;border-radius:3px;overflow:hidden">'+sparkBars+'<line x1="0" y1="'+avgKdaY+'" x2="'+sparkW+'" y2="'+avgKdaY+'" stroke="rgba(255,255,255,0.2)" stroke-width="1" stroke-dasharray="3,2"/></svg>';

    html+=sectionHead('Consistency Score','KDA variance across '+validMs.length+' games');
    html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px 24px;margin-bottom:24px;display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap">';
    // Big score
    html+='<div style="flex-shrink:0">';
    html+='<div style="font-size:64px;font-weight:700;font-family:Rajdhani,sans-serif;color:'+consColor+';line-height:1">'+consScore+'</div>';
    html+='<div style="font-size:11px;font-family:Rajdhani,sans-serif;font-weight:700;color:'+consColor+';letter-spacing:1px;margin-top:2px">'+consLabel.toUpperCase()+'</div>';
    html+='<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;margin-top:4px">out of 100</div>';
    html+='</div>';
    html+='<div style="flex:1;min-width:180px">';
    html+='<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px;margin-bottom:8px">KDA PER GAME · last '+sparkSample.length+' games <span style="color:var(--muted2);font-size:8px">— dashed line = avg '+kdaMean.toFixed(2)+'</span></div>';
    html+=sparkSvg;
    html+='<div style="display:flex;gap:16px;margin-top:12px;flex-wrap:wrap">';
    html+='<div><div style="font-size:16px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--text)">'+kdaMean.toFixed(2)+'</div><div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.5px">AVG KDA</div></div>';
    html+='<div><div style="font-size:16px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--gold)">±'+kdaStdDev.toFixed(2)+'</div><div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.5px">STD DEV</div></div>';
    var consInsight=consScore>=80?'Your KDA barely wavers game to game — opponents and teammates alike can predict exactly what they\'re getting.'
      :consScore>=60?'Solid consistency with minor session-to-session swings. You perform close to your ceiling most nights.'
      :consScore>=40?'Performance varies noticeably by session. On good days you can dominate; on bad days the numbers drop sharply. Work on floor, not ceiling.'
      :'High variance — your best games are impressive but your floor is low. Pinpoint what changes between your peak and trough sessions.';
    html+='</div>';
    html+='<div style="margin-top:12px;padding:10px 14px;border-left:3px solid '+consColor+';background:var(--surface2);border-radius:0 4px 4px 0;font-size:11px;color:var(--text);line-height:1.6">'+consInsight+'</div>';
    html+='</div>';
    html+='</div>';
  })();

  // Kill breakdown
  (function(){
    function _durSecs(m){if(!m.duration)return 999;var mm=String(m.duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);return mm?(parseInt(mm[1]||0)*3600)+(parseInt(mm[2]||0)*60)+parseFloat(mm[3]||0):999;}
    var _kbSample=displayMatches.slice(0,100);
    var totalHS=0,totalMelee=0,totalGrenades=0,totalPower=0,totalKillsSample=0,totalDeathsSample=0,kbWins=0,kbLosses=0,kbDraws=0;
    var totalShotsFired=0,totalShotsHit=0;
    _kbSample.forEach(function(m){
      var isDraw=m.outcome!==2&&m.outcome!==3;
      var isTooShort=_durSecs(m)<60;
      // Count record for all games
      if(m.outcome===2) kbWins++;
      else if(m.outcome===3) kbLosses++;
      else kbDraws++;
      // Skip draws and sub-1-minute games from stats — their data is unreliable
      if(isDraw||isTooShort) return;
      var ws=m.weaponStats||{};
      totalHS+=(ws.headshots||0);
      totalMelee+=(ws.melee||0);
      totalGrenades+=(ws.grenades||0);
      totalPower+=(ws.powerWeapon||0);
      totalKillsSample+=(m.kills||0);
      totalDeathsSample+=(m.deaths||0);
      totalShotsFired+=(m.shotsFired||0);
      totalShotsHit+=(m.shotsHit||0);
    });
    var kbAccuracy=totalShotsFired>0?(totalShotsHit/totalShotsFired*100).toFixed(1):null;
    var hasWeaponData=totalHS+totalMelee+totalGrenades+totalPower>0;
    if(!hasWeaponData||!totalKillsSample) return;
    var totalKills=totalKillsSample;
    var hsPct=Math.round((totalHS/totalKills)*100);
    var meleePct=Math.round((totalMelee/totalKills)*100);
    var grenPct=Math.round((totalGrenades/totalKills)*100);
    var powerPct=Math.round((totalPower/totalKills)*100);
    var otherPct=Math.max(0,100-hsPct-meleePct-grenPct-powerPct);
    var _validGames=_kbSample.filter(function(m){return m.outcome===2||m.outcome===3;}).filter(function(m){return _durSecs(m)>=60;});
    var sampleLabel='last '+_kbSample.length+' games';
    html+=sectionHead('Kill Breakdown',sampleLabel);
    function killStat(label,val,pct,color){
      return'<div class="stat-card"><div class="stat-label">'+label+'</div>'
        +'<div class="stat-value" style="color:'+color+'">'+val+'</div>'
        +'<div class="stat-sub">'+pct+'% of kills</div>'
        +'<div style="height:3px;background:var(--surface3);border-radius:2px;overflow:hidden;margin-top:8px">'
        +'<div style="height:100%;width:'+pct+'%;background:'+color+';border-radius:2px"></div></div>'
        +'</div>';
    }
    var kbKD=totalDeathsSample>0?(totalKillsSample/totalDeathsSample).toFixed(2):totalKillsSample.toFixed(2);
    var kbKDColor=parseFloat(kbKD)>=1?'var(--win)':'var(--loss)';
    var kbWLColor=kbWins>=kbLosses?'var(--win)':'var(--loss)';
    var recordStr=kbWins+'W <span style="color:var(--muted);font-size:18px">/</span> '+kbLosses+'L'+(kbDraws?' <span style="color:var(--muted);font-size:18px">/</span> <span style="color:var(--muted2)">'+kbDraws+'D</span>':'');
    var winPct=Math.round(kbWins/((kbWins+kbLosses)||1)*100);
    html+='<div class="stat-row">'
      +'<div class="stat-card"><div class="stat-label">Record</div><div class="stat-value" style="color:'+kbWLColor+';font-size:'+(kbDraws?'20px':'28px')+'">'+recordStr+'</div><div class="stat-sub">'+winPct+'% win rate</div></div>'
      +'<div class="stat-card"><div class="stat-label">K / D</div><div class="stat-value" style="color:'+kbKDColor+'">'+kbKD+'</div><div class="stat-sub">'+totalKillsSample+' kills · '+totalDeathsSample+' deaths</div></div>'
      +'<div class="stat-card"><div class="stat-label">Kills</div><div class="stat-value" style="color:var(--win)">'+totalKillsSample+'</div><div class="stat-sub">'+(_validGames.length?totalKillsSample/_validGames.length:0).toFixed(1)+' per game</div></div>'
      +'<div class="stat-card"><div class="stat-label">Deaths</div><div class="stat-value" style="color:var(--loss)">'+totalDeathsSample+'</div><div class="stat-sub">'+(_validGames.length?totalDeathsSample/_validGames.length:0).toFixed(1)+' per game</div></div>'
      +(kbAccuracy!==null?'<div class="stat-card"><div class="stat-label">Accuracy</div><div class="stat-value" style="color:var(--accent)">'+kbAccuracy+'%</div><div class="stat-sub">shots hit / fired</div></div>':'')
      +killStat('Headshots',totalHS,hsPct,'#ff6b6b')
      +killStat('Power Weapon',totalPower,powerPct,'var(--gold)')
      +killStat('Grenade',totalGrenades,grenPct,'#51cf66')
      +killStat('Melee',totalMelee,meleePct,'#339af0')
      +killStat('Body Shots',Math.max(0,totalKills-totalHS-totalMelee-totalGrenades-totalPower),otherPct,'var(--muted)')
      +'</div>';
  })();

  // Performance Insights
  (function(){
    if(allMatches.length<5) return;
    var insights=[];
    function _durSecs(m){if(!m.duration)return 999;var mm=String(m.duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);return mm?(parseInt(mm[1]||0)*3600)+(parseInt(mm[2]||0)*60)+parseFloat(mm[3]||0):999;}

    function insightCard(icon,label,msg,color){
      return '<div style="display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border)">'
        +'<span style="font-size:15px;flex-shrink:0;margin-top:1px">'+icon+'</span>'
        +'<div><div style="font-size:10px;color:'+color+';font-family:Share Tech Mono,monospace;letter-spacing:.8px;text-transform:uppercase;margin-bottom:2px">'+label+'</div>'
        +'<div style="font-size:12px;color:var(--text);line-height:1.5">'+msg+'</div></div>'
        +'</div>';
    }

    var sorted=allMatches.slice().sort(function(a,b){return new Date(b.startTime||0)-new Date(a.startTime||0);});
    var recent=sorted.slice(0,Math.min(5,sorted.length));
    var older=sorted.slice(5,Math.min(10,sorted.length));

    if(recent.length>=3&&older.length>=3){
      function avgKD(arr){var t=arr.reduce(function(s,m){return s+(m.deaths>0?m.kills/m.deaths:m.kills);},0);return t/arr.length;}
      var recentKD=avgKD(recent);var olderKD=avgKD(older);var delta=recentKD-olderKD;
      if(Math.abs(delta)>=0.10){
        if(delta>=0.10) insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><polyline points=\"23 6 13.5 15.5 8.5 10.5 1 18\"/><polyline points=\"17 6 23 6 23 12\"/></svg>','K/D Trending Up','Your K/D over the last 5 games ('+recentKD.toFixed(2)+') is up +'+delta.toFixed(2)+' from the prior 5 — momentum is building.','var(--win)'));
        else insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><polyline points=\"23 18 13.5 8.5 8.5 13.5 1 6\"/><polyline points=\"17 18 23 18 23 12\"/></svg>','K/D Trending Down','Your K/D over the last 5 games ('+recentKD.toFixed(2)+') is down '+delta.toFixed(2)+' from the prior 5 — you may be fatiguing or facing harder lobbies.','var(--loss)'));
      }
    }

    var accRecent=recent.filter(function(m){return m.accuracy!=null;});
    var accOlder=older.filter(function(m){return m.accuracy!=null;});
    if(accRecent.length>=3&&accOlder.length>=3){
      function avgAcc(arr){return arr.reduce(function(s,m){return s+parseFloat(m.accuracy);},0)/arr.length;}
      var aR=avgAcc(accRecent);var aO=avgAcc(accOlder);var aDelta=aR-aO;
      if(Math.abs(aDelta)>=2){
        if(aDelta>=2) insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><circle cx=\"12\" cy=\"12\" r=\"6\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/></svg>','Accuracy Improving','Shot accuracy is up '+aDelta.toFixed(1)+'% in recent games ('+aR.toFixed(1)+'%) — your aim is locking in.','var(--win)'));
        else insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><circle cx=\"12\" cy=\"12\" r=\"6\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/></svg>','Accuracy Dropping','Shot accuracy is down '+Math.abs(aDelta).toFixed(1)+'% in recent games ('+aR.toFixed(1)+'%) vs prior games ('+aO.toFixed(1)+'%).','var(--gold)'));
      }
    }

    var weaponMatches=allMatches.filter(function(m){return m.weaponStats&&m.kills>0;});
    if(weaponMatches.length>=5){
      var totK=0,totG=0,totM=0,totHS=0,totPW=0;
      weaponMatches.forEach(function(m){totK+=m.kills;totG+=m.weaponStats.grenades||0;totM+=m.weaponStats.melee||0;totHS+=m.weaponStats.headshots||0;totPW+=m.weaponStats.powerWeapon||0;});
      var gPct=totG/totK*100;var mPct=totM/totK*100;var hsPct2=totHS/totK*100;var pwPct=totPW/totK*100;
      if(gPct>22) insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><line x1=\"12\" y1=\"8\" x2=\"12\" y2=\"12\"/><line x1=\"12\" y1=\"16\" x2=\"12.01\" y2=\"16\"/></svg>','Heavy Grenade Reliance',Math.round(gPct)+'% of kills from grenades — grenades should be setting up Bandit fights, not closing them. At this rate opponents may be damaged enough that your gunfight positioning matters less than it should.','var(--muted)'));
      if(mPct>32) insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><path d=\"M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0\"/><path d=\"M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2\"/><path d=\"M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8\"/><path d=\"M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15\"/></svg>','Over-Relying on Melee',Math.round(mPct)+'% of kills are melee — BXB combos are healthy but at '+Math.round(mPct)+'% you may be rushing into melee range instead of finishing gunfights. Opponents at higher ranks will punish aggressive melee approaches.','var(--gold)'));
      if(hsPct2<35&&totHS>0) insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><circle cx=\"12\" cy=\"12\" r=\"6\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/></svg>','Not Finishing with the Headshot','Only '+Math.round(hsPct2)+'% of kills are headshot finishes. With the Bandit, 4 body shots break shields and a headshot closes it — that last shot should be a headshot on most kills. Body-shotting to the finish takes 1-2 extra shots and gives opponents more time to trade or disengage. Consciously aim for the head on the final shot.','var(--gold)'));
      if(pwPct>28) insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><line x1=\"13\" y1=\"2\" x2=\"13\" y2=\"6\"/><line x1=\"21\" y1=\"2\" x2=\"21\" y2=\"6\"/><line x1=\"17\" y1=\"6\" x2=\"17\" y2=\"22\"/><line x1=\"9\" y1=\"22\" x2=\"25\" y2=\"22\"/><line x1=\"9\" y1=\"12\" x2=\"13\" y2=\"6\"/></svg>','Power Weapon Dependent',Math.round(pwPct)+'% of kills from power weapons — you farm them well but your base gunfight rate may be lower than it looks.','var(--muted)'));
    }

        var placementMatches=allMatches.filter(function(m){return m.placement&&/^\d+/.test(m.placement);});
    if(placementMatches.length>=5){
      var avgPlace=placementMatches.reduce(function(s,m){return s+parseInt(m.placement);},0)/placementMatches.length;
      if(avgPlace<=3.0) insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><polyline points=\"6 9 6 2 18 2 18 9\"/><path d=\"M6 18H4a2 2 0 0 1-2-2v-1a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-2\"/><rect x=\"6\" y=\"18\" width=\"12\" height=\"4\"/><line x1=\"12\" y1=\"13\" x2=\"12\" y2=\"9\"/></svg>','Carrying Your Team','You consistently place top 2-3 on your team (avg '+avgPlace.toFixed(1)+') — your lobbies may need stronger teammates to convert wins.','var(--win)'));
      else if(avgPlace>=5.0) insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><path d=\"M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z\"/><line x1=\"12\" y1=\"9\" x2=\"12\" y2=\"13\"/><line x1=\"12\" y1=\"17\" x2=\"12.01\" y2=\"17\"/></svg>','Struggling to Impact','Avg placement '+avgPlace.toFixed(1)+' on your team — focus on surviving longer and converting damage to kills.','var(--loss)'));
    }

    var ctfGames=allMatches.filter(function(m){return m.objStats&&m.objStats.mode==='CTF';});
    var oddballGames=allMatches.filter(function(m){return m.objStats&&m.objStats.mode==='Oddball';});
    if(ctfGames.length>=3){
      var avgCaps=ctfGames.reduce(function(s,m){return s+(m.objStats.flagCaptures||0);},0)/ctfGames.length;
      if(avgCaps<0.3) insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><path d=\"M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z\"/><line x1=\"4\" y1=\"22\" x2=\"4\" y2=\"15\"/></svg>','Low Flag Contribution','Avg '+avgCaps.toFixed(2)+' CTF caps per game — consider being more aggressive about contesting and capping flags.','var(--gold)'));
    }
    if(oddballGames.length>=3){
      var avgHold=oddballGames.reduce(function(s,m){return s+(m.objStats.timeAsCarrier||0);},0)/oddballGames.length;
      if(avgHold<20) insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><path d=\"M12 2a9 9 0 0 1 9 9c0 3.18-1.65 5.97-4.13 7.58L16 21H8l-.87-2.42A9.14 9.14 0 0 1 3 11 9 9 0 0 1 12 2z\"/><line x1=\"9\" y1=\"15\" x2=\"9.01\" y2=\"15\"/><line x1=\"15\" y1=\"15\" x2=\"15.01\" y2=\"15\"/><line x1=\"10\" y1=\"18\" x2=\"14\" y2=\"18\"/></svg>','Low Ball Hold Time','Avg ball carry time is only '+Math.round(avgHold)+'s — you\'re dying too fast or passing to teammates rarely.','var(--gold)'));
    }

    var timeSlots={morning:[],afternoon:[],evening:[]};
    allMatches.forEach(function(m){
      if(!m.startTime||m.deaths===undefined) return;
      var h=new Date(m.startTime).getHours();var kd=m.deaths>0?m.kills/m.deaths:m.kills;
      if(h>=5&&h<12) timeSlots.morning.push(kd);
      else if(h>=12&&h<18) timeSlots.afternoon.push(kd);
      else timeSlots.evening.push(kd);
    });
    function slotAvg(arr){return arr.length?arr.reduce(function(s,v){return s+v;},0)/arr.length:null;}
    var slots=Object.entries(timeSlots).filter(function(e){return e[1].length>=3;}).map(function(e){return{name:e[0],kd:slotAvg(e[1]),count:e[1].length};});
    if(slots.length>=2){
      slots.sort(function(a,b){return b.kd-a.kd;});
      var best=slots[0];var worst=slots[slots.length-1];
      if(best.kd-worst.kd>=0.18){
        var nameMap={morning:'mornings',afternoon:'afternoons',evening:'evenings'};
        insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><polyline points=\"12 6 12 12 16 14\"/></svg>','Peak Hours','You perform best in the '+nameMap[best.name]+' ('+best.kd.toFixed(2)+' K/D) vs '+nameMap[worst.name]+' ('+worst.kd.toFixed(2)+' K/D). Schedule your ranked sessions accordingly.','var(--accent)'));
      }
    }

    var mmrGames=allMatches.filter(function(m){return m.isRanked&&m.mmr&&m.oppMmr&&m.outcome!==0;});
    if(mmrGames.length>=5){
      var favored=mmrGames.filter(function(m){return m.mmr>m.oppMmr;});
      var underdog=mmrGames.filter(function(m){return m.mmr<m.oppMmr;});
      var favWR=favored.length?favored.filter(function(m){return m.outcome===2;}).length/favored.length*100:null;
      var dogWR=underdog.length?underdog.filter(function(m){return m.outcome===2;}).length/underdog.length*100:null;
      if(favWR!==null&&dogWR!==null&&Math.abs(favWR-dogWR)>=15){
        if(dogWR>favWR) insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><polyline points=\"14.5 17.5 3 6 3 3 6 3 17.5 14.5\"/><line x1=\"13\" y1=\"19\" x2=\"19\" y2=\"13\"/><line x1=\"16\" y1=\"16\" x2=\"20\" y2=\"20\"/><line x1=\"19\" y1=\"21\" x2=\"21\" y2=\"19\"/><polyline points=\"14.5 6.5 18 3 21 3 21 6 17.5 9.5\"/><line x1=\"5\" y1=\"14\" x2=\"9\" y2=\"18\"/><line x1=\"7\" y1=\"21\" x2=\"9\" y2=\"19\"/></svg>','Underdog Mentality','You win '+Math.round(dogWR)+'% as the underdog vs '+Math.round(favWR)+'% as the favorite — you rise to the challenge.','var(--win)'));
        else insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><polyline points=\"14.5 17.5 3 6 3 3 6 3 17.5 14.5\"/><line x1=\"13\" y1=\"19\" x2=\"19\" y2=\"13\"/><line x1=\"16\" y1=\"16\" x2=\"20\" y2=\"20\"/><line x1=\"19\" y1=\"21\" x2=\"21\" y2=\"19\"/><polyline points=\"14.5 6.5 18 3 21 3 21 6 17.5 9.5\"/><line x1=\"5\" y1=\"14\" x2=\"9\" y2=\"18\"/><line x1=\"7\" y1=\"21\" x2=\"9\" y2=\"19\"/></svg>','Favored Team Pressure','Win rate drops to '+Math.round(dogWR)+'% as the underdog vs '+Math.round(favWR)+'% when favored — you may tighten up in harder lobbies.','var(--gold)'));
      }
    }

    var mapAccData={};
    allMatches.forEach(function(m){
      if(!m.mapName||m.accuracy==null) return;
      if(m.outcome!==2&&m.outcome!==3) return; // skip draws — unreliable accuracy data
      var _ms=_durSecs(m);if(_ms<180) return; // skip sub-3-min games
      if(!mapAccData[m.mapName]) mapAccData[m.mapName]={total:0,count:0};
      mapAccData[m.mapName].total+=parseFloat(m.accuracy);
      mapAccData[m.mapName].count++;
    });
    var mapAccList=Object.entries(mapAccData).filter(function(e){return e[1].count>=2;}).map(function(e){return{map:e[0],avg:e[1].total/e[1].count};});
    if(mapAccList.length>=3){
      mapAccList.sort(function(a,b){return b.avg-a.avg;});
      var bestMap=mapAccList[0];var worstMap=mapAccList[mapAccList.length-1];
      if(bestMap.avg-worstMap.avg>=4){
        insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><polygon points=\"1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6\"/><line x1=\"8\" y1=\"2\" x2=\"8\" y2=\"18\"/><line x1=\"16\" y1=\"6\" x2=\"16\" y2=\"22\"/></svg>','Map Accuracy Variance','Your accuracy is '+bestMap.avg.toFixed(1)+'% on '+bestMap.map+' vs '+worstMap.avg.toFixed(1)+'% on '+worstMap.map+' — study the sight lines on your weakest maps.','var(--accent)'));
      }
    }



    // Win rate check
    var _wGames=allMatches.filter(function(m){return m.outcome===2||m.outcome===3;});
    if(_wGames.length>=5){
      var _wr=_wGames.filter(function(m){return m.outcome===2;}).length/_wGames.length*100;
      if(_wr<40) insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><polyline points=\"23 18 13.5 8.5 8.5 13.5 1 6\"/><polyline points=\"17 18 23 18 23 12\"/></svg>','Below 40% Win Rate','Your win rate over '+_wGames.length+' games is '+Math.round(_wr)+'% — focus on one playlist and map type until your fundamentals solidify.','var(--loss)'));
      else if(_wr>=60) insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><polyline points=\"23 6 13.5 15.5 8.5 10.5 1 18\"/><polyline points=\"17 6 23 6 23 12\"/></svg>','Above 60% Win Rate','Winning '+Math.round(_wr)+'% of '+_wGames.length+' games — you are consistently outperforming your lobbies.','var(--win)'));
    }

    // Damage ratio
    var _dmgGames=allMatches.filter(function(m){return m.damageTaken>200&&m.damageDealt>200&&(m.outcome===2||m.outcome===3)&&_durSecs(m)>=180;});
    if(_dmgGames.length>=5){
      var _avgRatio=_dmgGames.reduce(function(s,m){return s+m.damageDealt/m.damageTaken;},0)/_dmgGames.length;
      if(_avgRatio<0.85) insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><line x1=\"18\" y1=\"6\" x2=\"6\" y2=\"18\"/><line x1=\"6\" y1=\"6\" x2=\"18\" y2=\"18\"/></svg>','Losing More Fights Than Winning','Damage ratio '+_avgRatio.toFixed(2)+' — you\'re dealing less damage than you\'re receiving across the game. This doesn\'t mean individual fights are unwinnable, but overall you\'re on the back foot more than the front foot.','var(--loss)'));
      else if(_avgRatio>1.2) insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><polyline points=\"22 12 18 12 15 21 9 3 6 12 2 12\"/></svg>','Damage Positive','Damage ratio '+_avgRatio.toFixed(2)+' — you\'re dealing more than you\'re receiving across the game. You\'re winning more engagements than you\'re losing.','var(--win)'));
    }


    // ── SENSITIVITY / AIM INSIGHTS ─────────────────────────────────────────

    // Look sensitivity signal: high accuracy but low headshot rate → sensitivity likely too fast (overshooting heads)
    //                          low accuracy but decent headshot rate → sensitivity too slow (only landing when very close)
    var _aimGames=allMatches.filter(function(m){return m.shotsFired>0&&m.shotsHit!=null&&m.kills>0&&(m.outcome===2||m.outcome===3)&&_durSecs(m)>=180;});
    if(_aimGames.length>=8){
      var _acc=_aimGames.reduce(function(s,m){return s+m.shotsHit/m.shotsFired*100;},0)/_aimGames.length;
      var _hs=_aimGames.reduce(function(s,m){return s+(m.weaponStats&&m.kills>0?m.weaponStats.headshots/m.kills*100:0);},0)/_aimGames.length;
      // High body accuracy but low headshots — shots landing body but not tracking to head → sens too high
      if(_acc>=45&&_hs<35){
        insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14\"/></svg>','Try Lowering Look Sensitivity','Accuracy ('+_acc.toFixed(1)+'%) is solid but only '+_hs.toFixed(0)+'% of kills are headshot finishes — most Bandit kills should end with the headshot. You may be drifting to body level on the final shot. Try holding chin height through the whole burst so the finishing shot naturally lands on the head. If you feel like you\'re consistently overshooting past the head, try dropping sensitivity by 1.','var(--accent)'));
      }
      // Low accuracy overall but higher headshot % — only landing when almost stationary → sens too low / deadzone masking input
      else if(_acc<40&&_hs>=40){
        insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14\"/></svg>','Try Raising Look Sensitivity','Low accuracy ('+_acc.toFixed(1)+'%) but solid headshot rate ('+_hs.toFixed(0)+'%) — you\'re precise when still but missing when targets strafe. With the Bandit this usually means sensitivity is too low to track lateral movement. Try raising look sensitivity by 1 or reducing your outer deadzone to improve strafe-tracking.','var(--accent)'));
      }
    }

    // Deadzone signal: very low accuracy on close-range maps (high melee %) — controller input lag / sluggish response
    var _meleeHeavy=_aimGames.filter(function(m){return m.weaponStats&&m.kills>0&&m.weaponStats.melee/m.kills>0.25&&_durSecs(m)>=180;});
    if(_meleeHeavy.length>=5){
      var _meleeAcc=_meleeHeavy.reduce(function(s,m){return s+m.shotsHit/m.shotsFired*100;},0)/_meleeHeavy.length;
      if(_meleeAcc<38){
        insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><line x1=\"12\" y1=\"8\" x2=\"12\" y2=\"12\"/><line x1=\"12\" y1=\"16\" x2=\"12.01\" y2=\"16\"/></svg>','Check Your Inner Deadzone','In close-range fights you finish with melee '+Math.round(_meleeHeavy.length/_aimGames.length*100)+'% of the time, but your accuracy in those games is only '+_meleeAcc.toFixed(1)+'%. A large inner deadzone can cause sluggish micro-adjustments at close range — try reducing it by 5-10% in Halo\'s controller settings.','var(--gold)'));
      }
    }

    // Trigger discipline — calibrated for Bandit Evo (5-shot perfect, 7-8 realistic)


    // ── TEAM & ASSIST INSIGHTS ──────────────────────────────────────────────

    var _assistGames=allMatches.filter(function(m){return(m.outcome===2||m.outcome===3)&&m.kills>0&&m.assists!=null&&_durSecs(m)>=60;});
    if(_assistGames.length>=8){
      var _avgAssistRatio=_assistGames.reduce(function(s,m){return s+m.assists/(m.kills+m.assists);},0)/_assistGames.length*100;
      if(_avgAssistRatio>40){
        insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><path d=\"M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M23 21v-2a4 4 0 0 0-3-3.87\"/><path d=\"M16 3.13a4 4 0 0 1 0 7.75\"/></svg>','Strong Team Player',''+Math.round(_avgAssistRatio)+'% of your kill participations are assists — you set teammates up well. Make sure you\'re following up on your own damage to convert more of those into kills.','var(--accent)'));
      } else if(_avgAssistRatio<5){
        insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><path d=\"M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M23 21v-2a4 4 0 0 0-3-3.87\"/><path d=\"M16 3.13a4 4 0 0 1 0 7.75\"/></svg>','Going Solo','Only '+Math.round(_avgAssistRatio)+'% of your kill participations are assists — extremely low even for Bandit Evo fast TTK. Try communicating callouts and softening targets before committing — sharing damage leads to cleaner trades and fewer deaths.','var(--gold)'));
      }
    }

    // ── PERFORMANCE VS EXPECTATION ──────────────────────────────────────────

    var _expGames=allMatches.filter(function(m){return m.expectedKills!=null&&m.expectedDeaths!=null&&m.kills!=null&&(m.outcome===2||m.outcome===3)&&_durSecs(m)>=60;});
    if(_expGames.length>=5){
      var _killDelta=_expGames.reduce(function(s,m){return s+(m.kills-m.expectedKills);},0)/_expGames.length;
      var _deathDelta=_expGames.reduce(function(s,m){return s+(m.deaths-m.expectedDeaths);},0)/_expGames.length;
      if(_killDelta>1.5&&_deathDelta<0.5){
        insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><line x1=\"18\" y1=\"20\" x2=\"18\" y2=\"10\"/><line x1=\"12\" y1=\"20\" x2=\"12\" y2=\"4\"/><line x1=\"6\" y1=\"20\" x2=\"6\" y2=\"14\"/></svg>','Outperforming Your MMR','You average +'+_killDelta.toFixed(1)+' kills above expectation per game — you\'re playing above your current rank. Keep the consistency and CSR should follow.','var(--win)'));
      } else if(_killDelta<-1.5){
        insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><line x1=\"18\" y1=\"20\" x2=\"18\" y2=\"10\"/><line x1=\"12\" y1=\"20\" x2=\"12\" y2=\"4\"/><line x1=\"6\" y1=\"20\" x2=\"6\" y2=\"14\"/></svg>','Below Kill Expectation','Averaging '+_killDelta.toFixed(1)+' kills vs expectation. The matchmaker expects more from you at this MMR — focus on taking safer, higher-percentage fights rather than challenging every duel.','var(--loss)'));
      }
      if(_deathDelta>2){
        insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><line x1=\"18\" y1=\"20\" x2=\"18\" y2=\"10\"/><line x1=\"12\" y1=\"20\" x2=\"12\" y2=\"4\"/><line x1=\"6\" y1=\"20\" x2=\"6\" y2=\"14\"/></svg>','Dying Too Much for Your MMR',''+_deathDelta.toFixed(1)+' deaths above expectation per game. Your opponents are punishing overextensions that players at your MMR typically avoid. Play slower — let them come to you.','var(--loss)'));
      }
    }

    // ── STAMINA / LATE-GAME FADE ────────────────────────────────────────────

    var _longGames=allMatches.filter(function(m){return _durSecs(m)>=480&&(m.outcome===2||m.outcome===3)&&m.kills!=null;});
    var _shortGames=allMatches.filter(function(m){return _durSecs(m)>=60&&_durSecs(m)<300&&(m.outcome===2||m.outcome===3)&&m.kills!=null;});
    if(_longGames.length>=4&&_shortGames.length>=4){
      function _kpm(arr){return arr.reduce(function(s,m){return s+m.kills/_durSecs(m)*60;},0)/arr.length;}
      var _lkpm=_kpm(_longGames);var _skpm=_kpm(_shortGames);
      if(_skpm>0&&(_lkpm/_skpm)<0.65){
        insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><path d=\"M18 8h1a4 4 0 0 1 0 8h-1\"/><path d=\"M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z\"/><line x1=\"6\" y1=\"1\" x2=\"6\" y2=\"4\"/><line x1=\"10\" y1=\"1\" x2=\"10\" y2=\"4\"/><line x1=\"14\" y1=\"1\" x2=\"14\" y2=\"4\"/></svg>','Late-Game Fade','Your kill rate drops to '+(_lkpm/_skpm*100).toFixed(0)+'% of your early pace in longer games. You may be fatiguing — take more cover in late rounds, rely on utility, and avoid unnecessary fights when the clock is running down.','var(--gold)'));
      } else if(_skpm>0&&(_lkpm/_skpm)>1.2){
        insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><path d=\"M18 8h1a4 4 0 0 1 0 8h-1\"/><path d=\"M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z\"/><line x1=\"6\" y1=\"1\" x2=\"6\" y2=\"4\"/><line x1=\"10\" y1=\"1\" x2=\"10\" y2=\"4\"/><line x1=\"14\" y1=\"1\" x2=\"14\" y2=\"4\"/></svg>','Warms Up Slowly','You perform '+Math.round((_lkpm/_skpm-1)*100)+'% better in longer games than short ones — you\'re a slow starter. Play extra conservatively in the first minute while you get your bearings.','var(--accent)'));
      }
    }

    // ── CLOSE RANGE vs LONG RANGE ───────────────────────────────────────────

    var _rangeGames=allMatches.filter(function(m){return m.kills>0&&m.shotsFired>0&&(m.outcome===2||m.outcome===3)&&_durSecs(m)>=180;});
    if(_rangeGames.length>=8){
      // SPK and melee % are the reliable range proxies — DPK is not usable here
      var _avgSpk=_rangeGames.reduce(function(s,m){return s+m.shotsFired/m.kills;},0)/_rangeGames.length;
      var _meleePct2=_rangeGames.reduce(function(s,m){return s+(m.weaponStats?m.weaponStats.melee/m.kills:0);},0)/_rangeGames.length*100;
      if(_meleePct2>20&&_avgSpk<=9){
        // High melee + clean SPK = finishing fights at close range consistently
        insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><circle cx=\"11\" cy=\"11\" r=\"8\"/><line x1=\"21\" y1=\"21\" x2=\"16.65\" y2=\"16.65\"/><line x1=\"8\" y1=\"11\" x2=\"14\" y2=\"11\"/></svg>','Close-Quarters Fighter',''+Math.round(_meleePct2)+'% of kills include melee — you are consistently closing to BXB range. Use this — look for flanks and angles that let you get close rather than contesting open sightlines.','var(--accent)'));
      } else if(_avgSpk>10&&_meleePct2<8){
        // High SPK + low melee = fighting at distance, taking more shots to kill
        insights.push(insightCard('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\"><circle cx=\"11\" cy=\"11\" r=\"8\"/><line x1=\"21\" y1=\"21\" x2=\"16.65\" y2=\"16.65\"/><line x1=\"8\" y1=\"11\" x2=\"14\" y2=\"11\"/></svg>','Distance Fighter','Low melee rate and higher SPK suggests you prefer contesting sightlines over closing in. Make sure you are using grenades to flush opponents from cover rather than standing in the open trading shots.','var(--accent)'));
      }
    }


    if(!insights.length) return;
    html+=sectionHead('Performance Insights', insights.length+' active');
    html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:24px">';
    insights.forEach(function(card){html+=card;});
    html=html.replace(/border-bottom:1px solid var\(--border\)(?=[^}]*<\/div><\/div><\/div><\/div>)/,'border-bottom:none');
    html+='</div>';
  })();

  // Damage Trends
  (function(){
    var _isMobile=window.innerWidth<768;
    var dmgSample=displayMatches.filter(function(m){
      var s=m.duration?String(m.duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/):null;
      var secs=s?(parseInt(s[1]||0)*3600)+(parseInt(s[2]||0)*60)+parseFloat(s[3]||0):0;
      return secs>=180&&m.damageDealt>300&&m.damageTaken>300&&(m.outcome===2||m.outcome===3);
    }).slice(0,_isMobile?20:40).reverse();
    if(dmgSample.length<3)return;

    var dealtVals=dmgSample.map(function(m){return m.damageDealt||0;});
    var takenVals=dmgSample.map(function(m){return m.damageTaken||0;});
    var avgDealt=Math.round(dealtVals.reduce(function(a,b){return a+b;},0)/dealtVals.length);
    var avgTaken=Math.round(takenVals.reduce(function(a,b){return a+b;},0)/takenVals.length);
    var maxVal=Math.max.apply(null,dealtVals.concat(takenVals))||1;
    var lastDealt=dealtVals[dealtVals.length-1];
    var lastTaken=takenVals[takenVals.length-1];
    function roll5(arr){return arr.map(function(_,i){var sl=arr.slice(Math.max(0,i-4),i+1);return Math.round(sl.reduce(function(a,b){return a+b;},0)/sl.length);});}
    var roll5Dealt=roll5(dealtVals);
    var roll5Taken=roll5(takenVals);
    var trendDealt=roll5Dealt[roll5Dealt.length-1]-roll5Dealt[Math.max(0,roll5Dealt.length-6)];
    var trendTaken=roll5Taken[roll5Taken.length-1]-roll5Taken[Math.max(0,roll5Taken.length-6)];
    var dmgRatioAvg=(avgTaken>0?avgDealt/avgTaken:0).toFixed(2);
    var dmgRatioColor=parseFloat(dmgRatioAvg)>=1?'var(--win)':'var(--loss)';

    function dmgMini(label,val,color,sub){
      return '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px 12px">'
        +'<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px">'+label+'</div>'
        +'<div style="font-size:18px;font-weight:700;font-family:Rajdhani,sans-serif;color:'+color+'">'+val+'</div>'
        +(sub?'<div style="font-size:9px;font-family:Share Tech Mono,monospace;margin-top:2px">'+sub+'</div>':'')
        +'</div>';
    }

    html+=sectionHead('Damage Trends','last '+dmgSample.length+' games');
    html+='<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 20px;margin-bottom:24px">';

    // Stat cards — 2-col on mobile, 4-col on desktop
    var tDColor=trendDealt>=0?'var(--win)':'var(--loss)';
    var tTColor=trendTaken<=0?'var(--win)':'var(--loss)';
    var tDLabel=(trendDealt>=0?'↑ +':'↓ ')+Math.abs(Math.round(trendDealt))+' trend';
    var tTLabel=(trendTaken<=0?'↓ -':'↑ +')+Math.abs(Math.round(trendTaken))+' trend';
    html+='<div style="display:grid;grid-template-columns:repeat('+(  _isMobile?'2':'4')+',1fr);gap:8px;margin-bottom:20px">';
    html+=dmgMini('Avg Dealt',avgDealt.toLocaleString(),'var(--win)','<span style="color:'+tDColor+'">'+tDLabel+'</span>');
    html+=dmgMini('Avg Taken',avgTaken.toLocaleString(),'var(--loss)','<span style="color:'+tTColor+'">'+tTLabel+'</span>');
    html+=dmgMini('Dmg Ratio',dmgRatioAvg,dmgRatioColor,'<span style="color:var(--muted2)">dealt / taken</span>');
    html+=dmgMini('Last Game',lastDealt.toLocaleString(),'var(--text)','<span style="color:var(--muted2)">vs '+lastTaken.toLocaleString()+' taken</span>');
    html+='</div>';

    // Legend
    html+='<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px">'
      +'Per-Game &nbsp;<span style="color:var(--win)">■ Dealt</span> &nbsp;<span style="color:var(--loss)">■ Taken</span>'
      +'</div>';

    // Stacked bar chart — dealt on top, taken below, both grow from center
    var barH=_isMobile?48:80;
    html+='<div style="display:flex;align-items:flex-end;gap:2px;height:'+(barH*2+4)+'px;margin-bottom:16px">';
    dmgSample.forEach(function(m){
      var d=m.damageDealt||0,t=m.damageTaken||0;
      var dh=Math.round((d/maxVal)*barH);
      var th=Math.round((t/maxVal)*barH);
      html+='<div style="display:flex;flex-direction:column;flex:1;min-width:0;gap:2px" title="'+(m.mapName||'')+'&#10;Dealt: '+Math.round(d).toLocaleString()+'&#10;Taken: '+Math.round(t).toLocaleString()+'">'
        +'<div style="display:flex;flex-direction:column;justify-content:flex-end;height:'+barH+'px">'
        +'<div style="width:100%;height:'+dh+'px;background:var(--win);border-radius:2px 2px 0 0;opacity:0.85"></div>'
        +'</div>'
        +'<div style="height:'+barH+'px">'
        +'<div style="width:100%;height:'+th+'px;background:var(--loss);border-radius:0 0 2px 2px;opacity:0.75"></div>'
        +'</div>'
        +'</div>';
    });
    html+='</div>';

    // Rolling 5-game avg — dealt as a taller bar chart showing trend
    var r5max=Math.max.apply(null,roll5Dealt)||1;
    var r5min=Math.min.apply(null,roll5Dealt)||0;
    var r5range=r5max-r5min||1;
    html+='<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px">5-Game Rolling Avg (Dealt)</div>';
    html+='<div style="position:relative">';
    // Y-axis labels
    html+='<div style="position:absolute;left:0;top:0;bottom:0;display:flex;flex-direction:column;justify-content:space-between;pointer-events:none">';
    html+='<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace">'+Math.round(r5max/1000*10)/10+'k</div>';
    html+='<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace">'+Math.round(r5min/1000*10)/10+'k</div>';
    html+='</div>';
    html+='<div style="display:flex;align-items:flex-end;gap:2px;height:80px;padding-left:28px">';
    roll5Dealt.forEach(function(v,i){
      var hPct=Math.round(((v-r5min)/r5range)*70)+10; // 10–80px range
      var isHigh=v===r5max, isLow=v===r5min;
      var barColor=isHigh?'var(--win)':isLow?'var(--loss)':'var(--accent)';
      html+='<div style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;height:80px">';
      html+='<div style="height:'+hPct+'px;background:'+barColor+';border-radius:2px 2px 0 0;opacity:0.75;transition:height 0.3s ease" title="'+v.toLocaleString()+'"></div>';
      html+='</div>';
    });
    html+='</div>';
    html+='</div>';

    html+='</div>';
  })();

  // CSR History
  html+=sectionHead('CSR History');
  html+=renderCsrFromMatches(allMatches,'Ranked Arena',_cc[0]);
  html+=renderCsrFromMatches(allMatches,'Ranked Slayer',_cc[1]);
  html+=renderCsrEfficiency(allMatches);
  html+='</div>'; // end performance tab

  // OBJECTIVES TAB
  html+='<div class="tab-panel'+(activeTab==='objectives'?' active':'')+'" data-tab="objectives">';
  html+=renderObjectiveStats(matches);
  html+=renderDuoSynergy(data.duoSynergy,p.gamertag);
  html+='</div>'; // end objectives tab

  // OPPONENTS TAB
  html+='<div class="tab-panel'+(activeTab==='opponents'?' active':'')+'" data-tab="opponents">';
  html+=sectionHead('Rival History');
  if(nemeses.length||victims.length){html+='<div class="rivals-grid"><div><div class="rivals-col-label nemesis"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" style=\"vertical-align:-1px\"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> Nemeses</div>';nemeses.forEach(function(r){var _rFav=isFavorite(r.gamertag);html+='<div class="rival-row" onclick="quickSearch(\''+r.gamertag.replace(/\'/g,"\\\'")+'\')" style="cursor:pointer">'+rivalAvatar(r)+'<div class="rival-name">'+r.gamertag+'</div><div class="rival-record"><span class="rival-w">W'+(r.wins||0)+'</span><span class="rival-l">L'+(r.losses||0)+'</span><span class="rival-total">'+r.total+'g</span><span onclick="event.stopPropagation();toggleFav(this.dataset.gt)" data-gt="'+r.gamertag.replace(/"/g,'&quot;')+'" style="margin-left:6px;cursor:pointer;color:#ffc107;opacity:'+(_rFav?'1':'0.35')+'" title="'+(_rFav?'Remove favorite':'Add favorite')+'">'+(_rFav?'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"11\" height=\"11\" viewBox=\"0 0 24 24\" fill=\"currentColor\" stroke=\"currentColor\" stroke-width=\"1.5\" style=\"vertical-align:-1px\"><polygon points=\"12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2\"/></svg>':'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"11\" height=\"11\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" style=\"vertical-align:-1px\"><polygon points=\"12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2\"/></svg>')+'</span></div></div>';});html+='</div><div><div class="rivals-col-label victim"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" style=\"vertical-align:-1px\"><circle cx="12" cy="11" r="5"/><path d="M9 17v2M15 17v2M7 11a5 5 0 0 1 10 0v2H7v-2z"/></svg> Victims</div>';victims.forEach(function(r){var _rFav=isFavorite(r.gamertag);html+='<div class="rival-row" onclick="quickSearch(\''+r.gamertag.replace(/\'/g,"\\\'")+'\')" style="cursor:pointer">'+rivalAvatar(r)+'<div class="rival-name">'+r.gamertag+'</div><div class="rival-record"><span class="rival-w">W'+(r.wins||0)+'</span><span class="rival-l">L'+(r.losses||0)+'</span><span class="rival-total">'+r.total+'g</span><span onclick="event.stopPropagation();toggleFav(this.dataset.gt)" data-gt="'+r.gamertag.replace(/"/g,'&quot;')+'" style="margin-left:6px;cursor:pointer;color:#ffc107;opacity:'+(_rFav?'1':'0.35')+'" title="'+(_rFav?'Remove favorite':'Add favorite')+'">'+(_rFav?'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"11\" height=\"11\" viewBox=\"0 0 24 24\" fill=\"currentColor\" stroke=\"currentColor\" stroke-width=\"1.5\" style=\"vertical-align:-1px\"><polygon points=\"12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2\"/></svg>':'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"11\" height=\"11\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" style=\"vertical-align:-1px\"><polygon points=\"12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2\"/></svg>')+'</span></div></div>';});html+='</div></div>';}
  else{html+='<div class="empty-state"><div class="empty-state-icon"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"28\" height=\"28\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" style=\"vertical-align:-4px\"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div><div class="empty-state-msg">No opponent history yet</div><div class="empty-state-sub">Builds with each Refresh</div></div>';}
  html+='</div>'; // end opponents tab


  document.getElementById('app').innerHTML=html;
  setTimeout(initCsrCharts,0);
  scheduleEmblemRetry();
}
loadStats();

window.addEventListener('popstate', function(e){
  var params=new URLSearchParams(window.location.search);
  var gt=params.get('player');
  if(gt){ doSearch(gt); }
  else { goHome(); }
});
// Auto-search if URL has ?search= param
// URL handling done in loadStats()

document.addEventListener('keydown', function(e){
  if (e.key === 'Escape') {
    var modal = document.getElementById('feedbackModal');
    if (modal && modal.style.display !== 'none') closeFeedbackModal();
  }
});
