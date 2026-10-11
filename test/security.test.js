'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const WebSocket = require('ws');

const { start } = require('../server/index');
const { createAuth, parseCookies, IDLE_MS, MAX_MS } = require('../server/auth');
const { createTotp, codeAt, base32Encode, base32Decode, newSecret } = require('../server/totp');

const BASE = { port: 0, mode: 'demo', haUrl: '', haToken: '', appPassword: 'correct-horse', sessionSecret: 's'.repeat(32), databaseUrl: '', production: false, totpSecret: '' };
const json = { 'Content-Type': 'application/json' };
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) });

// ---------- authenticator codes ----------

test('TOTP: matches the RFC 6238 test values', () => {
  const key = Buffer.from('12345678901234567890');
  assert.equal(codeAt(key, Math.floor(59 / 30)), '287082');
  assert.equal(codeAt(key, Math.floor(1111111109 / 30)), '081804');
  assert.equal(codeAt(key, Math.floor(1234567890 / 30)), '005924');
  assert.deepEqual(base32Decode(base32Encode(key)), key);
  assert.equal(base32Decode(newSecret()).length, 20);
});

test('TOTP: accepts the current code and one step either side, never the same step twice', () => {
  const secret = newSecret();
  const key = base32Decode(secret);
  let t = 1_700_000_000_000;
  const totp = createTotp(secret, () => t);
  const step = Math.floor(t / 30_000);
  assert.equal(totp.verify(codeAt(key, step - 2)), false, 'too old');
  assert.equal(totp.verify(codeAt(key, step)), true);
  assert.equal(totp.verify(codeAt(key, step)), false, 'replayed');
  assert.equal(totp.verify(codeAt(key, step - 1)), false, 'older than one already used');
  t += 30_000;
  assert.equal(totp.verify(codeAt(key, step + 1)), true);
  for (const bad of ['', '12345', '1234567', 'abcdef', null, 123456]) assert.equal(totp.verify(bad), false);
  assert.throws(() => createTotp('ABC'), /too short/);
  assert.throws(() => createTotp('not base32!!'), /base32/);
});

// ---------- sessions ----------

test('cookies: a badly encoded value is ignored instead of throwing', () => {
  assert.deepEqual(parseCookies('hc_session=%E0%A4%A; other=ok'), { other: 'ok' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('sessions: end after 7 idle days, are extended while used, and end 30 days after sign-in regardless', async () => {
  let t = 1_700_000_000_000;
  const auth = createAuth({ password: 'pw-123456', secret: 'k'.repeat(32), now: () => t });
  const res = () => { const h = {}; return { h, setHeader: (k, v) => { h[k] = v; }, status() { return this; }, json() { return this; } }; };
  const r = res();
  auth.login({ ip: '1.1.1.1', headers: {}, body: { password: 'pw-123456' } }, r);
  let cookie = r.h['Set-Cookie'].split(';')[0];
  assert.match(r.h['Set-Cookie'], /Max-Age=604800/);
  const req = () => ({ headers: { cookie } });
  assert.ok(auth.isAuthed(req()));

  // used every 6 days: extended each time, so still signed in after 4 weeks ...
  for (let i = 0; i < 4; i++) {
    t += 6 * 24 * 3600_000;
    assert.ok(auth.isAuthed(req()), `still signed in on day ${(i + 1) * 6}`);
    const rr = res();
    auth.renew(req(), rr, () => {});
    if (rr.h['Set-Cookie']) cookie = rr.h['Set-Cookie'].split(';')[0];
  }
  // ... but not past 30 days from signing in
  t += 6 * 24 * 3600_000;
  assert.equal(auth.isAuthed(req()), false, 'ended 30 days after sign-in');
  assert.ok(MAX_MS === 30 * 24 * 3600_000 && IDLE_MS === 7 * 24 * 3600_000);

  // not used for more than 7 days: ended
  const r2 = res();
  auth.login({ ip: '1.1.1.1', headers: {}, body: { password: 'pw-123456' } }, r2);
  const c2 = r2.h['Set-Cookie'].split(';')[0];
  t += 7 * 24 * 3600_000 + 1000;
  assert.equal(auth.isAuthed({ headers: { cookie: c2 } }), false);
  auth.stop();
});

test('sessions: an old-style or tampered cookie is refused', () => {
  const auth = createAuth({ password: 'pw-123456', secret: 'k'.repeat(32) });
  assert.equal(auth.isAuthed({ headers: { cookie: `hc_session=${Date.now() + 1e9}.abc` } }), false);
  assert.equal(auth.isAuthed({ headers: { cookie: `hc_session=1.${Date.now() + 1e9}.abc` } }), false);
  auth.stop();
});

// ---------- the running server ----------

test('a malformed cookie cannot crash the server (page request or live connection)', async (t) => {
  const app = await start(BASE);
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: 'hc_session=%E0%A4%A' } })).status, 401);

  await new Promise((resolve) => {
    const s = net.connect(app.port, '127.0.0.1', () => s.write([
      'GET /live HTTP/1.1', 'Host: 127.0.0.1', 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Cookie: hc_session=%E0%A4%A', '', ''].join('\r\n')));
    s.on('data', () => {}); s.on('close', resolve); s.on('error', resolve);
  });
  assert.equal((await fetch(`${base}/healthz`)).status, 200, 'still running');
});

test('public health check says only ok and the version; the details need a session', async (t) => {
  const app = await start(BASE);
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  assert.deepEqual(Object.keys(await (await fetch(`${base}/healthz`)).json()).sort(), ['commit', 'ok']);
  assert.equal((await fetch(`${base}/api/health`)).status, 401);
  const cookie = (await post(`${base}/api/login`, { password: 'correct-horse' })).headers.get('set-cookie').split(';')[0];
  const h = await (await fetch(`${base}/api/health`, { headers: { Cookie: cookie } })).json();
  assert.equal(h.mode, 'demo');
  assert.ok('history' in h);
});

test('HTTPS-only header in production', async (t) => {
  const app = await start({ ...BASE, production: true, appPassword: 'correct-horse-battery' });
  t.after(() => app.close());
  const res = await fetch(`http://127.0.0.1:${app.port}/login`);
  assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000');
});

test('with TOTP_SECRET set, signing in needs the password AND a current code', async (t) => {
  const secret = newSecret();
  const app = await start({ ...BASE, totpSecret: secret });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  assert.deepEqual(await (await fetch(`${base}/api/login-options`)).json(), { code: true });
  const now = codeAt(base32Decode(secret), Math.floor(Date.now() / 30_000));
  assert.equal((await post(`${base}/api/login`, { password: 'correct-horse' })).status, 401, 'password alone');
  assert.equal((await post(`${base}/api/login`, { password: 'wrong', code: now })).status, 401, 'code alone');
  const ok = await post(`${base}/api/login`, { password: 'correct-horse', code: now });
  assert.equal(ok.status, 200);
  assert.equal((await post(`${base}/api/login`, { password: 'correct-horse', code: now })).status, 401, 'same code twice');
});

test('without TOTP_SECRET the sign-in page does not ask for a code', async (t) => {
  const app = await start(BASE);
  t.after(() => app.close());
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${app.port}/api/login-options`)).json(), { code: false });
});

test('wrong attempts from many addresses pause all sign-ins', async (t) => {
  const app = await start(BASE);
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.port}/api/login`;
  const warn = console.warn; console.warn = () => {}; t.after(() => { console.warn = warn; });
  for (let i = 0; i < 30; i++) assert.equal((await post(url, { password: 'nope' }, { 'X-Forwarded-For': `10.0.0.${i}` })).status, 401);
  assert.equal((await post(url, { password: 'correct-horse' }, { 'X-Forwarded-For': '10.0.1.1' })).status, 429);
});

test('sign out everywhere ends every session and closes live connections; logout needs the same origin', async (t) => {
  const app = await start(BASE);
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const login = async () => (await post(`${base}/api/login`, { password: 'correct-horse' })).headers.get('set-cookie').split(';')[0];
  const phone = await login();
  await new Promise((r) => setTimeout(r, 5)); // a different sign-in time
  const laptop = await login();

  assert.equal((await post(`${base}/api/logout`, {}, { Origin: 'https://evil.example' })).status, 403);

  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/live`, { headers: { Cookie: phone } });
  await new Promise((r, j) => { ws.once('message', r); ws.once('error', j); });
  const closed = new Promise((r) => ws.once('close', (code) => r(code)));

  assert.equal((await post(`${base}/api/logout-all`, {}, { Cookie: laptop })).status, 200);
  assert.equal(await closed, 4001);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: phone } })).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: laptop } })).status, 401);
  const again = await login();
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: again } })).status, 200, 'signing in again works');
});

test('live connection refuses large messages', async (t) => {
  const app = await start(BASE);
  t.after(() => app.close());
  const cookie = (await post(`http://127.0.0.1:${app.port}/api/login`, { password: 'correct-horse' })).headers.get('set-cookie').split(';')[0];
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/live`, { headers: { Cookie: cookie } });
  await new Promise((r, j) => { ws.once('message', r); ws.once('error', j); });
  const closed = new Promise((r) => ws.once('close', (code) => r(code)));
  const warn = console.warn; console.warn = () => {}; t.after(() => { console.warn = warn; });
  ws.send('x'.repeat(4096));
  assert.equal(await closed, 1009); // "message too big"
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/healthz`)).status, 200, 'and the server carries on');
});

test('failed Home Assistant calls do not pass its error text to the browser', async (t) => {
  const app = await start(BASE);
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const cookie = (await post(`${base}/api/login`, { password: 'correct-horse' })).headers.get('set-cookie').split(';')[0];
  while (!app.store.ready) await new Promise((r) => setTimeout(r, 25));
  app.ha.callService = async () => { throw new Error('internal detail: KeyError mode at /usr/src/homeassistant'); };
  const err = console.error; console.error = () => {}; t.after(() => { console.error = err; });
  const res = await post(`${base}/api/command`, { id: 'plug:dishwasher', value: 'off' }, { Cookie: cookie });
  assert.equal(res.status, 502);
  assert.doesNotMatch(JSON.stringify(await res.json()), /KeyError|usr/);
});

// ---------- camera-only (viewer) sign-in ----------

const codeNow = (secret) => codeAt(base32Decode(secret), Math.floor(Date.now() / 30_000));
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];

test('viewer sign-in stays off until both VIEWER_PASSWORD and VIEWER_TOTP_SECRET are set (and never breaks the owner)', async (t) => {
  const warn = console.warn; console.warn = () => {}; t.after(() => { console.warn = warn; });
  const app = await start({ ...BASE, viewerPassword: 'camera-pass-1', viewerTotpSecret: '' });
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.port}/api/login`;
  assert.equal((await post(url, { password: 'camera-pass-1', code: '123456' })).status, 401);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${app.port}/api/login-options`)).json(), { code: false });
  assert.equal((await post(url, { password: 'correct-horse' })).status, 200, 'owner unaffected');
});

test('viewer: needs its own password AND a code from its own key; the owner key and password do not mix', async (t) => {
  const ownerKey = newSecret();
  const viewerKey = newSecret();
  const app = await start({ ...BASE, totpSecret: ownerKey, viewerPassword: 'camera-pass-1', viewerTotpSecret: viewerKey });
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.port}/api/login`;
  const warn = console.warn; console.warn = () => {}; t.after(() => { console.warn = warn; });
  assert.equal((await post(url, { password: 'camera-pass-1' })).status, 401, 'no code');
  assert.equal((await post(url, { password: 'camera-pass-1', code: codeNow(ownerKey) })).status, 401, "owner's code");
  assert.equal((await post(url, { password: 'correct-horse', code: codeNow(viewerKey) })).status, 401, "viewer's code for the owner");
  const ok = await post(url, { password: 'camera-pass-1', code: codeNow(viewerKey) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).role, 'viewer');
});

test('viewer: sees camera names only, cannot command or read anything else, and is told so in the page', async (t) => {
  const viewerKey = newSecret();
  const app = await start({ ...BASE, viewerPassword: 'camera-pass-1', viewerTotpSecret: viewerKey });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  while (!app.store.ready) await new Promise((r) => setTimeout(r, 25));
  // owner still signs in without a code (no TOTP_SECRET), although the page now shows the code box
  assert.deepEqual(await (await fetch(`${base}/api/login-options`)).json(), { code: true });
  const owner = cookieOf(await post(`${base}/api/login`, { password: 'correct-horse' }));
  const viewer = cookieOf(await post(`${base}/api/login`, { password: 'camera-pass-1', code: codeNow(viewerKey) }));
  const V = { Cookie: viewer };

  const st = await (await fetch(`${base}/api/state`, { headers: V })).json();
  assert.deepEqual(Object.keys(st).sort(), ['connection', 'role', 'security']);
  assert.deepEqual(Object.keys(st.security), ['cameras']);
  assert.equal(st.security.cameras.length, 4);
  for (const c of st.security.cameras) assert.deepEqual(Object.keys(c).sort(), ['id', 'name']);
  assert.equal((await (await fetch(`${base}/api/state`, { headers: { Cookie: owner } })).json()).role, 'owner');

  // refused
  assert.equal((await post(`${base}/api/command`, { id: 'floodlight:garage', value: 'on' }, V)).status, 403);
  assert.equal((await post(`${base}/api/command`, { id: 'plug:dishwasher', value: 'off' }, V)).status, 403);
  assert.equal(app.store.raw('switch.dishwasher').state, 'on', 'nothing changed');
  for (const p of ['/api/history', '/api/health']) assert.equal((await fetch(`${base}${p}`, { headers: V })).status, 403, p);
  assert.equal((await post(`${base}/api/logout-all`, {}, V)).status, 403);
  // allowed
  assert.deepEqual(await (await fetch(`${base}/api/camera/garage/stream`, { headers: V })).json(), { demo: true });
  assert.equal((await post(`${base}/api/cameras/warm`, {}, V)).status, 200);
  assert.match(await (await fetch(`${base}/`, { headers: V })).text(), /<body data-role="viewer"/);
  assert.doesNotMatch(await (await fetch(`${base}/`, { headers: { Cookie: owner } })).text(), /data-role="viewer"/);

  // live updates: the viewer only ever receives the camera-only state, even when the owner changes something
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/live`, { headers: V });
  const got = [];
  ws.on('message', (m) => got.push(JSON.parse(m).data));
  await new Promise((r) => ws.once('message', r));
  assert.equal((await post(`${base}/api/command`, { id: 'plug:dishwasher', value: 'off' }, { Cookie: owner })).status, 200);
  await new Promise((r) => setTimeout(r, 600));
  ws.close();
  assert.ok(got.length >= 2, 'received the update');
  for (const d of got) assert.deepEqual(Object.keys(d).sort(), ['connection', 'role', 'security']);
});

test('viewer: a new VIEWER_PASSWORD signs out every viewer but no owner; the owner can sign everyone out', async (t) => {
  const viewerKey = newSecret();
  const cfg = { ...BASE, viewerPassword: 'camera-pass-1', viewerTotpSecret: viewerKey };
  const first = await start(cfg);
  const base1 = `http://127.0.0.1:${first.port}`;
  const owner = cookieOf(await post(`${base1}/api/login`, { password: 'correct-horse' }));
  const viewer = cookieOf(await post(`${base1}/api/login`, { password: 'camera-pass-1', code: codeNow(viewerKey) }));
  await first.close();

  const second = await start({ ...cfg, viewerPassword: 'camera-pass-2' }); // restarted with a new viewer password
  t.after(() => second.close());
  const base = `http://127.0.0.1:${second.port}`;
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: viewer } })).status, 401, 'old viewer session ended');
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: owner } })).status, 200, 'owner still signed in');

  const v2 = cookieOf(await post(`${base}/api/login`, { password: 'camera-pass-2', code: codeNow(viewerKey) }));
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: v2 } })).status, 200);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await post(`${base}/api/logout-all`, {}, { Cookie: owner })).status, 200);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: v2 } })).status, 401, 'sign out everywhere includes viewers');
});
