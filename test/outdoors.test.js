'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Outdoors, rainSummary, bestTime, parseAurora, isDark, floodModel } = require('../server/outdoors');
const { start } = require('../server/index');
const { codeAt, base32Decode, newSecret } = require('../server/totp');

const Q = 15 * 60; // seconds in a quarter hour
const T0 = Date.UTC(2026, 9, 18, 11, 0); // 12:00 London (BST)

test('rain: dry, starting soon, raining and easing, raining throughout', () => {
  const times = Array.from({ length: 8 }, (_, i) => T0 / 1000 + i * Q);
  assert.equal(rainSummary(times, [0, 0, 0, 0, 0, 0, 0, 0], T0).text, 'Dry for the next 2 hours');
  const soon = rainSummary(times, [0, 0, 0.4, 0.4, 0, 0, 0, 0], T0 + 60_000);
  assert.equal(soon.startsInMin, 30);
  assert.equal(soon.text, 'Light rain in about 30 min');
  const easing = rainSummary(times, [0.2, 0.2, 0.05, 0, 0, 0, 0, 0], T0);
  assert.equal(easing.raining, true);
  assert.match(easing.text, /easing in about 30 min/);
  assert.match(rainSummary(times, Array(8).fill(3), T0).text, /^Heavy rain for the next 2 hours/);
  assert.equal(rainSummary([], [], T0).known, false);
});

test('best time: picks the sunny, clean window between 07:00 and 21:00', () => {
  const carbon = Array.from({ length: 48 }, (_, i) => {
    const from = T0 - 11 * 3600_000 + i * 1800_000; // from 01:00 London
    const h = new Date(from).getUTCHours() + 1;
    return { from, to: from + 1800_000, intensity: h >= 3 && h < 5 ? 40 : h >= 13 && h < 15 ? 90 : 200, index: 'moderate' };
  });
  const radiation = Array.from({ length: 30 }, (_, i) => { const t = T0 - 11 * 3600_000 + i * 3600_000; const h = new Date(t).getUTCHours() + 1; return { t, w: h >= 12 && h <= 16 ? 800 : 0 }; });
  const b = bestTime({ carbon, radiation, kwp: 6, now: T0 - 11 * 3600_000 });
  assert.equal(b.known, true);
  const startHour = new Date(b.best.from).getUTCHours() + 1;
  assert.ok(startHour >= 12 && startHour <= 14, `best starts in the sunny, clean early afternoon (got ${startHour}:00)`);
  assert.match(b.best.reason, /kW of sun/);
  // the very clean 03:00-05:00 grid is never suggested (night)
  assert.ok(new Date(b.best.from).getUTCHours() + 1 >= 7);
  assert.equal(bestTime({ carbon: [], radiation, kwp: 6 }).known, false);
});

test('northern lights: status parsing and darkness', () => {
  assert.equal(parseAurora('<site_status project_id="x" status_id="amber"/>'), 'amber');
  assert.equal(parseAurora('nonsense'), null);
  const sun = [{ sunrise: T0 - 5 * 3600_000, sunset: T0 + 6 * 3600_000 }];
  assert.equal(isDark(T0, sun), false);
  assert.equal(isDark(T0 + 8 * 3600_000, sun), true);
});

test('floods: only warnings in force, most severe first', () => {
  const w = floodModel([
    { severityLevel: 4, description: 'Old' },
    { severityLevel: 3, description: 'River Ock', floodArea: { riverOrSea: 'River Ock' }, message: 'Be prepared' },
    { severityLevel: 1, description: 'Thames at Buscot' },
  ]);
  assert.deepEqual(w.map((x) => x.level), [1, 3]);
  assert.equal(w[0].severity, 'Severe flood warning');
  assert.equal(w[1].river, 'River Ock');
});

test('service: a failing source keeps the others working and is reported', async () => {
  const fakeFetch = async (url) => {
    if (url.includes('aurorawatch')) return { ok: true, text: async () => '<site_status status_id="red"/>' };
    if (url.includes('pvlive')) return { ok: true, json: async () => ({ data: [[0, '2026-10-18T11:00:00Z', 9000, 22500]] }) };
    return { ok: false, status: 503 };
  };
  const warn = console.warn; console.warn = () => {};
  const o = new Outdoors({ area: { name: 'Faringdon', postcode: 'SN7', lat: 51.66, lon: -1.59, floodRadiusKm: 15 }, fetch: fakeFetch, getKwp: () => 6, now: () => T0 });
  await o.refreshAll();
  console.warn = warn;
  const v = o.view(3);
  assert.equal(v.aurora.status, 'red');
  assert.equal(v.solarVsUk.ukPercent, 40);
  assert.equal(v.solarVsUk.homePercent, 50);
  assert.ok(v.errors.weather && v.errors.floods, 'failures are listed');
  assert.equal(v.weather, null);
});

test('only the owner gets outside data and map tiles; the map serves only tiles around the area', async (t) => {
  const viewerKey = newSecret();
  const app = await start({ port: 0, mode: 'demo', haUrl: '', haToken: '', appPassword: 'correct-horse', sessionSecret: 's'.repeat(32), databaseUrl: '', production: false, totpSecret: '', viewerPassword: 'camera-pass-1', viewerTotpSecret: viewerKey });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const login = async (body) => (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).headers.get('set-cookie').split(';')[0];
  const owner = await login({ password: 'correct-horse' });
  const viewer = await login({ password: 'camera-pass-1', code: codeAt(base32Decode(viewerKey), Math.floor(Date.now() / 30_000)) });
  while (!app.store.ready) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 100));

  const st = await (await fetch(`${base}/api/state`, { headers: { Cookie: owner } })).json();
  assert.ok(st.outdoors && st.outdoors.weather, 'demo outside data');
  assert.equal(st.outdoors.bestTime.known, true);
  assert.equal(typeof st.houseWindows.groundLeft, 'boolean');
  const vs = await (await fetch(`${base}/api/state`, { headers: { Cookie: viewer } })).json();
  assert.equal(vs.outdoors, undefined, 'camera viewers get no outside data');
  assert.equal((await fetch(`${base}/api/maptile/base/7/63/42`, { headers: { Cookie: viewer } })).status, 403);
  assert.equal((await fetch(`${base}/api/maptile/base/7/10/10`, { headers: { Cookie: owner } })).status, 404, 'far-away tiles are refused');
  assert.equal((await fetch(`${base}/api/maptile/evil/7/63/42`, { headers: { Cookie: owner } })).status, 404);
  assert.equal((await fetch(`${base}/api/maptile/base/7/63/42`)).status, 401, 'needs a session');
});
