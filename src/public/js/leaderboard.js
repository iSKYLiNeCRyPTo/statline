// ── Leaderboard — embedded in main app ────────────────────────────────────────
var _lbTabData = {};
var _lbTab     = 'csrArena';
var _lbPage    = 1;
var _lbSearch  = '';
var LB_PER_PAGE = 250;
var LB_TTL      = 2 * 60 * 1000; // 2 min

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
  // Sidebar active state — clear player tabs, highlight LB button
  document.querySelectorAll('.sidebar-nav-item').forEach(function(b){ b.classList.remove('active'); });
  var lbBtn = document.getElementById('lbSidebarBtn');
  if (lbBtn) lbBtn.classList.add('active');
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
  _lbLoadTab(tab);
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
