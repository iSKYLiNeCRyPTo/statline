#!/usr/bin/env node
// Regression tests for the "ranked=0/0 after 25 raw matches" follow-up.
//
// Three behaviors locked down here:
//
//   1. Invalid/stub cached payloads (matchId without a gameMode) should NOT
//      anchor the incremental fetch. If the cache only contains stubs from
//      the PR #11 ReferenceError era, calling fetchMatchHistory with that
//      stub matchId as `stopAtMatchId` previously bailed after one batch
//      with `ranked=0/0`. The server now rejects stub anchors up-front via
//      _findValidAnchorId / _isValidAnchorMatch.
//
//   2. Once the match-list endpoint trips its shared 429/403 backoff,
//      fetchMatchHistory must short-circuit (return temporaryUnavailable)
//      instead of doing more API calls. This is what prevents the repeated
//      "[MatchFetch] 429 ... [Clearance] HTTP 403" log chain the user saw.
//
//   3. An incremental no-op (cache is already up to date) must NOT print
//      the alarming "Completed with 0 ranked / 0 total" warning. That
//      message was being misread as a regression when in fact it was the
//      normal "nothing new since last check" path.
//
// Run: node scripts/verify-incremental-and-backoff.js

const fs = require('fs');
const path = require('path');
const Module = require('module');

let failed = 0;
function assert(cond, label) {
  if (cond) console.log('  ✓ ' + label);
  else { console.log('  ✗ ' + label); failed++; }
}

// ---------------------------------------------------------------------------
// 0) Static checks against server.js source — _isValidAnchorMatch exists
// ---------------------------------------------------------------------------
const serverSrc = fs.readFileSync(path.resolve(__dirname, '../src/server.js'), 'utf8');
const haloSrc   = fs.readFileSync(path.resolve(__dirname, '../src/halo.js'),   'utf8');

console.log('server.js — stub-cache rejection scaffolding');
assert(
  /function\s+_isValidAnchorMatch\s*\(/.test(serverSrc),
  '_isValidAnchorMatch helper is defined'
);
assert(
  /function\s+_findValidAnchorId\s*\(/.test(serverSrc),
  '_findValidAnchorId helper is defined'
);
assert(
  /const\s+newestCachedId\s*=\s*_findValidAnchorId\(/.test(serverSrc),
  'incremental fetch uses _findValidAnchorId(cached) as the anchor'
);
assert(
  /stub matches.*invalidating cache/.test(serverSrc),
  'stub-cache invalidation path is present'
);
assert(
  /match-list-backoff/.test(serverSrc),
  'temporary-unavailable / match-list-backoff response path is present'
);

console.log('halo.js — backoff + no-op classification scaffolding');
assert(
  /function\s+isMatchListBackoffActive\s*\(/.test(haloSrc),
  'isMatchListBackoffActive helper is exported'
);
assert(
  /matchListBackoffUntil\s*=\s*Date\.now\(\)\s*\+\s*MATCH_LIST_BACKOFF_MS/.test(haloSrc),
  'match-list backoff is armed when fetch returns 429/403'
);
assert(
  /incremental no-op \(cache up to date\)/.test(haloSrc),
  'incremental no-op has its own stop reason'
);
assert(
  /hitStopNoop/.test(haloSrc),
  'hitStopNoop tracks "anchor was index 0" so warning is suppressed'
);
assert(
  /No new matches since cached anchor/.test(haloSrc),
  'no-op path logs a calm message instead of the scary "0 ranked / 0 total" warning'
);

// ---------------------------------------------------------------------------
// 1) End-to-end: stub_node_fetch + load halo.js, exercise fetchMatchHistory
// ---------------------------------------------------------------------------
const realLog = console.log, realWarn = console.warn;
const DEBUG = process.env.DEBUG_VERIFY === '1';
function silence() { if (!DEBUG) { console.log = () => {}; console.warn = () => {}; } }
function unsilence() { console.log = realLog; console.warn = realWarn; }

// Mutable stub. Tests reset it between cases via `installFetch(...)`.
let _currentFetch = () => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({}) });
function installFetch(fn) { _currentFetch = fn; }

const FAKE_FETCH_PATH = path.join(__dirname, '__fake_node_fetch_incr.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'node-fetch') return FAKE_FETCH_PATH;
  return origResolve.call(this, req, ...rest);
};
require.cache[FAKE_FETCH_PATH] = {
  id: FAKE_FETCH_PATH,
  filename: FAKE_FETCH_PATH,
  loaded: true,
  exports: (...a) => _currentFetch(...a),
};

delete process.env.REDIS_URL;

let halo;
try { halo = require(path.resolve(__dirname, '../src/halo.js')); }
catch (e) { console.log('  ✗ halo.js failed to load: ' + e.message); process.exit(1); }

function jsonResp(body, status = 200, headers = {}) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase?.() || k] || null },
    json: () => Promise.resolve(body),
  });
}

(async () => {
  // ── Case A: incremental no-op (anchor is first match in batch) ────────────
  // The match-list endpoint returns the cached anchor as the very first
  // entry. fetchMatchHistory must trim the batch to empty, report 0 matches,
  // and NOT warn — it's a calm no-op.
  console.log('\nCase A — incremental no-op when cache is already up to date');
  let warnedScary = false;
  console.warn = (...args) => {
    const s = args.join(' ');
    if (/Completed with 0 ranked \/ 0 total/.test(s)) warnedScary = true;
  };
  installFetch((url) => {
    const u = String(url);
    if (u.includes('/matches?')) {
      // Single match — the same id the caller passes as the anchor.
      return jsonResp({ Results: [{ MatchId: 'ANCHOR_ID', Outcome: 2 }] });
    }
    return jsonResp({});
  });
  // Silence the rest of halo.js chatter but keep our warn filter.
  const realLog2 = console.log; console.log = () => {};
  const outA = await halo.fetchMatchHistory('xuid-1', 'INSANE TACTICS', 100, null, 'ANCHOR_ID');
  console.log = realLog2;
  unsilence();
  assert(Array.isArray(outA.matches) && outA.matches.length === 0,
    'no-op returns empty matches array');
  assert(!warnedScary,
    'no-op does NOT emit the "Completed with 0 ranked / 0 total" warning');

  // ── Case B: match-list 429 arms shared backoff + short-circuit ────────────
  // First call: API returns a 429, then fetchMatchHistory's internal retries
  // also all 429 → backoff armed. Second call: backoff is active, must NOT
  // fire any further fetches and must return temporaryUnavailable.
  console.log('\nCase B — match-list 429 arms shared backoff, second call short-circuits');
  let fetchCount = 0;
  installFetch((url) => {
    fetchCount++;
    if (String(url).includes('/matches?')) return jsonResp({}, 429, { 'retry-after': '1' });
    return jsonResp({});
  });
  silence();
  const outB1 = await halo.fetchMatchHistory('xuid-2', 'BACKOFF TEST', 100);
  unsilence();
  assert(halo.isMatchListBackoffActive(), 'shared match-list backoff is now active after persistent 429');
  assert(outB1.matches.length === 0, 'first call returns no matches when 429 persists');

  const fetchesBefore = fetchCount;
  silence();
  const outB2 = await halo.fetchMatchHistory('xuid-2', 'BACKOFF TEST', 100);
  unsilence();
  assert(outB2.temporaryUnavailable === true,
    'second call returns temporaryUnavailable while backoff is active');
  assert(outB2.reason === 'match-list-backoff', 'temporary unavailable reason is match-list-backoff');
  assert(fetchCount === fetchesBefore,
    'second call performs zero additional fetches while backoff is active');

  // ── Case C: stub-cache anchor detection (server.js helper) ────────────────
  // Exercise the _isValidAnchorMatch helper by loading server.js into a
  // sandbox just long enough to grab the function. We require() it via a
  // proxy that captures it from the module scope.
  console.log('\nCase C — server.js stub-cache anchor detection');
  // Pure regex-driven assertions here since loading server.js spins up
  // Express and DB connections we don't want in CI. The static checks at
  // the top already verify the helpers are referenced from the search path.
  const stubAnchorBlock = serverSrc.match(/function\s+_isValidAnchorMatch[\s\S]*?\n}/);
  assert(stubAnchorBlock && /m\.gameMode\s*==\s*null/.test(stubAnchorBlock[0]),
    '_isValidAnchorMatch rejects rows with gameMode == null');
  assert(stubAnchorBlock && /!m\.matchId/.test(stubAnchorBlock[0]),
    '_isValidAnchorMatch rejects rows without matchId');

  // Behavior check: simulate by extracting the helper function and running it.
  // The helper is small and self-contained, so we can `eval` it safely from
  // our own controlled source.
  const helperSrc = stubAnchorBlock[0];
  // eslint-disable-next-line no-new-func
  const _isValidAnchorMatch = new Function(helperSrc + '\nreturn _isValidAnchorMatch;')();
  assert(_isValidAnchorMatch({ matchId: 'X', gameMode: 'Ranked Slayer' }) === true,
    'a real ranked match is a valid anchor');
  assert(_isValidAnchorMatch({ matchId: 'X', gameMode: null, kills: 0 }) === false,
    'a stub row (matchId but gameMode==null) is NOT a valid anchor');
  assert(_isValidAnchorMatch({ matchId: null, gameMode: 'Ranked' }) === false,
    'a row without matchId is NOT a valid anchor');
  assert(_isValidAnchorMatch(null) === false, 'null is rejected');

  if (failed) { console.log('\nFAILED: ' + failed + ' check(s)'); process.exit(1); }
  console.log('\nAll checks passed.');
})().catch(e => { console.log('  ✗ uncaught: ' + (e && e.stack || e)); process.exit(1); });
