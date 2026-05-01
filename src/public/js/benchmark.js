// benchmark.js — Rank Benchmark card
// Fetches /api/rank-comparison and renders a percentile breakdown for the current player.
(function () {

  var STAT_LABELS = {
    kd:        'K/D Ratio',
    win_rate:  'Win Rate',
    accuracy:  'Accuracy',
    avg_kills: 'Avg Kills',
  };
  var STAT_UNITS = {
    kd: '', win_rate: '%', accuracy: '%', avg_kills: '',
  };
  var STAT_ORDER = ['kd', 'win_rate', 'accuracy', 'avg_kills'];

  function fmtVal(key, val) {
    if (val == null || isNaN(val)) return '—';
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

  function renderRow(key, playerVal, peerAvg, peerPct, nextAvg) {
    var label = STAT_LABELS[key];
    var youStr = fmtVal(key, playerVal);
    var peerStr = fmtVal(key, peerAvg);
    var nextStr = nextAvg != null ? fmtVal(key, nextAvg) : null;
    var pct = peerPct != null ? peerPct : null;
    var barColor = pct != null ? pctColor(pct) : 'var(--muted2)';
    var barWidth = pct != null ? Math.max(3, pct) : 50;
    var badge = pct != null ? pctLabel(pct) : '';

    // Delta hint toward next rank
    var deltaHtml = '';
    if (nextAvg != null && playerVal != null) {
      var diff = parseFloat(nextAvg) - parseFloat(playerVal);
      if (Math.abs(diff) > 0.01) {
        var sign = diff > 0 ? '+' : '';
        var diffStr = sign + diff.toFixed(key === 'win_rate' || key === 'accuracy' ? 1 : 2) + STAT_UNITS[key];
        var needColor = diff > 0 ? 'var(--loss)' : 'var(--win)'; // red if you need to improve, green if already above
        deltaHtml = '<span style="font-size:9px;color:' + needColor + ';font-family:Share Tech Mono,monospace;margin-left:4px" title="difference from next rank avg">' + diffStr + '</span>';
      } else {
        deltaHtml = '<span style="font-size:9px;color:var(--win);font-family:Share Tech Mono,monospace;margin-left:4px">✓</span>';
      }
    }

    var h = '';
    h += '<div style="display:grid;grid-template-columns:80px 1fr 70px;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)">';

    // Stat label + your value
    h += '<div>';
    h += '<div style="font-size:9px;font-family:Share Tech Mono,monospace;color:var(--muted2);letter-spacing:1px;text-transform:uppercase">' + label + '</div>';
    h += '<div style="font-size:15px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--text)">' + youStr + '</div>';
    h += '</div>';

    // Progress bar + peer context
    h += '<div>';
    h += '<div style="display:flex;justify-content:space-between;margin-bottom:4px">';
    h += '<span style="font-size:10px;font-family:Share Tech Mono,monospace;color:var(--muted)">peer avg: ' + peerStr + '</span>';
    if (badge) h += '<span style="font-size:9px;font-family:Share Tech Mono,monospace;color:' + barColor + '">' + badge + ' (' + pct + 'th)</span>';
    h += '</div>';
    h += '<div style="height:5px;background:var(--surface2);border-radius:3px;position:relative;overflow:visible">';
    h += '<div style="height:100%;width:' + barWidth + '%;background:' + barColor + ';border-radius:3px;transition:width 0.6s ease;max-width:100%"></div>';
    // Marker at 50%
    h += '<div style="position:absolute;top:-2px;left:50%;width:1px;height:9px;background:var(--border2);transform:translateX(-50%)"></div>';
    h += '</div>';
    h += '</div>';

    // Next rank column
    h += '<div style="text-align:right">';
    if (nextStr) {
      h += '<div style="font-size:9px;font-family:Share Tech Mono,monospace;color:var(--muted2)">next rank</div>';
      h += '<div style="font-size:13px;font-weight:700;font-family:Rajdhani,sans-serif;color:var(--muted)">' + nextStr + deltaHtml + '</div>';
    }
    h += '</div>';

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

    var h = '';
    // Header
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
    h += '<div>';
    h += '<div style="font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted2);font-family:Share Tech Mono,monospace">Rank Benchmark</div>';
    h += '<div style="font-size:12px;font-family:Share Tech Mono,monospace;color:var(--accent);margin-top:2px">';
    h += rank.display + ' · ' + peers.count + ' players tracked';
    h += '</div>';
    // Always show which playlist the benchmark is based on
    h += '<div style="margin-top:4px;font-size:10px;font-family:Share Tech Mono,monospace;color:var(--muted2)">';
    h += 'benchmarking vs <span style="color:' + (isArena ? 'var(--accent)' : 'var(--gold)') + '">' + playlist + '</span> peers';
    h += '</div>';
    // If not Arena, show what their Arena rank actually is so context is clear
    if (!isArena) {
      var arenaEntry = allPlaylists.find(function(p) { return p.label === 'Ranked Arena'; });
      if (arenaEntry) {
        h += '<div style="margin-top:2px;font-size:10px;font-family:Share Tech Mono,monospace;color:var(--gold)">';
        h += '⚠ Ranked Arena (' + arenaEntry.display + ') is the primary competitive metric';
        h += '</div>';
      }
    }
    h += '</div>';
    if (next) {
      h += '<div style="text-align:right">';
      h += '<div style="font-size:9px;font-family:Share Tech Mono,monospace;color:var(--muted2)">target</div>';
      h += '<div style="font-size:11px;font-family:Share Tech Mono,monospace;color:var(--muted)">' + next.label + '</div>';
      h += '</div>';
    }
    h += '</div>';

    // Column headers for next rank area
    h += '<div style="display:grid;grid-template-columns:80px 1fr 70px;gap:10px;margin-bottom:2px">';
    h += '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase">YOUR STAT</div>';
    h += '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;text-align:center">RANK PERCENTILE</div>';
    h += '<div style="font-size:8px;color:var(--muted2);font-family:Share Tech Mono,monospace;text-transform:uppercase;text-align:right">' + (next ? next.label.toUpperCase() + ' AVG' : '') + '</div>';
    h += '</div>';

    // Stat rows
    STAT_ORDER.forEach(function (key) {
      var playerVal = player[key];
      var peerAvg   = peers.avg   ? peers.avg[key]         : null;
      var peerPct   = peers.percentiles ? peers.percentiles[key] : null;
      var nextAvg   = next && next.avg ? next.avg[key] : null;
      h += renderRow(key, playerVal, peerAvg, peerPct, nextAvg);
    });

    // Footer note
    h += '<div style="margin-top:10px;font-size:9px;font-family:Share Tech Mono,monospace;color:var(--muted2);text-align:right">';
    h += 'Based on players searched in the last 30 days';
    h += '</div>';

    return h;
  }

  function renderEmpty(reason) {
    var msg = reason === 'not_cached'  ? 'Search a player to see rank data.' :
              reason === 'no_csr'      ? 'No ranked CSR data — play ranked matches first.' :
              'Not enough data yet. Check back as more players search this rank.';
    return '<div style="font-size:11px;font-family:Share Tech Mono,monospace;color:var(--muted2);text-align:center;padding:16px 0">'
         + '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
         + msg + '</div>';
  }

  window.loadRankBenchmark = function (gamertag, csr) {
    var el = document.getElementById('rankBenchmarkCard');
    if (!el) return;
    if (!csr || !Object.keys(csr).length) { el.style.display = 'none'; return; }

    // Show skeleton while loading
    el.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:12px 0;color:var(--muted2);font-family:Share Tech Mono,monospace;font-size:11px">'
      + '<div style="width:10px;height:10px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.7s linear infinite;flex-shrink:0"></div>'
      + 'Loading rank comparison…</div>';

    fetch('/api/rank-comparison?gamertag=' + encodeURIComponent(gamertag))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.available || !data.peers || data.peers.count < 5) {
          el.innerHTML = renderEmpty(data.reason || 'no_data');
          return;
        }
        el.innerHTML = renderCard(data);
      })
      .catch(function () { el.innerHTML = ''; });
  };

})();
