'use strict';

// Sign-in: the app password, plus a six-digit code from an authenticator app when TOTP_SECRET is set.
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

function createAuth({ password, secret, secure, totpSecret = '', loadValidAfter = async () => 0, saveValidAfter = async () => {}, now = () => Date.now() }) {
  const enabled = !!password;
  const key = secret || crypto.randomBytes(32).toString('hex'); // random per process if unset (dev)
  const sign = (p) => crypto.createHmac('sha256', key).update(p).digest('base64url');
  const totp = totpSecret ? createTotp(totpSecret, now) : null;
  const fails = new Map(); // address -> { count, until }
  let recentFails = [];    // times of wrong attempts from anywhere, for the global limit
  let validAfter = 0;      // sessions started at or before this time are no longer accepted

  const makeToken = (loginAt, expires) => { const p = `${loginAt}.${expires}`; return `${p}.${sign(p)}`; };

  /** The session in a cookie value, or null. */
  function readToken(t) {
    if (typeof t !== 'string') return null;
    const parts = t.split('.');
    if (parts.length !== 3) return null;
    const [loginAt, expires, sig] = parts;
    const a = Buffer.from(sig);
    const b = Buffer.from(sign(`${loginAt}.${expires}`));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const s = { loginAt: Number(loginAt), expires: Number(expires) };
    if (!(s.expires > now()) || !(s.loginAt > validAfter) || now() - s.loginAt > MAX_MS) return null;
    return s;
  }

  const session = (req) => readToken(parseCookies(req.headers.cookie)[COOKIE]);
  const isAuthed = (req) => !enabled || !!session(req);

  function cookie(value, maxAgeSec) {
    return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
  }
  function issue(res, loginAt) {
    const expires = Math.min(now() + IDLE_MS, loginAt + MAX_MS);
    res.setHeader('Set-Cookie', cookie(makeToken(loginAt, expires), Math.max(1, Math.round((expires - now()) / 1000))));
  }

  /** Middleware: extends a session that is in use (at most once a day), up to 30 days from signing in. */
  function renew(req, res, next) {
    const s = enabled && session(req);
    if (s && s.expires - now() < IDLE_MS - RENEW_AFTER_MS && s.expires < s.loginAt + MAX_MS) issue(res, s.loginAt);
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
    const pwOk = enabled && crypto.timingSafeEqual(sha(given), sha(password));
    const codeOk = !totp || (pwOk && totp.verify(typeof body.code === 'string' ? body.code : ''));
    if (!pwOk || !codeOk) {
      failed(ip, rec, pwOk ? 'code' : 'password', req.headers['x-forwarded-for']);
      return res.status(401).json({ error: totp ? 'Incorrect password or code' : 'Incorrect password' });
    }
    fails.delete(ip);
    issue(res, t);
    return res.json({ ok: true });
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
    enabled, codeRequired: !!totp, isAuthed, session, renew, login, logout, signOutEverywhere, init,
    stop: () => clearInterval(pruner),
    _fails: fails,
  };
}

module.exports = { createAuth, parseCookies, IDLE_MS, MAX_MS };
