'use strict';

// Sign-in: the app password, plus a six-digit code from an authenticator app when TOTP_SECRET is set. That is the owner.
// A second, camera-only "viewer" sign-in exists when VIEWER_PASSWORD and VIEWER_TOTP_SECRET are both set: the shared viewer
// password plus a code from its own authenticator key. Viewer sessions are signed with a key that includes the viewer
// password, so changing VIEWER_PASSWORD ends every viewer session and no owner session.
// A session is a signed, HttpOnly cookie. It ends after 7 days without use, and 30 days after signing in whatever happens.
// "Sign out everywhere" ends every session that exists (the time it was used is kept in the database so it survives restarts).

const crypto = require('node:crypto');
const { createTotp } = require('./totp');

const COOKIE = 'hc_session';
const IDLE_MS = 7 * 24 * 3600 * 1000;    // unused for this long: signed out
const MAX_MS = 30 * 24 * 3600 * 1000;    // signed in this long ago: signed out, however much it is used
const RENEW_AFTER_MS = 24 * 3600 * 1000; // a session is extended at most once a day
const MAX_FAILS = 5;                     // wrong attempts from one address before it is locked out ...
const LOCK_MS = 15 * 60 * 1000;          // ... for this long
const GLOBAL_MAX_FAILS = 30;             // wrong attempts from everywhere in an hour before all sign-ins pause
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** Cookie header to {name: value}. A badly encoded value is skipped rather than allowed to throw. */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    try { out[part.slice(0, i).trim()] = decodeURIComponent(raw); } catch { /* malformed: ignore this cookie */ }
  }
  return out;
}

/** Why the viewer sign-in is off (or '' when it is on). It is never an error: the owner's sign-in is unaffected. */
function viewerProblem({ password, viewerPassword, viewerTotpSecret }) {
  if (!viewerPassword && !viewerTotpSecret) return 'not set up';
  if (!password) return 'the owner password (APP_PASSWORD) is not set';
  if (viewerPassword.length < 8) return 'VIEWER_PASSWORD must be at least 8 characters';
  if (viewerPassword === password) return 'VIEWER_PASSWORD must differ from APP_PASSWORD';
  if (!viewerTotpSecret) return 'VIEWER_TOTP_SECRET is not set (npm run totp:setup viewer)';
  try { createTotp(viewerTotpSecret); } catch (err) { return `VIEWER_TOTP_SECRET: ${err.message}`; }
  return '';
}

function createAuth({
  password, secret, secure, totpSecret = '', viewerPassword = '', viewerTotpSecret = '',
  loadValidAfter = async () => 0, saveValidAfter = async () => {}, now = () => Date.now(),
}) {
  const enabled = !!password;
  const key = secret || crypto.randomBytes(32).toString('hex'); // random per process if unset (dev)
  const hmac = (k, p) => crypto.createHmac('sha256', k).update(p).digest('base64url');
  const totp = totpSecret ? createTotp(totpSecret, now) : null;
  const viewerOff = viewerProblem({ password, viewerPassword, viewerTotpSecret });
  const viewer = viewerOff ? null : {
    totp: createTotp(viewerTotpSecret, now),
    key: `${key}|viewer|${sha(viewerPassword).toString('hex')}`, // a new viewer password = a new key = old viewer cookies refused
  };
  if (viewerOff && viewerOff !== 'not set up') console.warn(`[auth] camera-only sign-in is off: ${viewerOff}`);
  const codeRequired = !!totp || !!viewer; // the sign-in page shows the code box (the owner may leave it empty without TOTP_SECRET)
  const fails = new Map(); // address -> { count, until }
  let recentFails = [];    // times of wrong attempts from anywhere, for the global limit
  let validAfter = 0;      // sessions started at or before this time are no longer accepted

  // owner: "<loginAt>.<expires>.<sig>"   viewer: "v.<loginAt>.<expires>.<sig>"
  function makeToken(role, loginAt, expires) {
    const p = `${loginAt}.${expires}`;
    return role === 'viewer' ? `v.${p}.${hmac(viewer.key, `v.${p}`)}` : `${p}.${hmac(key, p)}`;
  }

  /** The session in a cookie value ({ role, loginAt, expires }), or null. */
  function readToken(t) {
    if (typeof t !== 'string') return null;
    const parts = t.split('.');
    let role; let signed; let k;
    if (parts.length === 3) { role = 'owner'; signed = `${parts[0]}.${parts[1]}`; k = key; }
    else if (parts.length === 4 && parts[0] === 'v' && viewer) { role = 'viewer'; parts.shift(); signed = `v.${parts[0]}.${parts[1]}`; k = viewer.key; }
    else return null;
    const [loginAt, expires, sig] = parts;
    const a = Buffer.from(sig);
    const b = Buffer.from(hmac(k, signed));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const s = { role, loginAt: Number(loginAt), expires: Number(expires) };
    if (!(s.expires > now()) || !(s.loginAt > validAfter) || now() - s.loginAt > MAX_MS) return null;
    return s;
  }

  const session = (req) => readToken(parseCookies(req.headers.cookie)[COOKIE]);
  const isAuthed = (req) => !enabled || !!session(req);
  /** 'owner', 'viewer' or null (not signed in). Without a password (local development only) everyone is the owner. */
  const role = (req) => (!enabled ? 'owner' : (session(req) || {}).role || null);

  function cookie(value, maxAgeSec) {
    return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
  }
  function issue(res, who, loginAt) {
    const expires = Math.min(now() + IDLE_MS, loginAt + MAX_MS);
    res.setHeader('Set-Cookie', cookie(makeToken(who, loginAt, expires), Math.max(1, Math.round((expires - now()) / 1000))));
  }

  /** Middleware: extends a session that is in use (at most once a day), up to 30 days from signing in. */
  function renew(req, res, next) {
    const s = enabled && session(req);
    if (s && s.expires - now() < IDLE_MS - RENEW_AFTER_MS && s.expires < s.loginAt + MAX_MS) issue(res, s.role, s.loginAt);
    next();
  }

  // The log line includes the forwarded-for chain, so it can be checked that the address used for the limit is the visitor's.
  function failed(ip, rec, why, forwardedFor) {
    let count = rec ? rec.count : 0;
    if (rec && rec.until && rec.until <= now()) count = 0; // lock expired: start again
    count += 1;
    fails.set(ip, { count, until: count >= MAX_FAILS ? now() + LOCK_MS : 0, seen: now() });
    recentFails.push(now());
    console.warn(`[auth] failed sign-in (${why}) from ${ip} [forwarded-for: ${forwardedFor || '-'}]: ${count} from this address, ${recentFails.length} in the last hour`);
  }

  function login(req, res) {
    const ip = req.ip || 'unknown';
    const t = now();
    recentFails = recentFails.filter((x) => t - x < GLOBAL_WINDOW_MS);
    const rec = fails.get(ip);
    if (rec && rec.until > t) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    if (recentFails.length >= GLOBAL_MAX_FAILS) {
      console.warn(`[auth] sign-in paused: ${recentFails.length} failed attempts in the last hour`);
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }

    const body = req.body || {};
    const given = typeof body.password === 'string' ? body.password : '';
    const code = typeof body.code === 'string' ? body.code : '';
    // Both passwords are always compared, so the time taken does not reveal which one was nearly right.
    const isOwner = enabled && crypto.timingSafeEqual(sha(given), sha(password));
    const isViewer = !!viewer && crypto.timingSafeEqual(sha(given), sha(viewerPassword));
    const who = isOwner ? 'owner' : isViewer ? 'viewer' : null;
    const codeOk = who === 'owner' ? (!totp || totp.verify(code)) : who === 'viewer' ? viewer.totp.verify(code) : false;
    if (!who || !codeOk) {
      failed(ip, rec, who ? `${who} code` : 'password', req.headers['x-forwarded-for']);
      return res.status(401).json({ error: codeRequired ? 'Incorrect password or code' : 'Incorrect password' });
    }
    fails.delete(ip);
    if (who === 'viewer') console.log(`[auth] camera-only sign-in from ${ip}`);
    issue(res, who, t);
    return res.json({ ok: true, role: who });
  }

  function logout(req, res) {
    res.setHeader('Set-Cookie', cookie('', 0));
    res.json({ ok: true });
  }

  /** Ends every session, this one included. */
  async function signOutEverywhere() {
    validAfter = now();
    await saveValidAfter(validAfter);
  }

  async function init() {
    try { validAfter = Number(await loadValidAfter()) || 0; } catch (err) { console.error('[auth] could not read sign-out time:', err.message); }
  }

  // Forget addresses whose lock has run out, so the list cannot grow without limit.
  const pruner = setInterval(() => {
    const t = now();
    for (const [ip, r] of fails) if ((r.until && r.until <= t) || (!r.until && t - r.seen > LOCK_MS)) fails.delete(ip);
    recentFails = recentFails.filter((x) => t - x < GLOBAL_WINDOW_MS);
  }, 5 * 60_000);
  pruner.unref();

  return {
    enabled, codeRequired, viewerEnabled: !!viewer, isAuthed, session, role, renew, login, logout, signOutEverywhere, init,
    stop: () => clearInterval(pruner),
    _fails: fails,
  };
}

module.exports = { createAuth, parseCookies, viewerProblem, IDLE_MS, MAX_MS };
