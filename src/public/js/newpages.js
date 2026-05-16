// ── New page rendering functions ──────────────────────────────────────────────
// Sessions, Activity, Weapons, Synergy, Compare tabs

// ── SESSIONS ─────────────────────────────────────────────────────────────────
function renderSessionsPage(p, allMatches) {
  if (!allMatches || !allMatches.length) {
    return '<div class="empty-state"><div class="empty-state-icon">◷</div><div class="empty-state-msg">No session data</div><div class="empty-state-sub">Load more match history to see sessions</div></div>';
  }

  // Group matches by local date
  var dayMap = {};
  allMatches.forEach(function(m) {
    if (!m.startTime) return;
    var d = new Date(m.startTime);
    var key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    if (!dayMap[key]) dayMap[key] = [];
    dayMap[key].push(m);
  });

  var days = Object.keys(dayMap).sort().reverse();
  if (!days.length) return '<div class="empty-state"><div class="empty-state-msg">No dated matches found</div></div>';

  // Summary stats
  var totalDays = days.length;
  var totalGames = allMatches.length;
  var avgPerDay = totalDays ? (totalGames / totalDays).toFixed(1) : 0;
  var allWins = allMatches.filter(function(m){return m.outcome===2;}).length;
  var overallWR = totalGames ? Math.round(allWins/totalGames*100) : 0;

  // Streak calculation
  var sortedKeys = days.slice().reverse();
  var bestStreak = 1, curStreak = 1;
  for (var i = 1; i < sortedKeys.length; i++) {
    var prev = new Date(sortedKeys[i-1]+'T12:00:00'), cur = new Date(sortedKeys[i]+'T12:00:00');
    if ((cur - prev) === 86400000) { curStreak++; if (curStreak > bestStreak) bestStreak = curStreak; }
    else curStreak = 1;
  }

  var html = '';

  // Summary row
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px;margin-bottom:24px">';
  html += statCard('Active Days', totalDays, 'accent', avgPerDay + ' games / day');
  html += statCard('Total Games', totalGames.toLocaleString(), '', '');
  html += statCard('Win Rate', overallWR + '%', overallWR>=50?'win':'loss', allWins + 'W · ' + (totalGames-allWins) + 'L');
  if (bestStreak > 1) html += statCard('Best Streak', bestStreak + ' days', 'gold', 'consecutive active days');
  html += '</div>';

  html += sectionHead('Session History', days.length + ' active days');

  days.forEach(function(day) {
    var matches = dayMap[day];
    var wins   = matches.filter(function(m){return m.outcome===2;}).length;
    var losses = matches.filter(function(m){return m.outcome===3;}).length;
    var draws  = matches.length - wins - losses;
    var kills  = matches.reduce(function(s,m){return s+(m.kills||0);},0);
    var deaths = matches.reduce(function(s,m){return s+(m.deaths||0);},0);
    var kd     = deaths > 0 ? (kills/deaths).toFixed(2) : kills > 0 ? kills+'.00' : '—';
    var kdVal  = deaths > 0 ? kills/deaths : kills;
    var kdColor = kdVal >= 1.2 ? 'var(--win)' : kdVal >= 0.8 ? 'var(--gold)' : 'var(--loss)';

    // CSR net per playlist
    var csrByPlaylist = {};
    matches.forEach(function(m) {
      if (!m.csrDelta || !m.gameMode) return;
      var pl = m.gameMode;
      csrByPlaylist[pl] = (csrByPlaylist[pl]||0) + (m.csrDelta||0);
    });
    var csrPills = '';
    Object.entries(csrByPlaylist).forEach(function(e) {
      if (!e[1]) return;
      var label = e[0].replace('Ranked ','');
      var pos = e[1] > 0;
      csrPills += '<span style="font-size:10px;padding:2px 8px;border-radius:4px;background:'+(pos?'rgba(76,175,80,0.13)':'rgba(244,67,54,0.13)')+';color:'+(pos?'var(--win)':'var(--loss)')+'">'+label+' '+(pos?'+':'')+e[1]+'</span>';
    });

    // Accuracy avg
    var accMs = matches.filter(function(m){return m.accuracy!=null && parseFloat(m.accuracy)>0;});
    var accStr = accMs.length ? (accMs.reduce(function(s,m){return s+parseFloat(m.accuracy);},0)/accMs.length).toFixed(1)+'%' : '';

    // Best game KDA
    var bestKda = matches.reduce(function(best, m) {
      var kda = m.deaths > 0 ? (m.kills + (m.assists||0)*0.33) / m.deaths : m.kills + (m.assists||0)*0.33;
      return kda > best ? kda : best;
    }, 0);

    var date = new Date(day + 'T12:00:00');
    var label = date.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
    var isToday = day === (function(){ var n=new Date(); return n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0')+'-'+String(n.getDate()).padStart(2,'0'); })();

    var expandId = 'sg-exp-' + day;
    var isFirst = day === days[0];

    html += '<div style="background:var(--surface);border:1px solid '+(isToday?'var(--accent)':'var(--border)')+';border-radius:8px;margin-bottom:8px;overflow:hidden">';

    // ── Clickable header ────────────────────────────────────────────────
    html += '<div onclick="_sgToggle(\''+expandId+'\')" style="padding:13px 16px;cursor:pointer;user-select:none">';

    // Row 1: date · game count · K/D · W/L
    html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap">';
    html += '<span id="'+expandId+'-chevron" style="font-size:11px;color:var(--muted2);margin-right:2px">'+(isFirst?'▾':'▸')+'</span>';
    html += '<div style="font-family:Share Tech Mono,monospace;font-size:11px;color:'+(isToday?'var(--accent)':'var(--text)')+';font-weight:'+(isToday?'700':'400')+';min-width:96px">'+label+'</div>';
    html += '<div style="font-size:11px;color:var(--muted);font-family:Share Tech Mono,monospace">'+matches.length+'g</div>';
    html += '<div style="font-family:Rajdhani,sans-serif;font-size:16px;font-weight:700;color:'+kdColor+'">'+kd+' <span style="font-size:10px;color:var(--muted2)">K/D</span></div>';
    html += '<div style="font-family:Share Tech Mono,monospace;font-size:12px"><span style="color:var(--win)">'+wins+'W</span><span style="color:var(--muted2);margin:0 2px">/</span><span style="color:var(--loss)">'+losses+'L</span>'+(draws?'<span style="color:var(--muted2);margin-left:2px">'+draws+'D</span>':'')+'</div>';
    if (accStr) html += '<div style="font-size:10px;color:var(--muted);font-family:Share Tech Mono,monospace">'+accStr+' acc</div>';
    if (bestKda > 0) html += '<div style="font-size:10px;color:var(--muted);font-family:Share Tech Mono,monospace;margin-left:auto">best <span style="color:var(--text)">'+bestKda.toFixed(1)+' KDA</span></div>';
    html += '</div>';

    // Row 2: outcome dots
    html += '<div style="display:flex;gap:3px;flex-wrap:wrap;align-items:center;margin-bottom:'+(csrPills?'8':'0')+'px">';
    matches.forEach(function(m) {
      var c = m.outcome===2?'var(--win)':m.outcome===3?'var(--loss)':'var(--muted2)';
      var mapLabel = (m.mapName||'')+(m.kills!=null?' · '+m.kills+'/'+m.deaths:'');
      html += '<div title="'+mapLabel+'" style="width:9px;height:9px;border-radius:50%;background:'+c+';flex-shrink:0"></div>';
    });
    html += '</div>';

    // Row 3: CSR pills
    if (csrPills) html += '<div style="display:flex;gap:6px;flex-wrap:wrap">'+csrPills+'</div>';

    html += '</div>'; // end clickable header

    // ── Expanded match list ──────────────────────────────────────────────
    html += '<div id="'+expandId+'" style="display:'+(isFirst?'block':'none')+';border-top:1px solid var(--border)">';
    // Scrollable wrapper for wide table on mobile
    html += '<div style="overflow-x:auto">';

    // Column headers
    var cols = '18px minmax(120px,1fr) 70px 40px 40px 40px 46px 56px 70px';
    var minTableW = '580px';
    html += '<div style="display:grid;grid-template-columns:'+cols+';min-width:'+minTableW+';padding:5px 16px;background:var(--surface3);font-family:Share Tech Mono,monospace;font-size:8px;color:var(--muted2);letter-spacing:1px;gap:4px">';
    html += '<span></span><span>MAP · MODE</span><span style="text-align:center">RESULT</span>';
    html += '<span style="text-align:center">K</span><span style="text-align:center">D</span><span style="text-align:center">A</span>';
    html += '<span style="text-align:center">ACC</span><span style="text-align:center">DMG</span><span style="text-align:center">KDA / CSR</span>';
    html += '</div>';

    matches.forEach(function(gm, gi) {
      var isLast = gi === matches.length - 1;
      var outColor = gm.outcome===2?'var(--win)':gm.outcome===3?'var(--loss)':'var(--muted2)';
      var outLabel = gm.outcome===2?'WIN':gm.outcome===3?'LOSS':'DRAW';
      var gmAcc = gm.accuracy!=null ? parseFloat(gm.accuracy).toFixed(0)+'%' : '—';
      var gmDmg = gm.damageDealt ? Math.round(gm.damageDealt/100)/10+'k' : '—';
      var gmKda = gm.kda || '—';
      var kdaNum = parseFloat(gmKda);
      var kdaColor = !isNaN(kdaNum) ? (kdaNum >= 1 ? 'var(--win)' : 'var(--loss)') : 'var(--muted)';
      var csrStr = gm.csrDelta != null ? (gm.csrDelta>0?'+':'')+gm.csrDelta : '';
      var csrColor = gm.csrDelta > 0 ? 'var(--win)' : gm.csrDelta < 0 ? 'var(--loss)' : 'var(--muted2)';
      var modeShort = (gm.gameMode||'').replace('Ranked ','').replace('Arena: ','');

      var rowBg = gi%2===0 ? 'var(--surface2)' : 'var(--surface)';
      var rowRadius = isLast ? 'border-radius:0 0 8px 8px' : '';
      html += '<div style="display:grid;grid-template-columns:'+cols+';min-width:'+minTableW+';padding:8px 16px;background:'+rowBg+';font-family:Share Tech Mono,monospace;font-size:10px;align-items:center;gap:4px;'+rowRadius+'">';

      html += '<div style="width:7px;height:7px;border-radius:50%;background:'+outColor+';flex-shrink:0"></div>';
      html += '<div style="min-width:0">';
      html += '<div style="color:var(--text);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+(gm.mapName||'—')+'</div>';
      html += '<div style="color:var(--muted2);font-size:8px;margin-top:1px">'+modeShort+'</div>';
      html += '</div>';
      html += '<div style="text-align:center;color:'+outColor+';font-size:9px;font-weight:700;letter-spacing:1px">'+outLabel+'</div>';
      html += '<div style="text-align:center;color:var(--text)">'+(gm.kills||0)+'</div>';
      html += '<div style="text-align:center;color:var(--muted)">'+(gm.deaths||0)+'</div>';
      html += '<div style="text-align:center;color:var(--muted)">'+(gm.assists||0)+'</div>';
      html += '<div style="text-align:center;color:var(--muted)">'+gmAcc+'</div>';
      html += '<div style="text-align:center;color:var(--muted)">'+gmDmg+'</div>';
      html += '<div style="text-align:center">';
      html += '<span style="color:'+kdaColor+';font-weight:700">'+gmKda+'</span>';
      if (csrStr) html += ' <span style="color:'+csrColor+';font-size:8px">'+csrStr+'</span>';
      html += '</div>';

      html += '</div>';
    });

    html += '</div>'; // end scroll wrapper
    html += '</div>'; // end expanded
    html += '</div>'; // end session card
  });

  return html;
}

// ── ACTIVITY ─────────────────────────────────────────────────────────────────
function renderActivityPage(p, allMatches) {
  if (!allMatches || !allMatches.length) {
    return '<div class="empty-state"><div class="empty-state-icon">◎</div><div class="empty-state-msg">No activity data</div><div class="empty-state-sub">Load more match history to see activity</div></div>';
  }

  var hourCounts = new Array(24).fill(0);
  var dayCounts  = new Array(7).fill(0);
  var modeCounts = {}, mapCounts = {}, mapWins = {};

  allMatches.forEach(function(m) {
    if (m.startTime) {
      var d = new Date(m.startTime);
      hourCounts[d.getHours()]++;
      dayCounts[d.getDay()]++;
    }
    var mode = (m.gameMode||'Unknown').replace('Ranked ','');
    modeCounts[mode] = (modeCounts[mode]||0) + 1;
    if (m.mapName) {
      mapCounts[m.mapName]  = (mapCounts[m.mapName]||0) + 1;
      if (m.outcome===2) mapWins[m.mapName] = (mapWins[m.mapName]||0) + 1;
    }
  });

  // Top summaries
  var totalGames = allMatches.length;
  var dayNames   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var peakHour   = hourCounts.indexOf(Math.max.apply(null,hourCounts));
  var peakDay    = dayCounts.indexOf(Math.max.apply(null,dayCounts));
  var topMode    = Object.entries(modeCounts).sort(function(a,b){return b[1]-a[1];})[0];
  var topMap     = Object.entries(mapCounts).sort(function(a,b){return b[1]-a[1];})[0];

  var hourLabel  = peakHour === 0 ? '12 AM' : peakHour < 12 ? peakHour+' AM' : peakHour===12 ? '12 PM' : (peakHour-12)+' PM';

  var html = '';

  // Summary cards
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px;margin-bottom:24px">';
  html += statCard('Peak Hour', hourLabel, 'accent', 'most games played');
  html += statCard('Peak Day', dayNames[peakDay], 'accent', dayCounts[peakDay]+' games');
  if (topMode) html += statCard('Top Playlist', topMode[0], '', Math.round(topMode[1]/totalGames*100)+'% of games');
  if (topMap)  html += statCard('Top Map', topMap[0], '', topMap[1]+' games played');
  html += '</div>';

  // ── Hour of day + Day of week + Playlists — three columns ───────────────
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin-bottom:20px">';

  // Hour of day
  var maxHour = Math.max.apply(null, hourCounts) || 1;
  var chartH = 72, chartPad = 4;
  var barW = 14, barGap = 3, totalW = 24 * (barW + barGap) - barGap;
  var svgViewW = totalW + chartPad*2, svgViewH = chartH + 20;
  html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 18px 12px;overflow-x:auto">';
  html += sectionHead('Hour of Day', 'when you queue up');
  var svgHour = '<svg xmlns="http://www.w3.org/2000/svg" width="' + svgViewW + '" height="' + svgViewH + '" viewBox="0 0 ' + svgViewW + ' ' + svgViewH + '" style="display:block;min-width:' + svgViewW + 'px">';
  hourCounts.forEach(function(c, h) {
    var barH = c ? Math.max(4, Math.round(c / maxHour * chartH)) : 0;
    var x = chartPad + h * (barW + barGap);
    var y = chartH - barH;
    var isPeak = h === peakHour;
    var label = h===0?'12 AM':h<12?h+' AM':h===12?'12 PM':(h-12)+' PM';
    var opacity = isPeak ? 1 : (0.25 + (c / maxHour) * 0.65);
    var fill = isPeak ? 'var(--accent)' : 'rgba(var(--accent-r,56),var(--accent-g,138),var(--accent-b,221),' + opacity.toFixed(2) + ')';
    if (barH > 0) {
      svgHour += '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + barH + '" rx="2" fill="' + fill + '"><title>' + label + ' · ' + c + ' game' + (c!==1?'s':'') + '</title></rect>';
    } else {
      svgHour += '<rect x="' + x + '" y="' + (chartH-2) + '" width="' + barW + '" height="2" rx="1" fill="rgba(255,255,255,0.05)"></rect>';
    }
    if (h % 3 === 0) {
      var lbl = h===0?'12a':h<12?h+'a':h===12?'12p':(h-12)+'p';
      svgHour += '<text x="' + (x + barW/2) + '" y="' + (chartH + 14) + '" text-anchor="middle" font-family="Share Tech Mono,monospace" font-size="8" fill="rgba(133,183,235,0.45)">' + lbl + '</text>';
    }
  });
  svgHour += '</svg>';
  html += svgHour;
  html += '</div>';

  // Day of week
  var maxDay = Math.max.apply(null,dayCounts) || 1;
  html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 18px">';
  html += sectionHead('Day of Week','');
  dayCounts.forEach(function(c,d) {
    var pct = c/maxDay*100;
    var isP = d===peakDay;
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">';
    html += '<div style="font-family:Share Tech Mono,monospace;font-size:9px;color:'+(isP?'var(--accent)':'var(--muted2)')+';width:26px">'+dayNames[d]+'</div>';
    html += '<div style="flex:1;height:7px;background:var(--surface3);border-radius:4px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+(isP?'var(--accent)':'rgba(var(--accent-r,56),var(--accent-g,138),var(--accent-b,221),0.5)')+';border-radius:4px"></div></div>';
    html += '<div style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--muted2);width:20px;text-align:right">'+c+'</div>';
    html += '</div>';
  });
  html += '</div>';

  // Playlists
  var modeEntries = Object.entries(modeCounts).sort(function(a,b){return b[1]-a[1];}).slice(0,8);
  var maxMode = modeEntries.length ? modeEntries[0][1] : 1;
  html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 18px">';
  html += sectionHead('Playlists','');
  modeEntries.forEach(function(e) {
    var pct = e[1]/maxMode*100;
    var sharePct = Math.round(e[1]/totalGames*100);
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">';
    html += '<div style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--muted2);width:72px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="'+e[0]+'">'+e[0]+'</div>';
    html += '<div style="flex:1;height:7px;background:var(--surface3);border-radius:4px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:rgba(var(--accent-r,56),var(--accent-g,138),var(--accent-b,221),0.55);border-radius:4px"></div></div>';
    html += '<div style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--muted2);width:26px;text-align:right">'+sharePct+'%</div>';
    html += '</div>';
  });
  html += '</div>';
  html += '</div>'; // end 3-col grid

  // ── Activity Heatmap — columns = days, rows = 6-hour time blocks ──────────
  (function() {
    // Build block map: "dateKey:block" → count  (block 0=12a-6a, 1=6a-12p, 2=12p-6p, 3=6p-12a)
    var blockMap = {}, daySet = {};
    allMatches.forEach(function(m) {
      if (!m.startTime) return;
      var d = new Date(m.startTime);
      var block = Math.floor(d.getHours() / 6);
      var dk = d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate();
      blockMap[dk+':'+block] = (blockMap[dk+':'+block]||0)+1;
      daySet[dk] = true;
    });
    var activeDays = Object.keys(daySet).length;
    if (!activeDays) return;

    var totalGames2 = allMatches.length;
    var now = new Date(); now.setHours(23,59,59,0);

    // Show last 7 days
    var spanMs = 7 * 86400000;
    var rangeStart = new Date(now.getTime() - spanMs);
    rangeStart.setHours(0,0,0,0);

    // Build day list oldest→newest
    var days = [], cur = new Date(rangeStart);
    while (cur <= now) { days.push(new Date(cur)); cur.setDate(cur.getDate()+1); }

    // Stats
    var allDayCounts = Object.keys(daySet).map(function(dk){
      return [0,1,2,3].reduce(function(s,b){ return s+(blockMap[dk+':'+b]||0); },0);
    });
    var bestDayCount = allDayCounts.length ? Math.max.apply(null, allDayCounts) : 0;
    var sortedTs = Object.keys(daySet).map(function(k){var p=k.split('-');return new Date(+p[0],+p[1]-1,+p[2]).getTime();}).sort(function(a,b){return a-b;});
    var bestSt=1,curSt=1;
    for(var si=1;si<sortedTs.length;si++){if(sortedTs[si]-sortedTs[si-1]===86400000){curSt++;if(curSt>bestSt)bestSt=curSt;}else curSt=1;}

    var maxCount = Math.max.apply(null, Object.values(blockMap).concat([1]));
    function heatColor(n) {
      if (!n) return 'rgba(255,255,255,0.04)';
      var intensity = Math.min(n / Math.max(maxCount * 0.75, 1), 1);
      var a = (0.18 + intensity * 0.82).toFixed(2);
      return 'rgba(var(--accent-r,56),var(--accent-g,138),var(--accent-b,221),'+a+')';
    }

    var BLOCK_LABELS = ['12a','6a','12p','6p'];
    var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var cellSz=12, cellGap=2, step=cellSz+cellGap;
    var leftPad=26, topPad=16, nBlocks=4;
    var svgW = leftPad + days.length*step + 4;
    var svgH = topPad + nBlocks*step + 4;

    var svgBody = '';
    // Row labels (time blocks on left)
    BLOCK_LABELS.forEach(function(lbl, bi) {
      svgBody += '<text x="'+(leftPad-3)+'" y="'+(topPad+bi*step+cellSz*0.78)+'" text-anchor="end" font-family="Share Tech Mono,monospace" font-size="7" fill="rgba(133,183,235,0.45)">'+lbl+'</text>';
    });
    // Month labels on top (first day of each new month)
    var lastMo = -1;
    days.forEach(function(day, di) {
      var mo = day.getMonth();
      if (mo !== lastMo) {
        lastMo = mo;
        svgBody += '<text x="'+(leftPad+di*step)+'" y="'+(topPad-4)+'" font-family="Share Tech Mono,monospace" font-size="7" fill="rgba(133,183,235,0.45)">'+MONTHS[mo]+'</text>';
      }
    });
    // Cells
    days.forEach(function(day, di) {
      var dk = day.getFullYear()+'-'+(day.getMonth()+1)+'-'+day.getDate();
      var dayLabel = day.toLocaleDateString(undefined,{month:'short',day:'numeric'});
      for (var bi=0; bi<4; bi++) {
        var count = blockMap[dk+':'+bi]||0;
        var x = leftPad + di*step, y = topPad + bi*step;
        var tip = dayLabel+' '+BLOCK_LABELS[bi]+'–'+BLOCK_LABELS[bi+1]+(count?' · '+count+' game'+(count!==1?'s':''):'');
        svgBody += '<rect x="'+x+'" y="'+y+'" width="'+cellSz+'" height="'+cellSz+'" rx="2" fill="'+heatColor(count)+'"><title>'+tip+'</title></rect>';
      }
    });

    html += sectionHead('Activity Heatmap', '7 days · 6h blocks');
    html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 20px;margin-bottom:24px">';
    html += '<div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:14px">';
    html += '<div><div style="font-size:22px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--text)">'+totalGames2+'</div><div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px">GAMES LOGGED</div></div>';
    html += '<div><div style="font-size:22px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--accent)">'+activeDays+'</div><div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px">ACTIVE DAYS</div></div>';
    if(bestSt>1) html += '<div><div style="font-size:22px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--gold)">'+bestSt+' <span style="font-size:12px;color:var(--muted2)">days</span></div><div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px">BEST STREAK</div></div>';
    if(bestDayCount>=4) html += '<div><div style="font-size:22px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--loss)">'+bestDayCount+' <span style="font-size:12px;color:var(--muted2)">games</span></div><div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px">MOST IN A DAY</div></div>';
    html += '</div>';
    html += '<div id="hm-scroll" style="overflow-x:auto"><svg xmlns="http://www.w3.org/2000/svg" width="'+svgW+'" height="'+svgH+'" viewBox="0 0 '+svgW+' '+svgH+'" style="display:block">'+svgBody+'</svg></div>';
    html += '<script>setTimeout(function(){var e=document.getElementById("hm-scroll");if(e)e.scrollLeft=e.scrollWidth;},50);</script>';
    html += '<div style="display:flex;align-items:center;gap:5px;margin-top:10px"><span style="font-size:8px;color:rgba(133,183,235,0.4);font-family:Share Tech Mono,monospace">Less</span>';
    ['rgba(255,255,255,0.04)','rgba(56,138,221,0.25)','rgba(56,138,221,0.5)','rgba(56,138,221,0.75)','rgba(56,138,221,0.97)'].forEach(function(c){html+='<div style="width:10px;height:10px;background:'+c+';border-radius:2px"></div>';});
    html += '<span style="font-size:8px;color:rgba(133,183,235,0.4);font-family:Share Tech Mono,monospace">More</span></div>';
    html += '</div>';
  })();

  // ── Top maps with win rate ───────────────────────────────────────────────
  var mapEntries = Object.entries(mapCounts).sort(function(a,b){return b[1]-a[1];}).slice(0,12);
  if (mapEntries.length) {
    html += sectionHead('Most Played Maps', '');
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:24px">';
    mapEntries.forEach(function(e) {
      var wr = e[1] ? Math.round((mapWins[e[0]]||0)/e[1]*100) : 0;
      var wrColor = wr>=55?'var(--win)':wr>=45?'var(--gold)':'var(--loss)';
      var sharePct = Math.round(e[1]/totalGames*100);
      html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px">';
      html += '<div style="font-family:Rajdhani,sans-serif;font-size:14px;font-weight:700;color:var(--text);margin-bottom:4px">'+e[0]+'</div>';
      html += '<div style="display:flex;justify-content:space-between;align-items:center">';
      html += '<div style="font-family:Share Tech Mono,monospace;font-size:10px;color:var(--muted2)">'+e[1]+' games · '+sharePct+'%</div>';
      html += '<div style="font-family:Share Tech Mono,monospace;font-size:11px;color:'+wrColor+'">'+wr+'% WR</div>';
      html += '</div>';
      html += '<div style="height:3px;background:var(--surface3);border-radius:2px;overflow:hidden;margin-top:8px"><div style="height:100%;width:'+wr+'%;background:'+wrColor+';border-radius:2px"></div></div>';
      html += '</div>';
    });
    html += '</div>';
  }

  return html;
}

// ── WEAPONS (Accuracy & Precision) ───────────────────────────────────────────
function renderWeaponsPage(p, allMatches) {
  if (!allMatches || !allMatches.length) {
    return '<div class="empty-state"><div class="empty-state-icon">◆</div><div class="empty-state-msg">No weapon data</div><div class="empty-state-sub">Load more match history to see precision stats</div></div>';
  }

  var ranked = allMatches.filter(function(m){return m.isRanked;});
  var ms = ranked.length >= 20 ? ranked : allMatches;

  var accMs    = ms.filter(function(m){return m.accuracy!=null && parseFloat(m.accuracy)>0;});
  var hsMs     = ms.filter(function(m){return m.weaponStats&&m.kills>0;});
  var dmgMs    = ms.filter(function(m){return m.damageDealt>0;});

  var avgAcc   = accMs.length ? accMs.reduce(function(s,m){return s+parseFloat(m.accuracy);},0)/accMs.length : null;
  var avgHsR   = hsMs.length  ? hsMs.reduce(function(s,m){return s+(m.weaponStats.headshots||0)/m.kills;},0)/hsMs.length*100 : null;
  var avgDmg   = dmgMs.length ? dmgMs.reduce(function(s,m){return s+m.damageDealt;},0)/dmgMs.length : null;
  var avgDmgTk = dmgMs.length ? dmgMs.reduce(function(s,m){return s+(m.damageTaken||0);},0)/dmgMs.length : null;

  var html = '';

  // Summary cards
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px;margin-bottom:24px">';
  if (avgAcc  !== null) html += statCard('Avg Accuracy', avgAcc.toFixed(1)+'%', 'accent', 'across '+accMs.length+' matches');
  if (avgHsR  !== null) html += statCard('Headshot Rate', avgHsR.toFixed(1)+'%', 'gold', 'of kills');
  if (avgDmg  !== null) html += statCard('Avg Damage', Math.round(avgDmg).toLocaleString(), 'win', 'dealt per match');
  if (avgDmgTk!== null && avgDmg !== null) {
    var ratio = (avgDmg/avgDmgTk).toFixed(2);
    html += statCard('Dmg Ratio', ratio, parseFloat(ratio)>=1?'win':'loss', 'dealt / taken');
  }
  html += '</div>';

  // ── Accuracy trend ───────────────────────────────────────────────────────
  var accTrend = accMs.slice(0,60).reverse();
  if (accTrend.length >= 5) {
    var maxA = Math.max.apply(null,accTrend.map(function(m){return parseFloat(m.accuracy);}));
    var minA = Math.min.apply(null,accTrend.map(function(m){return parseFloat(m.accuracy);}));
    var rng  = maxA - minA || 1;
    var svgH = 80, svgW = 600, pad = 6;
    var pts  = accTrend.map(function(m,i){
      var x = accTrend.length>1 ? (i/(accTrend.length-1))*(svgW-pad*2)+pad : svgW/2;
      var y = svgH - pad - ((parseFloat(m.accuracy)-minA)/rng)*(svgH-pad*2);
      return x+','+y;
    }).join(' ');
    html += sectionHead('Accuracy Trend', 'last '+accTrend.length+' matches · win=green, loss=red');
    html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 20px;margin-bottom:20px">';
    html += '<svg viewBox="0 0 '+svgW+' '+svgH+'" style="width:100%;height:auto;overflow:visible" xmlns="http://www.w3.org/2000/svg">';
    // Avg line
    if (avgAcc) {
      var avgY = svgH - pad - ((avgAcc-minA)/rng)*(svgH-pad*2);
      html += '<line x1="'+pad+'" y1="'+avgY+'" x2="'+(svgW-pad)+'" y2="'+avgY+'" stroke="rgba(133,183,235,0.25)" stroke-width="1" stroke-dasharray="4,3"/>';
    }
    html += '<polyline points="'+pts+'" fill="none" stroke="rgba(var(--accent-r,56),var(--accent-g,138),var(--accent-b,221),0.4)" stroke-width="1.5" stroke-linejoin="round"/>';
    accTrend.forEach(function(m,i){
      var x = accTrend.length>1?(i/(accTrend.length-1))*(svgW-pad*2)+pad:svgW/2;
      var y = svgH - pad - ((parseFloat(m.accuracy)-minA)/rng)*(svgH-pad*2);
      var c = m.outcome===2?'var(--win)':m.outcome===3?'var(--loss)':'var(--muted2)';
      html += '<circle cx="'+x+'" cy="'+y+'" r="3.5" fill="'+c+'" stroke="var(--surface)" stroke-width="1"><title>'+parseFloat(m.accuracy).toFixed(1)+'% · '+(m.mapName||'')+'</title></circle>';
    });
    html += '</svg>';
    html += '<div style="display:flex;justify-content:space-between;font-family:Share Tech Mono,monospace;font-size:9px;color:var(--muted2);margin-top:4px"><span>'+minA.toFixed(1)+'%</span><span style="color:rgba(133,183,235,0.5)">avg '+avgAcc.toFixed(1)+'%</span><span>'+maxA.toFixed(1)+'%</span></div>';
    html += '</div>';
  }

  // ── Headshot rate bars ───────────────────────────────────────────────────
  var hsTrend = hsMs.filter(function(m){return m.kills>=3;}).slice(0,50).reverse();
  if (hsTrend.length >= 5) {
    var hsRates = hsTrend.map(function(m){return (m.weaponStats.headshots||0)/m.kills*100;});
    var maxHs = Math.max.apply(null,hsRates) || 1;
    html += sectionHead('Headshot Rate per Match', 'headshots as % of kills');
    html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 20px;margin-bottom:20px">';
    html += '<svg viewBox="0 0 600 56" style="width:100%;height:auto" xmlns="http://www.w3.org/2000/svg">';
    var bw = 600/hsTrend.length - 1;
    hsTrend.forEach(function(m,i) {
      var v = hsRates[i];
      var h2 = Math.max((v/maxHs)*52, v>0?2:0);
      var x = i*(600/hsTrend.length);
      var c = v>=35?'var(--gold)':v>=20?'rgba(var(--accent-r,56),var(--accent-g,138),var(--accent-b,221),0.8)':'rgba(133,183,235,0.35)';
      html += '<rect x="'+x.toFixed(1)+'" y="'+(56-h2).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+h2.toFixed(1)+'" fill="'+c+'" rx="1"><title>'+v.toFixed(1)+'% · '+(m.mapName||'')+'</title></rect>';
    });
    html += '</svg>';
    if (avgHsR !== null) html += '<div style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--muted2);margin-top:4px">avg '+avgHsR.toFixed(1)+'% · gold = 35%+</div>';
    html += '</div>';
  }

  // ── Accuracy by map ──────────────────────────────────────────────────────
  var mapAcc = {};
  ms.forEach(function(m){
    if (!m.mapName||!m.accuracy) return;
    if (!mapAcc[m.mapName]) mapAcc[m.mapName]={sum:0,count:0,wins:0};
    mapAcc[m.mapName].sum += parseFloat(m.accuracy);
    mapAcc[m.mapName].count++;
    if (m.outcome===2) mapAcc[m.mapName].wins++;
  });
  var mapAccList = Object.entries(mapAcc)
    .filter(function(e){return e[1].count>=3;})
    .map(function(e){return {map:e[0],avg:e[1].sum/e[1].count,count:e[1].count,wr:Math.round(e[1].wins/e[1].count*100)};})
    .sort(function(a,b){return b.avg-a.avg;});

  if (mapAccList.length) {
    var globalAvg = avgAcc || 50;
    html += sectionHead('Accuracy by Map', 'min 3 games');
    html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:24px">';
    html += '<table style="width:100%;border-collapse:collapse">';
    html += '<thead><tr style="border-bottom:1px solid var(--border)">'
      + '<th style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--muted2);padding:8px 14px;text-align:left">MAP</th>'
      + '<th style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--muted2);padding:8px 10px;text-align:right">ACC</th>'
      + '<th style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--muted2);padding:8px 10px;text-align:right">WIN%</th>'
      + '<th style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--muted2);padding:8px 14px;text-align:right">vs AVG</th>'
      + '</tr></thead><tbody>';
    mapAccList.forEach(function(e){
      var diff = e.avg - globalAvg;
      var dc = diff>0?'var(--win)':diff<-2?'var(--loss)':'var(--muted)';
      var wrc = e.wr>=55?'var(--win)':e.wr>=45?'var(--gold)':'var(--loss)';
      html += '<tr onmouseover="this.style.background=\'var(--surface2)\'" onmouseout="this.style.background=\'\'">';
      html += '<td style="padding:8px 14px;font-family:Rajdhani,sans-serif;font-size:13px;font-weight:700">'+e.map+'<span style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--muted2);margin-left:8px">'+e.count+'g</span></td>';
      html += '<td style="padding:8px 10px;text-align:right;font-family:Share Tech Mono,monospace;font-size:11px;color:var(--accent)">'+e.avg.toFixed(1)+'%</td>';
      html += '<td style="padding:8px 10px;text-align:right;font-family:Share Tech Mono,monospace;font-size:11px;color:'+wrc+'">'+e.wr+'%</td>';
      html += '<td style="padding:8px 14px;text-align:right;font-family:Share Tech Mono,monospace;font-size:11px;color:'+dc+'">'+(diff>0?'+':'')+diff.toFixed(1)+'%</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div>';
  }

  // ── Damage dealt vs taken scatter ────────────────────────────────────────
  if (dmgMs.length >= 10) {
    var dmgSample = dmgMs.slice(0, 60).reverse();
    var maxDmg2 = Math.max.apply(null, dmgSample.map(function(m){return Math.max(m.damageDealt||0,m.damageTaken||0);})) || 1;
    html += sectionHead('Damage Dealt vs Taken', 'per match · above diagonal = net positive');
    html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 20px;margin-bottom:24px">';
    html += '<svg viewBox="0 0 300 200" style="width:100%;max-width:420px;height:auto" xmlns="http://www.w3.org/2000/svg">';
    // Diagonal
    html += '<line x1="20" y1="180" x2="290" y2="10" stroke="rgba(133,183,235,0.15)" stroke-width="1" stroke-dasharray="3,3"/>';
    // Axes
    html += '<line x1="20" y1="10" x2="20" y2="180" stroke="var(--border)" stroke-width="1"/>';
    html += '<line x1="20" y1="180" x2="290" y2="180" stroke="var(--border)" stroke-width="1"/>';
    html += '<text x="155" y="196" text-anchor="middle" font-family="Share Tech Mono,monospace" font-size="7" fill="rgba(133,183,235,0.4)">TAKEN</text>';
    html += '<text x="8" y="100" text-anchor="middle" font-family="Share Tech Mono,monospace" font-size="7" fill="rgba(133,183,235,0.4)" transform="rotate(-90,8,100)">DEALT</text>';
    dmgSample.forEach(function(m){
      var tx = 20 + ((m.damageTaken||0)/maxDmg2)*270;
      var ty = 180 - ((m.damageDealt||0)/maxDmg2)*170;
      var c = m.outcome===2?'var(--win)':m.outcome===3?'var(--loss)':'var(--muted2)';
      html += '<circle cx="'+tx.toFixed(1)+'" cy="'+ty.toFixed(1)+'" r="3" fill="'+c+'" opacity="0.75"><title>Dealt '+(m.damageDealt||0)+' · Taken '+(m.damageTaken||0)+(m.mapName?' · '+m.mapName:'')+'</title></circle>';
    });
    html += '</svg>';
    html += '<div style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--muted2);margin-top:4px">green=win · red=loss · points above diagonal = you dealt more than you took</div>';
    html += '</div>';
  }

  return html;
}

// ── SYNERGY ──────────────────────────────────────────────────────────────────
function renderSynergyPage(p, allMatches) {
  if (!allMatches || !allMatches.length) {
    return '<div class="empty-state"><div class="empty-state-icon">⊕</div><div class="empty-state-msg">Loading match data…</div><div class="empty-state-sub">Full match history is being fetched</div></div>';
  }
  // renderTeamSynergy is defined in players.js and available globally
  if (typeof renderTeamSynergy === 'function') {
    return renderTeamSynergy(null, p.gamertag);
  }
  return '<div class="empty-state"><div class="empty-state-msg">Synergy data unavailable</div></div>';
}

// ── LAST GAME ─────────────────────────────────────────────────────────────────
function renderLastGamePage(p, allMatches) {
  if (!allMatches || !allMatches.length) {
    return '<div class="empty-state"><div class="empty-state-icon">◈</div><div class="empty-state-msg">Loading match data…</div><div class="empty-state-sub">Full match history is being fetched</div></div>';
  }

  var m = allMatches[0];
  var isWin = m.outcome === 2;
  var isLoss = m.outcome === 3;
  var outcomeLabel = isWin ? 'WIN' : isLoss ? 'LOSS' : 'DRAW';
  var outcomeColor = isWin ? 'var(--win)' : isLoss ? 'var(--loss)' : 'var(--muted)';

  function parseDur(iso) {
    if (!iso) return '--';
    var h = iso.match(/(\d+)H/), mn = iso.match(/(\d+)M/), s = iso.match(/(\d+)S/);
    var hv = h ? parseInt(h[1]) : 0, mv = mn ? parseInt(mn[1]) : 0, sv = s ? parseInt(s[1]) : 0;
    if (hv) return hv + 'h ' + mv + 'm';
    return mv + 'm ' + sv + 's';
  }

  function timeAgo(iso) {
    if (!iso) return '';
    var diff = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diff / 60000), hours = Math.floor(mins / 60), days = Math.floor(hours / 24);
    if (days > 0) return days + 'd ago';
    if (hours > 0) return hours + 'h ago';
    if (mins > 1) return mins + 'm ago';
    return 'just now';
  }

  function avgStat(arr, fn) {
    var vals = arr.map(fn).filter(function(v){ return v != null && !isNaN(v); });
    return vals.length ? vals.reduce(function(a,b){ return a+b; }, 0) / vals.length : null;
  }
  function winRate(arr) {
    if (!arr.length) return null;
    return arr.filter(function(x){ return x.outcome === 2; }).length / arr.length * 100;
  }
  function fmt(v, dec) { dec = dec == null ? 2 : dec; return v != null ? parseFloat(v).toFixed(dec) : '—'; }
  function fmtPct(v) { return v != null ? parseFloat(v).toFixed(1) + '%' : '—'; }
  function deltaArrow(cur, avg, higherBetter) {
    if (cur == null || avg == null || avg === 0) return '';
    var diff = cur - avg, pct = Math.abs(diff / avg * 100);
    var better = higherBetter !== false ? diff > 0 : diff < 0;
    var color = better ? 'var(--win)' : 'var(--loss)';
    var arrow = diff > 0 ? '▲' : '▼';
    return '<span style="color:' + color + ';font-size:8px;margin-left:3px">' + arrow + pct.toFixed(0) + '%</span>';
  }

  var myKDA = parseFloat(m.kda) || 0;
  var myAcc = m.accuracy != null ? parseFloat(m.accuracy) : null;
  var myDmg = m.damageDealt || 0;
  var myGamertag = (p.gamertag || '').toLowerCase();

  var mapMatches  = allMatches.filter(function(x){ return x.mapName === m.mapName; });
  var modeMatches = allMatches.filter(function(x){ return x.gameMode === m.gameMode; });
  var contexts = [
    { label: 'THIS MAP',  sub: m.mapName || '—',                          matches: mapMatches  },
    { label: 'THIS MODE', sub: (m.gameMode||'').replace(/Ranked /,''),     matches: modeMatches },
    { label: 'OVERALL',   sub: allMatches.length + ' games',               matches: allMatches  },
  ];

  var html = '';

  // ── Live poll status strip ───────────────────────────────────────────────
  html += '<div id="lg-poll-strip" style="background:var(--surface2);border-bottom:1px solid var(--border);padding:7px 16px;font-family:Share Tech Mono,monospace;font-size:10px;color:var(--muted2);letter-spacing:1px;display:flex;align-items:center;gap:10px">';
  html += '<span id="lg-pulse-dot" style="width:7px;height:7px;border-radius:50%;background:var(--win);flex-shrink:0;animation:lgPulse 2.4s ease-in-out infinite"></span>';
  html += '<span id="lg-poll-status">WATCHING FOR NEW GAME</span>';
  html += '<span id="lg-checked-ago" style="color:var(--muted2);margin-left:4px"></span>';
  html += '<span id="lg-new-banner" style="display:none;margin-left:auto;color:var(--accent);font-weight:700;cursor:pointer;letter-spacing:1px;animation:lgBlink 1s step-end infinite" onclick="window._lgLoadNewGame && window._lgLoadNewGame()">▶ NEW GAME DETECTED — CLICK TO LOAD</span>';
  html += '</div>';

  // ── Map hero ─────────────────────────────────────────────────────────────
  var mapBg = m.mapImageUrl
    ? 'background:linear-gradient(to bottom,rgba(6,13,23,0.45) 0%,rgba(6,13,23,0.88) 55%,var(--bg) 100%),url(\'' + m.mapImageUrl + '\') center/cover no-repeat'
    : 'background:linear-gradient(135deg,var(--surface2),var(--surface3))';
  html += '<div style="' + mapBg + ';padding:36px 24px 28px;border-bottom:1px solid var(--border)">';
  html += '<div style="display:inline-flex;align-items:center;gap:8px;margin-bottom:12px">';
  html += '<span style="background:' + outcomeColor + ';color:var(--bg);font-family:Rajdhani,sans-serif;font-size:13px;font-weight:800;padding:3px 12px;border-radius:3px;letter-spacing:3px">' + outcomeLabel + '</span>';
  if (m.isRanked) html += '<span style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--muted2);letter-spacing:2px;border:1px solid var(--border2);padding:2px 7px;border-radius:2px">RANKED</span>';
  html += '</div>';
  html += '<div style="font-family:Rajdhani,sans-serif;font-size:36px;font-weight:700;color:var(--text);line-height:1;margin-bottom:6px">' + (m.mapName || 'Unknown Map') + '</div>';
  html += '<div style="font-family:Share Tech Mono,monospace;font-size:11px;color:var(--muted);letter-spacing:1px;margin-bottom:16px">';
  html += (m.gameMode || '').toUpperCase();
  if (m.duration) html += ' · ' + parseDur(m.duration);
  html += ' · ' + timeAgo(m.startTime);
  html += '</div>';
  // CSR delta badge
  if (m.csrDelta != null) {
    var d = m.csrDelta, dSign = d > 0 ? '+' : '', dColor = d > 0 ? 'var(--win)' : d < 0 ? 'var(--loss)' : 'var(--muted)';
    html += '<div style="display:inline-flex;align-items:center;gap:8px;background:rgba(0,0,0,0.45);border:1px solid var(--border2);border-radius:4px;padding:7px 14px">';
    html += '<span style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--muted2);letter-spacing:2px">CSR</span>';
    html += '<span style="font-family:Rajdhani,sans-serif;font-size:26px;font-weight:700;color:' + dColor + '">' + dSign + d + '</span>';
    if (m.csrAfter) html += '<span style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--muted);letter-spacing:1px">→ ' + m.csrAfter + '</span>';
    html += '</div>';
  }
  html += '</div>';

  html += '<div style="padding:20px 16px 32px">';

  // ── Your performance cards ───────────────────────────────────────────────
  html += sectionHead('YOUR PERFORMANCE', m.placement != null ? 'ranked #' + m.placement + ' on scoreboard' : null);
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin-top:12px">';
  var killsClass = m.kills > m.deaths ? 'win' : m.kills < m.deaths ? 'loss' : '';
  html += statCard('KILLS',   m.kills,  killsClass);
  html += statCard('DEATHS',  m.deaths, 'loss');
  html += statCard('ASSISTS', m.assists);
  html += statCard('KDA', m.kda, myKDA >= 1 ? 'win' : 'loss');
  if (myAcc != null) html += statCard('ACCURACY', myAcc.toFixed(1) + '%', myAcc >= 50 ? 'win' : 'loss');
  if (m.weaponStats && m.weaponStats.headshots != null && m.kills > 0) {
    var hsRate = (m.weaponStats.headshots / m.kills * 100).toFixed(0);
    html += statCard('HEADSHOT %', hsRate + '%', parseInt(hsRate) >= 40 ? 'win' : '');
  }
  var dmgDealtClass = (m.damageDealt && m.damageTaken != null) ? (m.damageDealt > m.damageTaken ? 'win' : '') : '';
  var dmgTakenClass = (m.damageTaken != null && m.damageDealt != null) ? (m.damageTaken > m.damageDealt ? 'loss' : '') : '';
  if (m.damageDealt) html += statCard('DMG DEALT', m.damageDealt.toLocaleString(), dmgDealtClass);
  if (m.damageTaken != null) html += statCard('DMG TAKEN', m.damageTaken.toLocaleString(), dmgTakenClass, m.damageTakenEstimated ? 'est.' : null);
  if (m.damageDealt && m.damageTaken) {
    var dmgRatio = (m.damageDealt / Math.max(m.damageTaken, 1)).toFixed(2);
    html += statCard('DMG RATIO', dmgRatio, parseFloat(dmgRatio) >= 1 ? 'win' : 'loss', 'dealt÷taken');
  }
  if (m.shotsFired && m.shotsHit) html += statCard('SHOTS FIRED', m.shotsFired.toLocaleString(), null, m.shotsHit.toLocaleString() + ' hit');
  html += '</div>';

  // ── Kill breakdown bars ──────────────────────────────────────────────────
  if (m.weaponStats && m.kills > 0) {
    var ws = m.weaponStats;
    var specialTotal = (ws.headshots||0) + (ws.melee||0) + (ws.grenades||0) + (ws.powerWeapon||0);
    var regularKills = Math.max(0, m.kills - specialTotal);
    var killTypes = [
      { label: 'BODY SHOTS', value: regularKills,    color: 'var(--accent)'  },
      { label: 'HEADSHOTS',  value: ws.headshots||0, color: 'var(--win)'     },
      { label: 'MELEE',      value: ws.melee||0,     color: 'var(--gold)'    },
      { label: 'GRENADES',   value: ws.grenades||0,  color: '#e8a030'        },
      { label: 'POWER WPN',  value: ws.powerWeapon||0, color: '#b060ff'      },
    ].filter(function(x){ return x.value > 0; });

    if (killTypes.length > 1) {
      html += '<div style="margin-top:24px">';
      html += sectionHead('KILL BREAKDOWN');
      html += '<div style="margin-top:12px;display:flex;flex-direction:column;gap:7px">';
      killTypes.forEach(function(k) {
        var pct = k.value / m.kills * 100;
        html += '<div style="display:flex;align-items:center;gap:10px">';
        html += '<div style="font-family:Share Tech Mono,monospace;font-size:8px;color:var(--muted2);letter-spacing:1px;width:72px;flex-shrink:0;text-align:right">' + k.label + '</div>';
        html += '<div style="flex:1;height:20px;background:var(--surface2);border-radius:2px;overflow:hidden;border:1px solid var(--border)">';
        html += '<div style="height:100%;width:' + pct.toFixed(1) + '%;background:' + k.color + ';display:flex;align-items:center;padding-left:7px;min-width:' + (k.value>0?'26px':'0') + ';transition:width 0.5s ease">';
        html += '<span style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--bg);font-weight:700">' + k.value + '</span>';
        html += '</div></div>';
        html += '<div style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--muted2);width:30px">' + pct.toFixed(0) + '%</div>';
        html += '</div>';
      });
      html += '</div></div>';
    }
  }

  // ── Context comparison ───────────────────────────────────────────────────
  html += '<div style="margin-top:28px">';
  html += sectionHead('PERFORMANCE CONTEXT', 'this game vs your averages');
  html += '<div style="margin-top:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px">';
  contexts.forEach(function(ctx) {
    var avgKDA  = avgStat(ctx.matches, function(x){ return parseFloat(x.kda); });
    var avgAcc  = avgStat(ctx.matches, function(x){ return x.accuracy != null ? parseFloat(x.accuracy) : null; });
    var avgDmg  = avgStat(ctx.matches, function(x){ return x.damageDealt || 0; });
    var wr      = winRate(ctx.matches);
    var n       = ctx.matches.length;

    html += '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:12px 10px">';
    html += '<div style="font-family:Share Tech Mono,monospace;font-size:8px;letter-spacing:2px;color:var(--accent);margin-bottom:2px">' + ctx.label + '</div>';
    html += '<div style="font-family:Share Tech Mono,monospace;font-size:8px;color:var(--muted2);margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + ctx.sub + '">' + ctx.sub + '</div>';

    function ctxRow(label, curVal, avgVal, fmtFn, higherBetter) {
      var fmtFnFinal = fmtFn || function(v){ return fmt(v); };
      var r = '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border)">';
      r += '<span style="font-family:Share Tech Mono,monospace;font-size:7px;color:var(--muted2);letter-spacing:1px">' + label + '</span>';
      r += '<div style="text-align:right">';
      r += '<span style="font-family:Rajdhani,sans-serif;font-size:15px;font-weight:700;color:var(--text)">' + fmtFnFinal(avgVal) + '</span>';
      r += deltaArrow(curVal, avgVal, higherBetter);
      r += '</div></div>';
      return r;
    }

    html += ctxRow('AVG KDA',  myKDA,  avgKDA,  function(v){ return fmt(v,2); });
    if (avgAcc != null && myAcc != null) html += ctxRow('AVG ACC', myAcc, avgAcc, function(v){ return fmtPct(v); });
    html += ctxRow('AVG DMG',  myDmg,  avgDmg,  function(v){ return v != null ? Math.round(v).toLocaleString() : '—'; });
    // Win rate — no delta arrow since it's a pool stat not a this-game stat
    var wrColor = wr != null && wr >= 50 ? 'var(--win)' : 'var(--loss)';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">';
    html += '<span style="font-family:Share Tech Mono,monospace;font-size:7px;color:var(--muted2);letter-spacing:1px">WIN RATE</span>';
    html += '<span style="font-family:Rajdhani,sans-serif;font-size:15px;font-weight:700;color:' + wrColor + '">' + fmtPct(wr) + '</span>';
    html += '</div>';

    html += '<div style="margin-top:6px;font-family:Share Tech Mono,monospace;font-size:7px;color:var(--muted2);text-align:right;letter-spacing:1px">' + n + ' GAMES</div>';
    html += '</div>';
  });
  html += '</div></div>';

  // ── Full scoreboard ──────────────────────────────────────────────────────
  if (m.teams && m.teams.length) {
    html += '<div style="margin-top:28px">';
    html += sectionHead('FULL SCOREBOARD');
    m.teams.forEach(function(team, ti) {
      var tOut   = team.outcome === 2 ? 'WIN' : team.outcome === 3 ? 'LOSS' : 'DRAW';
      var tColor = team.outcome === 2 ? 'var(--win)' : team.outcome === 3 ? 'var(--loss)' : 'var(--muted)';
      var sorted = team.players.slice().sort(function(a,b){ return (b.score||b.kills||0)-(a.score||a.kills||0); });

      html += '<div style="margin-top:14px">';
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">';
      html += '<span style="font-family:Share Tech Mono,monospace;font-size:9px;font-weight:700;letter-spacing:3px;color:' + tColor + '">' + tOut + '</span>';
      html += '<span style="font-family:Share Tech Mono,monospace;font-size:8px;color:var(--muted2)">TEAM ' + (ti+1) + ' · ' + sorted.length + ' PLAYERS</span>';
      html += '</div>';

      // Scrollable scoreboard wrapper for mobile
      html += '<div style="overflow-x:auto">';
      var cols = '1fr 36px 36px 36px 52px 72px 60px';
      var minScoreW = '420px';
      html += '<div style="display:grid;grid-template-columns:' + cols + ';min-width:'+minScoreW+';background:var(--surface3);border:1px solid var(--border);border-radius:4px 4px 0 0;padding:5px 10px;font-family:Share Tech Mono,monospace;font-size:8px;color:var(--muted2);letter-spacing:1px">';
      html += '<span>PLAYER</span><span style="text-align:center">K</span><span style="text-align:center">D</span><span style="text-align:center">A</span><span style="text-align:center">ACC</span><span style="text-align:center">DMG</span><span style="text-align:center">KDA</span>';
      html += '</div>';

      sorted.forEach(function(pl, pi) {
        var isMe = pl.gamertag.toLowerCase() === myGamertag;
        var isLast = pi === sorted.length - 1;
        var rowStyle = [
          isMe ? 'background:rgba(var(--accent-r),var(--accent-g),var(--accent-b),0.09);border-left:2px solid var(--accent)' : 'background:var(--surface2)',
          isLast ? 'border-radius:0 0 4px 4px' : '',
          'border:1px solid var(--border);border-top:none',
          'display:grid;grid-template-columns:' + cols,
          'min-width:' + minScoreW,
          'padding:7px 10px;align-items:center;font-family:Share Tech Mono,monospace;font-size:10px',
        ].filter(Boolean).join(';');

        var plKda   = pl.kda || pl.kd || null;
        var kdaNum  = parseFloat(plKda);
        var kdaColor = kdaNum >= 1.5 ? 'var(--win)' : kdaNum < 0.8 ? 'var(--loss)' : 'var(--text)';
        var plAcc   = pl.accuracy != null ? parseFloat(pl.accuracy).toFixed(0) + '%' : '—';
        var plDmg   = pl.damage  ? (Math.round(pl.damage/100)/10).toFixed(1) + 'k' : '—';

        // CSR badge suffix
        var csrBadge = '';
        if (pl.csrTier) {
          var csrLabel = pl.csrTier === 'Onyx' ? 'Onyx ' + (pl.csrValue||'') : pl.csrTier + (pl.csrSubTier != null ? ' ' + pl.csrSubTier : '');
          var csrChange = pl.csrDelta != null ? ' (' + (pl.csrDelta > 0 ? '+' : '') + pl.csrDelta + ')' : '';
          csrBadge = ' <span style="font-size:8px;color:var(--muted2)">' + csrLabel.trim() + csrChange + '</span>';
        }

        html += '<div style="' + rowStyle + '">';
        html += '<span style="color:' + (isMe ? 'var(--accent)' : 'var(--text)') + ';font-weight:' + (isMe ? '700' : '400') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + pl.gamertag + (isMe ? ' ←' : '') + csrBadge + '</span>';
        html += '<span style="text-align:center;color:var(--text)">'     + (pl.kills  || 0) + '</span>';
        html += '<span style="text-align:center;color:var(--muted)">'    + (pl.deaths || 0) + '</span>';
        html += '<span style="text-align:center;color:var(--muted)">'    + (pl.assists|| 0) + '</span>';
        html += '<span style="text-align:center;color:var(--muted)">'    + plAcc            + '</span>';
        html += '<span style="text-align:center;color:var(--muted)">'    + plDmg            + '</span>';
        html += '<span style="text-align:center;color:' + kdaColor + ';font-weight:700">' + (plKda || '—') + '</span>';
        html += '</div>';
      });
      html += '</div>'; // end scroll wrapper
      html += '</div>'; // end team block
    });
    html += '</div>';
  }

  // ── Medals ───────────────────────────────────────────────────────────────
  // ── Medals (using medalImg from utils.js for sprite sheet rendering) ─────
  if (m.topMedals && m.topMedals.length) {
    html += '<div style="margin-top:28px">';
    html += sectionHead('MEDALS', m.topMedals.length + ' earned');
    html += '<div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:8px">';
    m.topMedals.forEach(function(medal) {
      if (typeof medalImg === 'function') {
        html += medalImg(medal);
      } else {
        var meta = (typeof medalMeta !== 'undefined') ? (medalMeta[String(medal.nameId)] || {}) : {};
        var name = meta.name || medal.name || String(medal.nameId);
        var count = medal.count || 1;
        html += '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:5px 10px;display:flex;align-items:center;gap:5px">';
        html += '<span style="font-family:Share Tech Mono,monospace;font-size:10px;color:var(--text)">' + name + '</span>';
        if (count > 1) html += '<span style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--accent);font-weight:700">×' + count + '</span>';
        html += '</div>';
      }
    });
    html += '</div></div>';
  }

  // ── Objective stats ───────────────────────────────────────────────────────
  if (m.objStats) {
    var obj = m.objStats, objMode = obj.mode || '';
    // Historical averages for same objective mode (all maps/this mode)
    var sameObjMatches = allMatches.filter(function(x){ return x.objStats && x.objStats.mode === objMode; });
    var mapObjMatches  = sameObjMatches.filter(function(x){ return x.mapName === m.mapName; });
    function objAvg(field, src) {
      var pool = src || sameObjMatches;
      var vals = pool.map(function(x){ return x.objStats[field]; }).filter(function(v){ return v != null && !isNaN(v); });
      return vals.length >= 2 ? vals.reduce(function(a,b){ return a+b; }, 0) / vals.length : null;
    }
    function objSub(field, valRaw, isTime) {
      // prefer map-level avg, fall back to mode-level
      var avg = objAvg(field, mapObjMatches.length >= 3 ? mapObjMatches : null) || objAvg(field);
      if (avg == null) return null;
      var scope = mapObjMatches.length >= 3 ? 'map avg' : 'mode avg';
      var avgFmt = isTime ? Math.round(avg) + 's' : avg.toFixed(1);
      var val = isTime ? valRaw : valRaw;
      var numVal = isTime ? valRaw : parseFloat(valRaw);
      var diff = numVal - avg;
      var better = diff > 0;
      var diffSign = diff >= 0 ? '+' : '';
      var diffColor = better ? 'var(--win)' : 'var(--loss)';
      return scope + ' ' + avgFmt + ' <span style="color:' + diffColor + ';font-size:8px">' + diffSign + (isTime ? Math.round(diff) + 's' : diff.toFixed(1)) + '</span>';
    }
    var objRows = [];
    if (obj.flagCaptures  != null && obj.flagCaptures  > 0) objRows.push({ label:'FLAG CAPS',        value: obj.flagCaptures,  sub: objSub('flagCaptures',  obj.flagCaptures)  });
    if (obj.flagReturns   != null && obj.flagReturns   > 0) objRows.push({ label:'FLAG RETURNS',     value: obj.flagReturns,   sub: objSub('flagReturns',   obj.flagReturns)   });
    if (obj.flagGrabs     != null && obj.flagGrabs     > 0) objRows.push({ label:'FLAG GRABS',       value: obj.flagGrabs,     sub: objSub('flagGrabs',     obj.flagGrabs)     });
    if (obj.zoneCaptures  != null && obj.zoneCaptures  > 0) objRows.push({ label:'ZONE CAPS',        value: obj.zoneCaptures,  sub: objSub('zoneCaptures',  obj.zoneCaptures)  });
    if (obj.zoneSecures   != null && obj.zoneSecures   > 0) objRows.push({ label:'ZONE SECURES',     value: obj.zoneSecures,   sub: objSub('zoneSecures',   obj.zoneSecures)   });
    if (obj.timeAsCarrier != null && obj.timeAsCarrier > 0) objRows.push({ label:'CARRIER TIME',     value: Math.round(obj.timeAsCarrier) + 's', sub: objSub('timeAsCarrier', obj.timeAsCarrier, true) });
    if (obj.killsAsCarrier!= null && obj.killsAsCarrier> 0) objRows.push({ label:'KILLS AS CARRIER', value: obj.killsAsCarrier, sub: objSub('killsAsCarrier', obj.killsAsCarrier) });
    if (obj.ballGrabs     != null && obj.ballGrabs     > 0) objRows.push({ label:'BALL GRABS',       value: obj.ballGrabs,     sub: objSub('ballGrabs',     obj.ballGrabs)     });
    if (obj.longestCarry  != null && obj.longestCarry  > 0) objRows.push({ label:'LONGEST CARRY',    value: Math.round(obj.longestCarry) + 's', sub: objSub('longestCarry', obj.longestCarry, true) });
    if (obj.seedsDeposited!= null && obj.seedsDeposited> 0) objRows.push({ label:'SEEDS DEPOSITED',  value: obj.seedsDeposited, sub: objSub('seedsDeposited', obj.seedsDeposited) });
    if (obj.defensiveKills!= null && obj.defensiveKills> 0) objRows.push({ label:'DEFENSIVE KILLS',  value: obj.defensiveKills, sub: objSub('defensiveKills', obj.defensiveKills) });
    if (obj.offensiveKills!= null && obj.offensiveKills> 0) objRows.push({ label:'OFFENSIVE KILLS',  value: obj.offensiveKills, sub: objSub('offensiveKills', obj.offensiveKills) });
    if (objRows.length) {
      var nGames = sameObjMatches.length;
      html += '<div style="margin-top:28px">';
      html += sectionHead('OBJECTIVE', objMode.toUpperCase() + (nGames >= 2 ? ' · avg from ' + nGames + ' games' : ''));
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-top:12px">';
      objRows.forEach(function(r) {
        html += statCard(r.label, r.value, 'accent', r.sub || null);
      });
      html += '</div></div>';
    }
  }

  // ── Team damage comparison ────────────────────────────────────────────────
  if (m.teams && m.teams.length >= 2) {
    var myTeamIdx = m.teams.findIndex(function(t){ return t.outcome === m.outcome; });
    if (myTeamIdx === -1) myTeamIdx = 0;
    var enemyTeamIdx = myTeamIdx === 0 ? 1 : 0;
    var myTeamPlayers   = m.teams[myTeamIdx]   ? m.teams[myTeamIdx].players   : [];
    var enemyTeamPlayers= m.teams[enemyTeamIdx]? m.teams[enemyTeamIdx].players: [];

    function teamTotal(players, fn) {
      return players.reduce(function(s, p){ return s + (fn(p)||0); }, 0);
    }
    var myTotalKills  = teamTotal(myTeamPlayers,   function(p){ return p.kills; });
    var enTotalKills  = teamTotal(enemyTeamPlayers, function(p){ return p.kills; });
    var myTotalDmg    = teamTotal(myTeamPlayers,   function(p){ return p.damage; });
    var enTotalDmg    = teamTotal(enemyTeamPlayers, function(p){ return p.damage; });
    var myTotalAcc    = myTeamPlayers.filter(function(p){ return p.accuracy!=null; });
    var enTotalAcc    = enemyTeamPlayers.filter(function(p){ return p.accuracy!=null; });
    var myAvgAcc = myTotalAcc.length ? myTotalAcc.reduce(function(s,p){ return s+parseFloat(p.accuracy); },0)/myTotalAcc.length : null;
    var enAvgAcc = enTotalAcc.length ? enTotalAcc.reduce(function(s,p){ return s+parseFloat(p.accuracy); },0)/enTotalAcc.length : null;

    var myTotalDeaths = teamTotal(myTeamPlayers,   function(p){ return p.deaths; });
    var enTotalDeaths = teamTotal(enemyTeamPlayers, function(p){ return p.deaths; });
    var myTotalAssists= teamTotal(myTeamPlayers,   function(p){ return p.assists; });
    var enTotalAssists= teamTotal(enemyTeamPlayers, function(p){ return p.assists; });
    var myKdaPlayers  = myTeamPlayers.filter(function(p){ return p.kda != null && !isNaN(parseFloat(p.kda)); });
    var enKdaPlayers  = enemyTeamPlayers.filter(function(p){ return p.kda != null && !isNaN(parseFloat(p.kda)); });
    var myAvgKda = myKdaPlayers.length ? myKdaPlayers.reduce(function(s,p){ return s+parseFloat(p.kda); },0)/myKdaPlayers.length : null;
    var enAvgKda = enKdaPlayers.length ? enKdaPlayers.reduce(function(s,p){ return s+parseFloat(p.kda); },0)/enKdaPlayers.length : null;

    var comparisons = [
      { label:'TOTAL KILLS',   my: myTotalKills,   en: enTotalKills,   higherBetter: true,  fmt: function(v){ return v; } },
      { label:'TOTAL DEATHS',  my: myTotalDeaths,  en: enTotalDeaths,  higherBetter: false, fmt: function(v){ return v; } },
      { label:'TOTAL ASSISTS', my: myTotalAssists, en: enTotalAssists, higherBetter: true,  fmt: function(v){ return v; } },
      { label:'TOTAL DAMAGE',  my: myTotalDmg,     en: enTotalDmg,     higherBetter: true,  fmt: function(v){ return Math.round(v).toLocaleString(); } },
    ];
    if (myAvgAcc != null && enAvgAcc != null) {
      comparisons.push({ label:'AVG ACCURACY', my: myAvgAcc, en: enAvgAcc, higherBetter: true, fmt: function(v){ return v.toFixed(1)+'%'; } });
    }
    if (myAvgKda != null && enAvgKda != null) {
      comparisons.push({ label:'AVG KDA', my: myAvgKda, en: enAvgKda, higherBetter: true, fmt: function(v){ return v.toFixed(2); } });
    }

    html += '<div style="margin-top:28px">';
    html += sectionHead('TEAM BREAKDOWN', 'your team vs opponents');
    html += '<div style="margin-top:12px;display:flex;flex-direction:column;gap:10px">';
    comparisons.forEach(function(row) {
      var total = (row.my||0) + (row.en||0) || 1;
      var myPct = (row.my||0) / total * 100;
      var enPct = (row.en||0) / total * 100;
      // For deaths: fewer is better, so my "winning" means my value is lower
      var hb = row.higherBetter !== false;
      var myLeads = hb ? row.my >= row.en : row.my <= row.en;
      var myBarColor = myLeads ? 'var(--win)' : 'var(--loss)';
      var enBarColor = myLeads ? 'var(--loss)' : 'var(--win)';
      html += '<div>';
      html += '<div style="display:flex;justify-content:space-between;font-family:Share Tech Mono,monospace;font-size:9px;color:var(--muted2);letter-spacing:1px;margin-bottom:4px">';
      html += '<span style="color:'+(myLeads?'var(--win)':'var(--muted)')+'">YOUR TEAM · ' + row.fmt(row.my||0) + '</span>';
      html += '<span style="letter-spacing:2px">' + row.label + '</span>';
      html += '<span style="color:'+(!myLeads?'var(--win)':'var(--muted)')+'">OPPONENTS · ' + row.fmt(row.en||0) + '</span>';
      html += '</div>';
      html += '<div style="display:flex;height:10px;border-radius:3px;overflow:hidden;gap:2px">';
      html += '<div style="width:'+myPct.toFixed(1)+'%;background:'+myBarColor+';border-radius:3px 0 0 3px;transition:width 0.4s ease"></div>';
      html += '<div style="width:'+enPct.toFixed(1)+'%;background:'+enBarColor+';border-radius:0 3px 3px 0;transition:width 0.4s ease"></div>';
      html += '</div>';
      html += '</div>';
    });
    html += '</div></div>';
  }

  // ── CSR trend — where this game sits in your recent history ──────────────
  var csrHistory = allMatches.filter(function(x){ return x.csrDelta != null; }).slice(0, 20).reverse();
  if (csrHistory.length >= 3) {
    html += '<div style="margin-top:28px">';
    html += sectionHead('CSR HISTORY', 'last ' + csrHistory.length + ' ranked games');
    html += '<div style="margin-top:10px;display:flex;gap:3px;align-items:flex-end;height:40px">';
    var maxAbs = Math.max.apply(null, csrHistory.map(function(x){ return Math.abs(x.csrDelta); })) || 1;
    csrHistory.forEach(function(gm) {
      var isThis = gm.matchId === m.matchId;
      var d = gm.csrDelta;
      var pos = d > 0;
      var h = Math.max(3, Math.abs(d) / maxAbs * 36);
      var bg = isThis ? 'var(--accent)' : pos ? 'var(--win)' : 'var(--loss)';
      var sign = d > 0 ? '+' : '';
      html += '<div title="' + sign + d + '" style="flex:1;height:' + h + 'px;background:' + bg + ';border-radius:2px;opacity:' + (isThis ? '1' : '0.55') + ';min-width:6px;cursor:default;box-shadow:' + (isThis ? '0 0 6px var(--accent)' : 'none') + '"></div>';
    });
    html += '</div>';
    html += '<div style="display:flex;justify-content:space-between;font-family:Share Tech Mono,monospace;font-size:8px;color:var(--muted2);margin-top:4px">';
    html += '<span>OLDEST</span><span style="color:var(--accent)">← THIS GAME IS HIGHLIGHTED</span><span>LATEST</span>';
    html += '</div></div>';
  }

  // ── Recent results on this map ────────────────────────────────────────────
  if (mapMatches.length > 1) {
    var mapSlice = mapMatches.slice(0, 12);
    html += '<div style="margin-top:28px">';
    html += sectionHead('RECENT ON ' + (m.mapName||'THIS MAP').toUpperCase(), mapSlice.length + ' games shown');
    html += '<div style="margin-top:10px;display:flex;gap:4px;flex-wrap:wrap">';
    mapSlice.forEach(function(gm) {
      var w = gm.outcome===2, l = gm.outcome===3;
      var c = w ? 'var(--win)' : l ? 'var(--loss)' : 'var(--muted)';
      var lbl = w ? 'W' : l ? 'L' : 'D';
      var tip = (gm.kills||0)+'/'+(gm.deaths||0)+'/'+(gm.assists||0)+' · '+(gm.gameMode||'')+(gm.csrDelta!=null?' · CSR '+(gm.csrDelta>0?'+':'')+gm.csrDelta:'');
      html += '<div title="' + tip + '" style="background:var(--surface2);border:1px solid ' + c + ';border-radius:3px;padding:5px 8px;font-family:Share Tech Mono,monospace;font-size:9px;color:' + c + ';min-width:24px;text-align:center;cursor:default">';
      html += lbl;
      html += '<div style="font-size:7px;color:var(--muted2);margin-top:2px">' + (gm.kills||0) + '/' + (gm.deaths||0) + '</div>';
      html += '</div>';
    });
    html += '</div></div>';
  }

  html += '</div>'; // end main padding
  return html;
}

// ── COMPARE ──────────────────────────────────────────────────────────────────
// Opens the existing full-screen compare overlay — it already handles everything
function renderComparePage(p) {
  // Render a container that the compare functions write into, then init on next tick
  setTimeout(function() {
    if (typeof _initCompareTab === 'function') _initCompareTab();
  }, 0);
  return '<div id="cmpTabPanel" style="padding:20px 16px;min-height:300px">'
    + '<div style="text-align:center;padding:60px 20px;color:var(--muted2);font-family:Share Tech Mono,monospace;font-size:11px;letter-spacing:1px">LOADING…</div>'
    + '</div>';
}
