#!/usr/bin/env node
// Stub-driven smoke test for POST /api/admin/backfill-participants.
//
// We cannot stand up real Redis or Postgres in CI, so this test mounts the
// endpoint handler logic against an in-process Express app with the shared
// backfill module driving a fake Redis. The handler is exercised directly
// through HTTP (using node-fetch's underlying http server).
//
// Coverage:
//   - rejects unauthenticated requests (no header / wrong header → 401)
//   - misconfigured ADMIN_PASS surfaces as 503, not a silent default
//   - defaults to dry-run when body omits the explicit pair
//   - dryRun:false alone is still treated as dry-run (confirm:true also required)
//   - real run requires DATABASE_URL or returns 400
//   - real run with both flags invokes saveMatchParticipants and reports counts
//   - concurrent calls receive 409 with `since`/`dryRun` echo
//   - limit/batchSize/scanCount clamped to configured maximums
//
// Run:  node scripts/verify-backfill-endpoint.js

const http = require('http');
const path = require('path');

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ✓', msg); pass++; }
  else      { console.error('  ✗', msg); fail++; process.exitCode = 1; }
}

// ── Configure environment BEFORE requiring src/auth.js ───────────────────────
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASS = 'a-strong-test-admin-pass-1234';
process.env.CALIBRATE_KEY = 'a-strong-test-calibrate-key-1234';
process.env.ALLOW_DEV_INSECURE_SECRETS = '0';

const adminAuth = require(path.join(__dirname, '..', 'src', 'auth.js'));
const { runBackfill } = require(path.join(__dirname, '..', 'src', 'backfillParticipants.js'));

// ── Fake Redis with player blobs (same fixtures as verify-backfill.js) ───────
const fakeStore = {
  'player:alpha':   JSON.stringify({ xuid: '2000000000000001', gamertag: 'Alpha', allMatches: [
    { matchId: 'm-1', teams: [
      { players: [{ rawXuid: '1', kills: 10, deaths: 5 }, { rawXuid: '2', kills: 5, deaths: 5 }] },
      { players: [{ rawXuid: '3', kills: 8, deaths: 9 }] },
    ]},
  ]}),
  'player:bravo':   JSON.stringify({ xuid: '2000000000000002', gamertag: 'Bravo', allMatches: [
    { matchId: 'm-2', teams: [
      { players: [{ rawXuid: '4', kills: 1, deaths: 9 }] },
    ]},
  ]}),
};
const fakeRedis = {
  isOpen: true,
  get: async k => (fakeStore[k] != null ? fakeStore[k] : null),
  async *scanIterator(opts) {
    const pat = (opts && opts.MATCH) || '*';
    const re = new RegExp('^' + pat.replace(/\*/g, '.*') + '$');
    for (const k of Object.keys(fakeStore)) if (re.test(k)) yield k;
  },
};

let saveCalls = 0;
let saveTotalRowsRequested = 0;
async function fakeSaveMatchParticipants(matches, sourceXuid) {
  saveCalls++;
  let n = 0;
  for (const m of matches) for (const t of m.teams || []) n += (t.players || []).length;
  saveTotalRowsRequested += n;
  return n;
}

// ── Wire up a minimal express app that mirrors the production handler ────────
// The production handler is defined inline in server.js — we'd rather not boot
// the whole server (it opens DB+halo pools at import). Instead we re-implement
// the exact same wiring against our stubs. This keeps the test self-contained
// AND verifies the shared module behaves under the same option semantics that
// server.js applies.
const express = require('express');
const app = express();
app.use(express.json());

const LIMITS = {
  defaultLimit: 200, maxLimit: 5000,
  defaultBatchSize: 100, maxBatchSize: 1000,
  defaultScanCount: 200, maxScanCount: 2000,
};
let _running = null;

function checkAdminFailClosed(req, res) {
  try {
    if (!adminAuth.checkAdminPass(req)) { res.status(401).json({ error: 'Unauthorized' }); return false; }
    return true;
  } catch (e) { res.status(503).json({ error: 'misconfigured: ' + e.message }); return false; }
}
function clampInt(v, fb, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return fb;
  return Math.min(n, max);
}

app.post('/api/admin/backfill-participants', async (req, res) => {
  if (!checkAdminFailClosed(req, res)) return;
  if (_running) {
    return res.status(409).json({
      error: 'Backfill already running',
      since: new Date(_running.startedAt).toISOString(),
      dryRun: _running.dryRun,
    });
  }
  const body = req.body || {};
  const dryRun = !(body.dryRun === false && body.confirm === true);
  const options = {
    dryRun,
    limit: clampInt(body.limit, LIMITS.defaultLimit, LIMITS.maxLimit),
    batchSize: clampInt(body.batchSize, LIMITS.defaultBatchSize, LIMITS.maxBatchSize),
    scanCount: clampInt(body.scanCount, LIMITS.defaultScanCount, LIMITS.maxScanCount),
    keyPattern: typeof body.keyPattern === 'string' && body.keyPattern ? body.keyPattern : 'player:*',
    verbose: !!body.verbose,
  };
  if (!options.dryRun && !process.env.DATABASE_URL) {
    return res.status(400).json({ error: 'DATABASE_URL not configured' });
  }
  _running = { startedAt: Date.now(), dryRun: options.dryRun };
  try {
    const result = await runBackfill({
      redis: fakeRedis,
      saveMatchParticipants: fakeSaveMatchParticipants,
      options,
      logger: { log: () => {}, warn: () => {} },
    });
    res.json({ ok: true, dryRun: result.dryRun, requested: options, counters: {
      keysScanned: result.keysScanned,
      playersParsed: result.playersParsed,
      matchesEligible: result.matchesEligible,
      rowsWrittenReported: result.rowsWrittenReported,
      errors: result.errors,
    }, elapsedSeconds: result.elapsedSeconds });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    _running = null;
  }
});

// Boot test server on an ephemeral port and run assertions.
(async () => {
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function call(opts = {}) {
    const url = base + '/api/admin/backfill-participants';
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const body = opts.body ? JSON.stringify(opts.body) : '{}';
    const res = await new Promise((resolve, reject) => {
      const req = http.request(url, { method: 'POST', headers }, r => {
        let buf = '';
        r.on('data', d => buf += d);
        r.on('end', () => resolve({ status: r.statusCode, body: buf }));
      });
      req.on('error', reject);
      req.write(body); req.end();
    });
    let json = null;
    try { json = JSON.parse(res.body); } catch {}
    return { status: res.status, json };
  }

  try {
    console.log('Test 1: missing/wrong admin pass → 401');
    const r1 = await call({});
    assert(r1.status === 401, `no auth → 401 (got ${r1.status})`);
    const r1b = await call({ headers: { 'x-admin-pass': 'wrong' } });
    assert(r1b.status === 401, `wrong pass → 401 (got ${r1b.status})`);

    const headers = { 'x-admin-pass': process.env.ADMIN_PASS };

    console.log('\nTest 2: default body → dry-run (no writes)');
    saveCalls = 0; saveTotalRowsRequested = 0;
    const r2 = await call({ headers, body: {} });
    assert(r2.status === 200, `default → 200 (got ${r2.status})`);
    assert(r2.json && r2.json.dryRun === true, 'dryRun=true by default');
    assert(saveCalls === 0, `no saveMatchParticipants calls in dry-run (got ${saveCalls})`);
    assert(r2.json.counters.playersParsed === 2, `2 players parsed (got ${r2.json.counters.playersParsed})`);

    console.log('\nTest 3: dryRun:false without confirm:true is STILL dry-run');
    saveCalls = 0;
    const r3 = await call({ headers, body: { dryRun: false } });
    assert(r3.json.dryRun === true, 'fail-closed: missing confirm → dry-run');
    assert(saveCalls === 0, 'no writes when confirm missing');

    console.log('\nTest 4: confirm:true without dryRun:false is STILL dry-run');
    saveCalls = 0;
    const r4 = await call({ headers, body: { confirm: true } });
    assert(r4.json.dryRun === true, 'fail-closed: missing dryRun:false → dry-run');
    assert(saveCalls === 0, 'no writes when dryRun:false missing');

    console.log('\nTest 5: real run requires DATABASE_URL');
    delete process.env.DATABASE_URL;
    const r5 = await call({ headers, body: { dryRun: false, confirm: true } });
    assert(r5.status === 400, `no DATABASE_URL → 400 (got ${r5.status})`);
    process.env.DATABASE_URL = 'postgresql://stub';

    console.log('\nTest 6: dryRun:false + confirm:true → invokes saveMatchParticipants');
    saveCalls = 0; saveTotalRowsRequested = 0;
    const r6 = await call({ headers, body: { dryRun: false, confirm: true } });
    assert(r6.status === 200, `real run → 200 (got ${r6.status})`);
    assert(r6.json.dryRun === false, 'dryRun=false echoed');
    assert(saveCalls === 2, `saveMatchParticipants called once per player (got ${saveCalls})`);
    assert(r6.json.counters.rowsWrittenReported === saveTotalRowsRequested,
      `rowsWrittenReported (${r6.json.counters.rowsWrittenReported}) == saver totals (${saveTotalRowsRequested})`);

    console.log('\nTest 7: option clamps cap abusive request values');
    const r7 = await call({ headers, body: { limit: 999999, batchSize: 999999, scanCount: 999999 } });
    assert(r7.json.requested.limit === LIMITS.maxLimit, `limit clamped to ${LIMITS.maxLimit} (got ${r7.json.requested.limit})`);
    assert(r7.json.requested.batchSize === LIMITS.maxBatchSize, 'batchSize clamped');
    assert(r7.json.requested.scanCount === LIMITS.maxScanCount, 'scanCount clamped');

    console.log('\nTest 8: concurrent request → 409');
    // Stall the next save so the first run is still in-flight when we call again.
    const realSaver = fakeSaveMatchParticipants;
    let release;
    const gate = new Promise(r => { release = r; });
    // eslint-disable-next-line no-func-assign
    global.__overrideSaver = async () => { await gate; return 0; };
    // Monkey-patch by swapping the saver bound in the closure: easiest path is
    // to add a slow scanner. We'll just kick two requests at once on dry-run
    // (where save isn't called) but slow down scan via a custom keyPattern that
    // includes a synthetic key whose getter sleeps.
    const slowStore = { ...fakeStore, 'player:zzslow': JSON.stringify({ xuid: '9', gamertag: 'Slow', allMatches: [] }) };
    const slowRedis = {
      isOpen: true,
      get: async k => {
        if (k === 'player:zzslow') await gate;
        return slowStore[k] != null ? slowStore[k] : null;
      },
      async *scanIterator(opts) {
        const pat = (opts && opts.MATCH) || '*';
        const re = new RegExp('^' + pat.replace(/\*/g, '.*') + '$');
        for (const k of Object.keys(slowStore)) if (re.test(k)) yield k;
      },
    };
    // Temporarily replace fakeRedis used by the handler closure. We re-mount a
    // second route that wires slowRedis through the same logic.
    app.post('/api/admin/backfill-participants-slow', async (req, res) => {
      if (!checkAdminFailClosed(req, res)) return;
      if (_running) return res.status(409).json({ error: 'busy', since: new Date(_running.startedAt).toISOString(), dryRun: _running.dryRun });
      _running = { startedAt: Date.now(), dryRun: true };
      try {
        const r = await runBackfill({
          redis: slowRedis,
          saveMatchParticipants: realSaver,
          options: { dryRun: true, limit: 10, batchSize: 1, scanCount: 10, keyPattern: 'player:*', verbose: false },
          logger: { log: () => {}, warn: () => {} },
        });
        res.json({ ok: true, dryRun: r.dryRun });
      } finally { _running = null; }
    });
    function callSlow() {
      return new Promise((resolve, reject) => {
        const req = http.request(base + '/api/admin/backfill-participants-slow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-pass': process.env.ADMIN_PASS },
        }, r => {
          let buf = ''; r.on('data', d => buf += d); r.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch {} resolve({ status: r.statusCode, json: j }); });
        });
        req.on('error', reject); req.write('{}'); req.end();
      });
    }
    const first = callSlow();
    // Give the first request enough time to acquire the lock before firing the second.
    await new Promise(r => setTimeout(r, 50));
    const second = await callSlow();
    assert(second.status === 409, `concurrent → 409 (got ${second.status})`);
    assert(second.json && second.json.since, '409 includes since timestamp');
    release();
    await first;
    assert(_running === null, 'lock released after first run completes');

    console.log('\nTest 9: misconfigured ADMIN_PASS → 503 (fail closed)');
    // Reset the lazily-cached secrets so changing env takes effect.
    const goodPass = process.env.ADMIN_PASS;
    delete process.env.ADMIN_PASS;
    process.env.NODE_ENV = 'production'; // force strict validation
    // Re-require auth.js with a clean module cache so it re-reads env.
    delete require.cache[require.resolve(path.join(__dirname, '..', 'src', 'auth.js'))];
    const freshAuth = require(path.join(__dirname, '..', 'src', 'auth.js'));
    // Replace the live handler's adminAuth ref to use the fresh one. The
    // simplest path is to mount a dedicated test route that uses freshAuth.
    app.post('/api/admin/backfill-participants-misconfig', (req, res) => {
      try {
        if (!freshAuth.checkAdminPass(req)) return res.status(401).json({ error: 'Unauthorized' });
        res.json({ ok: true });
      } catch (e) {
        res.status(503).json({ error: e.message });
      }
    });
    const r9 = await new Promise(resolve => {
      const req = http.request(base + '/api/admin/backfill-participants-misconfig', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-pass': 'whatever' },
      }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolve({ status: r.statusCode, body: b })); });
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.write('{}'); req.end();
    });
    assert(r9.status === 503, `misconfigured → 503 (got ${r9.status})`);
    process.env.ADMIN_PASS = goodPass;
    process.env.NODE_ENV = 'test';

    console.log(`\nDone. ${pass} passed, ${fail} failed.`);
  } finally {
    server.close();
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
