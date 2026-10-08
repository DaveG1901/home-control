'use strict';

// Authenticator-app codes for signing in.
//   npm run totp:setup          makes a new secret to add to your authenticator app and to TOTP_SECRET
//   npm run totp:check 123456   checks a code from the app against TOTP_SECRET in .env

const { createTotp, newSecret } = require('../server/totp');

const [cmd, code] = process.argv.slice(2);

if (cmd === 'setup') {
  const secret = newSecret();
  const label = encodeURIComponent('Home Control');
  console.log(`
New authenticator secret (keep it private, like a password):

  ${secret.match(/.{1,4}/g).join(' ')}

1. In your authenticator app (Microsoft Authenticator, Google Authenticator, 1Password, ...), add an account and choose
   "enter a setup key" / "enter code manually". Name: Home Control. Key: the letters above. Type: time-based.
   (Some apps accept this link instead: otpauth://totp/${label}?secret=${secret}&issuer=${label})
2. Put it in .env as   TOTP_SECRET=${secret}
3. Check a code from the app:   npm run totp:check <the 6 digits>
4. When that works, add TOTP_SECRET with the same value in the Render dashboard (Environment). The service restarts and
   asks for a code at sign-in from then on.
`);
} else if (cmd === 'check') {
  const secret = (process.env.TOTP_SECRET || '').trim();
  if (!secret) { console.error('TOTP_SECRET is not set in .env'); process.exit(1); }
  const ok = createTotp(secret).verify(String(code || ''));
  console.log(ok ? 'Code accepted: the app and TOTP_SECRET match.' : 'Code NOT accepted. Check the key in the app, and that the computer and phone clocks are right.');
  process.exit(ok ? 0 : 1);
} else {
  console.log('Usage: npm run totp:setup | npm run totp:check <code>');
}
