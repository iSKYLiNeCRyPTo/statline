#!/usr/bin/env node
// Lightweight verification for the centralized auth module.
// Run with: `node scripts/verify-auth.js`
//
// Covers:
//   - placeholder / missing / short secrets are rejected (production)
//   - placeholder / missing / short secrets are rejected (non-production)
//     unless ALLOW_DEV_INSECURE_SECRETS=1
//   - safeEqual is constant-time-ish and returns correct booleans
//   - checkAdminPass / checkCalibrateKey accept correct values, reject wrong ones
//   - checkAdminPass reads from both ?pass= query and x-admin-pass header

const path = require('path');
const assert = require('assert');

const AUTH_PATH = path.join(__dirname, '..', 'src', 'auth.js');

function freshAuth() {
  delete require.cache[require.resolve(AUTH_PATH)];
  return require(AUTH_PATH);
}

function withEnv(overrides, fn) {
  const snapshot = {};
  for (const k of Object.keys(overrides)) {
    snapshot[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(snapshot)) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  }
}

function expectThrows(fn, matcher, label) {
  let threw = null;
  try { fn(); } catch(e) { threw = e; }
  assert.ok(threw, `${label}: expected throw, got success`);
  if (matcher) assert.ok(matcher.test(threw.message), `${label}: message "${threw.message}" did not match ${matcher}`);
}

let passed = 0;
function ok(label) { console.log('  ok  ' + label); passed++; }

console.log('verify-auth: starting');

// 1. Production rejects missing values.
withEnv({ NODE_ENV: 'production', ADMIN_PASS: undefined, CALIBRATE_KEY: undefined, ALLOW_DEV_INSECURE_SECRETS: undefined }, () => {
  const a = freshAuth();
  expectThrows(() => a.loadSecrets(), /ADMIN_PASS is not set/, 'prod missing ADMIN_PASS');
});
ok('production refuses to start with missing ADMIN_PASS');

// 2. Production rejects placeholder defaults.
withEnv({ NODE_ENV: 'production', ADMIN_PASS: 'changeme', CALIBRATE_KEY: 'calibrate', ALLOW_DEV_INSECURE_SECRETS: '1' }, () => {
  const a = freshAuth();
  expectThrows(() => a.loadSecrets(), /ADMIN_PASS .* placeholder/, 'prod placeholder ADMIN_PASS');
});
ok('production refuses placeholder ADMIN_PASS even with ALLOW_DEV_INSECURE_SECRETS=1');

// 3. Production rejects too-short secrets.
withEnv({ NODE_ENV: 'production', ADMIN_PASS: 'short', CALIBRATE_KEY: 'AStrongCalibKey1234' }, () => {
  const a = freshAuth();
  expectThrows(() => a.loadSecrets(), /ADMIN_PASS is shorter/, 'prod short ADMIN_PASS');
});
ok('production refuses too-short ADMIN_PASS');

// 4. Non-prod also rejects placeholders by default (no escape hatch flag).
withEnv({ NODE_ENV: 'development', ADMIN_PASS: 'changeme', CALIBRATE_KEY: 'AStrongCalibKey1234', ALLOW_DEV_INSECURE_SECRETS: undefined }, () => {
  const a = freshAuth();
  expectThrows(() => a.loadSecrets(), /placeholder/, 'dev placeholder without flag');
});
ok('non-production refuses placeholder ADMIN_PASS without ALLOW_DEV_INSECURE_SECRETS');

// 5. Non-prod with explicit flag: warn but continue.
withEnv({ NODE_ENV: 'development', ADMIN_PASS: 'changeme', CALIBRATE_KEY: 'AStrongCalibKey1234', ALLOW_DEV_INSECURE_SECRETS: '1' }, () => {
  const a = freshAuth();
  // Suppress warn output to keep test log clean.
  const origWarn = console.warn; console.warn = () => {};
  try {
    const s = a.loadSecrets();
    assert.strictEqual(s.ADMIN_PASS, 'changeme');
  } finally { console.warn = origWarn; }
});
ok('non-production with ALLOW_DEV_INSECURE_SECRETS=1 continues (with warning)');

// 6. Strong secrets succeed in production.
withEnv({ NODE_ENV: 'production', ADMIN_PASS: 'AStrongAdminPass123', CALIBRATE_KEY: 'AStrongCalibKey4567' }, () => {
  const a = freshAuth();
  const s = a.loadSecrets();
  assert.strictEqual(s.ADMIN_PASS, 'AStrongAdminPass123');
  assert.strictEqual(s.CALIBRATE_KEY, 'AStrongCalibKey4567');
});
ok('production accepts strong secrets');

// 7. checkAdminPass query + header, correct/incorrect.
withEnv({ NODE_ENV: 'production', ADMIN_PASS: 'AStrongAdminPass123', CALIBRATE_KEY: 'AStrongCalibKey4567' }, () => {
  const a = freshAuth();
  // prime the cached secrets
  a.secrets();
  assert.strictEqual(a.checkAdminPass({ query: { pass: 'AStrongAdminPass123' }, headers: {} }), true);
  assert.strictEqual(a.checkAdminPass({ query: {}, headers: { 'x-admin-pass': 'AStrongAdminPass123' } }), true);
  assert.strictEqual(a.checkAdminPass({ query: { pass: 'wrong' }, headers: {} }), false);
  assert.strictEqual(a.checkAdminPass({ query: {}, headers: {} }), false);
  assert.strictEqual(a.checkAdminPass({ query: { pass: '' }, headers: { 'x-admin-pass': '' } }), false);
});
ok('checkAdminPass accepts correct query/header, rejects wrong/empty');

// 8. checkCalibrateKey
withEnv({ NODE_ENV: 'production', ADMIN_PASS: 'AStrongAdminPass123', CALIBRATE_KEY: 'AStrongCalibKey4567' }, () => {
  const a = freshAuth();
  a.secrets();
  assert.strictEqual(a.checkCalibrateKey('AStrongCalibKey4567'), true);
  assert.strictEqual(a.checkCalibrateKey('calibrate'), false);
  assert.strictEqual(a.checkCalibrateKey(''), false);
  assert.strictEqual(a.checkCalibrateKey(undefined), false);
  assert.strictEqual(a.checkCalibrateKey(null), false);
  assert.strictEqual(a.checkCalibrateKey(12345), false);
});
ok('checkCalibrateKey accepts correct value, rejects placeholder/empty/non-string');

// 9. safeEqual: short-circuits non-strings, never throws.
withEnv({ NODE_ENV: 'production', ADMIN_PASS: 'AStrongAdminPass123', CALIBRATE_KEY: 'AStrongCalibKey4567' }, () => {
  const a = freshAuth();
  const { safeEqual } = a._internals;
  assert.strictEqual(safeEqual('abc', 'abc'), true);
  assert.strictEqual(safeEqual('abc', 'abcd'), false);
  assert.strictEqual(safeEqual('abc', 'abd'), false);
  assert.strictEqual(safeEqual(null, 'abc'), false);
  assert.strictEqual(safeEqual('abc', undefined), false);
  assert.strictEqual(safeEqual(123, 123), false);
});
ok('safeEqual handles equal/unequal/non-string inputs without throwing');

console.log(`\nverify-auth: ${passed} checks passed`);
