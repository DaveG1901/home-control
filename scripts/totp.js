'use strict';

// Authenticator-app codes for signing in.
//   npm run totp:setup            a new key for YOUR sign-in        -> TOTP_SECRET
//   npm run totp:setup viewer     a new key for the camera-only one -> VIEWER_TOTP_SECRET (give it only to camera viewers)
//   npm run totp:check 123456     says which key in .env a code from an app belongs to

const { createTotp, newSecret } = require('../server/totp');

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'setup') {
  const viewer = arg === 'viewer';
  const name = viewer ? 'Home Control cameras' : 'Home Control';
  const env = viewer ? 'VIEWER_TOTP_SECRET' : 'TOTP_SECRET';
  const secret = newSecret();
  const label = encodeURIComponent(name);
  console.log(`
New authenticator key for ${viewer ? 'the CAMERA-ONLY sign-in' : 'your own sign-in'} (keep it private, like a password):

  ${secret.match(/.{1,4}/g).join(' ')}

1. In the authenticator app${viewer ? ' of each person who may watch the cameras' : ''} (Microsoft Authenticator, Google Authenticator,
   1Password, ...), add an account and choose "enter a setup key" / "enter code manually".
   Name: ${name}. Key: the letters above. Type: time-based.
   (Some apps accept this link instead: otpauth://totp/${label}?secret=${secret}&issuer=${label})
2. Put it in .env as   ${env}=${secret}
3. Check a code from the app:   npm run totp:check <the 6 digits>
4. When that works, add ${env} with the same value in the Render dashboard (Environment).${viewer ? `
   The camera-only sign-in also needs VIEWER_PASSWORD (at least 8 characters, different from APP_PASSWORD). It stays off
   until both are set. Changing VIEWER_PASSWORD later signs every camera viewer out.` : ''}
`);
} else if (cmd === 'check') {
  const keys = [['TOTP_SECRET', 'your own sign-in'], ['VIEWER_TOTP_SECRET', 'the camera-only sign-in']]
    .filter(([k]) => (process.env[k] || '').trim());
  if (!keys.length) { console.error('Neither TOTP_SECRET nor VIEWER_TOTP_SECRET is set in .env'); process.exit(1); }
  const hit = keys.find(([k]) => createTotp(process.env[k].trim()).verify(String(arg || '')));
  console.log(hit ? `Code accepted: it matches ${hit[0]} (${hit[1]}).` : 'Code NOT accepted. Check the key in the app, and that the computer and phone clocks are right.');
  process.exit(hit ? 0 : 1);
} else {
  console.log('Usage: npm run totp:setup [viewer] | npm run totp:check <code>');
}
