#!/usr/bin/env node
// Static verification of the search-flow / ad-removal cleanup. No network,
// no DB — pure file content checks. Sister script to verify-backfill.js etc.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../src/public/js');
let failed = 0;
function assert(cond, label) {
  if (cond) console.log('  ✓ ' + label);
  else { console.log('  ✗ ' + label); failed++; }
}

const search = fs.readFileSync(path.join(root, 'search.js'), 'utf8');
const globals = fs.readFileSync(path.join(root, 'globals.js'), 'utf8');

console.log('search.js — artificial delays removed');
assert(!/setTimeout\(r,5000\)/.test(search), 'no 5000ms artificial "analyzing data" delay');
assert(!/setTimeout\(r,900\)/.test(search), 'no 900ms artificial "skill data" delay');

console.log('search.js — ad rendering gone');
assert(!/_renderAdSlot\(/.test(search), 'search.js no longer calls _renderAdSlot');
assert(!/_pickNewAd\(\)/.test(search), 'search.js no longer calls _pickNewAd');

console.log('search.js — phase timing added');
assert(/_phase\(/.test(search), '_phase helper is invoked');

console.log('globals.js — ad data stripped');
assert(!/FRAGR_ADS\s*=\s*\[/.test(globals), 'FRAGR_ADS array no longer declared');
assert(/function _renderAdSlot\b/.test(globals), '_renderAdSlot stub kept as safety net');
assert(/return\s*['"]['"]/.test(globals.match(/_renderAdSlot[\s\S]{0,200}/)[0]),
  '_renderAdSlot returns empty string');

console.log('search.js — critical-path correctness preserved');
assert(/api\/search\?gamertag=[^&]*&statsOnly=1/.test(search), 'still hits statsOnly=1 first');
assert(/_progressPoll=setInterval/.test(search), 'progress polling preserved');
assert(/reconstructedCount/.test(search), 'reconstructed-history banner preserved');
assert(/api\/skill-status/.test(search), 'skill-status post-render poll preserved');

console.log('public/images/ads removed');
const adsDir = path.resolve(__dirname, '../src/public/images/ads');
assert(!fs.existsSync(adsDir), 'ads image directory deleted');

if (failed) {
  console.error('\nFAILED: ' + failed + ' check(s)');
  process.exit(1);
}
console.log('\nDone. All search-flow checks passed.');
