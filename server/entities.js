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
  maxPower: 'sensor.sigen_plant_max_active_power',        // kW, the inverter's limit (used if solar.kwp is not set)
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

// Every smart plug. power = sensor in watts (null if none). Every plug can be switched from the app.
// A plug with a `warn` asks "are you sure?" before it is switched OFF:
//   'critical' = switching it off could do real harm (freezer, critical office power)
//   'network'  = powers a router / camera / powerline adapter: switching it off could cut your own way back in
const plug = (group, id, name, sw, power, warn = null) => ({
  group, id, name,
  switch: `switch.${sw}`,
  power: power ? `sensor.${power}` : null,
  control: true,
  warn,
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
  plug('Garage', 'freezer', 'Garage freezer', 'garage_freezer_plug', 'garage_freezer_plug_current_consumption', 'critical'),

  plug('Living areas', 'lamp_plug', 'Living room lamp', 'lamp_plug', 'lamp_plug_device_power'),
  plug('Living areas', 'living_big_lamp', 'Living room big lamp', 'living_room_big_lamp', 'living_room_big_lamp_current_consumption'),
  plug('Living areas', 'living_extension', 'Living room extension', 'living_room_extension', 'living_room_extension_current_consumption'),
  plug('Living areas', 'tv', 'TV plug', 'tv_plug', 'tv_plug_current_consumption'),
  plug('Living areas', 'downstairs_hall', 'Downstairs hall plug', 'downstairs_hall_plug', 'downstairs_hall_plug_power'),
  plug('Living areas', 'upstairs_hall', 'Upstairs hall plug', 'upstairs_hall_plug', 'upstairs_hall_plug_power_2'),
  plug('Living areas', 'dryer', 'Dryer plug', 'dryer_plug', 'dryer_plug_current_consumption'),
  plug('Living areas', 'bim_downstairs', 'Bim downstairs', 'bim_downstairs', 'bim_downstairs_current_consumption'),

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
  plug('Office', 'office_critical', 'Office critical power', 'office_critical_plug', 'office_critical_plug_current_consumption', 'critical'),

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

// What a light can do and how it is set right now, from its Home Assistant attributes (only reported while it is on).
const COLOUR_MODES = ['hs', 'rgb', 'xy', 'rgbw', 'rgbww'];
function lightInfo(state, attrs = {}) {
  const modes = Array.isArray(attrs.supported_color_modes) ? attrs.supported_color_modes : [];
  const colour = modes.some((m) => COLOUR_MODES.includes(m));
  const temp = modes.includes('color_temp');
  const info = {
    dim: colour || temp || modes.includes('brightness') || modes.includes('white'),
    colour, temp,
    minK: Number(attrs.min_color_temp_kelvin) || 2000, maxK: Number(attrs.max_color_temp_kelvin) || 6500,
    brightness: null, rgb: null, kelvin: null, mode: null,
  };
  if (state === 'on') {
    if (typeof attrs.brightness === 'number') info.brightness = Math.max(1, Math.round((attrs.brightness / 255) * 100));
    if (Array.isArray(attrs.rgb_color) && attrs.rgb_color.length === 3) info.rgb = attrs.rgb_color.map((n) => Math.round(Number(n) || 0));
    if (typeof attrs.color_temp_kelvin === 'number') info.kelvin = attrs.color_temp_kelvin;
    info.mode = attrs.color_mode || null;
  }
  return info;
}
const lights = [
  light('Living areas', 'living_bulb_1', 'Living room bulb 1', 'smart_bulb'),
  light('Living areas', 'living_bulb_2', 'Living room bulb 2', 'living_room_bulb_2'),
  light('Living areas', 'downstairs_hall', 'Downstairs hall', 'downstairs_hall_light'),
  light('Living areas', 'upstairs_hall', 'Upstairs hall', 'upstairs_hall_light'),
  light('Living areas', 'lobby', 'Lobby', 'lobby_light'),
  light('Bedrooms', 'dave_light', 'Dave light', 'dave_light'),
  light('Bedrooms', 'dave_bulb', 'Dave bulb', 'dave_bedroom_bulb'),
  light('Bedrooms', 'eleanor_light', 'Eleanor light', 'eleanor_light'),
  light('Bedrooms', 'eleanor_bulb', 'Eleanor bulb', 'living_room_bulb_1'), // Eleanor's colour bulb (HA calls it "Eleanor"; the entity id says living room)
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

// Council bin collections ("Bindicator"). The calendar comes from the council via a Home Assistant calendar integration.
// Bin colours are the council's; change them here if the council changes its bins.
const bins = {
  calendar: 'calendar.vale_1_south_2_monday_waste_collections',
  always: ['food'], // collected every week, whatever the council's event title says
  kinds: {
    grey: { label: 'Grey rubbish', color: '#8d99ab' },
    green: { label: 'Green recycling', color: '#2fa05b' },
    brown: { label: 'Brown garden waste', color: '#9a6a43' },
    food: { label: 'Food waste', color: '#6cb58c', caddy: true },
  },
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
function buildCommands(ctx = { mode: () => null, preset: () => null, attr: () => null, memory: new Map() }) {
  const attrOf = ctx.attr || (() => null);
  const cmds = new Map();
  const onOff = (v) => v === 'on' || v === 'off';

  for (const p of plugs) {
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
    // Brightness, white (warm to cool) or a colour: { brightness: 1-100 } and/or ONE of { kelvin } or { hs: [hue 0-360, saturation 0-100] }.
    // Only what the bulb itself says it supports is accepted.
    const can = () => lightInfo('off', { supported_color_modes: attrOf(l.light, 'supported_color_modes'), min_color_temp_kelvin: attrOf(l.light, 'min_color_temp_kelvin'), max_color_temp_kelvin: attrOf(l.light, 'max_color_temp_kelvin') });
    cmds.set(`lightset:${l.id}`, {
      label: `${l.name} brightness and colour`,
      validate: (v) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
        const keys = Object.keys(v);
        if (!keys.length || keys.some((k) => !['brightness', 'kelvin', 'hs'].includes(k)) || ('kelvin' in v && 'hs' in v)) return false;
        const c = can();
        const num = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
        if ('brightness' in v && !(c.dim && Number.isInteger(v.brightness) && num(v.brightness, 1, 100))) return false;
        if ('kelvin' in v && !(c.temp && num(v.kelvin, c.minK, c.maxK))) return false;
        if ('hs' in v && !(c.colour && Array.isArray(v.hs) && v.hs.length === 2 && num(v.hs[0], 0, 360) && num(v.hs[1], 0, 100))) return false;
        return true;
      },
      call: (v) => {
        const data = { entity_id: l.light };
        if ('brightness' in v) data.brightness_pct = v.brightness;
        if ('kelvin' in v) data.color_temp_kelvin = Math.round(v.kelvin);
        if ('hs' in v) data.hs_color = [Math.round(v.hs[0]), Math.round(v.hs[1])];
        return { domain: 'light', service: 'turn_on', data };
      },
      describe: (v) => `${l.name} set to ${['brightness' in v ? `${v.brightness}%` : null, 'kelvin' in v ? (v.kelvin < 3500 ? 'warm white' : v.kelvin > 5000 ? 'cool white' : 'white') : null, 'hs' in v ? 'a colour' : null].filter(Boolean).join(', ')}`,
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

  // Heating boost for the main thermostat and for every zone.
  // Starting uses hive.boost_heating_on. CANCELLING cannot use hive.boost_heating_off or climate.set_preset_mode: in this Home
  // Assistant both raise a KeyError ('mode') inside the Hive integration and leave the boost running. What does work is putting
  // the zone back into the mode it had before the boost, so we remember that mode when a boost starts.
  const MODES = ['off', 'auto', 'heat'];
  for (const z of [h.main, ...h.zones]) {
    cmds.set(`boost:${z.id}`, {
      label: `${z.name} boost`,
      validate: boostMinutes,
      call: (v) => {
        if (v > 0) {
          if (ctx.preset(z.climate) !== 'boost') { const m = ctx.mode(z.climate); if (MODES.includes(m)) ctx.memory.set(z.id, m); }
          return { domain: 'hive', service: 'boost_heating_on', data: { entity_id: z.climate, time_period: hms(v), temperature: h.boost.temperature } };
        }
        const prev = ctx.memory.get(z.id);
        if (MODES.includes(prev)) {
          ctx.memory.delete(z.id);
          return { domain: 'climate', service: 'set_hvac_mode', data: { entity_id: z.climate, hvac_mode: prev } };
        }
        // Mode unknown (boost started in the Hive app, or this server restarted): replace it with a 1-minute boost. When a
        // boost runs out Hive restores the previous mode itself (tested), so this ends within a couple of minutes.
        return { domain: 'hive', service: 'boost_heating_on', data: { entity_id: z.climate, time_period: hms(1), temperature: h.boost.temperature } };
      },
      describe: (v) => (v === 0 ? `${z.name} boost cancelled` : `${z.name} boosted to ${h.boost.temperature}° for ${minutesText(v)}`),
    });
  }

  // To-do lists. Items are referred to by Home Assistant's own id (uid), and only ids that are on the list right now are accepted.
  const itemsOf = ctx.todoItems || (() => []);
  const findItem = (list, uid) => (typeof uid === 'string' && uid.length <= 100 ? itemsOf(list.id).find((i) => i.uid === uid) : null);
  const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  for (const list of todoLists) {
    cmds.set(`todo.add:${list.id}`, {
      label: `Add to ${list.name}`,
      validate: (v) => clean(v).length >= 1 && clean(v).length <= 200,
      call: (v) => ({ domain: 'todo', service: 'add_item', data: { entity_id: list.entity, item: clean(v) } }),
      describe: (v) => `${clean(v)} added to ${list.name}`,
      kind: 'lists',
    });
    cmds.set(`todo.done:${list.id}`, {
      label: `Tick off on ${list.name}`,
      validate: (v) => !!v && typeof v === 'object' && typeof v.done === 'boolean' && !!findItem(list, v.uid),
      call: (v) => ({ domain: 'todo', service: 'update_item', data: { entity_id: list.entity, item: v.uid, status: v.done ? 'completed' : 'needs_action' } }),
      describe: (v) => `${(findItem(list, v.uid) || {}).summary || 'Item'} ${v.done ? 'ticked off' : 'put back'} on ${list.name}`,
      kind: 'lists',
    });
    cmds.set(`todo.remove:${list.id}`, {
      label: `Remove from ${list.name}`,
      validate: (v) => !!findItem(list, v),
      call: (v) => ({ domain: 'todo', service: 'remove_item', data: { entity_id: list.entity, item: v } }),
      describe: (v) => `${(findItem(list, v) || {}).summary || 'Item'} removed from ${list.name}`,
      kind: 'lists',
    });
    cmds.set(`todo.clear:${list.id}`, {
      label: `Clear ticked-off items on ${list.name}`,
      validate: (v) => v === true && itemsOf(list.id).some((i) => i.done),
      call: () => ({ domain: 'todo', service: 'remove_completed_items', data: { entity_id: list.entity } }),
      describe: () => `Ticked-off items cleared from ${list.name}`,
      kind: 'lists',
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

// ---- to-do lists (Home Assistant's own lists, so they stay in step with its app and voice assistants) ----
// To show another list, add it in Home Assistant (Settings > Devices & services > Add integration > Local To-do) and here.
const todoLists = [
  { id: 'shopping', name: 'Shopping list', entity: 'todo.shopping_list' },
  { id: 'todo', name: 'To-do list', entity: 'todo.to_do_list' },
];

// ---- outside the house (free public data, no Home Assistant needed) ----
// The village, not the house: the middle of Uffington. Only this (and the SN7 postcode district, for grid carbon) is ever
// sent to the weather, radar, carbon-intensity and flood services.
const area = { name: 'Uffington', postcode: 'SN7', lat: 51.598, lon: -1.565, floodRadiusKm: 15 };

// The panels' rated size in kWp (from the installation paperwork). If unset, the inverter's 6.6 kW limit is used.
const solar = { kwp: 8.8 };

// Which lights and plugs make each window of the house picture glow at night. Window ids are fixed positions on house.png.
// Only plugs that power a lamp belong here: a plug that is on for a TV or charger would light a window that is dark.
const houseWindows = {
  groundLeft: { lights: ['office_light', 'office_bulb'], plugs: [] },                     // office
  groundHall: { lights: ['downstairs_hall', 'lobby'], plugs: ['downstairs_hall'] },          // hall and front door
  groundRight: { lights: ['living_bulb_1', 'living_bulb_2'], plugs: ['lamp_plug', 'living_big_lamp'] }, // living room
  upLeft: { lights: ['eleanor_light', 'eleanor_bulb'], plugs: [] },                                         // Eleanor
  upMiddle: { lights: ['upstairs_hall'], plugs: [] },                                     // upstairs hall
  upRight: { lights: ['michelle_light'], plugs: [] },                                       // Michelle
};

module.exports = { todoLists, lightInfo, area, solar, houseWindows, energy, environment, heating, doorbells, cameras, plugs, lights, groupBy, bins, quickControls, surplusDevices, buildCommands, watchedEntities };
