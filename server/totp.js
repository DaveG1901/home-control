'use strict';

// Six-digit codes from an authenticator app (RFC 6238: SHA-1, 30-second steps), the second step of signing in.

const crypto = require('node:crypto');

const STEP_S = 30;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(s) {
  const clean = String(s || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('TOTP_SECRET is not valid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** The code for one 30-second step. */
function codeAt(key, step, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}

/**
 * Checks codes for one secret. Accepts the current step and one either side (phone clocks drift), and never accepts the same
 * step twice, so a code seen over someone's shoulder cannot be reused.
 */
function createTotp(secret, now = () => Date.now()) {
  const key = base32Decode(secret);
  if (key.length < 10) throw new Error('TOTP_SECRET is too short (use npm run totp:setup to make one)');
  let lastStep = -1;
  return {
    verify(code) {
      if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return false;
      const c = Buffer.from(code.trim());
      const step = Math.floor(now() / 1000 / STEP_S);
      for (const s of [step - 1, step, step + 1]) {
        if (s <= lastStep) continue;
        if (crypto.timingSafeEqual(c, Buffer.from(codeAt(key, s)))) { lastStep = s; return true; }
      }
      return false;
    },
  };
}

function newSecret() { return base32Encode(crypto.randomBytes(20)); }

module.exports = { createTotp, codeAt, base32Decode, base32Encode, newSecret };
