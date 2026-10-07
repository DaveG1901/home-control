'use strict';

// Single-password login with a signed, HttpOnly session cookie.
// Good enough for a personal dashboard behind HTTPS; rotate SESSION_SECRET to sign everyone out.

const crypto = require('node:crypto');

const COOKIE = 'hc_session';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth({ password, secret, secure }) {
  const enabled = !!password;
  const key = secret || crypto.randomBytes(32).toString('hex'); // random per process if unset (dev)
  const sign = (p) => crypto.createHmac('sha256', key).update(p).digest('base64url');
  const fails = new Map(); // ip -> { count, until }

  function makeToken() {
    const p = String(Date.now() + MAX_AGE_MS);
    return `${p}.${sign(p)}`;
  }

  function verifyToken(t) {
    if (!t) return false;
    const [p, sig] = t.split('.');
    if (!p || !sig) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(sign(p));
    return a.length === b.length && crypto.timingSafeEqual(a, b) && Number(p) > Date.now();
  }

  const isAuthed = (req) => !enabled || verifyToken(parseCookies(req.headers.cookie)[COOKIE]);

  function cookie(value, maxAgeSec) {
    return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
  }

  function login(req, res) {
    const ip = req.ip || 'unknown';
    const rec = fails.get(ip);
    if (rec && rec.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again later.' });

    const given = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    const ok = enabled && crypto.timingSafeEqual(sha(given), sha(password));
    if (!ok) {
      let count = rec ? rec.count : 0;
      if (rec && rec.until && rec.until <= Date.now()) count = 0; // lock expired: start again
      count += 1;
      fails.set(ip, { count, until: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      return res.status(401).json({ error: 'Incorrect password' });
    }
    fails.delete(ip);
    res.setHeader('Set-Cookie', cookie(makeToken(), MAX_AGE_MS / 1000));
    return res.json({ ok: true });
  }

  function logout(req, res) {
    res.setHeader('Set-Cookie', cookie('', 0));
    res.json({ ok: true });
  }

  return { enabled, isAuthed, login, logout };
}

module.exports = { createAuth, parseCookies };
