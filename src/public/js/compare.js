// ── Player Compare ────────────────────────────────────────────────────────────
var _compareData = null;

function openCompare() {
  var p = getAllPlayers()[selectedPlayer] || (data && data.players && data.players[0]);
  if (!p) return;
  var overlay = document.getElementById('compareOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  _compareData = null;
  _renderCompareSearch(p);
  setTimeout(function() {
    var inp = document.getElementById('cmpInput');
    if (inp) inp.focus();
  }, 80);
}

function closeCompare() {
  var overlay = document.getElementById('compareOverlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
}

function _renderCompareSearch(me) {
  var panel = document.getElementById('cmpPanel');
  if (!panel) return;
  var myCsr = _topCsr(me);
  var initials = (me.gamertag || '??').slice(0, 2).toUpperCase();

  panel.innerHTML =
    '<div style="max-width:500px;width:100%;margin:0 auto;padding:0 4px">'
    + '<div style="background:var(--surface);border:1px solid rgba(0,212,255,0.25);border-radius:10px;padding:14px 16px;margin-bottom:20px;display:flex;align-items:center;gap:12px">'
    + (me.emblemUrl
        ? '<img src="' + me.emblemUrl + '" style="width:42px;height:42px;object-fit:contain;flex-shrink:0">'
        : '<div style="width:42px;height:42px;background:var(--surface3);border-radius:6px;display:flex;align-items:center;justify-content:center;font-family:Rajdhani,sans-serif;font-size:15px;font-weight:700;color:var(--accent);flex-shrink:0">' + initials + '</div>')
    + '<div style="flex:1;min-width:0">'
    + '<div style="font-family:Rajdhani,sans-serif;font-size:18px;font-weight:700;color:var(--accent);letter-spacing:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + me.gamertag + '</div>'
    + '<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;margin-top:2px">'
    + (myCsr ? myCsr.tierName + ' · ' : '') + (me.stats ? 'K/D ' + me.stats.kd : '') + '</div>'
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
    + '<div style="font-family:Rajdhani,sans-serif;font-size:13px;color:var(--muted);letter-spacing:2px;text-transform:uppercase;margin-bottom:10px">Loading ' + gt + '</div>'
    + '<div style="display:flex;justify-content:center;gap:4px">'
    + '<div style="width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulse 1.2s ease-in-out infinite"></div>'
    + '<div style="width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulse 1.2s ease-in-out 0.2s infinite"></div>'
    + '<div style="width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulse 1.2s ease-in-out 0.4s infinite"></div>'
    + '</div>'
    + '</div>';

  try {
    var r = await fetch('/api/search?gamertag=' + encodeURIComponent(gt) + '&statsOnly=1');
    var d = await r.json();
    if (!d.success || !d.player) {
      panel.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--loss);font-family:Share Tech Mono,monospace;font-size:12px">' + (d.error || 'Player not found') + '</div>';
      return;
    }
    _compareData = d.player;
    _renderComparison();
    // Background full fetch for match history (trajectory etc)
    fetch('/api/search?gamertag=' + encodeURIComponent(gt))
      .then(function(r2) { return r2.json(); })
      .then(function(d2) {
        if (d2.success && d2.player) { _compareData = d2.player; _renderComparison(); }
      }).catch(function() {});
  } catch (e) {
    panel.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--loss);font-family:Share Tech Mono,monospace;font-size:12px">Fetch failed: ' + e.message + '</div>';
  }
}

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

function _renderComparison() {
  var panel = document.getElementById('cmpPanel');
  if (!panel || !_compareData) return;

  var me = getAllPlayers()[selectedPlayer] || (data && data.players && data.players[0]);
  var them = _compareData;
  if (!me) return;

  var ms = me.stats || {};
  var ts = them.stats || {};
  var myCsr = _topCsr(me);
  var theirCsr = _topCsr(them);

  var myMatches = fullMatchCache[me.gamertag] || me.allMatches || me.recentMatches || [];
  var theirMatches = fullMatchCache[them.gamertag] || them.allMatches || them.recentMatches || [];

  var myKD      = parseFloat(ms.kd) || 0;
  var theirKD   = parseFloat(ts.kd) || 0;
  var myWR      = parseFloat(ms.winRate) || 0;
  var theirWR   = parseFloat(ts.winRate) || 0;
  var myAcc     = parseFloat(ms.accuracy) || 0;
  var theirAcc  = parseFloat(ts.accuracy) || 0;
  var myKDA     = parseFloat(ms.kda) || 0;
  var theirKDA  = parseFloat(ts.kda) || 0;
  var myCsrV    = myCsr ? myCsr.value : 0;
  var theirCsrV = theirCsr ? theirCsr.value : 0;
  var myRKD     = _recentKD(myMatches, 20);
  var theirRKD  = _recentKD(theirMatches, 20);
  var myRWR     = _recentWR(myMatches, 20);
  var theirRWR  = _recentWR(theirMatches, 20);
  var myTrend   = (myRKD && myKD) ? (myRKD - myKD) : null;
  var theirTrend = (theirRKD && theirKD) ? (theirRKD - theirKD) : null;

  // Stat categories: [label, myVal, theirVal, formatFn]
  var cats = [];
  function addCat(lbl, myV, thV, fmt) {
    if (myV > 0 && thV > 0) cats.push({ lbl: lbl, myV: myV, thV: thV, fmt: fmt });
  }
  addCat('K/D Ratio',       myKD,     theirKD,   function(v) { return v.toFixed(2); });
  addCat('Win Rate',        myWR,     theirWR,   function(v) { return v.toFixed(1) + '%'; });
  addCat('Accuracy',        myAcc,    theirAcc,  function(v) { return v.toFixed(1) + '%'; });
  addCat('KDA',             myKDA,    theirKDA,  function(v) { return v.toFixed(2); });
  if (myCsrV && theirCsrV) addCat('CSR', myCsrV, theirCsrV, function(v) { return Math.round(v) + ''; });
  if (myRKD && theirRKD)   addCat('Recent K/D (20g)', myRKD, theirRKD, function(v) { return v.toFixed(2); });
  if (myRWR && theirRWR)   addCat('Recent Win Rate', myRWR, theirRWR, function(v) { return Math.round(v) + '%'; });

  // Score
  var myWins = 0, theirWins = 0;
  cats.forEach(function(c) {
    if (c.myV > c.thV) myWins++;
    else if (c.thV > c.myV) theirWins++;
  });
  var total = myWins + theirWins || 1;
  var myEdgePct = myWins / total;

  // Verdict
  var vText, vColor;
  if      (myEdgePct >= 0.70) { vText = 'YOU HAVE THE EDGE';  vColor = 'var(--win)'; }
  else if (myEdgePct >= 0.55) { vText = 'SLIGHT EDGE: YOU';   vColor = 'var(--win)'; }
  else if (myEdgePct >= 0.45) { vText = 'EVEN MATCHUP';       vColor = 'var(--accent)'; }
  else if (myEdgePct >= 0.30) { vText = 'SLIGHT EDGE: THEM';  vColor = '#f59e0b'; }
  else                        { vText = 'THEY HAVE THE EDGE'; vColor = 'var(--loss)'; }

  // Biggest advantage / disadvantage
  var catsByDiff = cats.slice().sort(function(a, b) {
    return (b.myV / b.thV) - (a.myV / a.thV);
  });
  var myBest  = catsByDiff[0];
  var myWorst = catsByDiff[catsByDiff.length - 1];

  // ── Build HTML ───────────────────────────────────────────────────────────
  var h = '<div style="max-width:760px;width:100%;margin:0 auto;padding:0 4px 40px">';

  // Player header row
  function _pCard(p, csr, isMe) {
    var color = isMe ? 'var(--accent)' : '#f59e0b';
    var borderColor = isMe ? 'rgba(0,212,255,0.3)' : 'rgba(245,158,11,0.3)';
    var s = p.stats || {};
    var ini = (p.gamertag || '??').slice(0, 2).toUpperCase();
    var align = isMe ? 'left' : 'right';
    var rowDir = isMe ? 'row' : 'row-reverse';
    return '<div style="background:var(--surface);border:1px solid ' + borderColor + ';border-radius:10px;padding:14px">'
      + '<div style="display:flex;align-items:center;gap:10px;flex-direction:' + rowDir + ';margin-bottom:10px">'
      + (p.emblemUrl
          ? '<img src="' + p.emblemUrl + '" style="width:40px;height:40px;object-fit:contain;flex-shrink:0">'
          : '<div style="width:40px;height:40px;background:var(--surface3);border-radius:6px;display:flex;align-items:center;justify-content:center;font-family:Rajdhani,sans-serif;font-size:15px;font-weight:700;color:' + color + ';flex-shrink:0">' + ini + '</div>')
      + '<div style="min-width:0;text-align:' + align + '">'
      + '<div style="font-family:Rajdhani,sans-serif;font-size:17px;font-weight:700;color:' + color + ';letter-spacing:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + p.gamertag + '</div>'
      + '<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;margin-top:1px">' + (csr ? csr.tierName : '—') + '</div>'
      + '</div>'
      + '</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px">'
      + [['K/D', s.kd || '—'], [(csr ? csr.display : '—'), 'CSR'], [s.winRate ? s.winRate + '%' : '—', 'WR']].map(function(pair) {
          return '<div style="background:var(--surface2);border-radius:4px;padding:6px 3px;text-align:center">'
            + '<div style="font-family:Rajdhani,sans-serif;font-size:14px;font-weight:700;color:' + color + ';line-height:1">' + pair[0] + '</div>'
            + '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace;margin-top:2px;letter-spacing:.5px">' + pair[1] + '</div>'
            + '</div>';
        }).join('')
      + '</div>'
      + '</div>';
  }

  h += '<div style="display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center;margin-bottom:16px">';
  h += _pCard(me, myCsr, true);
  h += '<div style="text-align:center;padding:0 4px">'
    + '<div style="font-family:Rajdhani,sans-serif;font-size:20px;font-weight:700;color:var(--muted2);letter-spacing:3px">VS</div>'
    + '<div style="margin-top:6px;font-size:8px;font-family:Share Tech Mono,monospace;color:' + vColor + ';letter-spacing:.8px;text-transform:uppercase;white-space:nowrap;line-height:1.4">' + vText + '</div>'
    + '<div style="margin-top:4px;font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace">' + myWins + '–' + theirWins + '</div>'
    + '</div>';
  h += _pCard(them, theirCsr, false);
  h += '</div>';

  // Edge callouts
  if (cats.length >= 2) {
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">';
    if (myBest && myBest.myV > myBest.thV) {
      h += '<div style="background:rgba(0,212,255,0.05);border:1px solid rgba(0,212,255,0.18);border-radius:7px;padding:10px 13px">'
        + '<div style="font-size:8px;color:var(--accent);font-family:Share Tech Mono,monospace;letter-spacing:1.2px;margin-bottom:4px">YOUR EDGE</div>'
        + '<div style="font-family:Rajdhani,sans-serif;font-size:15px;font-weight:700;color:var(--text)">' + myBest.lbl + '</div>'
        + '<div style="font-size:10px;color:var(--muted);font-family:Share Tech Mono,monospace;margin-top:2px">'
        + myBest.fmt(myBest.myV) + ' <span style="color:var(--muted2)">vs</span> ' + myBest.fmt(myBest.thV) + '</div>'
        + '</div>';
    } else {
      h += '<div></div>';
    }
    if (myWorst && myWorst.thV > myWorst.myV) {
      h += '<div style="background:rgba(245,158,11,0.05);border:1px solid rgba(245,158,11,0.18);border-radius:7px;padding:10px 13px">'
        + '<div style="font-size:8px;color:#f59e0b;font-family:Share Tech Mono,monospace;letter-spacing:1.2px;margin-bottom:4px">THEIR EDGE</div>'
        + '<div style="font-family:Rajdhani,sans-serif;font-size:15px;font-weight:700;color:var(--text)">' + myWorst.lbl + '</div>'
        + '<div style="font-size:10px;color:var(--muted);font-family:Share Tech Mono,monospace;margin-top:2px">'
        + myWorst.fmt(myWorst.myV) + ' <span style="color:var(--muted2)">vs</span> ' + myWorst.fmt(myWorst.thV) + '</div>'
        + '</div>';
    } else {
      h += '<div></div>';
    }
    h += '</div>';
  }

  // Tug-of-war bars
  h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:12px">';
  cats.forEach(function(c, i) {
    var myLeads = c.myV >= c.thV;
    var sum = c.myV + c.thV;
    var myPct = Math.round(c.myV / sum * 100);
    var thPct = 100 - myPct;
    var myBarColor = myLeads ? 'var(--accent)' : 'rgba(0,212,255,0.15)';
    var thBarColor = !myLeads ? '#f59e0b' : 'rgba(245,158,11,0.15)';

    h += '<div style="padding:11px 16px' + (i > 0 ? ';border-top:1px solid var(--border)' : '') + '">';
    // Values + label
    h += '<div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;margin-bottom:7px">';
    h += '<div style="font-family:Rajdhani,sans-serif;font-size:15px;font-weight:700;color:' + (myLeads ? 'var(--accent)' : 'var(--muted)') + '">'
       + (myLeads ? '◆ ' : '') + c.fmt(c.myV) + '</div>';
    h += '<div style="font-size:9px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:.8px;text-transform:uppercase;text-align:center;white-space:nowrap">' + c.lbl + '</div>';
    h += '<div style="font-family:Rajdhani,sans-serif;font-size:15px;font-weight:700;color:' + (!myLeads ? '#f59e0b' : 'var(--muted)') + ';text-align:right">'
       + c.fmt(c.thV) + (!myLeads ? ' ◆' : '') + '</div>';
    h += '</div>';
    // Bar
    h += '<div style="display:flex;height:5px;border-radius:3px;overflow:hidden">';
    h += '<div style="width:' + myPct + '%;background:' + myBarColor + ';transition:width 0.5s ease"></div>';
    h += '<div style="width:' + thPct + '%;background:' + thBarColor + ';transition:width 0.5s ease"></div>';
    h += '</div>';
    h += '</div>';
  });
  h += '</div>';

  // Trajectory
  if (myTrend !== null || theirTrend !== null) {
    h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:13px 16px;margin-bottom:12px">';
    h += '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:10px">TRAJECTORY — recent vs career K/D</div>';
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">';

    function _tCard(name, career, recent, trend, col) {
      if (!recent) return '<div></div>';
      var dir = trend > 0.05 ? '↑ IMPROVING' : trend < -0.05 ? '↓ DECLINING' : '→ STEADY';
      var dc  = trend > 0.05 ? 'var(--win)' : trend < -0.05 ? 'var(--loss)' : 'var(--muted)';
      return '<div style="background:var(--surface2);border-radius:6px;padding:10px 12px">'
        + '<div style="font-size:8px;color:' + col + ';font-family:Share Tech Mono,monospace;letter-spacing:1px;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + name + '</div>'
        + '<div style="display:flex;align-items:center;gap:8px">'
        + '<div><div style="font-family:Rajdhani,sans-serif;font-size:16px;font-weight:700;color:var(--muted)">' + career.toFixed(2) + '</div><div style="font-size:7px;color:var(--muted2);font-family:Share Tech Mono,monospace">CAREER</div></div>'
        + '<div style="color:var(--muted2);font-size:11px">→</div>'
        + '<div><div style="font-family:Rajdhani,sans-serif;font-size:16px;font-weight:700;color:' + dc + '">' + recent.toFixed(2) + '</div><div style="font-size:7px;color:var(--muted2);font-family:Share Tech Mono,monospace">RECENT</div></div>'
        + '<div style="font-size:8px;font-family:Share Tech Mono,monospace;color:' + dc + ';font-weight:700;margin-left:auto;white-space:nowrap">' + dir + '</div>'
        + '</div>'
        + '</div>';
    }

    h += _tCard(me.gamertag, myKD, myRKD, myTrend, 'var(--accent)');
    h += _tCard(them.gamertag, theirKD, theirRKD, theirTrend, '#f59e0b');
    h += '</div></div>';
  }

  // New comparison button
  h += '<div style="text-align:center">'
    + '<button onclick="_renderCompareSearch(getAllPlayers()[selectedPlayer]||(data&&data.players&&data.players[0]))" '
    + 'style="background:transparent;border:1px solid var(--border);color:var(--muted);padding:7px 18px;border-radius:4px;font-family:Share Tech Mono,monospace;font-size:10px;cursor:pointer;letter-spacing:1px">'
    + '← COMPARE DIFFERENT PLAYER</button>'
    + '</div>';

  h += '</div>';
  panel.innerHTML = h;
}
