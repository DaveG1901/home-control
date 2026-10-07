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
  boost: { temperature: 21, minutes: [30, 60, 120] },      // a zone boost heats to this temperature for the chosen time
};

const hms = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;

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
  return { id: k, name: names[k], stream: `camera.${k}_camera_fluent`, floodlight: `light.${k}_camera_floodlight`, detect };
});

// Every smart plug. power = sensor in watts (null if none). A plug with a `lock` can never be switched from the app:
//   'protected' = switching it off could do real harm (freezer, critical office power)
//   'network'   = powers a router / camera / powerline adapter: switching it off would cut your own way back in
const plug = (group, id, name, sw, power, lock = null) => ({
  group, id, name,
  switch: `switch.${sw}`,
  power: power ? `sensor.${power}` : null,
  control: !lock,
  protected: !!lock,
  lock,
});

const plugs = [
  plug('Kitchen & utility', 'dishwasher', 'Dishwasher', 'dishwasher', 'dishwasher_current_consumption'),
  plug('Kitchen & utility', 'washing_machine', 'Washing machine', 'washing_machine', 'washing_machine_current_consumption'),
  plug('Kitchen & utility', 'tumble_dryer', 'Tumble dryer', 'tumble_dryer', 'tumble_dryer_current_consumption'),
  plug('Kitchen & utility', 'microwave', 'Microwave', 'microwave', 'microwave_current_consumption'),
  plug('Kitchen & utility', 'kitchen_dryer', 'Kitchen dryer plug', 'kitchen_dryer_plug', 'kitchen_dryer_plug_current_consumption'),
  plug('Kitchen & utility', 'kitchen_charger', 'Kitchen charger plug', 'kitchen_charger_plug', 'kitchen_charger_plug_current_consumption'),
  plug('Kitchen & utility', 'kitchen_radio', 'Kitchen radio', 'kitchen_extension_kitchen_radio', 'kitchen_radio_current_consumption'),
  plug('Kitchen & utility', 'kitchen_lamp', 'Kitchen lamp', 'kitchen_extension_smart_plug_2', 'kitchen_lamp_current_consumption'),
  plug('Kitchen & utility', 'kitchen_plug_1', 'Kitchen extension plug 1', 'kitchen_extension_smart_plug_1', 'unnamed_p304m_smart_plug_1_current_consumption'),
  plug('Kitchen & utility', 'purifier', 'Air purifier', 'purifier', 'purifier_current_consumption'),

  plug('Garage', 'garage_heater', 'Garage heater', 'garage_heater', 'garage_heater_current_consumption'),
  plug('Garage', 'garage_charger', 'Garage charger plug', 'garage_charger_plug', 'garage_charger_plug_current_consumption'),
  plug('Garage', 'garage_extension', 'Garage extension', 'garage_extension', 'garage_extension_current_consumption'),
  plug('Garage', 'freezer', 'Garage freezer', 'garage_freezer_plug', 'garage_freezer_plug_current_consumption', 'protected'),

  plug('Living areas', 'lamp_plug', 'Living room lamp', 'lamp_plug', 'lamp_plug_device_power'),
  plug('Living areas', 'living_big_lamp', 'Living room big lamp', 'living_room_big_lamp', 'living_room_big_lamp_current_consumption'),
  plug('Living areas', 'living_extension', 'Living room extension', 'living_room_extension', 'living_room_extension_current_consumption'),
  plug('Living areas', 'tv', 'TV plug', 'tv_plug', 'tv_plug_current_consumption'),
  plug('Living areas', 'downstairs_hall', 'Downstairs hall plug', 'downstairs_hall_plug', 'downstairs_hall_plug_power'),
  plug('Living areas', 'upstairs_hall', 'Upstairs hall plug', 'upstairs_hall_plug', 'upstairs_hall_plug_power_2'),

  plug('Bedrooms', 'dave_tv', 'Dave TV plug', 'dave_tv_plug', 'dave_tv_plug_current_consumption'),
  plug('Bedrooms', 'eleanor_bedside', 'Eleanor bedside plug', 'eleanor_bedside_plug', 'eleanor_bedside_plug_current_consumption'),
  plug('Bedrooms', 'eleanor_cupboard', 'Eleanor cupboard plugs', 'eleanor_cupboard_plugs', 'eleanor_cupboard_plugs_current_consumption'),
  plug('Bedrooms', 'eleanor_tv', 'Eleanor TV', 'eleanor_tv', 'eleanor_tv_current_consumption'),
  plug('Bedrooms', 'kasper_bedside', 'Kasper bedside plug', 'kasper_bedside_plug', 'kasper_bedside_plug_current_consumption'),
  plug('Bedrooms', 'kasper_tv', 'Kasper TV', 'kasper_tv', 'kasper_tv_current_consumption'),
  plug('Bedrooms', 'kids_laptops', 'Kids laptops', 'kids_laptops', 'kids_laptops_current_consumption'),

  plug('Office', 'michelle_office', 'Michelle office power', 'michelle_office_power_1', 'michelle_office_power_1_current_consumption'),
  plug('Office', 'michelle_office_2', 'Michelle spare office power', 'michelle_office_power_2', 'michelle_office_power_2_current_consumption'),
  plug('Office', 'dave_desk', 'Dave office desk', 'office_dave_desk_power', 'office_dave_desk_power_current_consumption'),
  plug('Office', 'office_critical', 'Office critical power', 'office_critical_plug', 'office_critical_plug_current_consumption', 'protected'),

  plug('Network & cameras', 'router_dave', 'Router plug (Dave bedroom)', 'dave_bedroom_plug_1', 'dave_bedroom_plug_1_current_consumption', 'network'),
  plug('Network & cameras', 'router_kitchen', 'Kitchen router', 'kitchen_extension_kitchen_router', 'kitchen_router_current_consumption', 'network'),
  plug('Network & cameras', 'router_garage', 'Garage router', 'garage_camera_powerline', 'garage_camera_powerline_current_consumption', 'network'),
  plug('Network & cameras', 'cam_front_poe', 'Front camera PoE', 'front_camera_poe', 'front_camera_poe_current_consumption', 'network'),
  plug('Network & cameras', 'cam_front_poe_2', 'Front camera PoE (second plug)', 'front_camera_poe_2', 'front_camera_poe_current_consumption_2', 'network'),
  plug('Network & cameras', 'cam_front_powerline', 'Front camera powerline', 'front_camera_powerline', null, 'network'),
  plug('Network & cameras', 'cam_garden_powerline', 'Garden camera powerline', 'garden_camera_powerline', 'garden_camera_powerline_current_consumption', 'network'),
];

// House lights (camera floodlights live on the Security card; access-point and switch LEDs are left out on purpose).
const light = (group, id, name, entity) => ({ group, id, name, light: `light.${entity}` });
const lights = [
  light('Living areas', 'living_bulb_1', 'Living room bulb 1', 'smart_bulb'),
  light('Living areas', 'living_bulb_2', 'Living room bulb 2', 'living_room_bulb_2'),
  light('Living areas', 'living_bulb_3', 'Living room bulb 3 (named "Eleanor" in HA)', 'living_room_bulb_1'),
  light('Living areas', 'downstairs_hall', 'Downstairs hall', 'downstairs_hall_light'),
  light('Living areas', 'upstairs_hall', 'Upstairs hall', 'upstairs_hall_light'),
  light('Living areas', 'lobby', 'Lobby', 'lobby_light'),
  light('Bedrooms', 'dave_light', 'Dave light', 'dave_light'),
  light('Bedrooms', 'dave_bulb', 'Dave bulb', 'dave_bedroom_bulb'),
  light('Bedrooms', 'eleanor_light', 'Eleanor light', 'eleanor_light'),
  light('Bedrooms', 'kasper_light', 'Kasper light', 'kasper_bedroom_light'),
  light('Bedrooms', 'kasper_bulb', 'Kasper bulb', 'kasper_bulb'),
  light('Bedrooms', 'michelle_light', 'Michelle bedroom light', 'michelle_bedroom_light'),
  light('Office', 'office_light', 'Office light', 'office_light'),
  light('Office', 'office_bulb', 'Office bulb', 'office_bulb'),
];

// Group items in the order they first appear, e.g. for the Devices page.
const groupBy = (list) => {
  const map = new Map();
  for (const item of list) { if (!map.has(item.group)) map.set(item.group, []); map.get(item.group).push(item); }
  return [...map].map(([name, items]) => ({ name, items }));
};

// Appliances offered on the "Solar surplus" card, with their typical draw in kW.
// Must be plugs above with control: true. Switching a plug only powers the socket: the appliance itself still needs starting.
const surplusDevices = [
  { id: 'dishwasher', kw: 1.2 },
  { id: 'tumble_dryer', kw: 2.2 },
  { id: 'garage_heater', kw: 2.0 },
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

  for (const l of lights) {
    cmds.set(`light:${l.id}`, {
      label: l.name,
      validate: onOff,
      call: (v) => ({ domain: 'light', service: v === 'on' ? 'turn_on' : 'turn_off', data: { entity_id: l.light } }),
      describe: (v) => `${l.name} switched ${v}`,
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
  // hive.boost_hot_water: fields entity_id, on_off, time_period (confirmed against this Home Assistant).
  const boostMinutes = (v) => v === 0 || h.boost.minutes.includes(v);
  const minutesText = (m) => (m % 60 === 0 ? `${m / 60} h` : `${m} min`);
  cmds.set('hotwater.boost', {
    label: 'Hot water boost',
    validate: boostMinutes,
    call: (v) => (v === 0
      ? { domain: 'hive', service: 'boost_hot_water', data: { entity_id: h.hotWater.waterHeater, on_off: 'off' } }
      : { domain: 'hive', service: 'boost_hot_water', data: { entity_id: h.hotWater.waterHeater, on_off: 'on', time_period: hms(v) } }),
    describe: (v) => (v === 0 ? 'Hot water boost cancelled' : `Hot water boost for ${minutesText(v)}`),
  });

  // Heating boost for the main thermostat and for every zone: hive.boost_heating_on / boost_heating_off.
  for (const z of [h.main, ...h.zones]) {
    cmds.set(`boost:${z.id}`, {
      label: `${z.name} boost`,
      validate: boostMinutes,
      call: (v) => (v === 0
        ? { domain: 'hive', service: 'boost_heating_off', data: { entity_id: z.climate } }
        : { domain: 'hive', service: 'boost_heating_on', data: { entity_id: z.climate, time_period: hms(v), temperature: h.boost.temperature } }),
      describe: (v) => (v === 0 ? `${z.name} boost cancelled` : `${z.name} boosted to ${h.boost.temperature}° for ${minutesText(v)}`),
    });
  }

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
  for (const p of plugs) { set.add(p.switch); if (p.power) set.add(p.power); }
  for (const l of lights) set.add(l.light);
  return set;
}

module.exports = { energy, environment, heating, doorbells, cameras, plugs, lights, groupBy, quickControls, surplusDevices, buildCommands, watchedEntities };
