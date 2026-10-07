'use strict';

// Single place that maps the dashboard onto Home Assistant entity IDs.
// Change an ID here if you rename something in HA. Nothing else in the app hard-codes entities.
//
// SAFETY: the dashboard can ONLY command things that appear in COMMANDS below.
// Anything not listed (e.g. the freezer) is read-only no matter what a client sends.

const energy = {
  pv: 'sensor.sigen_plant_pv_power',                       // kW
  load: 'sensor.sigen_plant_consumed_power',               // kW
  battPower: 'sensor.sigen_plant_battery_power',           // kW (always positive; direction from the two binary sensors)
  battCharging: 'binary_sensor.sigen_plant_battery_charging',
  battDischarging: 'binary_sensor.sigen_plant_battery_discharging',
  soc: 'sensor.sigen_plant_battery_state_of_charge',       // %
  gridImport: 'sensor.sigen_plant_grid_import_power',      // kW
  gridExport: 'sensor.sigen_plant_grid_export_power',      // kW
  emsMode: 'sensor.sigen_plant_ems_work_mode',
  capacity: 'sensor.sigen_plant_rated_energy_capacity',    // kWh
  dailyPv: 'sensor.sigen_plant_daily_pv_energy',           // kWh
  dailyLoad: 'sensor.sigen_plant_daily_load_consumption',  // kWh
  dailyImport: 'sensor.sigen_plant_daily_grid_import_energy',
  dailyExport: 'sensor.sigen_plant_daily_grid_export_energy',
  prevDayPv: 'sensor.sigen_plant_pv_previous_day_generation', // kWh
  totalPv: 'sensor.sigen_plant_total_pv_generation',       // MWh
};

const environment = {
  outsideTemp: 'sensor.met_office_uffington_temperature',
  weather: 'sensor.met_office_uffington_weather',
  co2: 'sensor.electricity_maps_co2_intensity',
};

const heating = {
  main: { id: 'main', name: 'Main thermostat', climate: 'climate.thermostat' },
  zones: [
    { id: 'living_room', name: 'Living room', climate: 'climate.living_room' },
    { id: 'lobby', name: 'Lobby', climate: 'climate.lobby' },
    { id: 'office', name: 'Office', climate: 'climate.office' },
    { id: 'utility', name: 'Utility', climate: 'climate.utility' },
    { id: 'dave', name: 'Dave', climate: 'climate.dave_bedroom' },
    { id: 'eleanor', name: 'Eleanor', climate: 'climate.eleanor_bedroom' },
    { id: 'kasper', name: 'Kasper', climate: 'climate.kasper_bedroom' },
    { id: 'michelle', name: 'Michelle', climate: 'climate.michelle_bedroom' },
  ],
  hotWater: {
    waterHeater: 'water_heater.thermostat',
    heatingNow: 'binary_sensor.hotwater_state',
    boosting: 'binary_sensor.hotwater_boost',
    mode: 'sensor.hotwater_mode',
  },
  target: { min: 5, max: 25, step: 0.5 },
  modes: { off: 'off', schedule: 'auto', heat: 'heat' }, // UI label -> HA hvac_mode
};

const doorbells = [
  { id: 'front', name: 'Front doorbell', battery: 'sensor.front_doorbell_battery', motion: 'switch.front_doorbell_motion_detection', person: 'switch.front_doorbell_person_detection' },
  { id: 'side', name: 'Side doorbell', battery: 'sensor.side_doorbell_battery', motion: 'switch.side_doorbell_motion_detection', person: 'switch.side_doorbell_person_detection' },
];

// Each camera appears twice in HA ("_2" suffix); either one reporting counts.
const cameras = ['front_garden', 'back_garden', 'garage', 'garage_back'].map((k) => {
  const names = { front_garden: 'Front garden', back_garden: 'Back garden', garage: 'Garage', garage_back: 'Garage back' };
  const kinds = ['person', 'vehicle', 'animal', 'motion'];
  const detect = {};
  for (const kind of kinds) detect[kind] = [`binary_sensor.${k}_camera_${kind}`, `binary_sensor.${k}_camera_${kind}_2`];
  return { id: k, name: names[k], floodlight: `light.${k}_camera_floodlight`, detect };
});

// power: sensor in watts. control: may be switched from the dashboard. protected: never switchable.
const plugs = [
  { id: 'dishwasher', name: 'Dishwasher', switch: 'switch.dishwasher', power: 'sensor.dishwasher_current_consumption', control: true },
  { id: 'tumble_dryer', name: 'Tumble dryer', switch: 'switch.tumble_dryer', power: 'sensor.tumble_dryer_current_consumption', control: true },
  { id: 'garage_heater', name: 'Garage heater', switch: 'switch.garage_heater', power: 'sensor.garage_heater_current_consumption', control: true },
  { id: 'purifier', name: 'Air purifier', switch: 'switch.purifier', power: 'sensor.purifier_current_consumption', control: true },
  { id: 'kids_laptops', name: 'Kids laptops', switch: 'switch.kids_laptops', power: 'sensor.kids_laptops_current_consumption', control: true },
  { id: 'freezer', name: 'Garage freezer', switch: 'switch.garage_freezer_plug', power: 'sensor.garage_freezer_plug_current_consumption', protected: true },
  { id: 'office_critical', name: 'Office critical power', switch: 'switch.office_critical_plug', power: 'sensor.office_critical_plug_current_consumption', protected: true },
  // measured only (shown under "biggest consumers")
  { id: 'michelle_office', name: 'Michelle office', switch: 'switch.michelle_office_power_1', power: 'sensor.michelle_office_power_1_current_consumption' },
  { id: 'dave_desk', name: 'Dave office desk', switch: 'switch.office_dave_desk_power', power: 'sensor.office_dave_desk_power_current_consumption' },
  { id: 'tv', name: 'TV plug', switch: 'switch.tv_plug', power: 'sensor.tv_plug_current_consumption' },
  { id: 'garage_extension', name: 'Garage extension', switch: 'switch.garage_extension', power: 'sensor.garage_extension_current_consumption' },
  { id: 'washing_machine', name: 'Washing machine', switch: 'switch.washing_machine', power: 'sensor.washing_machine_current_consumption' },
  { id: 'living_extension', name: 'Living room extension', switch: 'switch.living_room_extension', power: 'sensor.living_room_extension_current_consumption' },
];

// Which quick-control tiles to show, in order.
const quickControls = ['dishwasher', 'tumble_dryer', 'garage_heater', 'purifier', 'kids_laptops', 'freezer'];

/**
 * Command allowlist. A command is { entity, domain, services:(value)=>[{domain,service,data}], validate(value) }.
 * The client sends { id, value }; anything not defined here is rejected.
 */
function buildCommands() {
  const cmds = new Map();
  const onOff = (v) => v === 'on' || v === 'off';

  for (const p of plugs) {
    if (!p.control || p.protected) continue;
    cmds.set(`plug:${p.id}`, {
      label: p.name,
      validate: onOff,
      call: (v) => ({ domain: 'switch', service: v === 'on' ? 'turn_on' : 'turn_off', data: { entity_id: p.switch } }),
      describe: (v) => `${p.name} switched ${v}`,
    });
  }

  for (const c of cameras) {
    cmds.set(`floodlight:${c.id}`, {
      label: `${c.name} floodlight`,
      validate: onOff,
      call: (v) => ({ domain: 'light', service: v === 'on' ? 'turn_on' : 'turn_off', data: { entity_id: c.floodlight } }),
      describe: (v) => `${c.name} floodlight switched ${v}`,
    });
  }

  const h = heating;
  cmds.set('heating.target', {
    label: 'Main thermostat target',
    validate: (v) => typeof v === 'number' && Number.isFinite(v) && v >= h.target.min && v <= h.target.max,
    call: (v) => ({ domain: 'climate', service: 'set_temperature', data: { entity_id: h.main.climate, temperature: Math.round(v * 2) / 2 } }),
    describe: (v) => `Thermostat target set to ${Math.round(v * 2) / 2}°`,
  });
  cmds.set('heating.mode', {
    label: 'Main thermostat mode',
    validate: (v) => Object.values(h.modes).includes(v),
    call: (v) => ({ domain: 'climate', service: 'set_hvac_mode', data: { entity_id: h.main.climate, hvac_mode: v } }),
    describe: (v) => `Heating mode set to ${v === 'auto' ? 'schedule' : v}`,
  });
  // NOTE: the Hive boost service name/fields should be confirmed in HA (Developer Tools > Actions).
  cmds.set('hotwater.boost', {
    label: 'Hot water boost',
    validate: (v) => v === 0 || v === 30 || v === 60,
    call: (v) => (v === 0
      ? { domain: 'hive', service: 'boost_hot_water', data: { entity_id: h.hotWater.waterHeater, on_off: 'off' } }
      : { domain: 'hive', service: 'boost_hot_water', data: { entity_id: h.hotWater.waterHeater, on_off: 'on', time_period: `00:${String(v).padStart(2, '0')}:00` } }),
    describe: (v) => (v === 0 ? 'Hot water boost cancelled' : `Hot water boost for ${v} min`),
  });

  return cmds;
}

/** Every entity the app watches. Only these are stored/forwarded, so nothing else in HA is ever exposed to the browser. */
function watchedEntities() {
  const set = new Set([...Object.values(energy), ...Object.values(environment)]);
  set.add(heating.main.climate);
  for (const z of heating.zones) set.add(z.climate);
  Object.values(heating.hotWater).forEach((e) => set.add(e));
  for (const d of doorbells) { set.add(d.battery); set.add(d.motion); set.add(d.person); }
  for (const c of cameras) { set.add(c.floodlight); Object.values(c.detect).flat().forEach((e) => set.add(e)); }
  for (const p of plugs) { set.add(p.switch); set.add(p.power); }
  return set;
}

module.exports = { energy, environment, heating, doorbells, cameras, plugs, quickControls, buildCommands, watchedEntities };
