function renderCsrFromMatches(matches,playlist,color){
  // Build CSR progression from match csrDelta — only ranked matches for this playlist.
  //
  // Three data shapes feed this chart:
  //   1. Real history fetched directly from Halo — populates `csrDelta` and
  //      `csrAfter` (string like "Onyx 1500" or "Diamond 4"). Older matches in
  //      the same season can drop csrDelta but still have csrAfter.
  //   2. Reconstructed history (private profiles) — populates the numeric
  //      `csrValue` per match (1298, 1500, …) and may have csrDelta+csrAfter,
  //      but the csrAfter string for non-Onyx tiers is "Diamond 4" where 4 is
  //      the subTier index, NOT a CSR number. parseInt of that would chart
  //      tier indices as if they were CSR — which is the bug we are fixing.
  //   3. Reconstructed non-Onyx — Halo API only returns Tier+SubTier (not
  //      numeric Value) for non-Onyx players in match RankRecap. We synthesise
  //      a 0–1499 scale (Bronze=0, Silver=300, Gold=600, Platinum=900,
  //      Diamond=1200; each sub-tier = +50) so tier-to-tier promotion/demotion
  //      is still visible. Movements *within* a sub-tier are invisible.

  // Tier → synthetic CSR base value
  var _TIER_BASE={Bronze:0,Silver:300,Gold:600,Platinum:900,Diamond:1200};
  // Track whether any value came from the synthetic path so we can show a note.
  var _usedSynthetic=false;

  function _csrFrom(m){
    // Prefer the explicit numeric CSR value (real CSR, e.g. 1298).
    if(m.csrValue!=null) return +m.csrValue;
    if(m.csr_value!=null) return +m.csr_value;
    // Fall back to parsing csrAfter ONLY when the tier is Onyx (where the
    // trailing number IS the CSR). For non-Onyx tiers parseInt would pick up
    // the subTier (1–6) and produce a misleading flat line near 0.
    if(m.csrAfter){
      var s=String(m.csrAfter);
      if(/^Onyx/i.test(s)){
        var n=parseInt(s.match(/\d+/));
        if(!isNaN(n)) return n;
      }
    }
    // Synthetic: map non-Onyx tier+subtier to a numeric scale so reconstructed
    // players still get a chart even when the Halo API omits numeric CSR values.
    var _tier=m.csrTier||m.csr_tier;
    var _sub=m.csrSubTier!=null?m.csrSubTier:(m.csr_subtier!=null?m.csr_subtier:null);
    if(_tier&&_tier!=='Onyx'&&_sub!=null&&_TIER_BASE[_tier]!=null){
      _usedSynthetic=true;
      return _TIER_BASE[_tier]+(_sub-1)*50;
    }
    return null;
  }
  function _getDelta(m){
    if(m.csrDelta!=null)return m.csrDelta;
    // Try to compute from numeric pre/post values when available.
    var aN=_csrFrom(m);
    var bN=m.csrPreValue!=null?+m.csrPreValue:(m.csr_pre_value!=null?+m.csr_pre_value:null);
    if(aN!=null&&bN!=null) return aN-bN;
    return null;
  }
  function _matchesPlaylist(m){
    if(!m.isRanked||!m.gameMode)return false;
    var gm=m.gameMode.trim();
    if(playlist==='Ranked Slayer') return /^Ranked Slayer$/i.test(gm);
    if(playlist==='Ranked Legacy') return /^Ranked Legacy$/i.test(gm);
    // Ranked Arena = everything ranked that isn't Slayer or Legacy
    return !/^Ranked Slayer$/i.test(gm) && !/^Ranked Legacy$/i.test(gm);
  }
  var pm=matches.slice().reverse().filter(function(m){
    if(!_matchesPlaylist(m))return false;
    // Genuine ties (outcome=4): always include as flat, no CSR change expected.
    // Unknown/null outcomes from reconstructed private-player data are NOT real
    // draws — without actual CSR data they'd all inherit the profile-fallback
    // CSR (e.g. 1298) and produce a misleading flat line. Require real data.
    if(m.outcome!==2&&m.outcome!==3) return m.outcome===4||_getDelta(m)!=null||_csrFrom(m)!=null;
    // Wins/losses: need delta or a real numeric CSR to plot
    return _getDelta(m)!=null||_csrFrom(m)!=null;
  });
  if(pm.length<2)return'';
  // Flag when we have limited data — Halo's API only includes RankRecap (CSR before/after) for
  // recent matches within the current/previous season. Older matches return null for this field.
  var _limitedData = pm.length < 15;

  // Build running CSR from most recent value backwards
  var lastCsr=null;
  var recent=matches.find(function(m){
    if(!m.isRanked||!m.gameMode)return false;
    if(!_matchesPlaylist(m)) return false;
    return _csrFrom(m)!=null;
  });
  if(recent) lastCsr=_csrFrom(recent);
  if(!lastCsr){
    var csrKey=playlist==='Ranked Arena'?'Ranked Arena':playlist==='Ranked Legacy'?'Ranked Legacy':'Ranked Slayer';
    var pnow=(getAllPlayers()[selectedPlayer]||{});
    if(pnow.csr&&pnow.csr[csrKey])lastCsr=pnow.csr[csrKey].value;
  }
  // No real CSR value anywhere → hide the chart rather than plot tier/subtier
  // indices, which would render a misleading "flat tiny values around 2" line.
  if(!lastCsr)return'';

  // Build array of CSR values + outcomes — draws always plot flat (0 delta)
  // pm is oldest→newest. vals[i] = CSR after match pm[i].
  // We reconstruct backwards from lastCsr (= CSR after pm[pm.length-1]).
  var vals=[lastCsr];
  var outcomes=[pm[pm.length-1].outcome];
  for(var i=0;i<pm.length-1;i++){
    // _m is the match whose result produced vals[0] (the current earliest point)
    // We need to prepend the CSR *before* _m, i.e. after pm[pm.length-2-i]
    var _m=pm[pm.length-1-i]; // match that produced the current vals[0]
    var _prev=pm[pm.length-2-i]; // match before it
    var _isDraw=_m.outcome===4; // Only genuine ties plot flat; null/unknown use delta/value
    if(_isDraw){
      vals.unshift(vals[0]); // flat — draw means no CSR change
    } else {
      var _d=_getDelta(_m);
      if(_d!=null){
        vals.unshift(vals[0]-_d);
      } else {
        var _av=_csrFrom(_m);
        vals.unshift(_av!=null?_av:vals[0]);
      }
    }
    outcomes.unshift(_prev.outcome); // outcome of the match that ended at this new point
  }

  // All values identical → no real per-match CSR data (often older poisoned
  // snapshot rows where every match was stamped with the player's current rating).
  // Hide the chart rather than render a meaningless flat line at one CSR value.
  var _csrMin=Math.min.apply(null,vals),_csrMax=Math.max.apply(null,vals);
  if(_csrMin===_csrMax)return'';

  var w=800,h=130,pad={t:18,r:70,b:24,l:44};
  var minV=_csrMin-10;
  var maxV=_csrMax+10;
  var n=vals.length;
  function x(i){return pad.l+(i/(n-1))*(w-pad.l-pad.r);}
  function y(v){return h-pad.b-(((v-minV)/(maxV-minV))*(h-pad.t-pad.b));}

  var svg='<svg viewBox="0 0 '+w+' '+h+'" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;width:100%">';

  // Grid lines — when using synthetic scale, label with tier name instead of number
  var _TIER_LABELS=_usedSynthetic?[
    [0,'Bronze'],[300,'Silver'],[600,'Gold'],[900,'Plat'],[1200,'Diamond']
  ]:null;
  function _synthLabel(v){
    if(!_TIER_LABELS)return String(Math.round(v));
    // Find the tier whose base is closest to v
    var best='',bestDist=99999;
    for(var _ti=0;_ti<_TIER_LABELS.length;_ti++){
      var _d=Math.abs(_TIER_LABELS[_ti][0]-v);
      if(_d<bestDist){bestDist=_d;best=_TIER_LABELS[_ti][1];}
    }
    return best;
  }
  for(var g=0;g<4;g++){
    var gv=minV+((maxV-minV)/3)*g;
    var gy=y(gv);
    svg+='<line x1="'+pad.l+'" y1="'+gy+'" x2="'+(w-pad.r)+'" y2="'+gy+'" stroke="rgba(30,48,80,0.6)" stroke-width="1"/>';
    svg+='<text x="'+(pad.l-4)+'" y="'+(gy+4)+'" text-anchor="end" fill="#3a5070" font-size="9" font-family="Share Tech Mono">'+_synthLabel(gv)+'</text>';
  }

  // Color segments — green for gains, red for losses, gray for draws
  for(var si=0;si<n-1;si++){
    var _drawSeg=outcomes[si+1]!==2&&outcomes[si+1]!==3;
    var _segStroke=_drawSeg?'rgba(74,106,144,0.6)':(vals[si+1]>=vals[si]?'rgba(0,230,118,0.5)':'rgba(255,61,87,0.5)');
    svg+='<line x1="'+x(si)+'" y1="'+y(vals[si])+'" x2="'+x(si+1)+'" y2="'+y(vals[si+1])+'" stroke="'+_segStroke+'" stroke-width="1.5"'+(vals[si+1]===vals[si]?' stroke-dasharray="4,3"':'')+'/>';
  }

  // Main line
  var points=vals.map(function(v,i){return x(i)+','+y(v);}).join(' ');
  svg+='<polyline points="'+points+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';

  // Dots for each game
  vals.forEach(function(v,i){
    var isLast=i===n-1;
    svg+='<circle cx="'+x(i)+'" cy="'+y(v)+'" r="'+(isLast?4:2)+'" fill="'+(isLast?color:'rgba(255,255,255,0.3)')+'"'+(isLast?' stroke="'+color+'" stroke-width="1"':'')+'/>';
  });

  // End label — positioned to the right of the last dot, never behind the line
  var lx=x(n-1)+8;
  var ly=y(vals[n-1])+4;
  // If too close to top, push down; if too close to bottom, push up
  if(ly<pad.t+12)ly=pad.t+12;
  if(ly>h-pad.b-4)ly=h-pad.b-4;
  // End label — show tier name for synthetic scale, numeric CSR for real data.
  var _endLabel=_usedSynthetic?_synthLabel(vals[n-1]):String(vals[n-1]);
  svg+='<text x="'+lx+'" y="'+ly+'" text-anchor="start" fill="'+color+'" font-size="11" font-family="Share Tech Mono" font-weight="bold">'+_endLabel+'</text>';

  // X labels
  svg+='<text x="'+pad.l+'" y="'+(h-6)+'" fill="#3a5070" font-size="8" font-family="Share Tech Mono">Game 1</text>';
  svg+='<text x="'+(w-pad.r)+'" y="'+(h-6)+'" text-anchor="end" fill="#3a5070" font-size="8" font-family="Share Tech Mono">Game '+n+'</text>';
  svg+='</svg>';

  // Net change
  var net=vals[n-1]-vals[0];
  var netStr=(net>=0?'+':'')+net;
  var netColor=net>=0?'var(--win)':'var(--loss)';
  // Synthetic-scale note: when all values came from tier+subtier mapping,
  // net change is in synthetic units (50 = one sub-tier step) so we label
  // it as sub-tier movement rather than raw CSR points.
  var netLabel=_usedSynthetic
    ? (net===0?'no sub-tier change over '+n+' games':(net>0?'+':'')+Math.round(net/50)+' sub-tier'+(Math.abs(net)===50?'':'s')+' over '+n+' games')
    : netStr+' CSR over '+n+' games';

  var chartId='csr_'+playlist.replace(/\s/g,'_');

  return'<div class="csr-chart-wrap" style="margin-bottom:12px">'
    +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'
    +'<span style="font-size:11px;font-family:Share Tech Mono,monospace;color:'+color+'">— '+playlist+(_usedSynthetic?' <span style="color:var(--muted2);font-size:9px">· approx. tier progression</span>':'')+'</span>'
    +'<span id="'+chartId+'_tip" style="font-size:11px;font-family:Share Tech Mono,monospace;color:'+netColor+'">'+netLabel
    +(_limitedData?' <span style="color:var(--muted2);font-size:9px;margin-left:4px">· recent matches only</span>':'')
    +'</span>'
    +'</div>'
    +'<div class="csr-chart-canvas" id="'+chartId+'_wrap"'
    +' data-vals="'+encodeURIComponent(JSON.stringify(vals))+'"'
    +' data-w="'+w+'" data-h="'+h+'"'
    +' data-padl="'+pad.l+'" data-padr="'+pad.r+'" data-padt="'+pad.t+'" data-padb="'+pad.b+'"'
    +' data-minv="'+minV+'" data-maxv="'+maxV+'" data-color="'+color+'" data-net="'+netLabel+'"'
    +' style="position:relative;cursor:crosshair">'
    +svg
    +'<svg id="'+chartId+'_cross" viewBox="0 0 '+w+' '+h+'" xmlns="http://www.w3.org/2000/svg" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible" preserveAspectRatio="none">'
    +'<line id="'+chartId+'_vline" x1="0" y1="0" x2="0" y2="'+h+'" stroke="rgba(255,255,255,0.25)" stroke-width="1" stroke-dasharray="3,3" opacity="0"/>'
    +'<circle id="'+chartId+'_dot" cx="0" cy="0" r="5" fill="'+color+'" stroke="#fff" stroke-width="1.5" opacity="0"/>'
    +'</svg>'
    +'</div>'
    +'</div>';
}

function initCsrCharts(){
  document.querySelectorAll('[id$="_wrap"][data-vals]').forEach(function(wrap){
    if(wrap._csrInit)return;
    wrap._csrInit=true;
    var vals=JSON.parse(decodeURIComponent(wrap.dataset.vals));
    var w=+wrap.dataset.w,h=+wrap.dataset.h;
    var padl=+wrap.dataset.padl,padr=+wrap.dataset.padr,padt=+wrap.dataset.padt,padb=+wrap.dataset.padb;
    var minV=+wrap.dataset.minv,maxV=+wrap.dataset.maxv;
    var color=wrap.dataset.color;
    var n=vals.length;
    var id=wrap.id.replace('_wrap','');
    var tip=document.getElementById(id+'_tip');
    var vline=document.getElementById(id+'_vline');
    var dot=document.getElementById(id+'_dot');
    var netLabel=wrap.dataset.net;
    // Detect synthetic scale: values are multiples of 50 within 0–1499
    var _isSynth=vals.every(function(v){return v>=0&&v<1500&&v%50===0;})&&vals.every(function(v,i,a){return i===0||Math.abs(v-a[i-1])%50===0;});
    var _TIER_BASES_INIT=[[1200,'Diamond'],[900,'Platinum'],[600,'Gold'],[300,'Silver'],[0,'Bronze']];
    function _synthTip(v){
      for(var _i=0;_i<_TIER_BASES_INIT.length;_i++){if(v>=_TIER_BASES_INIT[_i][0]){var _s=Math.round((v-_TIER_BASES_INIT[_i][0])/50)+1;return _TIER_BASES_INIT[_i][1]+' '+_s;}}return String(v);
    }
    function xPos(i){return padl+(i/(n-1))*(w-padl-padr);}
    function yPos(v){return h-padb-(((v-minV)/(maxV-minV))*(h-padt-padb));}
    function onMove(clientX){
      var rect=wrap.getBoundingClientRect();
      var relX=(clientX-rect.left)*(w/rect.width);
      var idx=Math.round(((relX-padl)/(w-padl-padr))*(n-1));
      idx=Math.max(0,Math.min(n-1,idx));
      var v=vals[idx];
      var cx=xPos(idx),cy=yPos(v);
      vline.setAttribute('x1',cx);vline.setAttribute('x2',cx);vline.setAttribute('opacity','1');
      dot.setAttribute('cx',cx);dot.setAttribute('cy',cy);dot.setAttribute('opacity','1');
      var delta=idx>0?v-vals[idx-1]:0;
      var dColor=delta>=0?'var(--win)':'var(--loss)';
      var _vLabel=_isSynth?_synthTip(v):v+' CSR';
      var _dLabel=_isSynth?(delta===0?'—':(delta>0?'+':'')+Math.round(delta/50)+' sub-tier'):(delta>=0?'+':'')+delta;
      if(tip)tip.innerHTML='<span style="color:'+color+'">'+_vLabel+'</span> <span style="color:'+dColor+'">'+_dLabel+'</span> <span style="color:var(--muted)">· Game '+(idx+1)+'/'+n+'</span>';
    }
    function onLeave(){
      vline.setAttribute('opacity','0');dot.setAttribute('opacity','0');
      if(tip)tip.innerHTML='<span style="color:'+color+'">'+netLabel+'</span>';
    }
    wrap.addEventListener('mousemove',function(e){onMove(e.clientX);});
    wrap.addEventListener('mouseleave',onLeave);
    wrap.addEventListener('touchmove',function(e){e.preventDefault();onMove(e.touches[0].clientX);},{passive:false});
    wrap.addEventListener('touchend',onLeave);
  });
}
