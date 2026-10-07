'use strict';

// A small in-process imitation of Home Assistant's WebSocket API, seeded with values from the real house.
// Used for demo mode and for tests, so the real HA client + the whole pipeline run without a live HA.
// It speaks the same protocol (auth, get_states, subscribe_events, call_service, ping) and keeps values moving.

const { WebSocketServer } = require('ws');
const { londonHour } = require('./history');

function seed() {
  const s = {};
  const set = (id, state, attributes = {}) => { s[id] = { entity_id: id, state: String(state), attributes }; };

  // Solar + battery (Sigenergy)
  set('sensor.sigen_plant_pv_power', 1.174, { unit_of_measurement: 'kW' });
  set('sensor.sigen_plant_consumed_power', 0.496, { unit_of_measurement: 'kW' });
  set('sensor.sigen_plant_battery_power', 0.672, { unit_of_measurement: 'kW' });
  set('binary_sensor.sigen_plant_battery_charging', 'on');
  set('binary_sensor.sigen_plant_battery_discharging', 'off');
  set('sensor.sigen_plant_battery_state_of_charge', 12.1, { unit_of_measurement: '%' });
  set('sensor.sigen_plant_grid_import_power', 0, { unit_of_measurement: 'kW' });
  set('sensor.sigen_plant_grid_export_power', 0, { unit_of_measurement: 'kW' });
  set('sensor.sigen_plant_ems_work_mode', 'Maximum Self Consumption');
  set('sensor.sigen_plant_rated_energy_capacity', 9.04, { unit_of_measurement: 'kWh' });
  set('sensor.sigen_plant_daily_pv_energy', 4.98, { unit_of_measurement: 'kWh' });
  set('sensor.sigen_plant_daily_load_consumption', 14.29, { unit_of_measurement: 'kWh' });
  set('sensor.sigen_plant_daily_grid_import_energy', 6.45, { unit_of_measurement: 'kWh' });
  set('sensor.sigen_plant_daily_grid_export_energy', 0, { unit_of_measurement: 'kWh' });
  set('sensor.sigen_plant_pv_previous_day_generation', 14.31, { unit_of_measurement: 'kWh' });
  set('sensor.sigen_plant_total_pv_generation', 0.708, { unit_of_measurement: 'MWh' });

  // Weather / grid
  set('sensor.met_office_uffington_temperature', 11.5, { unit_of_measurement: '°C' });
  set('sensor.met_office_uffington_weather', 'partlycloudy');
  set('sensor.electricity_maps_co2_intensity', 258);

  // Heating (Hive)
  const climate = (id, cur, target = 7, mode = 'off') => set(id, mode, { current_temperature: cur, temperature: target, hvac_modes: ['off', 'auto', 'heat'] });
  climate('climate.thermostat', 21.4);
  climate('climate.living_room', 20.6);
  climate('climate.lobby', 19.6);
  climate('climate.office', 20.4);
  climate('climate.utility', 21.2);
  climate('climate.dave_bedroom', 20.8);
  climate('climate.eleanor_bedroom', 19.7);
  climate('climate.kasper_bedroom', 20.2);
  climate('climate.michelle_bedroom', 20.2);
  set('water_heater.thermostat', 'eco');
  set('binary_sensor.hotwater_state', 'on');
  set('binary_sensor.hotwater_boost', 'off');
  set('sensor.hotwater_mode', 'schedule');

  // Doorbells
  set('sensor.front_doorbell_battery', 45, { unit_of_measurement: '%' });
  set('sensor.side_doorbell_battery', 73, { unit_of_measurement: '%' });
  for (const d of ['front', 'side']) { set(`switch.${d}_doorbell_motion_detection`, 'on'); set(`switch.${d}_doorbell_person_detection`, 'on'); }

  // Cameras (each exists twice in the real HA)
  for (const c of ['front_garden', 'back_garden', 'garage', 'garage_back']) {
    set(`light.${c}_camera_floodlight`, 'off');
    for (const k of ['person', 'vehicle', 'animal', 'motion']) { set(`binary_sensor.${c}_camera_${k}`, 'off'); set(`binary_sensor.${c}_camera_${k}_2`, 'off'); }
  }

  // Plugs: [id, switchState, watts]
  const plug = (name, sw, w) => {
    set(`switch.${name}`, sw);
    set(`sensor.${name === 'office_dave_desk_power' ? 'office_dave_desk_power' : name}_current_consumption`, w, { unit_of_measurement: 'W' });
  };
  plug('dishwasher', 'on', 0); plug('tumble_dryer', 'on', 0.7); plug('garage_heater', 'off', 0);
  plug('purifier', 'on', 5.9); plug('kids_laptops', 'on', 0); plug('garage_freezer_plug', 'on', 69.2);
  plug('office_critical_plug', 'on', 61); plug('michelle_office_power_1', 'on', 54.7); plug('office_dave_desk_power', 'on', 11);
  plug('tv_plug', 'on', 18); plug('garage_extension', 'on', 12.7); plug('washing_machine', 'on', 0); plug('living_room_extension', 'on', 2.4);
  return s;
}

const NOMINAL_WATTS = { garage_heater: 2000, dishwasher: 1200, tumble_dryer: 2200, washing_machine: 500, kids_laptops: 60, purifier: 5.9, tv_plug: 18 };

async function createFakeHa({ token = 'demo-token', host = '127.0.0.1', port = 0, animate = true } = {}) {
  const states = seed();
  const subscribers = new Map(); // ws -> subscription id
  const wss = new WebSocketServer({ host, port, path: '/api/websocket' });
  await new Promise((resolve) => wss.once('listening', resolve));
  const timers = new Set();

  const now = () => new Date().toISOString();
  const withMeta = (st) => ({ ...st, last_changed: now(), last_updated: now(), context: { id: 'fake' } });

  function setState(entityId, state, attrs) {
    const old = states[entityId] ? { ...states[entityId] } : null;
    const next = { entity_id: entityId, state: String(state), attributes: attrs || (old ? old.attributes : {}) };
    states[entityId] = next;
    for (const [ws, subId] of subscribers) {
      if (ws.readyState !== 1) continue;
      ws.send(JSON.stringify({ id: subId, type: 'event', event: { event_type: 'state_changed', data: { entity_id: entityId, old_state: old && withMeta(old), new_state: withMeta(next) }, time_fired: now() } }));
    }
  }

  function setPlugPower(switchId, on) {
    const name = switchId.replace('switch.', '');
    const sensorId = `sensor.${name}_current_consumption`;
    if (!states[sensorId]) return;
    setState(sensorId, on ? (NOMINAL_WATTS[name] ?? Math.max(1, +states[sensorId].state || 10)) : 0);
  }

  function callService(domain, service, data) {
    const id = data.entity_id;
    const known = (e) => { if (!states[e]) throw Object.assign(new Error(`Entity ${e} not found`), { code: 'not_found' }); };
    if ((domain === 'switch' || domain === 'light') && (service === 'turn_on' || service === 'turn_off')) {
      known(id); const on = service === 'turn_on';
      setState(id, on ? 'on' : 'off');
      if (domain === 'switch') setPlugPower(id, on);
      return;
    }
    if (domain === 'climate' && service === 'set_temperature') { known(id); setState(id, states[id].state, { ...states[id].attributes, temperature: data.temperature }); return; }
    if (domain === 'climate' && service === 'set_hvac_mode') { known(id); setState(id, data.hvac_mode); return; }
    if (domain === 'hive' && service === 'boost_hot_water') {
      known(id);
      const on = data.on_off === 'on';
      setState('binary_sensor.hotwater_boost', on ? 'on' : 'off');
      if (on) setState('binary_sensor.hotwater_state', 'on');
      if (on) { const m = String(data.time_period || '00:30:00').split(':').map(Number); const ms = ((m[0] * 60) + m[1]) * 60_000; const t = setTimeout(() => setState('binary_sensor.hotwater_boost', 'off'), ms); timers.add(t); }
      return;
    }
    throw Object.assign(new Error(`Service ${domain}.${service} not found`), { code: 'not_found' });
  }

  wss.on('connection', (ws) => {
    let authed = false;
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: 'fake-2026.10' }));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!authed) {
        if (m.type === 'auth' && m.access_token === token) { authed = true; ws.send(JSON.stringify({ type: 'auth_ok', ha_version: 'fake-2026.10' })); }
        else { ws.send(JSON.stringify({ type: 'auth_invalid', message: 'Invalid access token' })); ws.close(); }
        return;
      }
      const ok = (result = null) => ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result }));
      const fail = (code, message) => ws.send(JSON.stringify({ id: m.id, type: 'result', success: false, error: { code, message } }));
      switch (m.type) {
        case 'ping': ws.send(JSON.stringify({ id: m.id, type: 'pong' })); break;
        case 'get_states': ok(Object.values(states).map(withMeta)); break;
        case 'subscribe_events': subscribers.set(ws, m.id); ok(); break;
        case 'call_service':
          try { callService(m.domain, m.service, m.service_data || {}); ok({ context: { id: 'fake' } }); } catch (e) { fail(e.code || 'unknown', e.message); }
          break;
        default: fail('unknown_command', `Unknown command ${m.type}`);
      }
    });
    ws.on('close', () => subscribers.delete(ws));
  });

  // Make the numbers move so the dashboard feels alive.
  let tick = 0;
  if (animate) {
    const acc = { soc: 12.1, dailyPv: 4.98, dailyLoad: 14.29, dailyImport: 6.45, dailyExport: 0 };
    const t = setInterval(() => {
      tick++;
      const h = londonHour(Date.now());
      const sun = h < 6.3 || h > 17.5 ? 0 : Math.sin(((h - 6.3) / 11.2) * Math.PI) ** 1.4;
      const pv = Math.max(0, 3.4 * sun * (0.8 + 0.2 * Math.sin(tick / 7)) + (sun ? (Math.random() - 0.5) * 0.08 : 0));
      let load = 0.45 + 0.1 * Math.sin(tick / 11) + Math.random() * 0.05;
      for (const [id, st] of Object.entries(states)) if (id.startsWith('switch.') && st.state === 'off') { /* off plugs add nothing */ }
      const net = pv - load;
      let charge = 0, discharge = 0, imp = 0, exp = 0;
      if (net >= 0) { if (acc.soc < 99.5) charge = Math.min(net, 4.4); exp = net - charge; }
      else { if (acc.soc > 5) discharge = Math.min(-net, 4.8); imp = -net - discharge; }
      acc.soc = Math.min(100, Math.max(0, acc.soc + ((charge - discharge) * (3 / 3600) / 9.04) * 100 * 30)); // sped up 30x
      const dt = 3 / 3600;
      acc.dailyPv += pv * dt; acc.dailyLoad += load * dt; acc.dailyImport += imp * dt; acc.dailyExport += exp * dt;
      const r = (n, d = 3) => +n.toFixed(d);
      setState('sensor.sigen_plant_pv_power', r(pv));
      setState('sensor.sigen_plant_consumed_power', r(load));
      setState('sensor.sigen_plant_battery_power', r(charge || discharge));
      setState('binary_sensor.sigen_plant_battery_charging', charge > 0.02 ? 'on' : 'off');
      setState('binary_sensor.sigen_plant_battery_discharging', discharge > 0.02 ? 'on' : 'off');
      setState('sensor.sigen_plant_battery_state_of_charge', r(acc.soc, 1));
      setState('sensor.sigen_plant_grid_import_power', r(imp));
      setState('sensor.sigen_plant_grid_export_power', r(exp));
      setState('sensor.sigen_plant_daily_pv_energy', r(acc.dailyPv, 2));
      setState('sensor.sigen_plant_daily_load_consumption', r(acc.dailyLoad, 2));
      setState('sensor.sigen_plant_daily_grid_import_energy', r(acc.dailyImport, 2));
      setState('sensor.sigen_plant_daily_grid_export_energy', r(acc.dailyExport, 2));
      // Occasionally a camera "sees" something.
      if (tick % 40 === 0) {
        const cams = ['front_garden', 'back_garden', 'garage'];
        const c = cams[Math.floor(Math.random() * cams.length)];
        const id = `binary_sensor.${c}_camera_person`;
        setState(id, 'on');
        const off = setTimeout(() => setState(id, 'off'), 6000); timers.add(off);
      }
    }, 3000);
    timers.add(t);
  }

  const address = wss.address();
  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    states,
    setState,
    close: () => new Promise((resolve) => { for (const t of timers) { clearTimeout(t); clearInterval(t); } for (const ws of wss.clients) ws.terminate(); wss.close(() => resolve()); }),
  };
}

module.exports = { createFakeHa, seed };
