var playerData=null,data=null,medalMeta={},expandedMatches={},fullMatchCache={},MEDAL_SHEET='/api/medal-sheet',selectedPlayer=0,searchData=null,searchMode=false,activeTab='overview',matchHistoryPage=1,matchHistoryData=null,matchHistoryLoading=false;
var _searchToken = 0; // incremented on every new doSearch — stale searches self-cancel

// ── Sponsor ad rotation ──────────────────────────────────────────────────────
// To add a real paid sponsor: set active:true on any entry and add image/link.
// Fake/humor entries keep active:false — they always rotate in automatically.
var FRAGR_ADS = [
  // Insurance & Protection
  {brand:'Teabagging Insurance',        tagline:'Comprehensive coverage for your post-kill dignity. Because some victories deserve protection.',        active:true,  image:'/images/ads/teabagging-insurance.jpg'},
  {brand:'Teabag Defense LLC',          tagline:'Shielding Spartans from unwanted crouch encounters since Reach. Your reputation, fully insured.',      active:true,  image:'/images/ads/teabag-defense.jpg'},
  {brand:'Corpse Protocol Insurance',   tagline:"Don't let a bad bag ruin your K/D. We've got you covered.",                                           active:true,  image:'/images/ads/corpse-protocol.jpg'},
  // Energy & Hydration
  {brand:'Spartan Hydrate',             tagline:"Master Chief's official electrolyte formula. Replenish. Dominate. Repeat.",                            active:true,  image:'/images/ads/spartan-hydrate.jpg'},
  {brand:'Mjolnir Fuel',                tagline:'Powered by pure Forerunner tech. Because even legends need a boost between matches.',                  active:true,  image:'/images/ads/mjolnir-fuel.jpg'},
  {brand:'Plasma Pulse Energy',         tagline:'Pink, powerful, and guaranteed to track your enemies (and your stats).',                               active:true,  image:'/images/ads/plasma-pulse.jpg'},
  // Snacks & Nutrition
  {brand:'Noob Bites',                  tagline:"Crunchy protein cubes. A Chief's favorite field ration. One bag turns noobs into pros.",               active:true,  image:'/images/ads/noob-bites.jpg'},
  {brand:'UNSC Combat Rations',         tagline:'Battle-tested nutrition that tastes like victory. Now with extra accuracy sprinkles.',                  active:true,  image:'/images/ads/combat-rations.jpg'},
  {brand:'Needler Nuggets',             tagline:'Pink, homing, and impossible to put down. The ultimate post-match snack.',                             active:true,  image:'/images/ads/needler-nuggets.jpg'},
  // Weapon & Gear
  {brand:'Overshield Protection Systems',tagline:'Extra lives for your stats. Because one shield is never enough.',                                     active:true,  image:'/images/ads/overshield.jpg'},
  // Text-only (no image yet)
  {brand:'Energy Sword Sharpening Co.', tagline:'Precision edge maintenance for Spartans who demand clean kills and clean stats.'},
  {brand:'Gravity Hammer Athletics',    tagline:'Training gear that smashes PRs. Built for Spartans who play hard.'},
  {brand:'Active Camo Solutions',       tagline:'Stealth technology for your gameplay. Hide your weaknesses, reveal your true rank.',        active:true,  image:'/images/ads/active-camo.png'},
  {brand:'UNSC Logistics Division',     tagline:'Supplying accurate data to the front lines. Your stats, delivered with precision.'},
  {brand:'Cortana Analytics',           tagline:'Smart data for smarter Spartans. She may be gone, but the insights remain.'},
  {brand:'Ban Hammer Compliance Group', tagline:'Enforcing fair play and fair stats. Protecting the Halo community one match at a time.'},
  {brand:'Respawn Dynamics',            tagline:'Engineering shorter waits and longer win streaks. Your comeback starts here.'},
];
// Locked per search so the ad doesn't flicker across re-renders
var _fragrAdIdx = 0;
function _pickNewAd(){ _fragrAdIdx = Math.floor(Math.random() * FRAGR_ADS.length); }
_pickNewAd();

// Renders an ad slot. variant: 'banner' (compact, loading screen) or 'card' (large, refresh page)
function _renderAdSlot(variant){
  var isCard = variant === 'card';
  var isMobile = window.innerWidth < 768;
  var ad = FRAGR_ADS[_fragrAdIdx] || FRAGR_ADS[0];

  // Image-based ad
  if(ad.active && ad.image){
    var taglineShort = ad.tagline.split(/[.!?]/)[0].trim() + '.';
    if(isCard && isMobile){
      // Mobile card: fill full available height, cover image, text cap pinned at bottom
      return '<div style="border:1px solid var(--border2);border-radius:8px;overflow:hidden;background:var(--surface2);display:flex;flex-direction:column;height:100%">'
        +'<div style="font-size:8px;letter-spacing:2px;font-family:Share Tech Mono,monospace;color:var(--muted2);text-align:center;padding:4px 0;background:var(--surface3);text-transform:uppercase;flex-shrink:0">Sponsored</div>'
        +'<div style="flex:1;min-height:0;overflow:hidden">'
        +'<img src="'+ad.image+'" style="width:100%;height:100%;object-fit:cover;object-position:center;display:block" alt="'+ad.brand+'"></div>'
        +'<div style="padding:10px 14px;flex-shrink:0;background:var(--surface2)">'
        +'<div style="font-family:Rajdhani,sans-serif;font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">'+ad.brand+'</div>'
        +'<div style="font-size:9px;font-family:Share Tech Mono,monospace;color:var(--muted2);line-height:1.4">'+taglineShort+'</div>'
        +'</div>'
        +'</div>';
    }
    // Desktop card or banner
    var imgH = isCard ? '320px' : (isMobile ? '90px' : '110px');
    var imgFit = isCard ? 'contain' : 'cover';
    return '<div style="border:1px solid var(--border2);border-radius:8px;overflow:hidden;background:var(--surface2)">'
      +'<div style="font-size:8px;letter-spacing:2px;font-family:Share Tech Mono,monospace;color:var(--muted2);text-align:center;padding:4px 0;background:var(--surface3);text-transform:uppercase">Sponsored</div>'
      +'<div style="width:100%;height:'+imgH+';background:var(--surface3);display:flex;align-items:center;justify-content:center">'
      +'<img src="'+ad.image+'" style="width:100%;height:100%;object-fit:'+imgFit+';display:block" alt="'+ad.brand+'"></div>'
      +'<div style="padding:'+(isCard?'12px 16px':'8px 12px')+'">'
      +'<div style="font-family:Rajdhani,sans-serif;font-size:'+(isCard?'13px':'11px')+';font-weight:700;color:var(--muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.5px">'+ad.brand+'</div>'
      +'<div style="font-size:'+(isCard?'10px':'9px')+';font-family:Share Tech Mono,monospace;color:var(--muted2);line-height:1.5">'+(isCard?ad.tagline:taglineShort)+'</div>'
      +'</div></div>';
  }

  // Text-based ad
  var brandWords = ad.brand.split(' ');
  var mid = Math.ceil(brandWords.length / 2);
  var brandL1 = brandWords.slice(0, mid).join(' ');
  var brandL2 = brandWords.slice(mid).join(' ');
  var brandFontSize = isCard ? (isMobile ? '22px' : '26px') : '15px';

  if(isCard){
    return '<div style="border:1px solid var(--border2);border-radius:8px;background:var(--surface2);padding:20px;display:flex;flex-direction:column;gap:12px;box-sizing:border-box">'
      +'<div style="font-size:8px;letter-spacing:2px;font-family:Share Tech Mono,monospace;color:var(--muted2);text-transform:uppercase">Sponsored</div>'
      +'<div style="font-family:Rajdhani,sans-serif;font-weight:700;line-height:1.05;color:var(--text)">'
        +'<span style="font-size:'+brandFontSize+';color:var(--accent)">'+brandL1+'</span>'
        +(brandL2?'<br><span style="font-size:'+brandFontSize+'">'+brandL2+'</span>':'')
      +'</div>'
      +'<div style="width:28px;height:2px;background:var(--accent);border-radius:1px;opacity:0.5"></div>'
      +'<div style="font-size:10px;font-family:Share Tech Mono,monospace;color:var(--muted);line-height:1.6">'+ad.tagline+'</div>'
      +'</div>';
  } else {
    return '<div style="border:1px solid var(--border2);border-radius:6px;background:var(--surface2);padding:12px 16px">'
      +'<div style="font-size:8px;letter-spacing:2px;font-family:Share Tech Mono,monospace;color:var(--muted2);text-transform:uppercase;margin-bottom:5px">Sponsored</div>'
      +'<div style="font-family:Rajdhani,sans-serif;font-size:'+brandFontSize+';font-weight:700;color:var(--accent);margin-bottom:4px">'+ad.brand+'</div>'
      +'<div style="font-size:10px;font-family:Share Tech Mono,monospace;color:var(--muted);line-height:1.5">'+ad.tagline+'</div>'
      +'</div>';
  }
}

try{activeTab=localStorage.getItem('haloTab')||'overview';}catch(e){}
