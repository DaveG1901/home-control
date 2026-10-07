'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../server/entities');
const { seed } = require('../server/fakeHa');
const { start } = require('../server/index');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(25); }
  throw new Error('timed out waiting for condition');
}

async function demoApp(t) {
  const app = await start({ port: 0, mode: 'demo', haUrl: '', haToken: '', appPassword: 'correct-horse', sessionSecret: 's'.repeat(32), databaseUrl: '', production: false });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  await until(() => app.store.ready);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const H = { 'Content-Type': 'application/json', Cookie: cookie };
  return {
    app,
    state: async () => (await fetch(`${base}/api/state`, { headers: H })).json(),
    cmd: (id, value) => fetch(`${base}/api/command`, { method: 'POST', headers: H, body: JSON.stringify({ id, value }) }),
  };
}

test('config sanity: ids are unique and every watched entity exists in the seeded house', () => {
  for (const [name, list] of [['plugs', E.plugs], ['lights', E.lights]]) {
    const ids = list.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate ${name} ids`);
  }
  const seeded = seed();
  const missing = [...E.watchedEntities()].filter((id) => !seeded[id]);
  assert.deepEqual(missing, [], 'watched entities missing from the fake HA seed (typo in entities.js, or seed needs updating)');
});

test('every plug and light is listed once on the Devices page, and the risky plugs carry a warning', async (t) => {
  const { state } = await demoApp(t);
  const vm = await state();
  const plugItems = vm.catalogue.plugs.flatMap((g) => g.items);
  const lightItems = vm.catalogue.lights.flatMap((g) => g.items);
  assert.equal(plugItems.length, E.plugs.length);
  assert.equal(lightItems.length, E.lights.length);
  const byId = Object.fromEntries(plugItems.map((p) => [p.id, p]));
  for (const id of ['freezer', 'office_critical']) assert.equal(byId[id].warn, 'critical', id);
  for (const id of ['router_dave', 'router_kitchen', 'router_garage', 'cam_front_poe', 'cam_front_powerline']) assert.equal(byId[id].warn, 'network', id);
  for (const id of ['dishwasher', 'michelle_office', 'dave_desk', 'tv', 'washing_machine']) assert.equal(byId[id].warn, null, `${id} needs no warning`);
  for (const p of plugItems) assert.equal(p.control, true, `${p.id} should be switchable`);
  assert.ok(vm.catalogue.plugs.map((g) => g.name).includes('Network & cameras'));
});

test('any plug and any light can be switched, one at a time', async (t) => {
  const { app, cmd } = await demoApp(t);
  assert.equal((await cmd('plug:michelle_office', 'off')).status, 200);
  await until(() => app.store.raw('switch.michelle_office_power_1').state === 'off');
  // other plugs were not touched
  assert.equal(app.store.raw('switch.dave_tv_plug').state, 'on');

  assert.equal((await cmd('light:dave_light', 'on')).status, 200);
  await until(() => app.store.raw('light.dave_light').state === 'on');
  assert.equal((await cmd('light:office_light', 'off')).status, 200);
  await until(() => app.store.raw('light.office_light').state === 'off');
  assert.equal(app.store.raw('light.office_bulb').state, 'on', 'other lights untouched');
});

test('even the important plugs can be switched (the app only asks for confirmation), but only by their named command', async (t) => {
  const { app, cmd } = await demoApp(t);
  for (const id of ['freezer', 'office_critical', 'router_dave', 'router_garage', 'cam_front_poe', 'cam_front_powerline']) {
    assert.equal((await cmd(`plug:${id}`, 'off')).status, 200, id);
  }
  await until(() => app.store.raw('switch.garage_freezer_plug').state === 'off');
  await until(() => app.store.raw('switch.garage_camera_powerline').state === 'off');
  assert.equal(app.store.raw('switch.dave_tv_plug').state, 'on', 'unrelated plugs untouched');
  // raw entity ids and path tricks are still refused
  assert.equal((await cmd('switch.garage_freezer_plug', 'on')).status, 404);
  assert.equal((await cmd('light:../freezer', 'off')).status, 404);
  assert.equal(app.store.raw('switch.garage_freezer_plug').state, 'off');
});

test('heating boost works on the main thermostat and every zone, and can be cancelled', async (t) => {
  const { app, cmd, state } = await demoApp(t);
  for (const z of [E.heating.main, ...E.heating.zones]) {
    assert.equal((await cmd(`boost:${z.id}`, 60)).status, 200, `boost ${z.id}`);
    await until(() => app.store.attr(z.climate, 'preset_mode') === 'boost');
  }
  let vm = await state();
  assert.ok(vm.heating.main.boost && vm.heating.zones.every((z) => z.boost), 'every zone shows as boosting');
  assert.equal(vm.heating.boost.temperature, 21);

  assert.equal((await cmd('boost:lobby', 0)).status, 200);
  await until(() => app.store.attr('climate.lobby', 'preset_mode') === 'none');
  vm = await state();
  assert.equal(vm.heating.zones.find((z) => z.id === 'lobby').boost, false);
  assert.equal(vm.heating.zones.find((z) => z.id === 'office').boost, true, 'other zones keep boosting');
  assert.ok(vm.activity.some((a) => /Lobby boost cancelled/.test(a.text)));
  assert.ok(vm.activity.some((a) => /boosted to 21° for 1 h/.test(a.text)));
});

test('boost and hot water only accept the offered durations', async (t) => {
  const { app, cmd } = await demoApp(t);
  for (const v of [30, 60, 120, 0]) assert.equal((await cmd('boost:office', v)).status, 200, `boost ${v}`);
  for (const bad of [45, 90, -30, 1000, '60', null, 'on']) assert.equal((await cmd('boost:office', bad)).status, 400, `boost ${bad}`);
  assert.equal((await cmd('boost:attic', 60)).status, 404);
  assert.equal((await cmd('hotwater.boost', 120)).status, 200);
  await until(() => app.store.isOn('binary_sensor.hotwater_boost'));
  assert.equal((await cmd('hotwater.boost', 90)).status, 400);
  assert.equal((await cmd('hotwater.boost', 0)).status, 200);
  await until(() => !app.store.isOn('binary_sensor.hotwater_boost'));
});
