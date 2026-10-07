'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/state');
const { seed } = require('../server/fakeHa');

// A store seeded like the real house, with a controllable clock.
function house({ pv, load, charging = false, battKw = 0, exportKw = 0 } = {}) {
  const states = seed();
  const set = (id, state) => { states[id] = { ...states[id], state: String(state) }; };
  set('sensor.sigen_plant_pv_power', pv);
  set('sensor.sigen_plant_consumed_power', load);
  set('binary_sensor.sigen_plant_battery_charging', charging ? 'on' : 'off');
  set('sensor.sigen_plant_battery_power', battKw);
  set('sensor.sigen_plant_grid_export_power', exportKw);
  const store = new Store('demo');
  let t = 1_000_000;
  store.now = () => t;
  store.applyStates(Object.values(states));
  return { store, advance: (s) => { t += s * 1000; }, change: (id, state) => store.applyChange(id, { state: String(state), attributes: {} }) };
}
const fits = (vm) => Object.fromEntries(vm.surplus.devices.map((d) => [d.id, d.fit]));

test('night: no solar means no surplus and nothing is suggested', () => {
  const { store } = house({ pv: 0, load: 0.5 });
  const s = store.viewModel().surplus;
  assert.equal(s.state, 'night');
  assert.equal(s.spare, 0);
  assert.deepEqual(Object.values(fits(store.viewModel())), ['no', 'no', 'no']);
});

test('strong sun: enough spare for everything', () => {
  const { store } = house({ pv: 3.0, load: 0.5, charging: true, battKw: 1.0, exportKw: 1.5 });
  const vm = store.viewModel();
  assert.equal(vm.surplus.state, 'good');
  assert.equal(vm.surplus.spare, 2.5);
  assert.deepEqual(fits(vm), { dishwasher: 'good', tumble_dryer: 'good', garage_heater: 'good' });
  assert.deepEqual(vm.surplus.split, { home: 0.5, battery: 1, grid: 1.5 });
});

test('partial sun: small loads fit, big ones are marginal', () => {
  const { store } = house({ pv: 1.6, load: 0.5 }); // spare 1.1 kW
  const f = fits(store.viewModel());
  assert.equal(f.dishwasher, 'good');      // 1.1 / 1.2 = 92%
  assert.equal(f.tumble_dryer, 'marginal'); // 50%
  assert.equal(f.garage_heater, 'marginal'); // 55%
});

test('low sun: little spare', () => {
  const { store } = house({ pv: 0.6, load: 0.5 });
  const vm = store.viewModel();
  assert.equal(vm.surplus.state, 'low');
  assert.deepEqual(Object.values(fits(vm)), ['no', 'no', 'no']);
});

test('an appliance that is already drawing power is reported as running', () => {
  const { store, change } = house({ pv: 3.0, load: 1.7 });
  change('sensor.dishwasher_current_consumption', 1150);
  assert.equal(fits(store.viewModel()).dishwasher, 'running');
});

test('an unavailable plug is reported as unavailable, not suggested', () => {
  const { store, change } = house({ pv: 3.0, load: 0.5 });
  change('switch.tumble_dryer', 'unavailable');
  assert.equal(fits(store.viewModel()).tumble_dryer, 'unavailable');
});

test('spare solar is smoothed over about 30 seconds so cards do not flicker', () => {
  const { store, advance, change } = house({ pv: 0.8, load: 0.5 }); // spare 0.3
  assert.equal(store.viewModel().surplus.spare, 0.3);
  advance(1);
  change('sensor.sigen_plant_pv_power', 3.5); // sudden sun: instantaneous spare 3.0
  const soon = store.viewModel().surplus.spare;
  assert.ok(soon > 0.3 && soon < 0.8, `expected a small move after 1s, got ${soon}`);
  advance(120);
  change('sensor.sigen_plant_pv_power', 3.5);
  const later = store.viewModel().surplus.spare;
  assert.ok(later > 2.8 && later <= 3.0, `expected to converge near 3.0 after 2 min, got ${later}`);
});

test('missing data yields an unknown state rather than a wrong number', () => {
  const { store, change } = house({ pv: 1, load: 0.5 });
  change('sensor.sigen_plant_pv_power', 'unavailable');
  const s = store.viewModel().surplus;
  assert.equal(s.state, 'unknown');
  assert.equal(s.spare, null);
});
