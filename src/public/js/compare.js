// ── Player Compare ────────────────────────────────────────────────────────────
var _compareData = null;
var _compareMe   = null; // locked at open-time so globals changing later can't corrupt it

// Returns the active compare panel — tab panel when on compare tab, overlay otherwise
function _getCmpPanel() {
  var tabPanel = document.getElementById('cmpTabPanel');
  if (tabPanel && tabPanel.closest('.tab-panel.active')) return tabPanel;
  return document.getElementById('compareOverlay');
}

// Initialise compare in the tab (called by setTab('compare'))
function _initCompareTab() {
  var p = getAllPlayers()[selectedPlayer] || (data && data.players && data.players[0]);
  if (!p) return;
  _compareMe = p;
  _compareData = null;
  _renderCompareSearch();
}

function openCompare() {
  var p = getAllPlayers()[selectedPlayer] || (data && data.players && data.players[0]);
  if (!p) return;
  _compareMe   = p;
  _compareData = null;
  var overlay = document.getElementById('compareOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  _renderCompareSearch();
  setTimeout(function() { var i = document.getElementById('cmpInput'); if (i) i.focus(); }, 80);
}

function closeCompare() {
  var overlay = document.getElementById('compareOverlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
}

function _renderCompareSearch() {
  var panel = _getCmpPanel();
  if (!panel) return;
  var me = _compareMe;
  if (!me) return;
  var myCsr = _topCsr(me);
  var ini = (me.gamertag || '??').slice(0, 2).toUpperCase();

  panel.innerHTML =
    '<div style="max-width:500px;width:100%;margin:0 auto">'
    + '<div style="background:var(--surface);border:1px solid rgba(0,212,255,0.25);border-radius:10px;padding:14px 16px;margin-bottom:20px;display:flex;align-items:center;gap:12px">'
    + (me.emblemUrl ? '<img src="' + me.emblemUrl + '" style="width:42px;height:42px;object-fit:contain;flex-shrink:0">'
        : '<div style="width:42px;height:42px;background:var(--surface3);border-radius:6px;display:flex;align-items:center;justify-content:center;font-family:Rajdhani,sans-serif;font-size:15px;font-weight:700;color:var(--accent);flex-shrink:0">' + ini + '</div>')
    + '<div style="flex:1;min-width:0">'
    + '<div style="font-family:Rajdhani,sans-serif;font-size:18px;font-weight:700;color:var(--accent);letter-spacing:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + me.gamertag + '</div>'
    + '<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;margin-top:2px">'
    + (myCsr ? myCsr.tier + ' · ' : '') + (me.stats ? 'K/D ' + me.stats.kd : '') + '</div>'
    + '</div>'
    + '<div style="font-size:9px;color:var(--accent);font-family:Share Tech Mono,monospace;letter-spacing:1px;background:rgba(0,212,255,0.08);padding:3px 8px;border-radius:3px;border:1px solid rgba(0,212,255,0.2);flex-shrink:0">YOU</div>'
    + '</div>'
    + '<div style="text-align:center;margin-bottom:18px">'
    + '<span style="font-family:Rajdhani,sans-serif;font-size:32px;font-weight:700;color:var(--muted2);letter-spacing:5px">VS</span>'
    + '</div>'
    + '<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px">Search opponent gamertag</div>'
    + '<div style="display:flex;gap:8px;position:relative">'
    + '<div style="position:relative;flex:1">'
    + '<input id="cmpInput" class="search-input" style="width:100%;font-size:14px;padding:10px 14px;height:44px;box-sizing:border-box" placeholder="Enter gamertag..." autocomplete="off"'
    + ' onkeydown="if(event.key===\'Enter\')_doFetchCompare();handleSuggestKey(event,\'cmpSuggest\')"'
    + ' oninput="debounceSuggest(this.value,\'cmpSuggest\',\'cmpInput\')">'
    + '<div class="suggest-dropdown" id="cmpSuggest"></div>'
    + '</div>'
    + '<button onclick="_doFetchCompare()" style="background:var(--accent);border:none;color:#000;padding:0 20px;border-radius:4px;font-family:Share Tech Mono,monospace;font-size:11px;cursor:pointer;font-weight:700;height:44px;white-space:nowrap;flex-shrink:0;letter-spacing:1px">COMPARE</button>'
    + '</div>'
    + '</div>';
}

async function _doFetchCompare() {
  var inp = document.getElementById('cmpInput');
  if (!inp) return;
  var gt = inp.value.trim();
  if (!gt) return;
  var panel = _getCmpPanel();
  if (!panel) return;

  panel.innerHTML =
    '<div style="text-align:center;padding:60px 20px">'
    + '<div style="font-family:Rajdhani,sans-serif;font-size:13px;color:var(--muted);letter-spacing:2px;text-transform:uppercase;margin-bottom:12px">Loading ' + gt + '</div>'
    + '<div style="display:flex;justify-content:center;gap:5px">'
    + '<div style="width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulse 1.2s ease-in-out infinite"></div>'
    + '<div style="width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulse 1.2s ease-in-out 0.2s infinite"></div>'
    + '<div style="width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulse 1.2s ease-in-out 0.4s infinite"></div>'
    + '</div></div>';

  try {
    var r = await fetch('/api/search?gamertag=' + encodeURIComponent(gt) + '&statsOnly=1');
    var d = await r.json();
    if (!d.success || !d.player) {
      panel.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--loss);font-family:Share Tech Mono,monospace;font-size:12px">' + (d.error || 'Player not found') + '</div>';
      return;
    }
    _compareData = d.player;
    _renderComparison();
    // Background full fetch for match data (maps, modes, trajectory)
    fetch('/api/search?gamertag=' + encodeURIComponent(gt))
      .then(function(r2) { return r2.json(); })
      .then(function(d2) { if (d2.success && d2.player) { _compareData = d2.player; _renderComparison(); } })
      .catch(function() {});
  } catch (e) {
    panel.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--loss);font-family:Share Tech Mono,monospace;font-size:12px">Fetch failed: ' + e.message + '</div>';
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _topCsr(p) {
  if (!p || !p.csr) return null;
  var cv = Object.values(p.csr);
  return cv.length ? cv.sort(function(a, b) { return b.value - a.value; })[0] : null;
}

function _recentKD(matches, n) {
  var r = (matches || []).filter(function(m) { return m.kills != null && m.deaths != null; }).slice(0, n);
  if (!r.length) return null;
  var k = r.reduce(function(a, m) { return a + (m.kills || 0); }, 0);
  var d = r.reduce(function(a, m) { return a + (m.deaths || 0); }, 0);
  return d > 0 ? k / d : k > 0 ? k : null;
}

function _recentWR(matches, n) {
  var r = (matches || []).filter(function(m) { return m.outcome === 2 || m.outcome === 3; }).slice(0, n);
  if (!r.length) return null;
  return r.filter(function(m) { return m.outcome === 2; }).length / r.length * 100;
}

// Map stats dict keyed by mapName: {map, games, wr, kd}
function _mapStatsDict(matches) {
  var byMap = {};
  (matches || []).forEach(function(m) {
    if (!m.mapName || (m.outcome !== 2 && m.outcome !== 3)) return;
    var k = m.mapName;
    if (!byMap[k]) byMap[k] = { map: k, wins: 0, losses: 0, kills: 0, deaths: 0 };
    if (m.outcome === 2) byMap[k].wins++; else byMap[k].losses++;
    byMap[k].kills  += m.kills  || 0;
    byMap[k].deaths += m.deaths || 0;
  });
  var out = {};
  Object.keys(byMap).forEach(function(k) {
    var e = byMap[k], total = e.wins + e.losses;
    out[k] = { map: k, games: total, wr: Math.round(e.wins / total * 100),
               kd: e.deaths > 0 ? e.kills / e.deaths : e.kills > 0 ? e.kills : 0 };
  });
  return out;
}

// Shared maps between two players, sorted by combined game count, min 3g each
function _sharedMaps(myDict, theirDict, n) {
  var shared = Object.keys(myDict).filter(function(k) {
    return theirDict[k] && myDict[k].games >= 3 && theirDict[k].games >= 3;
  });
  shared.sort(function(a, b) {
    return (myDict[b].games + theirDict[b].games) - (myDict[a].games + theirDict[a].games);
  });
  return shared.slice(0, n);
}

// Per-mode stats: [{mode, label, icon, wr, games, objKey, objAvg}]
function _modeStats(matches) {
  var MODES = [
    { key: 'Slayer',           re: /slayer/i,          obj: null },
    { key: 'Oddball',          re: /oddball/i,         obj: 'timeAsCarrier',  objLabel: 'avg carry' },
    { key: 'CTF',              re: /ctf|flag/i,        obj: 'flagCaptures',   objLabel: 'caps' },
    { key: 'Strongholds',      re: /stronghold/i,      obj: 'captures',       objLabel: 'caps' },
    { key: 'King of the Hill', re: /king.*hill|koth/i, obj: 'occupationTime', objLabel: 'hill time' },
    { key: 'Land Grab',        re: /land.*grab/i,      obj: 'captures',       objLabel: 'caps' },
    { key: 'Stockpile',        re: /stockpile/i,       obj: 'seedsDeposited', objLabel: 'seeds' },
  ];
  var buckets = {};
  MODES.forEach(function(md) { buckets[md.key] = { w: 0, l: 0, objSum: 0, objCount: 0, def: md }; });

  (matches || []).forEach(function(m) {
    if (!m.gameMode || (m.outcome !== 2 && m.outcome !== 3)) return;
    var matched = null;
    for (var i = 0; i < MODES.length; i++) {
      if (MODES[i].re.test(m.gameMode)) { matched = MODES[i].key; break; }
    }
    if (!matched) return;
    var b = buckets[matched];
    if (m.outcome === 2) b.w++; else b.l++;
    if (b.def.obj && m.objStats && m.objStats[b.def.obj] != null) {
      var val = m.objStats[b.def.obj];
      // Convert seconds to minutes for time fields
      if (b.def.obj === 'timeAsCarrier' || b.def.obj === 'occupationTime') val = val / 60;
      b.objSum += val; b.objCount++;
    }
  });

  return MODES.map(function(md) {
    var b = buckets[md.key];
    var total = b.w + b.l;
    if (total < 3) return null;
    return {
      mode:     md.key,
      wr:       Math.round(b.w / total * 100),
      games:    total,
      objLabel: md.objLabel || null,
      objAvg:   b.objCount >= 3 ? b.objSum / b.objCount : null
    };
  }).filter(Boolean);
}

// Objective contribution score per game
// Recent accuracy (avg over last N games that have accuracy data)
function _recentAcc(matches, n) {
  var r = (matches || []).filter(function(m) { return m.accuracy != null; }).slice(0, n);
  if (r.length < 3) return null;
  return r.reduce(function(a, m) { return a + parseFloat(m.accuracy); }, 0) / r.length;
}

// Recent assists per game
function _recentAst(matches, n) {
  var r = (matches || []).filter(function(m) { return m.assists != null && (m.outcome === 2 || m.outcome === 3); }).slice(0, n);
  if (r.length < 3) return null;
  return r.reduce(function(a, m) { return a + (m.assists || 0); }, 0) / r.length;
}

// Recent damage ratio
function _recentDmgRatio(matches, n) {
  var r = (matches || []).filter(function(m) { return m.damageDealt > 300 && m.damageTaken > 300; }).slice(0, n);
  if (r.length < 3) return null;
  var dealt = r.reduce(function(a, m) { return a + m.damageDealt; }, 0);
  var taken = r.reduce(function(a, m) { return a + m.damageTaken; }, 0);
  return taken > 0 ? dealt / taken : null;
}

// Rich objective breakdown: {score, assists, flagCaps, flagGrabs, flagReturns, captures, secures, carryMins, seeds, objGames, totalGames}
function _objBreakdown(matches) {
  var all = (matches || []).filter(function(m) { return m.outcome === 2 || m.outcome === 3; });
  if (!all.length) return null;
  var objGames = all.filter(function(m) { return m.objStats; });
  var out = { totalGames: all.length, objGames: objGames.length, score: 0,
              assists: 0, assistGames: 0,
              flagCaps: 0, flagGrabs: 0, flagReturns: 0,
              captures: 0, secures: 0, carryMins: 0, seeds: 0 };
  all.forEach(function(m) {
    if (m.assists != null) { out.assists += m.assists || 0; out.assistGames++; }
  });
  objGames.forEach(function(m) {
    var o = m.objStats || {};
    out.flagCaps    += o.flagCaptures     || 0;
    out.flagGrabs   += o.flagGrabs        || 0;
    out.flagReturns += o.flagReturns      || 0;
    out.captures    += o.captures         || 0;
    out.secures     += o.secures          || 0;
    out.carryMins   += (o.timeAsCarrier   || 0) / 60;
    out.seeds       += o.seedsDeposited   || 0;
    out.score += (o.flagCaptures || 0) * 4 + (o.captures || 0) * 2
              + (o.flagGrabs || 0) * 0.5 + (o.flagReturns || 0) * 0.5
              + (o.secures || 0) * 0.5   + (o.seedsDeposited || 0) * 0.3
              + Math.min((o.timeAsCarrier || 0) / 60, 3);
  });
  out.scorePG      = objGames.length  ? out.score      / objGames.length  : 0;
  out.assistsPG    = out.assistGames  ? out.assists     / out.assistGames  : 0;
  out.flagCapsPG   = objGames.length  ? out.flagCaps    / objGames.length  : 0;
  out.flagGrabsPG  = objGames.length  ? out.flagGrabs   / objGames.length  : 0;
  out.flagRetPG    = objGames.length  ? out.flagReturns / objGames.length  : 0;
  out.capturesPG   = objGames.length  ? out.captures    / objGames.length  : 0;
  out.securesPG    = objGames.length  ? out.secures     / objGames.length  : 0;
  out.carryPG      = objGames.length  ? out.carryMins   / objGames.length  : 0;
  out.seedsPG      = objGames.length  ? out.seeds       / objGames.length  : 0;
  return out;
}

// ── Main render ───────────────────────────────────────────────────────────────

function _renderComparison() {
  var panel = _getCmpPanel();
  if (!panel || !_compareData) return;

  var me   = _compareMe;
  var them = _compareData;
  if (!me) return;

  var ms = me.stats   || {};
  var ts = them.stats || {};
  var myCsr    = _topCsr(me);
  var theirCsr = _topCsr(them);
  var isMobile = window.innerWidth < 600;

  var myMatches    = fullMatchCache[me.gamertag]    || me.allMatches    || me.recentMatches    || [];
  var theirMatches = fullMatchCache[them.gamertag]  || them.allMatches  || them.recentMatches  || [];

  var myKD      = parseFloat(ms.kd)       || 0;
  var theirKD   = parseFloat(ts.kd)       || 0;
  var myWR      = parseFloat(ms.winRate)  || 0;
  var theirWR   = parseFloat(ts.winRate)  || 0;
  var myAcc     = parseFloat(ms.accuracy) || 0;
  var theirAcc  = parseFloat(ts.accuracy) || 0;
  var myKDA     = parseFloat(ms.kda)      || 0;
  var theirKDA  = parseFloat(ts.kda)      || 0;
  var myCsrV    = myCsr    ? myCsr.value    : 0;
  var theirCsrV = theirCsr ? theirCsr.value : 0;
  var myRKD     = _recentKD(myMatches, 20);
  var theirRKD  = _recentKD(theirMatches, 20);
  var myRWR     = _recentWR(myMatches, 20);
  var theirRWR  = _recentWR(theirMatches, 20);
  var myTrend   = (myRKD   && myKD)   ? myRKD   - myKD   : null;
  var theirTrend = (theirRKD && theirKD) ? theirRKD - theirKD : null;
  var myObj      = _objBreakdown(myMatches);
  var theirObj   = _objBreakdown(theirMatches);
  var myMapDict  = _mapStatsDict(myMatches);
  var thMapDict  = _mapStatsDict(theirMatches);
  var sharedMaps = _sharedMaps(myMapDict, thMapDict, 6);
  var myModes    = _modeStats(myMatches);
  var theirModes = _modeStats(theirMatches);

  // Core stat categories
  var cats = [];
  function addCat(lbl, myV, thV, fmt) {
    if (myV > 0 && thV > 0) cats.push({ lbl: lbl, myV: myV, thV: thV, fmt: fmt });
  }
  addCat('K/D Ratio',        myKD,     theirKD,   function(v) { return v.toFixed(2); });
  addCat('Win Rate',         myWR,     theirWR,   function(v) { return v.toFixed(1) + '%'; });
  addCat('Accuracy',         myAcc,    theirAcc,  function(v) { return v.toFixed(1) + '%'; });
  addCat('KDA',              myKDA,    theirKDA,  function(v) { return v.toFixed(2); });
  if (myCsrV && theirCsrV)  addCat('CSR',         myCsrV,   theirCsrV, function(v) { return Math.round(v) + ''; });
  if (myRKD  && theirRKD)   addCat('Recent K/D',  myRKD,    theirRKD,  function(v) { return v.toFixed(2); });
  if (myRWR  && theirRWR)   addCat('Recent WR',   myRWR,    theirRWR,  function(v) { return Math.round(v) + '%'; });
  if (myObj  && theirObj && myObj.scorePG && theirObj.scorePG)
    addCat('Obj Score/g', myObj.scorePG, theirObj.scorePG, function(v) { return v.toFixed(1); });

  // Trajectory vars
  var myRAcc    = _recentAcc(myMatches, 20);
  var theirRAcc = _recentAcc(theirMatches, 20);
  var myRAst    = _recentAst(myMatches, 20);
  var theirRAst = _recentAst(theirMatches, 20);
  var myRDmg    = _recentDmgRatio(myMatches, 20);
  var theirRDmg = _recentDmgRatio(theirMatches, 20);
  var myCareerAcc  = parseFloat(ms.accuracy)   || 0;
  var thCareerAcc  = parseFloat(ts.accuracy)   || 0;
  var myCareerDmg  = parseFloat(ms.damageRatio)|| 0;
  var thCareerDmg  = parseFloat(ts.damageRatio)|| 0;
  var myCareerAst  = ms.assistsPerGame ? parseFloat(ms.assistsPerGame) : null;
  var thCareerAst  = ts.assistsPerGame ? parseFloat(ts.assistsPerGame) : null;

  // Scoring
  var myWins = 0, theirWins = 0;
  cats.forEach(function(c) {
    if (c.myV > c.thV) myWins++; else if (c.thV > c.myV) theirWins++;
  });
  var total = myWins + theirWins || 1;
  var myEdge = myWins / total;

  var vText, vColor;
  if      (myEdge >= 0.70) { vText = 'YOU HAVE THE EDGE';  vColor = 'var(--win)'; }
  else if (myEdge >= 0.55) { vText = 'SLIGHT EDGE: YOU';   vColor = 'var(--win)'; }
  else if (myEdge >= 0.45) { vText = 'EVEN MATCHUP';       vColor = 'var(--accent)'; }
  else if (myEdge >= 0.30) { vText = 'SLIGHT EDGE: THEM';  vColor = '#f59e0b'; }
  else                     { vText = 'THEY HAVE THE EDGE'; vColor = 'var(--loss)'; }

  var catsByRatio = cats.slice().sort(function(a, b) { return (b.myV/b.thV) - (a.myV/a.thV); });
  var myBest  = catsByRatio[0];
  var myWorst = catsByRatio[catsByRatio.length - 1];

  // ── HTML ─────────────────────────────────────────────────────────────────
  var h = '<div style="max-width:800px;width:100%;margin:0 auto">';

  // Player header — stacks vertically on mobile
  function _pCard(p, csr, isMe) {
    var color  = isMe ? 'var(--accent)' : '#f59e0b';
    var border = isMe ? 'rgba(0,212,255,0.3)' : 'rgba(245,158,11,0.3)';
    var s      = p.stats || {};
    var ini    = (p.gamertag || '??').slice(0, 2).toUpperCase();
    var align  = isMobile ? 'left' : (isMe ? 'left' : 'right');
    var rowDir = isMobile ? 'row' : (isMe ? 'row' : 'row-reverse');
    return '<div style="background:var(--surface);border:1px solid ' + border + ';border-radius:10px;padding:13px">'
      + '<div style="display:flex;align-items:center;gap:10px;flex-direction:' + rowDir + ';margin-bottom:10px">'
      + (p.emblemUrl
          ? '<img src="' + p.emblemUrl + '" style="width:38px;height:38px;object-fit:contain;flex-shrink:0">'
          : '<div style="width:38px;height:38px;background:var(--surface3);border-radius:6px;display:flex;align-items:center;justify-content:center;font-family:Rajdhani,sans-serif;font-size:14px;font-weight:700;color:' + color + ';flex-shrink:0">' + ini + '</div>')
      + '<div style="min-width:0;text-align:' + align + ';flex:1">'
      + '<div style="font-family:Rajdhani,sans-serif;font-size:' + (isMobile ? '15' : '16') + 'px;font-weight:700;color:' + color + ';letter-spacing:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + p.gamertag + '</div>'
      + '<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;margin-top:1px">' + (csr ? csr.tier : '—') + '</div>'
      + '</div>'
      + (isMe ? '<div style="font-size:8px;color:var(--accent);font-family:Share Tech Mono,monospace;background:rgba(0,212,255,0.08);padding:2px 6px;border-radius:3px;border:1px solid rgba(0,212,255,0.2);flex-shrink:0">YOU</div>' : '')
      + '</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px">'
      + [['K/D', s.kd || '—'], [(csr ? csr.display : '—'), 'CSR'], [s.winRate ? s.winRate + '%' : '—', 'WR']].map(function(pair) {
          return '<div style="background:var(--surface2);border-radius:4px;padding:6px 3px;text-align:center">'
            + '<div style="font-family:Rajdhani,sans-serif;font-size:14px;font-weight:700;color:' + color + ';line-height:1">' + pair[0] + '</div>'
            + '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace;margin-top:2px">' + pair[1] + '</div>'
            + '</div>';
        }).join('')
      + '</div>'
      + '</div>';
  }

  if (isMobile) {
    // Mobile: stacked cards with VS between
    h += '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">';
    h += _pCard(me, myCsr, true);
    h += '<div style="text-align:center;padding:2px 0">'
       + '<span style="font-family:Rajdhani,sans-serif;font-size:18px;font-weight:700;color:var(--muted2);letter-spacing:3px">VS</span>'
       + '<span style="font-size:8px;color:' + vColor + ';font-family:Share Tech Mono,monospace;letter-spacing:.8px;text-transform:uppercase;margin-left:10px">' + vText + '</span>'
       + '<span style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;margin-left:8px">' + myWins + '–' + theirWins + '</span>'
       + '</div>';
    h += _pCard(them, theirCsr, false);
    h += '</div>';
  } else {
    // Desktop: side-by-side with VS in center
    h += '<div style="display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center;margin-bottom:14px">';
    h += _pCard(me, myCsr, true);
    h += '<div style="text-align:center;padding:0 6px">'
       + '<div style="font-family:Rajdhani,sans-serif;font-size:20px;font-weight:700;color:var(--muted2);letter-spacing:3px">VS</div>'
       + '<div style="margin-top:5px;font-size:8px;font-family:Share Tech Mono,monospace;color:' + vColor + ';letter-spacing:.8px;text-transform:uppercase;white-space:nowrap;line-height:1.4">' + vText + '</div>'
       + '<div style="margin-top:3px;font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace">' + myWins + '–' + theirWins + '</div>'
       + '</div>';
    h += _pCard(them, theirCsr, false);
    h += '</div>';
  }

  // Edge callouts
  var showMyEdge    = myBest  && myBest.myV  > myBest.thV;
  var showTheirEdge = myWorst && myWorst.thV > myWorst.myV;
  if (showMyEdge || showTheirEdge) {
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">';
    if (showMyEdge) {
      h += '<div style="background:rgba(0,212,255,0.05);border:1px solid rgba(0,212,255,0.18);border-radius:7px;padding:10px 12px">'
         + '<div style="font-size:8px;color:var(--accent);font-family:Share Tech Mono,monospace;letter-spacing:1px;margin-bottom:3px">YOUR EDGE</div>'
         + '<div style="font-family:Rajdhani,sans-serif;font-size:14px;font-weight:700;color:var(--text)">' + myBest.lbl + '</div>'
         + '<div style="font-size:10px;color:var(--muted);font-family:Share Tech Mono,monospace;margin-top:2px">' + myBest.fmt(myBest.myV) + ' <span style="color:var(--muted2)">vs</span> ' + myBest.fmt(myBest.thV) + '</div>'
         + '</div>';
    } else { h += '<div></div>'; }
    if (showTheirEdge) {
      h += '<div style="background:rgba(245,158,11,0.05);border:1px solid rgba(245,158,11,0.18);border-radius:7px;padding:10px 12px">'
         + '<div style="font-size:8px;color:#f59e0b;font-family:Share Tech Mono,monospace;letter-spacing:1px;margin-bottom:3px">THEIR EDGE</div>'
         + '<div style="font-family:Rajdhani,sans-serif;font-size:14px;font-weight:700;color:var(--text)">' + myWorst.lbl + '</div>'
         + '<div style="font-size:10px;color:var(--muted);font-family:Share Tech Mono,monospace;margin-top:2px">' + myWorst.fmt(myWorst.myV) + ' <span style="color:var(--muted2)">vs</span> ' + myWorst.fmt(myWorst.thV) + '</div>'
         + '</div>';
    } else { h += '<div></div>'; }
    h += '</div>';
  }

  // ── Tug-of-war bars ───────────────────────────────────────────────────────
  h += _sectionHead('HEAD-TO-HEAD');
  h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:12px">';
  cats.forEach(function(c, i) {
    var myLeads   = c.myV >= c.thV;
    var sum       = c.myV + c.thV;
    var myPct     = Math.round(c.myV / sum * 100);
    var thPct     = 100 - myPct;
    var myBarClr  = myLeads ? 'var(--accent)' : 'rgba(0,212,255,0.12)';
    var thBarClr  = !myLeads ? '#f59e0b'       : 'rgba(245,158,11,0.12)';
    h += '<div style="padding:10px 14px' + (i > 0 ? ';border-top:1px solid var(--border)' : '') + '">';
    h += '<div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:6px;margin-bottom:6px">';
    h += '<div style="font-family:Rajdhani,sans-serif;font-size:14px;font-weight:700;color:' + (myLeads ? 'var(--accent)' : 'var(--muted)') + '">' + (myLeads ? '◆ ' : '') + c.fmt(c.myV) + '</div>';
    h += '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.6px;text-transform:uppercase;text-align:center;white-space:nowrap">' + c.lbl + '</div>';
    h += '<div style="font-family:Rajdhani,sans-serif;font-size:14px;font-weight:700;color:' + (!myLeads ? '#f59e0b' : 'var(--muted)') + ';text-align:right">' + c.fmt(c.thV) + (!myLeads ? ' ◆' : '') + '</div>';
    h += '</div>';
    h += '<div style="display:flex;height:4px;border-radius:2px;overflow:hidden">';
    h += '<div style="width:' + myPct + '%;background:' + myBarClr + ';transition:width 0.5s ease"></div>';
    h += '<div style="width:' + thPct + '%;background:' + thBarClr + ';transition:width 0.5s ease"></div>';
    h += '</div></div>';
  });
  h += '</div>';

  // ── Mode breakdown (per mode, both players side by side) ─────────────────
  var allModeNames = [];
  myModes.concat(theirModes).forEach(function(m) { if (allModeNames.indexOf(m.mode) < 0) allModeNames.push(m.mode); });
  if (allModeNames.length) {
    h += _sectionHead('MODE BREAKDOWN');
    h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:12px">';
    var MODE_ICONS = {
      'Slayer':           '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><line x1="18" y1="6" x2="6" y2="18"/><polyline points="8 6 18 6 18 16"/></svg>',
      'Oddball':          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><circle cx="12" cy="11" r="5"/><path d="M9 17v2M15 17v2"/></svg>',
      'CTF':              '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>',
      'Strongholds':      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
      'King of the Hill': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><path d="M2 19h20v2H2zM2 9l5 3 5-7 5 7 5-3v8H2z"/></svg>',
      'Land Grab':        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
      'Stockpile':        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>'
    };
    var renderedModes = 0;
    allModeNames.forEach(function(mode) {
      var myM    = myModes.find(function(m) { return m.mode === mode; });
      var theirM = theirModes.find(function(m) { return m.mode === mode; });
      // Only show row if both players have data for this mode
      if (!myM || !theirM) return;
      var myLeads = myM.wr >= theirM.wr;
      var sum2 = myM.wr + theirM.wr || 1;
      var myP  = Math.round(myM.wr / sum2 * 100);
      var icon = MODE_ICONS[mode] || '';
      // Obj detail string
      var myObj2    = (myM.objAvg    != null) ? ' · ' + (myM.objLabel    === 'avg carry' ? myM.objAvg.toFixed(1)    + 'm' : myM.objAvg.toFixed(1))    : '';
      var theirObj2 = (theirM.objAvg != null) ? ' · ' + (theirM.objLabel === 'avg carry' ? theirM.objAvg.toFixed(1) + 'm' : theirM.objAvg.toFixed(1)) : '';
      h += '<div style="padding:10px 14px' + (renderedModes > 0 ? ';border-top:1px solid var(--border)' : '') + '">';
      h += '<div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:6px;margin-bottom:6px">';
      h += '<div><div style="font-family:Rajdhani,sans-serif;font-size:15px;font-weight:700;color:' + (myLeads ? 'var(--accent)' : 'var(--muted)') + '">' + (myLeads ? '◆ ' : '') + myM.wr + '%</div>'
         + '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace">' + myM.games + 'g' + myObj2 + '</div></div>';
      h += '<div style="text-align:center">'
         + '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.6px;white-space:nowrap">' + icon + ' ' + mode.toUpperCase() + '</div>'
         + (myM.objLabel ? '<div style="font-size:7px;color:var(--muted2);font-family:Share Tech Mono,monospace;opacity:0.7;margin-top:1px">' + myM.objLabel + '</div>' : '')
         + '</div>';
      h += '<div style="text-align:right"><div style="font-family:Rajdhani,sans-serif;font-size:15px;font-weight:700;color:' + (!myLeads ? '#f59e0b' : 'var(--muted)') + '">' + (!myLeads ? '◆ ' : '') + theirM.wr + '%</div>'
         + '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace">' + theirObj2 + theirM.games + 'g</div></div>';
      h += '</div>';
      h += '<div style="display:flex;height:4px;border-radius:2px;overflow:hidden">';
      h += '<div style="width:' + myP + '%;background:' + (myLeads ? 'var(--accent)' : 'rgba(0,212,255,0.12)') + '"></div>';
      h += '<div style="width:' + (100-myP) + '%;background:' + (!myLeads ? '#f59e0b' : 'rgba(245,158,11,0.12)') + '"></div>';
      h += '</div></div>';
      renderedModes++;
    });
    if (!renderedModes) h += '<div style="padding:12px 14px;font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace">Not enough shared mode data yet</div>';
    h += '</div>';
  }

  // ── Map performance — shared maps only ────────────────────────────────────
  if (sharedMaps.length) {
    h += _sectionHead('MAP PERFORMANCE — SHARED MAPS');
    h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:12px">';
    sharedMaps.forEach(function(mapName, i) {
      var myM    = myMapDict[mapName];
      var theirM = thMapDict[mapName];
      var myLeads = myM.wr >= theirM.wr;
      var sum3 = myM.wr + theirM.wr || 1;
      var myP3 = Math.round(myM.wr / sum3 * 100);
      h += '<div style="padding:10px 14px' + (i > 0 ? ';border-top:1px solid var(--border)' : '') + '">';
      // Map name header
      h += '<div style="font-size:9px;color:var(--muted);font-family:Share Tech Mono,monospace;letter-spacing:.5px;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + mapName + '</div>';
      // WR row
      h += '<div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:6px;margin-bottom:5px">';
      h += '<div><div style="font-family:Rajdhani,sans-serif;font-size:15px;font-weight:700;color:' + (myLeads ? 'var(--accent)' : 'var(--muted)') + '">' + (myLeads ? '◆ ' : '') + myM.wr + '%</div>'
         + '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace">' + myM.kd.toFixed(2) + ' K/D · ' + myM.games + 'g</div></div>';
      h += '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-align:center">WIN RATE</div>';
      h += '<div style="text-align:right"><div style="font-family:Rajdhani,sans-serif;font-size:15px;font-weight:700;color:' + (!myLeads ? '#f59e0b' : 'var(--muted)') + '">' + (!myLeads ? '◆ ' : '') + theirM.wr + '%</div>'
         + '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace">' + theirM.games + 'g · ' + theirM.kd.toFixed(2) + ' K/D</div></div>';
      h += '</div>';
      h += '<div style="display:flex;height:4px;border-radius:2px;overflow:hidden">';
      h += '<div style="width:' + myP3 + '%;background:' + (myLeads ? 'var(--accent)' : 'rgba(0,212,255,0.12)') + '"></div>';
      h += '<div style="width:' + (100-myP3) + '%;background:' + (!myLeads ? '#f59e0b' : 'rgba(245,158,11,0.12)') + '"></div>';
      h += '</div></div>';
    });
    h += '</div>';
  }

  // ── Trajectory ────────────────────────────────────────────────────────────
  (function() {
    // Build rows: [{label, myCareer, myRecent, thCareer, thRecent, fmt, pctThreshold}]
    var tRows = [];
    function addTRow(lbl, myC, myR, thC, thR, fmt, thresh) {
      if (myR != null && thR != null && myC > 0 && thC > 0)
        tRows.push({ lbl: lbl, myC: myC, myR: myR, thC: thC, thR: thR, fmt: fmt, thresh: thresh || 0.05 });
    }
    addTRow('K/D',          myKD,        myRKD,    theirKD,     theirRKD,  function(v) { return v.toFixed(2); },  0.05);
    addTRow('Win Rate',     myWR,        myRWR,    theirWR,     theirRWR,  function(v) { return Math.round(v) + '%'; }, 3);
    addTRow('Accuracy',     myCareerAcc, myRAcc,   thCareerAcc, theirRAcc, function(v) { return v.toFixed(1) + '%'; }, 1);
    addTRow('Dmg Ratio',    myCareerDmg, myRDmg,   thCareerDmg, theirRDmg, function(v) { return v.toFixed(2); },  0.05);
    if (myCareerAst && thCareerAst)
      addTRow('Assists/g',  myCareerAst, myRAst,   thCareerAst, theirRAst, function(v) { return v.toFixed(1); },  0.3);
    if (!tRows.length) return;

    h += _sectionHead('TRAJECTORY — LAST 20 GAMES vs CAREER');
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">';

    function _tCard2(name, rows, col) {
      var c = '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">';
      c += '<div style="padding:8px 12px;border-bottom:1px solid var(--border);font-size:8px;color:' + col + ';font-family:Share Tech Mono,monospace;letter-spacing:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + name + '</div>';
      var isMe = col === 'var(--accent)';
      rows.forEach(function(r, i) {
        var career = isMe ? r.myC : r.thC;
        var recent = isMe ? r.myR : r.thR;
        if (recent == null) return;
        var diff   = recent - career;
        var rising = diff >  r.thresh;
        var falling= diff < -r.thresh;
        var arrow  = rising ? '↑' : falling ? '↓' : '→';
        var dc     = rising ? 'var(--win)' : falling ? 'var(--loss)' : 'var(--muted)';
        c += '<div style="padding:7px 12px;display:flex;align-items:center;gap:8px' + (i > 0 ? ';border-top:1px solid var(--border)' : '') + '">';
        c += '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace;width:58px;flex-shrink:0">' + r.lbl + '</div>';
        c += '<div style="font-family:Rajdhani,sans-serif;font-size:13px;color:var(--muted);min-width:32px">' + r.fmt(career) + '</div>';
        c += '<div style="color:var(--muted2);font-size:10px">→</div>';
        c += '<div style="font-family:Rajdhani,sans-serif;font-size:13px;font-weight:700;color:' + dc + ';min-width:32px">' + r.fmt(recent) + '</div>';
        c += '<div style="font-size:10px;color:' + dc + ';font-weight:700;margin-left:auto">' + arrow + '</div>';
        c += '</div>';
      });
      c += '</div>';
      return c;
    }

    h += _tCard2(me.gamertag,   tRows, 'var(--accent)');
    h += _tCard2(them.gamertag, tRows, '#f59e0b');
    h += '</div>';
  })();

  // ── Objective contribution breakdown ──────────────────────────────────────
  (function() {
    if (!myObj || !theirObj || !myObj.objGames || !theirObj.objGames) return;

    // Rows to show: [label, myVal, thVal, fmt, show condition]
    var oRows = [];
    function addORow(lbl, myV, thV, fmt) {
      if (myV > 0.01 || thV > 0.01) oRows.push({ lbl: lbl, myV: myV, thV: thV, fmt: fmt });
    }
    addORow('Assists/g',      myObj.assistsPG,   theirObj.assistsPG,   function(v) { return v.toFixed(1); });
    addORow('Flag Caps/g',    myObj.flagCapsPG,   theirObj.flagCapsPG,  function(v) { return v.toFixed(2); });
    addORow('Flag Grabs/g',   myObj.flagGrabsPG,  theirObj.flagGrabsPG, function(v) { return v.toFixed(2); });
    addORow('Flag Ret./g',    myObj.flagRetPG,    theirObj.flagRetPG,   function(v) { return v.toFixed(2); });
    addORow('Zone Caps/g',    myObj.capturesPG,   theirObj.capturesPG,  function(v) { return v.toFixed(2); });
    addORow('Zone Sec./g',    myObj.securesPG,    theirObj.securesPG,   function(v) { return v.toFixed(2); });
    addORow('Carry (min/g)',  myObj.carryPG,      theirObj.carryPG,     function(v) { return v.toFixed(1); });
    addORow('Seeds/g',        myObj.seedsPG,      theirObj.seedsPG,     function(v) { return v.toFixed(2); });
    if (!oRows.length) return;

    h += _sectionHead('OBJECTIVE CONTRIBUTION');
    h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:12px">';

    // Header row showing obj games count
    h += '<div style="display:grid;grid-template-columns:auto 1fr auto 1fr;gap:0;padding:7px 14px;border-bottom:1px solid var(--border);align-items:center">';
    h += '<div style="font-family:Rajdhani,sans-serif;font-size:12px;font-weight:700;color:var(--accent)">' + me.gamertag + '</div>';
    h += '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace;padding-left:6px">' + myObj.objGames + ' obj games</div>';
    h += '<div style="font-family:Rajdhani,sans-serif;font-size:12px;font-weight:700;color:#f59e0b;text-align:right">' + them.gamertag + '</div>';
    h += '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-align:right;padding-right:0">' + theirObj.objGames + ' obj games</div>';
    h += '</div>';

    oRows.forEach(function(r, i) {
      var sum     = r.myV + r.thV || 1;
      var myPct   = Math.round(r.myV / sum * 100);
      var myLeads = r.myV >= r.thV;
      h += '<div style="padding:9px 14px' + (i > 0 ? ';border-top:1px solid var(--border)' : '') + '">';
      h += '<div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:6px;margin-bottom:5px">';
      h += '<div style="font-family:Rajdhani,sans-serif;font-size:14px;font-weight:700;color:' + (myLeads ? 'var(--accent)' : 'var(--muted)') + '">' + (myLeads ? '◆ ' : '') + r.fmt(r.myV) + '</div>';
      h += '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.5px;text-align:center;white-space:nowrap">' + r.lbl + '</div>';
      h += '<div style="font-family:Rajdhani,sans-serif;font-size:14px;font-weight:700;color:' + (!myLeads ? '#f59e0b' : 'var(--muted)') + ';text-align:right">' + r.fmt(r.thV) + (!myLeads ? ' ◆' : '') + '</div>';
      h += '</div>';
      h += '<div style="display:flex;height:4px;border-radius:2px;overflow:hidden">';
      h += '<div style="width:' + myPct + '%;background:' + (myLeads ? 'var(--accent)' : 'rgba(0,212,255,0.12)') + '"></div>';
      h += '<div style="width:' + (100-myPct) + '%;background:' + (!myLeads ? '#f59e0b' : 'rgba(245,158,11,0.12)') + '"></div>';
      h += '</div></div>';
    });
    h += '</div>';
  })();

  // ── New comparison button ─────────────────────────────────────────────────
  h += '<div style="text-align:center;padding-bottom:8px">'
     + '<button onclick="_compareMe=_compareMe;_compareData=null;_renderCompareSearch()" '
     + 'style="background:transparent;border:1px solid var(--border);color:var(--muted);padding:8px 20px;border-radius:4px;font-family:Share Tech Mono,monospace;font-size:10px;cursor:pointer;letter-spacing:1px">'
     + '← COMPARE DIFFERENT PLAYER</button>'
     + '</div>';

  h += '</div>'; // close max-width wrapper
  panel.innerHTML = h;
}

function _sectionHead(label) {
  return '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;padding-left:2px">' + label + '</div>';
}
