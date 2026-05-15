// Centralized auth/secret validation for fragr (statline).
//
// All admin and calibration endpoints route their credential checks through
// this module so there is a single source of truth. Secrets are pulled from
// environment variables only — no fallback defaults — and validated at
// startup so the process fails closed if they are missing or obviously unsafe.

const crypto = require('crypto');

// Values that historically appeared as fallback defaults or are otherwise
// well-known/weak. We refuse to start with any of these as the configured
// secret to make sure a leftover dev value never reaches production.
const FORBIDDEN_SECRETS = new Set([
  'changeme',
  'change-me',
  'password',
  'admin',
  'calibrate',
  'secret',
  'test',
  '',
]);

const MIN_SECRET_LENGTH = 12;

function isPlaceholder(value) {
  if (!value) return true;
  return FORBIDDEN_SECRETS.has(String(value).trim().toLowerCase());
}

// Constant-time string compare. Falls back to `false` when either side is
// missing rather than throwing — callers always treat that as auth failure.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still run a compare against `ab` so total time depends on the attacker-
    // controlled input length, not on whether the configured secret matched
    // in length.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function readSecret(name) {
  const raw = process.env[name];
  return typeof raw === 'string' ? raw : '';
}

// Validate one secret env var. In production, missing/placeholder/short
// values throw and abort startup. In non-production, the same conditions
// throw unless ALLOW_DEV_INSECURE_SECRETS=1 is explicitly set, in which
// case we log a loud warning and continue with the unsafe value so local
// tests can run. This flag is intentionally never honored when NODE_ENV
// is "production".
function validateSecret(name, { production, allowDevInsecure }) {
  const value = readSecret(name);
  const problems = [];
  if (!value) problems.push('is not set');
  else if (isPlaceholder(value)) problems.push('uses a known placeholder/default value');
  else if (value.length < MIN_SECRET_LENGTH) problems.push(`is shorter than ${MIN_SECRET_LENGTH} chars`);

  if (!problems.length) return value;

  const detail = problems.join(', ');
  if (production || !allowDevInsecure) {
    throw new Error(
      `[auth] ${name} ${detail}. Set ${name} to a strong value in the environment. ` +
      `For local dev only, you may set ALLOW_DEV_INSECURE_SECRETS=1 (NODE_ENV must not be "production").`
    );
  }
  console.warn(`[auth] WARNING: ${name} ${detail}. Continuing because ALLOW_DEV_INSECURE_SECRETS=1 and NODE_ENV != production.`);
  return value;
}

function loadSecrets() {
  const production = process.env.NODE_ENV === 'production';
  const allowDevInsecure = process.env.ALLOW_DEV_INSECURE_SECRETS === '1';
  return {
    ADMIN_PASS: validateSecret('ADMIN_PASS', { production, allowDevInsecure }),
    CALIBRATE_KEY: validateSecret('CALIBRATE_KEY', { production, allowDevInsecure }),
  };
}

let _secrets = null;
function secrets() {
  if (!_secrets) _secrets = loadSecrets();
  return _secrets;
}

function extractAdminPass(req) {
  const fromQuery = req.query && req.query.pass;
  const fromHeader = req.headers && req.headers['x-admin-pass'];
  return (typeof fromQuery === 'string' && fromQuery)
    || (typeof fromHeader === 'string' && fromHeader)
    || '';
}

function checkAdminPass(req) {
  return safeEqual(extractAdminPass(req), secrets().ADMIN_PASS);
}

function checkCalibrateKey(key) {
  return safeEqual(typeof key === 'string' ? key : '', secrets().CALIBRATE_KEY);
}

// Express middleware: 401 JSON when admin pass is wrong/missing.
function requireAdminJson(req, res, next) {
  if (!checkAdminPass(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Express middleware: 401 plain text when admin pass is wrong/missing
// (matches the legacy behavior of the HTML/admin UI endpoints).
function requireAdminText(req, res, next) {
  if (!checkAdminPass(req)) return res.status(401).send('Unauthorized');
  next();
}

module.exports = {
  loadSecrets,
  secrets,
  checkAdminPass,
  checkCalibrateKey,
  requireAdminJson,
  requireAdminText,
  // exported for tests
  _internals: { isPlaceholder, safeEqual, FORBIDDEN_SECRETS, MIN_SECRET_LENGTH },
};
