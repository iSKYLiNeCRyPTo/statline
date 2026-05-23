// ── Leaderboard — embedded in main app ────────────────────────────────────────
var _lbTabData       = {};
var _lbTab           = 'csrArena';
var _lbPage          = 1;
var _lbSearch        = '';
var LB_PER_PAGE      = 250;
var LB_TTL           = 2 * 60 * 1000; // 2 min
var _LB_TIERS        = ['Bronze','Silver','Gold','Platinum','Diamond','Onyx'];
var _LB_TIER_COLORS  = { Bronze:'#cd7f32', Silver:'#aaaaaa', Gold:'#d4860a', Platinum:'#80dddd', Diamond:'#60cfff', Onyx:'#00c8ff' };
var _lbTierDiveCharts = [];
var _lbTierDiveRows   = [];

function showLeaderboard() {
  hideLanding();
  // URL
  try {
    var url = new URL(window.location);
    url.searchParams.delete('player');
    url.searchParams.set('view', 'leaderboard');
    window.history.pushState({}, '', url);
  } catch(e) {}
  // Titles
  document.title = 'fragr — Leaderboard';
  var el = document.getElementById('topbarTitle');
  if (el) el.textContent = '// LEADERBOARD';
  // Sidebar + mobile tab active state — clear all, highlight LB
  document.querySelectorAll('.sidebar-nav-item').forEach(function(b){ b.classList.remove('active'); });
  document.querySelectorAll('.mobile-tab[data-tab]').forEach(function(b){ b.classList.remove('active'); });
  var lbBtn = document.getElementById('lbSidebarBtn');
  if (lbBtn) lbBtn.classList.add('active');
  var lbMobileTab = document.querySelector('.mobile-tab[data-tab="leaderboard"]');
  if (lbMobileTab) lbMobileTab.classList.add('active');
  // Render shell into #app
  document.getElementById('app').innerHTML = _lbShell();
  // Load data
  _lbLoadTab(_lbTab);
}

function _lbShell() {
  return '<div style="padding:24px 20px 60px;max-width:900px;margin:0 auto;position:relative;z-index:1">'
    + '<div style="margin-bottom:20px">'
    +   '<div style="font-family:Rajdhani,sans-serif;font-size:28px;font-weight:700;color:var(--text);letter-spacing:2px">'
    +     '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:8px"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></svg>'
    +     'GLOBAL LEADERBOARDS'
    +   '</div>'
    +   '<div style="font-family:Share Tech Mono,monospace;font-size:10px;color:var(--muted2);letter-spacing:1.5px;margin-top:4px">// RANKED PLAYERS · UPDATED ON SEARCH</div>'
    + '</div>'
    + '<div style="background:rgba(255,193,7,0.06);border:1px solid rgba(255,193,7,0.2);border-radius:6px;padding:8px 14px;margin-bottom:18px;font-family:Share Tech Mono,monospace;font-size:10px;color:rgba(255,193,7,0.7);line-height:1.6;letter-spacing:0.5px">'
    +   '⚠ Community-sourced data — rankings include players who have been searched on fragr or appeared as opponents/teammates in tracked matches. Not a complete global ranking.'
    + '</div>'
    + '<div class="lb-tabs">'
    +   '<button class="lb-tab' + (_lbTab==='csrArena'  ?' active':'') + '" onclick="_lbSwitchTab(\'csrArena\',this)">RANKED ARENA</button>'
    +   '<button class="lb-tab' + (_lbTab==='csrSlayer' ?' active':'') + '" onclick="_lbSwitchTab(\'csrSlayer\',this)">RANKED SLAYER</button>'
    +   '<button class="lb-tab' + (_lbTab==='csrLegacy' ?' active':'') + '" onclick="_lbSwitchTab(\'csrLegacy\',this)">RANKED LEGACY</button>'
    +   '<button class="lb-tab' + (_lbTab==='csrDoubles'?' active':'') + '" onclick="_lbSwitchTab(\'csrDoubles\',this)">RANKED DOUBLES</button>'
    +   '<button class="lb-tab' + (_lbTab==='insights'  ?' active':'') + '" onclick="_lbSwitchTab(\'insights\',this)">INSIGHTS</button>'
    + '</div>'
    + '<div class="lb-search-wrap">'
    +   '<svg class="lb-search-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'
    +   '<input class="lb-search" id="lbSearch" type="text" placeholder="Filter by gamertag..." oninput="_lbOnSearch(this.value)" autocomplete="off" spellcheck="false"' + (_lbSearch ? ' value="'+_lbEsc(_lbSearch)+'"' : '') + '>'
    +   '<button class="lb-search-clear" id="lbSearchClear" onclick="_lbClearSearch()" style="display:' + (_lbSearch?'block':'none') + '">✕</button>'
    + '</div>'
    + '<div class="meta-bar">'
    +   '<div class="meta-count" id="meta-count">Loading...</div>'
    +   '<button class="refresh-btn" onclick="_lbLoad(true)">↻ REFRESH</button>'
    + '</div>'
    + '<div id="lb-panel"><div class="lb-loading">// LOADING LEADERBOARD DATA...</div></div>'
    + '</div>';
}

async function _lbLoadTab(tab, force) {
  if (!force && _lbTabData[tab] && (Date.now() - _lbTabData[tab].ts) < LB_TTL) {
    _lbRender(); return;
  }
  var panel = document.getElementById('lb-panel');
  var mc    = document.getElementById('meta-count');
  if (panel) panel.innerHTML = '<div class="lb-loading">// LOADING ' + tab.toUpperCase() + '...</div>';
  if (mc)    mc.textContent  = 'Loading...';
  try {
    var res  = await fetch('/api/leaderboard?tab=' + encodeURIComponent(tab) + (force ? '&force=1' : ''));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var json = await res.json();
    _lbTabData[tab] = { rows: json.rows || [], ts: Date.now() };
    _lbRender();
  } catch(e) {
    if (panel) panel.innerHTML = '<div class="lb-empty"><div class="lb-empty-title">Failed to load</div><div class="lb-empty-sub">' + e.message + '</div></div>';
    if (mc)    mc.textContent  = '';
  }
}

function _lbLoad(force) { return _lbLoadTab(_lbTab, force); }

function _lbSwitchTab(tab, btn) {
  _lbTab = tab; _lbPage = 1;
  document.querySelectorAll('.lb-tab').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
  var sw = document.querySelector('.lb-search-wrap');
  if (tab === 'insights') {
    if (sw) sw.style.display = 'none';
    _lbRenderInsights();
  } else {
    if (sw) sw.style.display = '';
    _lbLoadTab(tab);
  }
}

function _lbRenderInsights() {
  var panel = document.getElementById('lb-panel');
  var mc    = document.getElementById('meta-count');
  var src   = _lbTabData['csrArena'] || _lbTabData['csrSlayer'] || _lbTabData['csrLegacy'] || _lbTabData['csrDoubles'];
  if (!src) {
    if (panel) panel.innerHTML = '<div class="lb-loading">// LOADING ARENA DATA...</div>';
    if (mc)    mc.textContent  = '';
    fetch('/api/leaderboard?tab=csrArena').then(function(r){ return r.json(); }).then(function(json){
      _lbTabData['csrArena'] = { rows: json.rows || [], ts: Date.now() };
      _lbRenderInsights();
    });
    return;
  }
  var rows = src.rows;
  _lbTierDiveRows = rows;
  if (mc) mc.textContent = rows.length.toLocaleString() + ' PLAYERS ANALYZED';

  var TIERS       = _LB_TIERS;
  var TIER_COLORS = _LB_TIER_COLORS;
  var stats = {};
  TIERS.forEach(function(t){ stats[t] = { count:0, kd:[], wr:[] }; });
  rows.forEach(function(p){
    var t = p.csr_tier;
    if (!t || !stats[t]) return;
    stats[t].count++;
    if (p.kd      != null) stats[t].kd.push(parseFloat(p.kd));
    if (p.win_rate != null) stats[t].wr.push(parseFloat(p.win_rate));
  });
  function _avg(arr){ return arr.length ? arr.reduce(function(a,b){return a+b},0)/arr.length : null; }
  var counts = TIERS.map(function(t){ return stats[t].count; });
  var avgKds = TIERS.map(function(t){ var a=_avg(stats[t].kd);  return a!=null?+a.toFixed(2):null; });
  var avgWrs = TIERS.map(function(t){ var a=_avg(stats[t].wr);  return a!=null?+a.toFixed(1):null; });
  var colors = TIERS.map(function(t){ return TIER_COLORS[t]; });
  var total  = counts.reduce(function(a,b){return a+b},0);

  var tableRows = TIERS.map(function(t,i){
    var pct = total>0?(stats[t].count/total*100).toFixed(1):'0.0';
    return '<tr style="border-bottom:1px solid var(--border)">'
      + '<td style="padding:7px 8px"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:'+TIER_COLORS[t]+';margin-right:6px;vertical-align:middle"></span>'
      +   '<span style="color:'+TIER_COLORS[t]+'">'+t.toUpperCase()+'</span></td>'
      + '<td style="text-align:right;padding:7px 8px;color:var(--text)">'+stats[t].count.toLocaleString()+'</td>'
      + '<td style="text-align:right;padding:7px 8px;color:var(--muted2)">'+pct+'%</td>'
      + '<td style="text-align:right;padding:7px 8px;color:var(--accent)">'+(avgKds[i]!=null?avgKds[i]:'—')+'</td>'
      + '<td style="text-align:right;padding:7px 8px;color:var(--win)">'+(avgWrs[i]!=null?avgWrs[i]+'%':'—')+'</td>'
      + '</tr>';
  }).join('');

  if (panel) panel.innerHTML =
    '<div style="font-family:Share Tech Mono,monospace;font-size:10px;color:var(--muted2);letter-spacing:1px;margin-bottom:20px">'
    +  '// COMMUNITY ANALYTICS · '+rows.length.toLocaleString()+' TRACKED PLAYERS · RANKED ARENA'
    +'</div>'
    +'<div style="display:grid;gap:16px">'
      +'<div class="chart-card">'
        +'<div class="chart-title">RANK DISTRIBUTION</div>'
        +'<div class="chart-sub">Player count per tier across tracked community</div>'
        +'<canvas id="lbChartDist" height="160"></canvas>'
      +'</div>'
      +'<div class="chart-grid">'
        +'<div class="chart-card">'
          +'<div class="chart-title">AVG K/D BY TIER</div>'
          +'<div class="chart-sub">Kill / death ratio per rank tier</div>'
          +'<canvas id="lbChartKd" height="200"></canvas>'
        +'</div>'
        +'<div class="chart-card">'
          +'<div class="chart-title">AVG WIN RATE BY TIER</div>'
          +'<div class="chart-sub">Win percentage per rank tier</div>'
          +'<canvas id="lbChartWr" height="200"></canvas>'
        +'</div>'
      +'</div>'
      +'<div class="chart-card">'
        +'<div class="chart-title">TIER BREAKDOWN</div>'
        +'<table style="width:100%;border-collapse:collapse;font-family:Share Tech Mono,monospace;font-size:11px">'
          +'<thead><tr style="border-bottom:1px solid var(--border2)">'
            +'<th style="text-align:left;padding:6px 8px;color:var(--muted2);font-size:9px;letter-spacing:1px">TIER</th>'
            +'<th style="text-align:right;padding:6px 8px;color:var(--muted2);font-size:9px;letter-spacing:1px">PLAYERS</th>'
            +'<th style="text-align:right;padding:6px 8px;color:var(--muted2);font-size:9px;letter-spacing:1px">SHARE</th>'
            +'<th style="text-align:right;padding:6px 8px;color:var(--muted2);font-size:9px;letter-spacing:1px">AVG K/D</th>'
            +'<th style="text-align:right;padding:6px 8px;color:var(--muted2);font-size:9px;letter-spacing:1px">AVG WIN%</th>'
          +'</tr></thead>'
          +'<tbody>'+tableRows+'</tbody>'
        +'</table>'
      +'</div>'
      +'<div class="chart-card">'
        +'<div class="chart-title">TIER DEEP DIVE</div>'
        +'<div class="chart-sub">Select a tier to see subtier distribution, performance averages, and individual player scatter</div>'
        +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px" id="lbTierDiveSel">'
        + TIERS.map(function(t){
            return '<button class="lb-tdive-btn" data-tier="'+t+'" onclick="_lbSwitchTierDive(\''+t+'\')"'
              +' style="font-family:Share Tech Mono,monospace;font-size:10px;letter-spacing:1px;cursor:pointer;padding:4px 12px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--muted);transition:all .15s">'
              +t.toUpperCase()+'</button>';
          }).join('')
        +'</div>'
        +'<div id="lbTierDiveContent"></div>'
      +'</div>'
    +'</div>';

  function _lbBuildCharts() {
    var gridColor = 'rgba(56,138,221,0.07)';
    var tickColor = 'rgba(133,183,235,0.55)';
    var baseScales = {
      x:{ grid:{color:gridColor}, ticks:{color:tickColor,font:{family:'Share Tech Mono',size:10}} },
      y:{ grid:{color:gridColor}, ticks:{color:tickColor,font:{family:'Share Tech Mono',size:10}}, beginAtZero:true }
    };
    var baseOpts = {
      responsive:true, animation:{duration:600},
      plugins:{ legend:{display:false}, tooltip:{bodyFont:{family:'Share Tech Mono'},titleFont:{family:'Share Tech Mono'}} },
      scales:baseScales
    };
    new window.Chart(document.getElementById('lbChartDist'), {
      type:'bar',
      data:{labels:TIERS,datasets:[{data:counts,backgroundColor:colors.map(function(c){return c+'30';}),borderColor:colors,borderWidth:2,borderRadius:5}]},
      options:Object.assign({},baseOpts,{plugins:Object.assign({},baseOpts.plugins,{tooltip:{callbacks:{label:function(ctx){var p=total>0?(ctx.raw/total*100).toFixed(1):0;return ' '+ctx.raw.toLocaleString()+' players ('+p+'%)';}}}})})
    });
    new window.Chart(document.getElementById('lbChartKd'), {
      type:'bar',
      data:{labels:TIERS,datasets:[{data:avgKds,backgroundColor:colors.map(function(c){return c+'30';}),borderColor:colors,borderWidth:2,borderRadius:5}]},
      options:Object.assign({},baseOpts,{plugins:Object.assign({},baseOpts.plugins,{tooltip:{callbacks:{label:function(ctx){return ' '+ctx.raw+' K/D';}}}}),scales:Object.assign({},baseScales,{y:Object.assign({},baseScales.y,{min:0})})})
    });
    new window.Chart(document.getElementById('lbChartWr'), {
      type:'bar',
      data:{labels:TIERS,datasets:[{data:avgWrs,backgroundColor:colors.map(function(c){return c+'30';}),borderColor:colors,borderWidth:2,borderRadius:5}]},
      options:Object.assign({},baseOpts,{plugins:Object.assign({},baseOpts.plugins,{tooltip:{callbacks:{label:function(ctx){return ' '+ctx.raw+'%';}}}}),scales:Object.assign({},baseScales,{y:Object.assign({},baseScales.y,{min:0,suggestedMax:80})})})
    });
  }

  function _lbDoAllCharts() { _lbBuildCharts(); _lbBuildTierDive('Diamond'); }
  if (window.Chart) {
    _lbDoAllCharts();
  } else {
    var _s = document.createElement('script');
    _s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
    _s.onload = _lbDoAllCharts;
    document.head.appendChild(_s);
  }
}

function _lbSwitchTierDive(tier) { _lbBuildTierDive(tier); }

function _lbBuildTierDive(tier) {
  _lbTierDiveCharts.forEach(function(c){ try{ c.destroy(); }catch(e){} });
  _lbTierDiveCharts = [];

  document.querySelectorAll('.lb-tdive-btn').forEach(function(b){
    var on = b.dataset.tier === tier;
    var tc = _LB_TIER_COLORS[b.dataset.tier] || 'var(--accent)';
    b.style.borderColor = on ? tc : 'var(--border)';
    b.style.color       = on ? tc : 'var(--muted)';
    b.style.background  = on ? tc+'18' : 'transparent';
  });

  var container = document.getElementById('lbTierDiveContent');
  if (!container) return;

  var tierRows = _lbTierDiveRows.filter(function(p){ return p.csr_tier === tier; });
  if (!tierRows.length) {
    container.innerHTML = '<div style="text-align:center;padding:32px;font-family:Share Tech Mono,monospace;font-size:10px;color:var(--muted2)">No '+tier+' players in dataset yet</div>';
    return;
  }

  var baseColor = _LB_TIER_COLORS[tier];
  var rr = parseInt(baseColor.slice(1,3),16);
  var gg = parseInt(baseColor.slice(3,5),16);
  var bb = parseInt(baseColor.slice(5,7),16);
  function rgba(a){ return 'rgba('+rr+','+gg+','+bb+','+a+')'; }

  var isOnyx = tier === 'Onyx';
  var subtiers;

  if (isOnyx) {
    var csrVals = tierRows.map(function(p){ return parseFloat(p.csr_value); }).filter(function(v){ return !isNaN(v); });
    if (csrVals.length) {
      var bMin = Math.floor(Math.min.apply(null, csrVals) / 100) * 100;
      var bMax = Math.floor(Math.max.apply(null, csrVals) / 100) * 100;
      subtiers = [];
      for (var bk = bMin; bk <= bMax; bk += 100) subtiers.push(bk);
    } else {
      subtiers = [1500];
    }
  } else {
    subtiers = [1,2,3,4,5,6];
  }

  var groups = {};
  subtiers.forEach(function(s){ groups[String(s)] = { count:0, kd:[], wr:[], acc:[], pts:[] }; });

  tierRows.forEach(function(p){
    var key;
    if (isOnyx) {
      var cv = parseFloat(p.csr_value);
      key = String(isNaN(cv) ? subtiers[0] : Math.floor(cv / 100) * 100);
    } else {
      key = String(p.csr_subtier != null ? p.csr_subtier : 1);
    }
    if (!groups[key]) return;
    groups[key].count++;
    if (p.kd != null) {
      var kv = parseFloat(p.kd);
      groups[key].kd.push(kv);
      if (p.csr_value != null) groups[key].pts.push({ x:parseFloat(p.csr_value), y:kv, gt:p.gamertag, wr:p.win_rate!=null?parseFloat(p.win_rate).toFixed(1):'—' });
    }
    if (p.win_rate != null) groups[key].wr.push(parseFloat(p.win_rate));
    if (p.accuracy != null) groups[key].acc.push(parseFloat(p.accuracy));
  });

  function _lbAvg(arr){ return arr.length?arr.reduce(function(a,b){return a+b},0)/arr.length:null; }
  function subA(i){ return 0.35+(i/Math.max(subtiers.length-1,1))*0.65; }

  var labels   = subtiers.map(function(s){ return isOnyx ? s.toString() : 'S'+s; });
  var counts   = subtiers.map(function(s){ return groups[String(s)].count; });
  var avgKds   = subtiers.map(function(s){ var a=_lbAvg(groups[String(s)].kd);  return a!=null?+a.toFixed(2):null; });
  var avgWrs   = subtiers.map(function(s){ var a=_lbAvg(groups[String(s)].wr);  return a!=null?+a.toFixed(1):null; });
  var avgAccs  = subtiers.map(function(s){ var a=_lbAvg(groups[String(s)].acc); return a!=null?+a.toFixed(1):null; });
  var hasAcc   = avgAccs.some(function(v){ return v != null; });
  var barBg    = subtiers.map(function(s,i){ return rgba(subA(i)); });
  var barBord  = subtiers.map(function(s,i){ return rgba(Math.min(subA(i)+0.2,1)); });

  var accCell  = hasAcc
    ? '<div><div class="chart-sub" style="margin-bottom:6px">AVG ACCURACY PER '+(isOnyx?'CSR RANGE':'SUBTIER')+'</div><canvas id="lbDivAcc" height="180"></canvas></div>'
    : '<div><div class="chart-sub" style="margin-bottom:6px">AVG ACCURACY PER '+(isOnyx?'CSR RANGE':'SUBTIER')+'</div><div style="display:flex;align-items:center;justify-content:center;height:140px;font-family:Share Tech Mono,monospace;font-size:10px;color:var(--muted2)">Not enough data yet</div></div>';

  container.innerHTML =
     '<div class="chart-grid" style="margin-bottom:16px">'
    +  '<div><div class="chart-sub" style="margin-bottom:6px">PLAYERS PER '+(isOnyx?'CSR RANGE':'SUBTIER')+'</div><canvas id="lbDivCount" height="180"></canvas></div>'
    +  '<div><div class="chart-sub" style="margin-bottom:6px">AVG K/D PER '+(isOnyx?'CSR RANGE':'SUBTIER')+'</div><canvas id="lbDivKd" height="180"></canvas></div>'
    +'</div>'
    +'<div class="chart-grid" style="margin-bottom:16px">'
    +  '<div><div class="chart-sub" style="margin-bottom:6px">AVG WIN RATE PER '+(isOnyx?'CSR RANGE':'SUBTIER')+'</div><canvas id="lbDivWr" height="180"></canvas></div>'
    +  accCell
    +'</div>'
    +'<div class="chart-sub" style="margin-bottom:6px">CSR vs K/D — each dot is a player'+(isOnyx?' · colored by CSR range':' · colored by subtier')+'</div>'
    +'<canvas id="lbDivScatter" height="260"></canvas>';

  var gc  = 'rgba(56,138,221,0.07)';
  var tc  = 'rgba(133,183,235,0.55)';
  var ttF = { bodyFont:{family:'Share Tech Mono'}, titleFont:{family:'Share Tech Mono'} };
  var sX  = { grid:{color:gc}, ticks:{color:tc,font:{family:'Share Tech Mono',size:10}} };
  var sY  = { grid:{color:gc}, ticks:{color:tc,font:{family:'Share Tech Mono',size:10}}, beginAtZero:true, min:0 };

  function mkBar(id, data, cbLabel) {
    var el = document.getElementById(id); if (!el) return;
    _lbTierDiveCharts.push(new window.Chart(el, {
      type:'bar',
      data:{ labels:labels, datasets:[{ data:data, backgroundColor:barBg, borderColor:barBord, borderWidth:2, borderRadius:4 }] },
      options:{ responsive:true, animation:{duration:400}, plugins:{ legend:{display:false}, tooltip:Object.assign({callbacks:{label:cbLabel}},ttF) }, scales:{x:sX,y:sY} }
    }));
  }

  mkBar('lbDivCount', counts, function(ctx){ return ' '+ctx.raw+' players'; });
  mkBar('lbDivKd',    avgKds, function(ctx){ return ' '+ctx.raw+' K/D'; });
  mkBar('lbDivWr',    avgWrs, function(ctx){ return ' '+ctx.raw+'% win rate'; });
  if (hasAcc) mkBar('lbDivAcc', avgAccs, function(ctx){ return ' '+ctx.raw+'% accuracy'; });

  var _sBg = ['rgba(255,100,100,0.55)','rgba(255,165,50,0.55)','rgba(255,215,0,0.55)','rgba(80,220,120,0.55)','rgba(80,180,255,0.55)','rgba(180,100,255,0.55)'];
  var _sBd = ['rgba(255,100,100,0.9)', 'rgba(255,165,50,0.9)', 'rgba(255,215,0,0.9)', 'rgba(80,220,120,0.9)', 'rgba(80,180,255,0.9)', 'rgba(180,100,255,0.9)'];
  var scatterDS = subtiers.map(function(s,i){
    var lbl = isOnyx ? 'Onyx '+s : 'Sub '+s;
    var bg  = isOnyx ? rgba(subA(i) * 0.6) : (_sBg[i] || rgba(0.45));
    var bd  = isOnyx ? rgba(subA(i))        : (_sBd[i] || rgba(0.75));
    return { label:lbl, data:groups[String(s)].pts, backgroundColor:bg, borderColor:bd, borderWidth:1, pointRadius:4, pointHoverRadius:7 };
  });
  var scEl = document.getElementById('lbDivScatter'); if (!scEl) return;
  _lbTierDiveCharts.push(new window.Chart(scEl, {
    type:'scatter',
    data:{ datasets:scatterDS },
    options:{
      responsive:true, animation:{duration:400},
      plugins:{
        legend:{ display: subtiers.length > 1, labels:{color:'rgba(133,183,235,0.7)',font:{family:'Share Tech Mono',size:10}} },
        tooltip:Object.assign({ callbacks:{ label:function(ctx){ var p=ctx.raw; return [p.gt, p.y.toFixed(2)+' K/D  ·  '+p.wr+'% WR']; } } }, ttF)
      },
      scales:{
        x:Object.assign({},sX,{ title:{ display:true, text:'CSR', color:tc, font:{family:'Share Tech Mono',size:10} } }),
        y:Object.assign({},sY,{ title:{ display:true, text:'K/D', color:tc, font:{family:'Share Tech Mono',size:10} } })
      }
    }
  }));
}

function _lbOnSearch(val) {
  _lbSearch = val.trim().toLowerCase();
  _lbPage = 1;
  var clr = document.getElementById('lbSearchClear');
  if (clr) clr.style.display = _lbSearch ? 'block' : 'none';
  _lbRender();
}

function _lbClearSearch() {
  var inp = document.getElementById('lbSearch');
  if (inp) inp.value = '';
  _lbOnSearch('');
}

function _lbGoPage(p) {
  _lbPage = p;
  _lbRender();
  var cc = document.querySelector('.cmd-content');
  if (cc) { cc.scrollTop = 0; } else { window.scrollTo(0, 0); }
}

function _lbRender() {
  if (!_lbTabData[_lbTab]) return;
  var allRows = _lbTabData[_lbTab].rows || [];
  var panel   = document.getElementById('lb-panel');
  var mc      = document.getElementById('meta-count');
  if (!panel) return;

  var filtered = _lbSearch
    ? allRows.filter(function(p){ return p.gamertag.toLowerCase().indexOf(_lbSearch) !== -1; })
    : allRows;

  if (!filtered.length) {
    panel.innerHTML = allRows.length
      ? '<div class="lb-empty"><div class="lb-empty-title">No match</div><div class="lb-empty-sub">No players found for "' + _lbEsc(_lbSearch) + '"</div></div>'
      : '<div class="lb-empty"><div class="lb-empty-title">No data yet</div><div class="lb-empty-sub">Search players on fragr to populate the leaderboard</div></div>';
    if (mc) mc.textContent = '0 PLAYERS';
    return;
  }

  var totalPages = Math.max(1, Math.ceil(filtered.length / LB_PER_PAGE));
  _lbPage = Math.min(_lbPage, totalPages);
  var start    = (_lbPage - 1) * LB_PER_PAGE;
  var pageRows = filtered.slice(start, start + LB_PER_PAGE);

  if (mc) mc.textContent = _lbSearch
    ? filtered.length + ' MATCH' + (filtered.length !== 1 ? 'ES' : '') + ' · ' + allRows.length + ' TOTAL'
    : allRows.length + ' PLAYERS';

  var html = '<table class="lb-table"><thead><tr>'
    + '<th style="width:40px">#</th><th>GAMERTAG</th>'
    + '<th class="right hide-mobile">RANK</th><th class="right">CSR</th>'
    + '<th class="right">K/D</th><th class="right">WIN %</th>'
    + '<th class="right hide-mobile">MATCHES</th>'
    + '</tr></thead><tbody>';

  function tierShort(tier, sub) {
    if (!tier) return '';
    if (tier === 'Onyx') return 'Onyx';
    return (tier[0] || '?').toUpperCase() + (sub != null ? sub : '');
  }

  pageRows.forEach(function(p) {
    var pos       = allRows.indexOf(p) + 1;
    var rankClass = pos <= 3 && !_lbSearch ? ' top3 rank-' + pos : '';
    var medal     = !_lbSearch && pos <= 3
      ? (pos===1
          ? '<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:rgba(255,215,0,0.18);color:#FFD700;font-weight:700;font-size:11px;font-family:Share Tech Mono,monospace">1</span>'
          : pos===2
          ? '<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:rgba(192,192,192,0.18);color:#C0C0C0;font-weight:700;font-size:11px;font-family:Share Tech Mono,monospace">2</span>'
          : '<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:rgba(205,127,50,0.18);color:#CD7F32;font-weight:700;font-size:11px;font-family:Share Tech Mono,monospace">3</span>')
      : pos;
    var tier       = p.csr_tier || '';
    var tierBadge  = tier
      ? '<span class="tier-badge tier-' + tier + '">' + tier.toUpperCase() + (p.csr_subtier ? ' ' + p.csr_subtier : '') + '</span>'
      : '<span class="tier-badge">—</span>';
    var tierMobile = tier
      ? '<span class="tier-badge tier-' + tier + '">' + tierShort(tier, p.csr_subtier) + '</span>'
      : '';
    var matches = p.matches_played != null ? Number(p.matches_played).toLocaleString() : '—';
    var safeGt  = p.gamertag.replace(/\\/g,'\\\\').replace(/'/g,"\\'");

    html += '<tr class="' + rankClass + '">';
    html += '<td class="rank-num">' + medal + '</td>';
    html += '<td><div class="lb-mobile-gt-cell">'
          +   '<a class="gt-link" href="#" onclick="event.preventDefault();doSearch(\'' + safeGt + '\')">' + _lbEsc(p.gamertag) + '</a>'
          +   (tierMobile ? '<div class="lb-mobile-tier-row">' + tierMobile + '<span>' + matches + ' M</span></div>' : '')
          + '</div></td>';
    html += '<td class="hide-mobile" style="text-align:right">' + tierBadge + '</td>';
    html += '<td class="stat-val stat-csr">'    + (p.csr_value  || '—') + '</td>';
    html += '<td class="stat-val stat-kd">'     + (p.kd      != null ? Number(p.kd).toFixed(2)       : '—') + '</td>';
    html += '<td class="stat-val stat-wr">'     + (p.win_rate != null ? Number(p.win_rate).toFixed(1)+'%' : '—') + '</td>';
    html += '<td class="stat-val stat-muted hide-mobile">' + matches + '</td>';
    html += '</tr>';
  });

  html += '</tbody></table>';

  if (totalPages > 1) {
    html += '<div class="lb-pagination">';
    html += '<button class="pg-btn" onclick="_lbGoPage(' + (_lbPage-1) + ')"' + (_lbPage<=1?' disabled':'') + '>‹</button>';
    var pStart = Math.max(1, _lbPage-3), pEnd = Math.min(totalPages, pStart+6);
    pStart = Math.max(1, pEnd-6);
    if (pStart > 1) html += '<button class="pg-btn" onclick="_lbGoPage(1)">1</button>' + (pStart>2?'<span style="color:var(--muted2);padding:0 4px;font-size:10px;font-family:Share Tech Mono,monospace">…</span>':'');
    for (var pi=pStart; pi<=pEnd; pi++)
      html += '<button class="pg-btn'+(pi===_lbPage?' active':'')+'" onclick="_lbGoPage('+pi+')">'+pi+'</button>';
    if (pEnd < totalPages) html += (pEnd<totalPages-1?'<span style="color:var(--muted2);padding:0 4px;font-size:10px;font-family:Share Tech Mono,monospace">…</span>':'') + '<button class="pg-btn" onclick="_lbGoPage('+totalPages+')">'+totalPages+'</button>';
    html += '<button class="pg-btn" onclick="_lbGoPage('+(_lbPage+1)+')"'+(_lbPage>=totalPages?' disabled':'')+'>›</button>';
    html += '<span style="color:var(--muted2);font-family:Share Tech Mono,monospace;font-size:10px;margin-left:8px">Page '+_lbPage+' of '+totalPages+'</span>';
    html += '</div>';
  }

  panel.innerHTML = html;
}

function _lbEsc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
