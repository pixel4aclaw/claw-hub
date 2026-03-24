const crypto = require('crypto');

const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Z4tCdDg4prtNwCb';
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'claw_session';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

function signValue(val) {
  const sig = crypto.createHmac('sha256', COOKIE_SECRET).update(val).digest('base64url');
  return `${val}.${sig}`;
}

function verifyValue(signed) {
  if (!signed) return null;
  const dot = signed.lastIndexOf('.');
  if (dot < 0) return null;
  const val = signed.slice(0, dot);
  const expected = signValue(val);
  if (signed !== expected) return null;
  return val;
}

function setSession(res, username) {
  const payload = JSON.stringify({ username, ts: Date.now() });
  const b64 = Buffer.from(payload).toString('base64url');
  const signed = signValue(b64);
  res.cookie(COOKIE_NAME, signed, {
    maxAge: COOKIE_MAX_AGE,
    httpOnly: true,
    sameSite: 'lax',
  });
}

function getSession(req) {
  const signed = req.cookies?.[COOKIE_NAME];
  const b64 = verifyValue(signed);
  if (!b64) return null;
  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString());
  } catch {
    return null;
  }
}

function clearSession(res) {
  res.clearCookie(COOKIE_NAME);
}

// Middleware: require valid session or redirect to /login
function requireAuth(req, res, next) {
  // Always allow login page and its assets
  if (req.path === '/login' || req.path.startsWith('/api/login')) return next();
  const session = getSession(req);
  if (session?.username) {
    req.user = session.username;
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.redirect('/login');
}

module.exports = { SITE_PASSWORD, setSession, getSession, clearSession, requireAuth };
