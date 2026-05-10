function renderCsrFromMatches(matches,playlist,color){
  // Build CSR progression from match csrDelta — only ranked matches for this playlist
  // Helper: compute csrDelta if missing but csrAfter+csrBefore both present
  function _getDelta(m){
    if(m.csrDelta!=null)return m.csrDelta;
    // Try to compute from csrAfter and csrBefore strings
    if(m.csrAfter&&m.csrBefore){
      var a=parseInt(String(m.csrAfter).match(/\d+/));
      var b=parseInt(String(m.csrBefore).match(/\d+/));
      if(!isNaN(a)&&!isNaN(b))return a-b;
    }
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
    // Draws always included — plotted flat at same CSR
    if(m.outcome!==2&&m.outcome!==3) return true;
    // Wins/losses: need delta or csrAfter to plot
    return _getDelta(m)!=null||m.csrAfter!=null;
  });
  if(pm.length<2)return'';
  // Flag when we have limited data — Halo's API only includes RankRecap (CSR before/after) for
  // recent matches within the current/previous season. Older matches return null for this field.
  var _limitedData = pm.length < 15;

  // Build running CSR from most recent value backwards
  var lastCsr=null;
  var recent=matches.find(function(m){
    if(!m.isRanked||!m.csrAfter||!m.gameMode)return false;
    var gm=m.gameMode.trim();
    if(playlist==='Ranked Slayer') return /^Ranked Slayer$/i.test(gm);
    if(playlist==='Ranked Legacy') return /^Ranked Legacy$/i.test(gm);
    return !/^Ranked Slayer$/i.test(gm) && !/^Ranked Legacy$/i.test(gm);
  });
  if(recent&&recent.csrAfter){
    var raw=recent.csrAfter;
    var num=parseInt(String(raw).match(/\d+/));
    if(!isNaN(num))lastCsr=num;
  }
  if(!lastCsr){
    var csrKey=playlist==='Ranked Arena'?'Ranked Arena':playlist==='Ranked Legacy'?'Ranked Legacy':'Ranked Slayer';
    var pnow=(getAllPlayers()[selectedPlayer]||{});
    if(pnow.csr&&pnow.csr[csrKey])lastCsr=pnow.csr[csrKey].value;
  }
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
    var _isDraw=_m.outcome!==2&&_m.outcome!==3;
    if(_isDraw){
      vals.unshift(vals[0]); // flat — draw means no CSR change
    } else {
      var _d=_getDelta(_m);
      if(_d!=null){
        vals.unshift(vals[0]-_d);
      } else if(_m.csrAfter){
        var _av=parseInt(String(_m.csrAfter).match(/\d+/));
        vals.unshift(!isNaN(_av)?_av:vals[0]);
      } else {
        vals.unshift(vals[0]);
      }
    }
    outcomes.unshift(_prev.outcome); // outcome of the match that ended at this new point
  }

  var w=800,h=130,pad={t:18,r:70,b:24,l:44};
  var minV=Math.min.apply(null,vals)-10;
  var maxV=Math.max.apply(null,vals)+10;
  var n=vals.length;
  function x(i){return pad.l+(i/(n-1))*(w-pad.l-pad.r);}
  function y(v){return h-pad.b-(((v-minV)/(maxV-minV))*(h-pad.t-pad.b));}

  var svg='<svg viewBox="0 0 '+w+' '+h+'" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;width:100%">';

  // Grid lines
  for(var g=0;g<4;g++){
    var gv=minV+((maxV-minV)/3)*g;
    var gy=y(gv);
    svg+='<line x1="'+pad.l+'" y1="'+gy+'" x2="'+(w-pad.r)+'" y2="'+gy+'" stroke="rgba(30,48,80,0.6)" stroke-width="1"/>';
    svg+='<text x="'+(pad.l-4)+'" y="'+(gy+4)+'" text-anchor="end" fill="#3a5070" font-size="9" font-family="Share Tech Mono">'+Math.round(gv)+'</text>';
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
  svg+='<text x="'+lx+'" y="'+ly+'" text-anchor="start" fill="'+color+'" font-size="11" font-family="Share Tech Mono" font-weight="bold">'+vals[n-1]+'</text>';

  // X labels
  svg+='<text x="'+pad.l+'" y="'+(h-6)+'" fill="#3a5070" font-size="8" font-family="Share Tech Mono">Game 1</text>';
  svg+='<text x="'+(w-pad.r)+'" y="'+(h-6)+'" text-anchor="end" fill="#3a5070" font-size="8" font-family="Share Tech Mono">Game '+n+'</text>';
  svg+='</svg>';

  // Net change
  var net=vals[n-1]-vals[0];
  var netStr=(net>=0?'+':'')+net;
  var netColor=net>=0?'var(--win)':'var(--loss)';

  var chartId='csr_'+playlist.replace(/\s/g,'_');

  return'<div class="csr-chart-wrap" style="margin-bottom:12px">'
    +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'
    +'<span style="font-size:11px;font-family:Share Tech Mono,monospace;color:'+color+'">— '+playlist+'</span>'
    +'<span id="'+chartId+'_tip" style="font-size:11px;font-family:Share Tech Mono,monospace;color:'+netColor+'">'+netStr+' CSR over '+n+' games'
    +(_limitedData?' <span style="color:var(--muted2);font-size:9px;margin-left:4px">· recent matches only</span>':'')
    +'</span>'
    +'</div>'
    +'<div class="csr-chart-canvas" id="'+chartId+'_wrap"'
    +' data-vals="'+encodeURIComponent(JSON.stringify(vals))+'"'
    +' data-w="'+w+'" data-h="'+h+'"'
    +' data-padl="'+pad.l+'" data-padr="'+pad.r+'" data-padt="'+pad.t+'" data-padb="'+pad.b+'"'
    +' data-minv="'+minV+'" data-maxv="'+maxV+'" data-color="'+color+'" data-net="'+netStr+' CSR over '+n+' games"'
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
      var dStr=(delta>=0?'+':'')+delta;
      var dColor=delta>=0?'var(--win)':'var(--loss)';
      if(tip)tip.innerHTML='<span style="color:'+color+'">'+v+' CSR</span> <span style="color:'+dColor+'">'+dStr+'</span> <span style="color:var(--muted)">· Game '+(idx+1)+'/'+n+'</span>';
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
