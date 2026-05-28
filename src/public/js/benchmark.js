// benchmark.js — Rank Benchmark card
// Fetches /api/rank-comparison and renders a percentile breakdown for the current player.
(function () {

  var STAT_LABELS = {
    kd:         'K/D Ratio',
    win_rate:   'Win Rate',
    accuracy:   'Accuracy',
    avg_kills:  'Kills/Min',
    avg_damage: 'Dmg/Min',
  };
  var STAT_UNITS = {
    kd: '', win_rate: '%', accuracy: '%', avg_kills: '', avg_damage: '',
  };
  var STAT_ORDER = ['kd', 'win_rate', 'accuracy', 'avg_kills', 'avg_damage'];

  function fmtVal(key, val) {
    if (val == null || isNaN(val)) return '—';
    if (key === 'avg_damage') return Math.round(parseFloat(val)).toLocaleString() + STAT_UNITS[key];
    return parseFloat(val).toFixed(key === 'kd' || key === 'avg_kills' ? 2 : 1) + STAT_UNITS[key];
  }

  function pctColor(pct) {
    if (pct >= 70) return 'var(--win)';
    if (pct >= 40) return 'var(--gold)';
    return 'var(--loss)';
  }

  function pctLabel(pct) {
    if (pct == null) return '';
    if (pct >= 90) return 'Top 10%';
    if (pct >= 75) return 'Top 25%';
    if (pct >= 50) return 'Above avg';
    if (pct >= 25) return 'Below avg';
    return 'Bottom 25%';
  }

  function renderRow(key, playerVal, peerAvg, peerPct, nextAvg, proAvg, peersCount) {
    var label = STAT_LABELS[key];
    var youStr = fmtVal(key, playerVal);
    var peerStr = fmtVal(key, peerAvg);
    var nextStr = nextAvg != null ? fmtVal(key, nextAvg) : null;
    var proStr  = proAvg  != null ? fmtVal(key, proAvg)  : null;
    var pct = peerPct != null ? peerPct : null;
    var barColor = pct != null ? pctColor(pct) : 'var(--muted2)';
    var barWidth = pct != null ? Math.max(3, pct) : 50;
    var badge = pct != null ? pctLabel(pct) : '';

    // Delta hint — show gap to pro avg if available, otherwise next rank
    var deltaTarget = proAvg != null ? proAvg : nextAvg;
    var deltaLabel  = proAvg != null ? 'vs pro' : 'vs next rank';
    var deltaHtml = '';
    if (deltaTarget != null && playerVal != null) {
      var diff = parseFloat(deltaTarget) - parseFloat(playerVal);
      if (Math.abs(diff) > 0.01) {
        var sign = diff > 0 ? '+' : '';
        var diffStr = sign + diff.toFixed(key === 'win_rate' || key === 'accuracy' ? 1 : 2) + STAT_UNITS[key];
        var needColor = diff > 0 ? 'var(--loss)' : 'var(--win)';
        deltaHtml = '<span style="font-size:11px;color:' + needColor + ';font-family:Share Tech Mono,monospace;margin-left:4px" title="' + deltaLabel + '">' + diffStr + '</span>';
      } else {
        deltaHtml = '<span style="font-size:11px;color:var(--win);font-family:Share Tech Mono,monospace;margin-left:4px">✓</span>';
      }
    }

    var hasPro = proStr != null;
    var cols = hasPro ? '90px 1fr 64px 64px' : '90px 1fr 80px';
    var h = '';
    h += '<div style="display:grid;grid-template-columns:' + cols + ';gap:12px;align-items:center;padding:9px 0;border-bottom:1px solid var(--border)">';

    // Stat label + your value
    h += '<div>';
    h += '<div style="font-size:10px;font-family:Share Tech Mono,monospace;color:var(--muted2);letter-spacing:1px;text-transform:uppercase">' + label + '</div>';
    h += '<div style="font-size:17px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--text)">' + youStr + deltaHtml + '</div>';
    h += '</div>';

    // Progress bar + peer context
    h += '<div>';
    h += '<div style="display:flex;justify-content:space-between;margin-bottom:5px">';
    h += '<span style="font-size:11px;font-family:Share Tech Mono,monospace;color:var(--muted)">peer avg: ' + peerStr + '</span>';
    if (badge) {
      var placeStr = '';
      if (peersCount > 0 && pct != null) {
        var place = Math.max(1, Math.ceil(peersCount * (1 - pct / 100)));
        placeStr = ' (#' + place + ' of ' + peersCount + ')';
      }
      h += '<span style="font-size:11px;font-family:Share Tech Mono,monospace;color:' + barColor + '">' + badge + placeStr + '</span>';
    }
    h += '</div>';
    h += '<div style="height:6px;background:var(--surface2);border-radius:3px;position:relative;overflow:visible">';
    h += '<div style="height:100%;width:' + barWidth + '%;background:' + barColor + ';border-radius:3px;transition:width 0.6s ease;max-width:100%"></div>';
    h += '<div style="position:absolute;top:-2px;left:50%;width:1px;height:10px;background:var(--border2);transform:translateX(-50%)"></div>';
    h += '</div>';
    h += '</div>';

    // Pro column
    if (hasPro) {
      h += '<div style="text-align:right">';
      h += '<div style="font-size:15px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--gold)">' + proStr + '</div>';
      h += '</div>';
    }

    // Next rank column
    h += '<div style="text-align:right">';
    if (nextStr) {
      h += '<div style="font-size:15px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--muted)">' + nextStr + '</div>';
    }
    h += '</div>';

    h += '</div>';
    return h;
  }

  // Playlist toggle: which playlists the player has any CSR for. Each entry
  // becomes a button on the Rank Benchmark card so the user can compare
  // themselves against Ranked Arena / Slayer / Legacy peers separately.
  // `csrSnapshot` is preserved from the initial loadRankBenchmark call so the
  // toggle does not need a second profile fetch.
  function renderToggle(allPlaylists, current) {
    var pls = ['Ranked Arena', 'Ranked Slayer', 'Ranked Legacy']
      .filter(function (p) { return allPlaylists.some(function (a) { return a.label === p; }); });
    if (pls.length < 2) return '';
    var h = '<div class="rbm-toggle" style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">';
    pls.forEach(function (p) {
      var active = p === current;
      var bg = active ? 'var(--accent)' : 'transparent';
      var color = active ? 'var(--bg)' : 'var(--muted)';
      var border = active ? 'var(--accent)' : 'var(--border)';
      h += '<button type="button" data-rbm-playlist="' + p + '" '
        + 'style="font-family:Share Tech Mono,monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;'
        + 'padding:5px 10px;border-radius:4px;cursor:pointer;background:' + bg + ';color:' + color + ';border:1px solid ' + border + '">'
        + p.replace('Ranked ', '') + '</button>';
    });
    h += '</div>';
    return h;
  }

  function renderCard(data) {
    var peers = data.peers;
    var next  = data.nextRank;
    var rank  = data.rank;
    var player = data.player || {};
    var playlist = data.playlist || '';
    var isArena = data.isArena;
    var allPlaylists = data.allPlaylists || [];
    var pro = data.pro || null; // pro player aggregate stats
    var statsSource = data.statsSource || 'career'; // 'recent' | 'career'
    var statsGames  = data.statsGames  || null;
    var lowData     = peers.count < 20; // flag thin peer pools

    var h = '';
    // Header
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">';
    h += '<div>';
    h += '<div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted2);font-family:Share Tech Mono,monospace">Rank Benchmark</div>';
    h += '<div style="font-size:13px;font-family:Share Tech Mono,monospace;color:var(--accent);margin-top:3px">';
    h += rank.display + ' · ' + peers.count + ' player' + (peers.count !== 1 ? 's' : '') + ' tracked';
    h += '</div>';
    h += '<div style="margin-top:4px;font-size:11px;font-family:Share Tech Mono,monospace;color:var(--muted2)">';
    h += 'benchmarking vs <span style="color:' + (isArena ? 'var(--accent)' : 'var(--gold)') + '">' + playlist + '</span> peers';
    h += '</div>';
    // Per-playlist toggle (Arena / Slayer / Legacy) — only renders when the
    // player has CSR in at least two playlists.
    h += renderToggle(allPlaylists, playlist);
    // Low peer count warning
    if (lowData) {
      h += '<div style="margin-top:4px;font-size:11px;font-family:Share Tech Mono,monospace;color:var(--muted2)">';
      h += '⚠ Small sample (' + peers.count + ' peers) — percentiles less reliable';
      h += '</div>';
    }
    h += '</div>';
    if (next) {
      h += '<div style="text-align:right">';
      h += '<div style="font-size:10px;font-family:Share Tech Mono,monospace;color:var(--muted2)">Target</div>';
      h += '<div style="font-size:13px;font-family:Share Tech Mono,monospace;color:var(--muted)">' + next.label + '</div>';
      h += '</div>';
    }
    h += '</div>';

    // Column headers
    var hasPro = pro && pro.count > 0;
    var cols = hasPro ? '90px 1fr 64px 64px' : '90px 1fr 80px';
    h += '<div style="display:grid;grid-template-columns:' + cols + ';gap:12px;margin-bottom:3px">';
    // Show stat source in the "YOUR STAT" column header
    var yourStatLabel = statsSource === 'recent' && statsGames
      ? 'YOUR STAT <span style="color:var(--muted2);font-weight:400">last ' + statsGames + 'g</span>'
      : 'YOUR STAT <span style="color:var(--muted2);font-weight:400">career</span>';
    h += '<div style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase">' + yourStatLabel + '</div>';
    h += '<div style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;text-align:center">RANK PERCENTILE</div>';
    if (hasPro) {
      h += '<div style="font-size:10px;color:var(--gold);font-family:Share Tech Mono,monospace;text-transform:uppercase;text-align:right">PRO AVG</div>';
    }
    h += '<div style="font-size:10px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;text-align:right">' + (next ? next.label.toUpperCase() : '') + '</div>';
    h += '</div>';

    // Stat rows
    STAT_ORDER.forEach(function (key) {
      var playerVal = player[key];
      var peerAvg   = peers.avg        ? peers.avg[key]         : null;
      var peerPct   = peers.percentiles ? peers.percentiles[key] : null;
      var nextAvg   = next && next.avg  ? next.avg[key]          : null;
      var proAvg    = hasPro            ? pro[key]               : null;
      h += renderRow(key, playerVal, peerAvg, peerPct, nextAvg, proAvg, peers.count);
    });

    // Footer
    h += '<div style="margin-top:10px;font-size:11px;font-family:Share Tech Mono,monospace;color:var(--muted2);display:flex;justify-content:space-between">';
    h += '<span>Peers: players searched in the last 30 days</span>';
    if (hasPro) h += '<span style="color:var(--gold)">★ ' + pro.count + ' pro' + (pro.count !== 1 ? 's' : '') + ' tracked</span>';
    h += '</div>';

    return h;
  }

  function renderEmpty(reason, opts) {
    opts = opts || {};
    var playlist = opts.playlist || '';
    var allPlaylists = opts.allPlaylists || [];
    var msg = reason === 'not_cached'  ? 'Search a player to see rank data.' :
              reason === 'no_csr'      ? (playlist
                  ? 'No CSR data for ' + playlist + ' — play matches in this playlist first.'
                  : 'No ranked CSR data — play ranked matches first.') :
              reason === 'insufficient_peers'
                ? 'Not enough ' + (playlist || 'ranked') + ' peer data yet — try Ranked Arena.'
                : 'Not enough data yet. Check back as more players search this rank.';
    var h = '<div style="font-size:12px;font-family:Share Tech Mono,monospace;color:var(--muted2);text-align:center;padding:16px 0">'
         + '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
         + msg + '</div>';
    if (allPlaylists.length) h += '<div style="display:flex;justify-content:center">' + renderToggle(allPlaylists, playlist) + '</div>';
    return h;
  }

  function fetchAndRender(el, gamertag, playlist, csrSnapshot) {
    el.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:12px 0;color:var(--muted2);font-family:Share Tech Mono,monospace;font-size:12px">'
      + '<div style="width:10px;height:10px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.7s linear infinite;flex-shrink:0"></div>'
      + 'Loading rank comparison…</div>';

    var url = '/api/rank-comparison?gamertag=' + encodeURIComponent(gamertag);
    if (playlist) url += '&playlist=' + encodeURIComponent(playlist);

    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        // Build allPlaylists fallback from the CSR snapshot in case the
        // endpoint shortcuts (e.g. no_csr for a specific playlist) — we still
        // want the toggle visible so the user can switch back.
        var pls = data.allPlaylists && data.allPlaylists.length
          ? data.allPlaylists
          : (csrSnapshot
              ? Object.keys(csrSnapshot)
                  .filter(function (k) { return csrSnapshot[k] && csrSnapshot[k].tier; })
                  .map(function (k) { return { label: k, display: csrSnapshot[k].display, value: csrSnapshot[k].value }; })
              : []);
        if (!data.available) {
          el.innerHTML = renderEmpty(data.reason || 'no_data', { playlist: playlist, allPlaylists: pls });
        } else if (!data.peers || data.peers.count < 5) {
          el.innerHTML = renderEmpty('insufficient_peers', { playlist: data.playlist || playlist, allPlaylists: pls });
        } else {
          el.innerHTML = renderCard(data);
        }
        // Wire up toggle buttons (event delegation kept simple — re-bind on each render).
        Array.prototype.forEach.call(el.querySelectorAll('[data-rbm-playlist]'), function (btn) {
          btn.addEventListener('click', function () {
            var pl = btn.getAttribute('data-rbm-playlist');
            if (pl === (data.playlist || playlist)) return;
            fetchAndRender(el, gamertag, pl, csrSnapshot);
          });
        });
      })
      .catch(function () { el.innerHTML = ''; });
  }

  var _lastBenchmarkGt = null;

  window.loadRankBenchmark = function (gamertag, csr) {
    var el = document.getElementById('rankBenchmarkCard');
    if (!el) return;
    if (!csr || !Object.keys(csr).length) { el.style.display = 'none'; return; }
    // Skip re-fetch if the card already has content for this gamertag.
    // render() is called multiple times (e.g. skill poll re-render) but the
    // benchmark data doesn't change between renders — avoid the double-load flicker.
    if (_lastBenchmarkGt === gamertag && el.children.length > 0) return;
    _lastBenchmarkGt = gamertag;
    fetchAndRender(el, gamertag, null, csr);
  };

  window.resetRankBenchmark = function () { _lastBenchmarkGt = null; };

})();
