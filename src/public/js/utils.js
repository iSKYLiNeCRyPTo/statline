// Format a player's CSR as a compact rank label.
// `mode` is 'desktop' (full label, e.g. "Diamond 3", "Onyx 1734")
// or 'mobile' (single-letter tier + subtier, e.g. "D3"; Onyx => just the CSR number).
// Returns '' if rank data is incomplete — caller should omit the badge rather than
// render a placeholder. Tier names map to the standard Halo Infinite CSR ladder.
function formatRankLabel(tier, subTier, value, mode){
  if(!tier) return '';
  if(tier === 'Onyx'){
    // Onyx is uncapped — the CSR number is the meaningful identifier.
    // Mobile drops the tier name to save space; desktop keeps "Onyx" for clarity.
    if(value == null) return 'Onyx';
    return mode === 'mobile' ? String(value) : ('Onyx ' + value);
  }
  var sub = subTier != null ? subTier : 1;
  if(mode === 'mobile'){
    var letter = (tier && tier[0]) ? tier[0].toUpperCase() : '?';
    return letter + sub;
  }
  // Desktop: full label like "Diamond 3"
  return tier + ' ' + sub;
}
// Build the HTML for a rank badge that appears next to a player's name.
// Desktop and mobile variants are emitted together — CSS hides the inactive one
// based on viewport width. Returns '' when rank data is missing so the row layout
// is unchanged for unranked matches / private players.
function rankBadgeHtml(player){
  if(!player) return '';
  // Accept both camelCase (renderer-friendly) and snake_case (raw DB column
  // names). The reconstructed-history path in db.js returns rows shaped from
  // the match_participants table; if any caller skips the camelCase mapping,
  // snake_case still surfaces the badge instead of silently dropping it.
  var tier = player.csrTier != null ? player.csrTier : player.csr_tier;
  var sub  = player.csrSubTier != null ? player.csrSubTier : player.csr_subtier;
  var val  = player.csrValue != null ? player.csrValue : player.csr_value;
  var desktopText = formatRankLabel(tier, sub, val, 'desktop');
  var mobileText  = formatRankLabel(tier, sub, val, 'mobile');
  if(!desktopText && !mobileText) return '';
  // Use a single accessible title for screen readers / hover.
  var titleParts = [tier];
  if(tier && tier !== 'Onyx' && sub != null) titleParts.push(sub);
  if(val != null) titleParts.push('· CSR ' + val);
  var title = titleParts.filter(Boolean).join(' ');
  return '<span class="rank-badge" title="'+title.replace(/"/g,'&quot;')+'" aria-label="'+title.replace(/"/g,'&quot;')+'">'
    + '<span class="rank-badge-desktop">'+desktopText+'</span>'
    + '<span class="rank-badge-mobile">'+mobileText+'</span>'
    + '</span>';
}
function rivalAvatar(r,size){
  var init=(r.gamertag||'?')[0].toUpperCase();
  var src=r.xuid?'/api/emblem?xuid='+r.xuid:(r.gamerpicUrl||null);
  var _sz=size?'width:'+size+'px;height:'+size+'px;border-radius:6px;':'';
  if(src){
    return '<img class="rival-avatar" style="'+_sz+'" src="'+src+'" onerror="this.onerror=null;this.style.display=\'none\';this.nextSibling.style.display=\'flex\'" loading="lazy">'
          +'<span class="rival-avatar-placeholder" style="display:none;'+_sz+'font-size:'+(size?Math.round(size*0.36):10)+'px">'+init+'</span>';
  }
  return '<span class="rival-avatar-placeholder" style="'+_sz+'font-size:'+(size?Math.round(size*0.36):10)+'px">'+init+'</span>';
}
function timeAgo(iso){if(!iso)return'';var diff=Date.now()-new Date(iso).getTime(),m=Math.floor(diff/60000),h=Math.floor(m/60),d=Math.floor(h/24);if(d>0)return d+'d ago';if(h>0)return h+'h ago';if(m>0)return m+'m ago';return'just now';}
function formatDur(iso){if(!iso)return'';var p=iso.match(/PT(?:(\d+)M)?(?:([\d.]+)S)?/);if(!p)return'';return(parseInt(p[1]||0))+'m '+Math.floor(parseFloat(p[2]||0))+'s';}
function medalImg(medal){
  // If no sprite data, just show medal name as a badge
  if(!medal || !medal.nameId) return '';var meta=medalMeta[medal.nameId]||{},name=meta.name||medal.name||String(medal.nameId),idx=meta.spriteIndex!==undefined?meta.spriteIndex:null,cols=meta.columns||16,glow={normal:'#00e676',heroic:'#3b82f6',legendary:'#7c3aed',mythic:'#ff3d57'}[meta.difficulty||'normal'],inner=idx!==null?'<img src="'+MEDAL_SHEET+'" style="position:absolute;width:'+(cols*60)+'px;height:auto;top:-'+(Math.floor(idx/cols)*60)+'px;left:-'+((idx%cols)*60)+'px" onerror="this.parentNode.innerHTML=\'<span style=&quot;font-size:22px;line-height:60px&quot;><svg xmlns=&quot;http://www.w3.org/2000/svg&quot; width=&quot;22&quot; height=&quot;22&quot; viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;2&quot;><circle cx=&quot;12&quot; cy=&quot;8&quot; r=&quot;6&quot;/><path d=&quot;M15.477 12.89L17 22l-5-3-5 3 1.523-9.11&quot;/></svg></span>\'">':'<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"22\\" height=\\"22\\" viewBox=\\"0 0 24 24\\" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"2\\"><circle cx=\\"12\\" cy=\\"8\\" r=\\"6\\"/><path d=\\"M15.477 12.89L17 22l-5-3-5 3 1.523-9.11\\"/></svg>';var nameShort=name.length>14?name.slice(0,13)+'…':name;
return'<div class="medal-item" title="'+name+'"><div class="medal-wrap" style="box-shadow:0 0 8px '+glow+'44">'+inner+'</div><div class="medal-name">'+nameShort+'</div><div class="medal-count">×'+medal.count.toLocaleString()+'</div></div>';}
var CSR_STYLES={Bronze:{bg:'rgba(205,124,47,0.12)',border:'#cd7c2f',text:'#cd7c2f'},Silver:{bg:'rgba(148,163,184,0.12)',border:'#94a3b8',text:'#94a3b8'},Gold:{bg:'rgba(255,193,7,0.12)',border:'#ffc107',text:'#ffc107'},Platinum:{bg:'rgba(93,202,165,0.12)',border:'#5DCAA5',text:'#5DCAA5'},Diamond:{bg:'rgba(133,183,235,0.12)',border:'#85B7EB',text:'#85B7EB'},Onyx:{bg:'rgba(175,169,236,0.12)',border:'#AFA9EC',text:'#AFA9EC'}};
var CAREER_EMBLEMS_ONYX={
  'Cadet': 'https://halo.wiki.gallery/images/thumb/6/64/HINF_-_Emblem_icon_-_Onyx_Cadet.png/200px-HINF_-_Emblem_icon_-_Onyx_Cadet.png',
  'Private': 'https://halo.wiki.gallery/images/thumb/5/5c/HINF_-_Emblem_icon_-_Onyx_Private.png/200px-HINF_-_Emblem_icon_-_Onyx_Private.png',
  'Lance Corporal': 'https://halo.wiki.gallery/images/thumb/e/e6/HINF_-_Emblem_icon_-_Onyx_Lance_Corporal.png/200px-HINF_-_Emblem_icon_-_Onyx_Lance_Corporal.png',
  'Corporal': 'https://halo.wiki.gallery/images/thumb/c/cf/HINF_-_Emblem_icon_-_Onyx_Corporal.png/200px-HINF_-_Emblem_icon_-_Onyx_Corporal.png',
  'Sergeant': 'https://halo.wiki.gallery/images/thumb/c/c2/HINF_-_Emblem_icon_-_Onyx_Sergeant.png/200px-HINF_-_Emblem_icon_-_Onyx_Sergeant.png',
  'Staff Sergeant': 'https://halo.wiki.gallery/images/thumb/b/bf/HINF_-_Emblem_icon_-_Onyx_Staff_Sergeant.png/200px-HINF_-_Emblem_icon_-_Onyx_Staff_Sergeant.png',
  'Gunnery Sergeant': 'https://halo.wiki.gallery/images/thumb/6/60/HINF_-_Emblem_icon_-_Onyx_Gunnery_Sergeant.png/200px-HINF_-_Emblem_icon_-_Onyx_Gunnery_Sergeant.png',
  'Master Sergeant': 'https://halo.wiki.gallery/images/thumb/7/7f/HINF_-_Emblem_icon_-_Onyx_Master_Sergeant.png/200px-HINF_-_Emblem_icon_-_Onyx_Master_Sergeant.png',
  'Master Gunnery Sergeant': 'https://halo.wiki.gallery/images/thumb/c/c5/HINF_-_Emblem_icon_-_Onyx_Master_Gunnery_Sergeant.png/200px-HINF_-_Emblem_icon_-_Onyx_Master_Gunnery_Sergeant.png',
  'Warrant Officer': 'https://halo.wiki.gallery/images/thumb/9/9d/HINF_-_Emblem_icon_-_Onyx_Warrant_Officer.png/200px-HINF_-_Emblem_icon_-_Onyx_Warrant_Officer.png',
  'Chief Warrant Officer': 'https://halo.wiki.gallery/images/thumb/6/6e/HINF_-_Emblem_icon_-_Onyx_Chief_Warrant_Officer.png/200px-HINF_-_Emblem_icon_-_Onyx_Chief_Warrant_Officer.png',
  'Second Lieutenant': 'https://halo.wiki.gallery/images/thumb/f/f3/HINF_-_Emblem_icon_-_Onyx_Second_Lieutenant.png/200px-HINF_-_Emblem_icon_-_Onyx_Second_Lieutenant.png',
  'First Lieutenant': 'https://halo.wiki.gallery/images/thumb/a/ab/HINF_-_Emblem_icon_-_Onyx_First_Lieutenant.png/200px-HINF_-_Emblem_icon_-_Onyx_First_Lieutenant.png',
  'Captain': 'https://halo.wiki.gallery/images/thumb/f/fa/HINF_-_Emblem_icon_-_Onyx_Captain.png/200px-HINF_-_Emblem_icon_-_Onyx_Captain.png',
  'Major': 'https://halo.wiki.gallery/images/thumb/f/f3/HINF_-_Emblem_icon_-_Onyx_Major.png/200px-HINF_-_Emblem_icon_-_Onyx_Major.png',
  'Lt. Colonel': 'https://halo.wiki.gallery/images/thumb/0/06/HINF_-_Emblem_icon_-_Onyx_Lt._Colonel.png/200px-HINF_-_Emblem_icon_-_Onyx_Lt._Colonel.png',
  'General': 'https://halo.wiki.gallery/images/thumb/d/d8/HINF_-_Emblem_icon_-_Onyx_General.png/200px-HINF_-_Emblem_icon_-_Onyx_General.png',
  'Hero': 'https://halo.wiki.gallery/images/thumb/2/26/HINF_-_Emblem_icon_-_Onyx_Hero.png/200px-HINF_-_Emblem_icon_-_Onyx_Hero.png'
};
var CSR_EMBLEMS={
  bronze:'https://halo.wiki.gallery/images/thumb/3/3b/HINF_-_Emblem_icon_-_Signum_Bronze_S6.png/200px-HINF_-_Emblem_icon_-_Signum_Bronze_S6.png',
  silver:'https://halo.wiki.gallery/images/thumb/3/39/HINF_-_Emblem_icon_-_Signum_Silver_S6.png/200px-HINF_-_Emblem_icon_-_Signum_Silver_S6.png',
  gold:'https://halo.wiki.gallery/images/thumb/a/a4/HINF_-_Emblem_icon_-_Signum_Gold_S6.png/200px-HINF_-_Emblem_icon_-_Signum_Gold_S6.png',
  platinum:'https://halo.wiki.gallery/images/thumb/a/a5/HINF_-_Emblem_icon_-_Signum_Platinum_S6.png/200px-HINF_-_Emblem_icon_-_Signum_Platinum_S6.png',
  diamond:'https://halo.wiki.gallery/images/thumb/d/d4/HINF_-_Emblem_icon_-_Signum_Diamond_S6.png/200px-HINF_-_Emblem_icon_-_Signum_Diamond_S6.png',
  onyx:'https://halo.wiki.gallery/images/thumb/3/36/HINF_-_Emblem_icon_-_Signum_Onyx_S6.png/200px-HINF_-_Emblem_icon_-_Signum_Onyx_S6.png'
};
function careerIcon(tier,rank,style,crRankNum){
  if(tier==='Onyx'&&CAREER_EMBLEMS_ONYX[rank]){
    return '<img src="'+CAREER_EMBLEMS_ONYX[rank]+'" alt="'+rank+'" style="width:100%;height:100%;object-fit:contain">';
  }
  return csrIcon(tier||'Bronze',style.border,style.bg);
}
function csrIcon(tier,border,bg){var t=tier.toLowerCase();var src=CSR_EMBLEMS[t];if(!src)return'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"22\" height=\"22\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" style=\"vertical-align:-1px\"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11"/></svg>';return'<img src="'+src+'" alt="'+tier+'" style="width:100%;height:100%;object-fit:contain">';}
function renderCsrCards(csr,matches){
  if(!csr)return'';
  // Ranked Arena always renders first — it is the primary competitive metric.
  var _order=['Ranked Arena','Ranked Slayer','Ranked Legacy'];
  var entries=Object.entries(csr).filter(function(e){return e[1]&&e[1].tier;});
  entries.sort(function(a,b){
    var ai=_order.indexOf(a[0]),bi=_order.indexOf(b[0]);
    if(ai===-1&&bi===-1)return 0;if(ai===-1)return 1;if(bi===-1)return-1;return ai-bi;
  });
  return entries.map(function(e){
    var label=e[0],c=e[1];
    var s=CSR_STYLES[c.tier]||{bg:'var(--surface2)',border:'var(--border)',text:'var(--text)',icon:''};
    var isArena=label==='Ranked Arena';
    var detailLabel=label+(isArena?' · primary':'');
    return'<div class="csr-card" style="border-color:'+s.border+'33;background:'+s.bg+'"><div class="csr-icon" style="background:'+s.bg+';border:2px solid '+s.border+';color:'+s.text+'">'+csrIcon(c.tier,s.border,s.bg)+'</div><div class="csr-info"><div class="csr-tier" style="color:'+s.text+'">'+c.display+'</div><div class="csr-detail">CSR '+c.value+' · '+detailLabel+'</div><div class="csr-bar-wrap"><div class="csr-bar-fill" style="width:'+(c.pct||0)+'%;background:'+s.border+'"></div></div><div class="csr-bar-labels"><span>'+(c.tier==='Onyx'?'Onyx':c.tier+' '+(c.subTier||1))+'</span><span>'+(c.pct||0)+'%</span><span>'+(c.nextLabel||'')+'</span></div>'+(c.seasonMax?'<div style="margin-top:6px;font-size:10px;font-family:Share Tech Mono,monospace;color:var(--muted)">Season peak: <span style="color:var(--gold)">'+c.seasonMax+'</span>'+(c.allTimeMax&&c.allTimeMax!==c.seasonMax?'<br>All-time: <span style="color:var(--accent)">'+c.allTimeMax+'</span>':'')+'</div>':'')+'</div></div>';
  }).join('');
}
function renderConnectionDetail(cq){
  if(!cq||!cq.signals.length)return'';
  return'<div style="margin:10px 0;padding:10px 14px;background:var(--surface2);border-radius:6px;border-left:3px solid '+cq.verdict.color+'">'
    +'<div style="font-size:10px;color:'+cq.verdict.color+';font-family:Share Tech Mono,monospace;font-weight:700;margin-bottom:6px">'+cq.verdict.label+'</div>'
    +'<div style="display:flex;flex-direction:column;gap:4px">'
    +cq.signals.map(function(s){
      return'<div style="font-size:10px;color:'+(s.bad?'var(--loss)':'var(--win)')+'">'+(s.bad?'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"11\" height=\"11\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" style=\"vertical-align:-1px\"><path d=\"M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z\"/><line x1=\"12\" y1=\"9\" x2=\"12\" y2=\"13\"/><line x1=\"12\" y1=\"17\" x2=\"12.01\" y2=\"17\"/></svg> ':'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"11\" height=\"11\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" style=\"vertical-align:-1px\"><polyline points=\"20 6 9 17 4 12\"/></svg> ')+s.msg+'</div>';
    }).join('')
    +'</div></div>';
}
