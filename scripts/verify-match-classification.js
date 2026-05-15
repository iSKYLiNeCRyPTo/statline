#!/usr/bin/env node
// Regression test for the "ranked=0/100, all matches unknown mode" bug.
//
// Root cause being verified:
//   PR #11 added `playlistId: matchPlaylistId, playlistKind` to the
//   results.push() at the bottom of fetchMatchHistory, but
//   matchPlaylistId/isRankedSlayer/etc were declared with `const` inside
//   the `if (md)` block scope. Reading them after the block closes threw
//   a ReferenceError that fell into the per-match catch, producing a
//   stub row without `isRanked: true` for every match. The Stats page
//   then computed nothing because 0 ranked matches were available.
//
// This script:
//   1. Loads halo.js (any syntax error fails) and validates the source
//      shape — vars must NOT be re-declared inside the `if (md)` block.
//   2. Stubs global.fetch to return MatchInfo payloads for Ranked Arena,
//      Ranked Slayer, and Ranked Legacy, then calls fetchMatchHistory
//      and asserts each match comes back with isRanked: true and the
//      correct playlistKind. Catches a regression of this exact bug.
//
// Run: node scripts/verify-match-classification.js

const fs = require('fs');
const path = require('path');

let failed = 0;
function assert(cond, label) {
  if (cond) console.log('  ✓ ' + label);
  else { console.log('  ✗ ' + label); failed++; }
}

// ---------------------------------------------------------------------------
// 1) Static checks against halo.js source
// ---------------------------------------------------------------------------
const haloSrc = fs.readFileSync(path.resolve(__dirname, '../src/halo.js'), 'utf8');

console.log('halo.js — playlist context variables stay in scope for results.push');
assert(
  !/const\s+matchPlaylistId\s*=/.test(haloSrc),
  'matchPlaylistId is no longer declared as `const` inside the if(md) block'
);
assert(
  !/const\s+isRankedSlayer\s*=/.test(haloSrc),
  'isRankedSlayer is no longer declared as `const` inside the if(md) block'
);
assert(
  /let\s+matchPlaylistId\s*=\s*null,\s*playlistKind\s*=\s*null/.test(haloSrc),
  'matchPlaylistId/playlistKind are hoisted with `let` to the outer per-match scope'
);
assert(
  /let\s+isRankedSlayer\s*=\s*false,\s*isRankedArena\s*=\s*false,\s*isRankedLegacy\s*=\s*false/.test(haloSrc),
  'isRankedSlayer/Arena/Legacy are hoisted with `let` to the outer per-match scope'
);
assert(
  /\[MatchFetch\] Failed to parse match/.test(haloSrc),
  'per-match catch now logs a clear warning so future classification regressions surface'
);

// ---------------------------------------------------------------------------
// 2) End-to-end fetchMatchHistory with stubbed fetch.
// ---------------------------------------------------------------------------
// Suppress noisy console output from halo.js during the run.
const realLog = console.log, realWarn = console.warn;
const DEBUG = process.env.DEBUG_VERIFY === '1';
if (!DEBUG) { console.log = () => {}; console.warn = () => {}; }

const RANKED_ARENA_ID  = 'edfef3ac-9cbe-4fa2-b949-8f29deafd483';
const RANKED_SLAYER_ID = 'f5580605-660c-43f9-ac69-4075c4a05c5d';
const RANKED_LEGACY_ID = 'c94cb508-2fbd-450a-81db-bb74f7741d45';

// Fixture: one match per playlist kind. MatchInfo carries the playlist
// AssetId — that's what classification keys off. Players[] holds our
// search-target's stats so the per-match parsing has something to read.
const TARGET_XUID = '1234567890';
function makeMatch(matchId, playlistId, gameVariantCategory) {
  return {
    MatchId: matchId,
    Outcome: 2,
    MatchInfo: {
      StartTime: '2026-05-11T00:00:00Z',
      Duration: 'PT10M',
      LifecycleMode: 3,
      PlaylistExperience: 'Ranked',
      GameVariantCategory: gameVariantCategory,
      Playlist: { AssetId: playlistId },
      MapVariant: { AssetId: 'map-asset', VersionId: 'v1' },
      UgcGameVariant: { Name: 'Slayer' },
    },
    Players: [{
      PlayerId: `xuid(${TARGET_XUID})`,
      LastTeamId: 0,
      PlayerTeamStats: [{
        Stats: {
          CoreStats: {
            Kills: 10, Deaths: 5, Assists: 3, PersonalScore: 1000,
            ShotsFired: 100, ShotsHit: 50, Accuracy: 50,
            DamageDealt: 1500, DamageTaken: 800, Medals: [],
          },
        },
      }],
    }],
  };
}

// matches list payload (the /matches?count=...&start=... endpoint).
const ALL_MATCHES = [
  makeMatch('match-arena-1',  RANKED_ARENA_ID,  6),
  makeMatch('match-slayer-1', RANKED_SLAYER_ID, 6),
  makeMatch('match-legacy-1', RANKED_LEGACY_ID, 14), // KOTH
];

function jsonResp(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  });
}

function stubbedFetch(url /*, init */) {
  const u = String(url);
  if (DEBUG) realLog('[stub-fetch]', u);
  if (u.includes('/matches?')) {
    // batched listing — return all fixtures once, then empty
    const u2 = new URL(u, 'https://x/');
    const start = parseInt(u2.searchParams.get('start') || '0', 10);
    if (start === 0) return jsonResp({ Results: ALL_MATCHES });
    return jsonResp({ Results: [] });
  }
  // per-match stats fetch — `/hi/matches/<id>/stats`
  const mm = u.match(/\/hi\/matches\/([^\/]+)\/stats/);
  if (mm) {
    const found = ALL_MATCHES.find(x => x.MatchId === mm[1]);
    return jsonResp(found || {});
  }
  // skill data + everything else not relevant to this regression
  if (u.includes('/skill/')) return jsonResp({ Value: [] });
  return jsonResp({});
}

// halo.js does `const fetch = require('node-fetch')` at module top, so a
// global.fetch stub never gets seen. Override the node-fetch module entry
// in the require cache before halo.js is loaded.
const Module = require('module');
const origResolve = Module._resolveFilename;
const FAKE_FETCH_PATH = path.join(__dirname, '__fake_node_fetch.js');
Module._resolveFilename = function (req, ...rest) {
  if (req === 'node-fetch') return FAKE_FETCH_PATH;
  return origResolve.call(this, req, ...rest);
};
require.cache[FAKE_FETCH_PATH] = {
  id: FAKE_FETCH_PATH,
  filename: FAKE_FETCH_PATH,
  loaded: true,
  exports: stubbedFetch,
};

// Stub redis so getRedis() doesn't fight us. halo.js gates redis behind a
// best-effort wrapper, but we set REDIS_URL to nothing to be safe.
delete process.env.REDIS_URL;

(async () => {
  let halo;
  try { halo = require(path.resolve(__dirname, '../src/halo.js')); }
  catch (e) {
    console.log = realLog; console.warn = realWarn;
    console.log('  ✗ halo.js failed to load: ' + (e && e.message ? e.message : e));
    process.exit(1);
  }

  let out;
  try {
    out = await halo.fetchMatchHistory(TARGET_XUID, 'INSANE TACTICS', 100);
  } catch (e) {
    console.log = realLog; console.warn = realWarn;
    console.log('  ✗ fetchMatchHistory threw: ' + (e && e.message ? e.message : e));
    process.exit(1);
  }

  console.log = realLog; console.warn = realWarn;

  console.log('fetchMatchHistory — ranked classification for representative payloads');
  const results = Array.isArray(out) ? out : (out && out.matches) || [];
  const byId = Object.fromEntries(results.map(r => [r.matchId, r]));

  const arena = byId['match-arena-1'];
  assert(arena, 'Ranked Arena match returned in results');
  assert(arena && arena.isRanked === true, 'Ranked Arena match has isRanked: true');
  assert(arena && arena.playlistKind === 'arena', 'Ranked Arena match has playlistKind="arena"');
  assert(arena && arena.playlistId === RANKED_ARENA_ID, 'Ranked Arena match has playlistId set');
  assert(arena && !arena.isCustom, 'Ranked Arena match is NOT flagged isCustom');

  const slayer = byId['match-slayer-1'];
  assert(slayer, 'Ranked Slayer match returned in results');
  assert(slayer && slayer.isRanked === true, 'Ranked Slayer match has isRanked: true');
  assert(slayer && slayer.playlistKind === 'slayer', 'Ranked Slayer match has playlistKind="slayer"');
  assert(slayer && slayer.gameMode === 'Ranked Slayer', 'Ranked Slayer gameMode is "Ranked Slayer"');

  const legacy = byId['match-legacy-1'];
  assert(legacy, 'Ranked Legacy match returned in results');
  assert(legacy && legacy.isRanked === true, 'Ranked Legacy match has isRanked: true');
  assert(legacy && legacy.playlistKind === 'legacy', 'Ranked Legacy match has playlistKind="legacy"');
  assert(legacy && /Ranked Legacy/.test(legacy.gameMode || ''), 'Ranked Legacy gameMode starts with "Ranked Legacy"');

  // The headline symptom: ranked count must be > 0.
  const rankedCount = results.filter(r => r.isRanked).length;
  assert(rankedCount === 3, `ranked count = ${rankedCount} (expected 3, not 0 like the regression)`);

  if (failed) { console.log('\nFAILED: ' + failed + ' check(s)'); process.exit(1); }
  console.log('\nAll checks passed.');
})();
