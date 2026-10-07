'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const { createFakeHa } = require('../server/fakeHa');
const { HAClient } = require('../server/ha');
const { start } = require('../server/index');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(25); }
  throw new Error('timed out waiting for condition');
}
const once = (em, ev) => new Promise((r) => em.once(ev, r));

test('HA client: authenticates, gets states, receives changes, calls services', async () => {
  const fake = await createFakeHa({ token: 't0ken', animate: false });
  const ha = new HAClient({ url: fake.url, token: 't0ken' });
  const gotStates = once(ha, 'states');
  ha.start();
  const states = await gotStates;
  assert.ok(states.length > 50);
  assert.ok(states.find((s) => s.entity_id === 'sensor.sigen_plant_pv_power'));

  const changed = new Promise((r) => ha.on('state_changed', (id, s) => { if (id === 'switch.dishwasher') r(s); }));
  await ha.callService('switch', 'turn_off', { entity_id: 'switch.dishwasher' });
  assert.equal((await changed).state, 'off');
  assert.equal(fake.states['sensor.dishwasher_current_consumption'].state, '0');

  await assert.rejects(ha.callService('nope', 'nothing', { entity_id: 'x.y' }), /not found/i);
  ha.stop();
  await fake.close();
});

test('HA client: bad token is fatal and does not retry', async () => {
  const fake = await createFakeHa({ token: 'right', animate: false });
  const ha = new HAClient({ url: fake.url, token: 'wrong' });
  const fatal = once(ha, 'fatal');
  ha.start();
  assert.match(await fatal, /rejected the token/);
  assert.equal(ha.stopped, true);
  await fake.close();
});

test('HA client: reconnects after the server drops', async () => {
  const fake = await createFakeHa({ token: 't', animate: false });
  const ha = new HAClient({ url: fake.url, token: 't' });
  ha.start();
  await once(ha, 'connected');
  const dropped = once(ha, 'disconnected');
  ha.ws.terminate();
  await dropped;
  await once(ha, 'connected'); // backoff starts at 1s
  ha.stop();
  await fake.close();
});

test('web app: auth, command allowlist, live updates', async (t) => {
  const app = await start({
    port: 0, mode: 'demo', haUrl: '', haToken: '', appPassword: 'correct-horse', sessionSecret: 's'.repeat(32), databaseUrl: '', production: false,
  });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  await until(() => app.store.ready);

  // unauthenticated
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/login`)).status, 200);

  // wrong password, then right password
  const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
  assert.equal(bad.status, 401);
  const good = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse' }) });
  assert.equal(good.status, 200);
  const cookie = good.headers.get('set-cookie').split(';')[0];
  assert.match(good.headers.get('set-cookie'), /HttpOnly/);
  assert.match(good.headers.get('set-cookie'), /SameSite=Strict/);
  const H = { 'Content-Type': 'application/json', Cookie: cookie };

  // state view model
  const state = await (await fetch(`${base}/api/state`, { headers: H })).json();
  assert.equal(state.connection.ha, true);
  assert.equal(state.connection.mode, 'demo');
  assert.equal(state.heating.zones.length, 8);
  assert.equal(state.security.cameras.length, 4);
  assert.equal(state.devices.find((d) => d.id === 'freezer').protected, true);
  assert.equal(state.security.doorbellPressAvailable, false);
  assert.ok(state.today.selfSufficiency !== null);

  const cmd = (id, value, extra = {}) => fetch(`${base}/api/command`, { method: 'POST', headers: { ...H, ...extra }, body: JSON.stringify({ id, value }) });

  // allowed command round-trips through "HA" and back
  assert.equal((await cmd('plug:dishwasher', 'off')).status, 200);
  await until(() => app.store.raw('switch.dishwasher').state === 'off');
  assert.equal((await cmd('floodlight:garage', 'on')).status, 200);
  await until(() => app.store.isOn('light.garage_camera_floodlight'));
  assert.equal((await cmd('heating.target', 21.5)).status, 200);
  await until(() => app.store.attr('climate.thermostat', 'temperature') === 21.5);
  assert.equal((await cmd('heating.mode', 'auto')).status, 200);
  assert.equal((await cmd('hotwater.boost', 30)).status, 200);
  await until(() => app.store.isOn('binary_sensor.hotwater_boost'));

  // protected / unknown / invalid are refused and nothing changes
  assert.equal((await cmd('plug:freezer', 'off')).status, 404);
  assert.equal((await cmd('plug:office_critical', 'off')).status, 404);
  assert.equal((await cmd('switch.garage_freezer_plug', 'off')).status, 404);
  assert.equal(app.store.raw('switch.garage_freezer_plug').state, 'on');
  assert.equal((await cmd('heating.target', 99)).status, 400);
  assert.equal((await cmd('heating.target', '21')).status, 400);
  assert.equal((await cmd('heating.mode', 'cool')).status, 400);
  assert.equal((await cmd('hotwater.boost', 7)).status, 400);
  assert.equal((await cmd('plug:dishwasher', 'maybe')).status, 400);

  // cross-site requests are refused
  assert.equal((await cmd('plug:dishwasher', 'on', { Origin: 'https://evil.example' })).status, 403);

  // activity log records our actions
  const after = await (await fetch(`${base}/api/state`, { headers: H })).json();
  assert.ok(after.activity.some((a) => /Dishwasher switched off/.test(a.text)));

  // history endpoint
  const hist = await (await fetch(`${base}/api/history`, { headers: H })).json();
  assert.ok(hist.points.length > 10);

  // websocket: refused without a cookie, pushes live state with one
  await assert.rejects(new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${app.port}/live`); w.on('open', res); w.on('error', rej); }));
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/live`, { headers: { Cookie: cookie } });
  const first = await new Promise((res, rej) => { ws.on('message', (m) => res(JSON.parse(m))); ws.on('error', rej); });
  assert.equal(first.type, 'state');
  const update = new Promise((res) => ws.on('message', (m) => { const d = JSON.parse(m).data; if (d.devices.find((x) => x.id === 'dishwasher').state === 'on') res(d); }));
  assert.equal((await cmd('plug:dishwasher', 'on')).status, 200);
  assert.ok(await update);
  ws.close();
});

test('production refuses to start without a password', async () => {
  await assert.rejects(start({ port: 0, mode: 'demo', haUrl: '', haToken: '', appPassword: '', sessionSecret: '', databaseUrl: '', production: true }), /APP_PASSWORD/);
});

test('login is rate limited after repeated failures', async (t) => {
  const app = await start({ port: 0, mode: 'demo', haUrl: '', haToken: '', appPassword: 'correct-horse', sessionSecret: 's'.repeat(32), databaseUrl: '', production: false });
  t.after(() => app.close());
  const post = (password) => fetch(`http://127.0.0.1:${app.port}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  for (let i = 0; i < 5; i++) assert.equal((await post('wrong')).status, 401);
  assert.equal((await post('correct-horse')).status, 429); // locked out even with the right password
});

test('camera streams: authenticated, allowlisted, demo flag, and live addresses point at Home Assistant', async (t) => {
  const login = async (base, password) => (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })).headers.get('set-cookie').split(';')[0];

  // demo mode
  const demo = await start({ port: 0, mode: 'demo', haUrl: '', haToken: '', appPassword: 'correct-horse', sessionSecret: 's'.repeat(32), databaseUrl: '', production: false });
  t.after(() => demo.close());
  const dBase = `http://127.0.0.1:${demo.port}`;
  assert.equal((await fetch(`${dBase}/api/camera/garage/stream`)).status, 401, 'needs a session');
  const dCookie = await login(dBase, 'correct-horse');
  assert.deepEqual(await (await fetch(`${dBase}/api/camera/garage/stream`, { headers: { Cookie: dCookie } })).json(), { demo: true });
  assert.equal((await fetch(`${dBase}/api/camera/bedroom/stream`, { headers: { Cookie: dCookie } })).status, 404, 'unknown cameras are refused');
  const lib = await fetch(`${dBase}/vendor/hls.min.js`, { headers: { Cookie: dCookie } });
  assert.equal(lib.status, 200);
  assert.match(await lib.text(), /Hls/);
  assert.equal((await fetch(`${dBase}/vendor/hls.min.js`, { redirect: 'manual' })).status, 302, 'player library is behind the login too');

  // live mode against the fake Home Assistant
  const fake = await createFakeHa({ token: 'live-token', animate: false });
  t.after(() => fake.close());
  const live = await start({ port: 0, mode: 'live', haUrl: fake.url, haToken: 'live-token', appPassword: 'correct-horse', sessionSecret: 's'.repeat(32), databaseUrl: '', production: false });
  t.after(() => live.close());
  await until(() => live.store.ready);
  const lBase = `http://127.0.0.1:${live.port}`;
  const lCookie = await login(lBase, 'correct-horse');
  const res = await fetch(`${lBase}/api/camera/front_garden/stream`, { headers: { Cookie: lCookie } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, `${fake.url}/api/hls/faketoken/master_playlist.m3u8`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  // the browser may load video from Home Assistant, and only from there
  const csp = (await fetch(`${lBase}/login`)).headers.get('content-security-policy');
  assert.ok(csp.includes(`media-src 'self' blob: ${new URL(fake.url).origin}`));
  const dCsp = (await fetch(`${dBase}/login`)).headers.get('content-security-policy');
  assert.ok(!dCsp.includes('http://127.0.0.1:' + fake.port), 'demo mode does not whitelist any Home Assistant origin');
});
