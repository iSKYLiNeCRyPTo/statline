// ── Player Compare ────────────────────────────────────────────────────────────
var _compareData = null;
var _compareMe   = null; // locked at open-time so globals changing later can't corrupt it

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
  var panel = document.getElementById('cmpPanel');
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
  var panel = document.getElementById('cmpPanel');
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

// Build top-N map stats: [{map, wins, losses, kd, wr}]
function _mapStats(matches, n) {
  var byMap = {};
  (matches || []).forEach(function(m) {
    if (!m.mapName || (m.outcome !== 2 && m.outcome !== 3)) return;
    var k = m.mapName;
    if (!byMap[k]) byMap[k] = { map: k, wins: 0, losses: 0, kills: 0, deaths: 0 };
    if (m.outcome === 2) byMap[k].wins++; else byMap[k].losses++;
    byMap[k].kills  += m.kills  || 0;
    byMap[k].deaths += m.deaths || 0;
  });
  return Object.values(byMap)
    .filter(function(e) { return e.wins + e.losses >= 3; })
    .sort(function(a, b) { return (b.wins + b.losses) - (a.wins + a.losses); })
    .slice(0, n)
    .map(function(e) {
      var total = e.wins + e.losses;
      return {
        map: e.map,
        games: total,
        wr: Math.round(e.wins / total * 100),
        kd: e.deaths > 0 ? (e.kills / e.deaths) : e.kills > 0 ? e.kills : 0
      };
    });
}

// Build mode win rates: [{mode, wr, games}] — simplified to Slayer vs Obj
function _modeStats(matches) {
  var SLAYER_RE = /slayer/i;
  var OBJ_MODES = ['Oddball','CTF','Strongholds','King of the Hill','Land Grab','Stockpile','Extraction'];
  var buckets = { Slayer: { w: 0, l: 0 }, Objective: { w: 0, l: 0 } };
  (matches || []).forEach(function(m) {
    if (!m.gameMode || (m.outcome !== 2 && m.outcome !== 3)) return;
    var isSlayer = SLAYER_RE.test(m.gameMode);
    var isObj    = OBJ_MODES.some(function(mo) { return m.gameMode.indexOf(mo) > -1; });
    var bucket = isSlayer ? 'Slayer' : isObj ? 'Objective' : null;
    if (!bucket) return;
    if (m.outcome === 2) buckets[bucket].w++; else buckets[bucket].l++;
  });
  return Object.keys(buckets).map(function(mode) {
    var b = buckets[mode];
    var total = b.w + b.l;
    return total >= 3 ? { mode: mode, wr: Math.round(b.w / total * 100), games: total } : null;
  }).filter(Boolean);
}

// Objective contribution score per game
function _objScore(matches) {
  var scored = (matches || []).filter(function(m) { return m.objStats; });
  if (!scored.length) return null;
  var total = scored.reduce(function(a, m) {
    var o = m.objStats || {};
    return a + (o.flagCaptures || 0) * 4 + (o.captures || 0) * 2
             + (o.flagGrabs || 0) * 0.5 + (o.flagReturns || 0) * 0.5
             + (o.secures || 0) * 0.5 + (o.seedsDeposited || 0) * 0.3
             + Math.min((o.timeAsCarrier || 0) / 60, 3);
  }, 0);
  return total / scored.length;
}

// ── Main render ───────────────────────────────────────────────────────────────

function _renderComparison() {
  var panel = document.getElementById('cmpPanel');
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
  var myObj     = _objScore(myMatches);
  var theirObj  = _objScore(theirMatches);
  var myMaps    = _mapStats(myMatches, 5);
  var theirMaps = _mapStats(theirMatches, 5);
  var myModes   = _modeStats(myMatches);
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
  if (myObj  && theirObj)   addCat('Obj Score/g', myObj,    theirObj,  function(v) { return v.toFixed(1); });

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

  // ── Mode breakdown ────────────────────────────────────────────────────────
  if (myModes.length && theirModes.length) {
    h += _sectionHead('MODE BREAKDOWN');
    h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:12px">';
    var allModeNames = [];
    myModes.concat(theirModes).forEach(function(m) { if (allModeNames.indexOf(m.mode) < 0) allModeNames.push(m.mode); });
    allModeNames.forEach(function(mode, i) {
      var myM    = myModes.find(function(m) { return m.mode === mode; });
      var theirM = theirModes.find(function(m) { return m.mode === mode; });
      if (!myM && !theirM) return;
      var myWR2    = myM    ? myM.wr    : null;
      var theirWR2 = theirM ? theirM.wr : null;
      var myLeads2 = myWR2 !== null && theirWR2 !== null ? myWR2 >= theirWR2 : myWR2 !== null;
      var ICON = mode === 'Slayer'
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><line x1="18" y1="6" x2="6" y2="18"/><polyline points="8 6 18 6 18 16"/></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
      h += '<div style="padding:10px 14px' + (i > 0 ? ';border-top:1px solid var(--border)' : '') + '">';
      h += '<div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:6px;margin-bottom:6px">';
      h += '<div style="font-family:Rajdhani,sans-serif;font-size:14px;font-weight:700;color:' + (myLeads2 ? 'var(--accent)' : 'var(--muted)') + '">' + (myWR2 !== null ? (myLeads2 ? '◆ ' : '') + myWR2 + '% <span style="font-size:9px;color:var(--muted2)">(' + (myM ? myM.games : 0) + 'g)</span>' : '—') + '</div>';
      h += '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.6px;text-align:center;white-space:nowrap">' + ICON + ' ' + mode.toUpperCase() + '</div>';
      h += '<div style="font-family:Rajdhani,sans-serif;font-size:14px;font-weight:700;color:' + (!myLeads2 ? '#f59e0b' : 'var(--muted)') + ';text-align:right">' + (theirWR2 !== null ? (!myLeads2 ? '◆ ' : '') + theirWR2 + '% <span style="font-size:9px;color:var(--muted2)">(' + (theirM ? theirM.games : 0) + 'g)</span>' : '—') + '</div>';
      h += '</div>';
      if (myWR2 !== null && theirWR2 !== null) {
        var sum2 = myWR2 + theirWR2;
        var myP  = Math.round(myWR2 / sum2 * 100);
        h += '<div style="display:flex;height:4px;border-radius:2px;overflow:hidden">';
        h += '<div style="width:' + myP + '%;background:' + (myLeads2 ? 'var(--accent)' : 'rgba(0,212,255,0.12)') + '"></div>';
        h += '<div style="width:' + (100-myP) + '%;background:' + (!myLeads2 ? '#f59e0b' : 'rgba(245,158,11,0.12)') + '"></div>';
        h += '</div>';
      }
      h += '</div>';
    });
    h += '</div>';
  }

  // ── Map performance ───────────────────────────────────────────────────────
  if (myMaps.length || theirMaps.length) {
    h += _sectionHead('MAP PERFORMANCE');
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">';

    function _mapCard(maps, color, label) {
      if (!maps.length) return '<div></div>';
      var c = '';
      c += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">';
      c += '<div style="padding:8px 12px;border-bottom:1px solid var(--border);font-size:8px;color:' + color + ';font-family:Share Tech Mono,monospace;letter-spacing:1px">' + label + ' — TOP MAPS</div>';
      maps.forEach(function(m, i) {
        var wrColor = m.wr >= 60 ? 'var(--win)' : m.wr >= 45 ? 'var(--muted)' : 'var(--loss)';
        var kdColor = m.kd >= 1.2 ? 'var(--win)' : m.kd >= 0.8 ? 'var(--muted)' : 'var(--loss)';
        c += '<div style="padding:8px 12px' + (i > 0 ? ';border-top:1px solid var(--border)' : '') + '">';
        c += '<div style="font-family:Share Tech Mono,monospace;font-size:10px;color:var(--text);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + m.map + '</div>';
        c += '<div style="display:flex;gap:6px;align-items:center">';
        c += '<div style="font-size:8px;color:' + wrColor + ';font-family:Share Tech Mono,monospace;background:rgba(255,255,255,0.04);padding:2px 5px;border-radius:3px">' + m.wr + '% WR</div>';
        c += '<div style="font-size:8px;color:' + kdColor + ';font-family:Share Tech Mono,monospace;background:rgba(255,255,255,0.04);padding:2px 5px;border-radius:3px">' + m.kd.toFixed(2) + ' K/D</div>';
        c += '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace;margin-left:auto">' + m.games + 'g</div>';
        c += '</div>';
        // mini WR bar
        c += '<div style="margin-top:4px;height:3px;border-radius:2px;background:var(--surface2);overflow:hidden">';
        c += '<div style="width:' + m.wr + '%;height:100%;background:' + wrColor + ';opacity:0.7"></div>';
        c += '</div></div>';
      });
      c += '</div>';
      return c;
    }

    h += _mapCard(myMaps,    'var(--accent)', me.gamertag);
    h += _mapCard(theirMaps, '#f59e0b',       them.gamertag);
    h += '</div>';
  }

  // ── Trajectory ────────────────────────────────────────────────────────────
  if (myTrend !== null || theirTrend !== null) {
    h += _sectionHead('TRAJECTORY — RECENT vs CAREER K/D');
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">';
    function _tCard(name, career, recent, trend, col) {
      if (!recent) return '<div></div>';
      var dir = trend >  0.05 ? '↑ IMPROVING' : trend < -0.05 ? '↓ DECLINING' : '→ STEADY';
      var dc  = trend >  0.05 ? 'var(--win)'  : trend < -0.05 ? 'var(--loss)' : 'var(--muted)';
      return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px">'
        + '<div style="font-size:8px;color:' + col + ';font-family:Share Tech Mono,monospace;letter-spacing:1px;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + name + '</div>'
        + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
        + '<div><div style="font-family:Rajdhani,sans-serif;font-size:18px;font-weight:700;color:var(--muted)">' + career.toFixed(2) + '</div><div style="font-size:7px;color:var(--muted2);font-family:Share Tech Mono,monospace">CAREER</div></div>'
        + '<div style="color:var(--muted2)">→</div>'
        + '<div><div style="font-family:Rajdhani,sans-serif;font-size:18px;font-weight:700;color:' + dc + '">' + recent.toFixed(2) + '</div><div style="font-size:7px;color:var(--muted2);font-family:Share Tech Mono,monospace">RECENT</div></div>'
        + '<div style="font-size:8px;font-family:Share Tech Mono,monospace;color:' + dc + ';font-weight:700;margin-left:auto;white-space:nowrap">' + dir + '</div>'
        + '</div></div>';
    }
    h += _tCard(me.gamertag,   myKD,   myRKD,   myTrend,    'var(--accent)');
    h += _tCard(them.gamertag, theirKD, theirRKD, theirTrend, '#f59e0b');
    h += '</div>';
  }

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
