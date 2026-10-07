'use strict';

const { EventEmitter } = require('node:events');
const E = require('./entities');

const WEATHER = {
  'clear-night': 'Clear night', cloudy: 'Cloudy', exceptional: 'Exceptional', fog: 'Fog', hail: 'Hail',
  lightning: 'Thunder', 'lightning-rainy': 'Thunderstorms', partlycloudy: 'Partly cloudy', pouring: 'Heavy rain',
  rainy: 'Rain', snowy: 'Snow', 'snowy-rainy': 'Sleet', sunny: 'Sunny', windy: 'Windy', 'windy-variant': 'Windy',
};

const BAD = new Set(['unavailable', 'unknown', 'none', '']);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round = (n, dp = 2) => (n === null ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/** Holds the latest state of every watched entity, plus a short activity log. */
class Store extends EventEmitter {
  constructor(mode) {
    super();
    this.mode = mode;
    this.watched = E.watchedEntities();
    this.entities = new Map();
    this.activity = [];
    this.haConnected = false;
    this.fatal = null;
    this.ready = false; // true once the first full snapshot has arrived
  }

  applyStates(list) {
    this.entities.clear();
    for (const s of list) if (this.watched.has(s.entity_id)) this.entities.set(s.entity_id, { state: s.state, attributes: s.attributes || {} });
    this.ready = true;
    this.emit('change');
  }

  applyChange(entityId, newState) {
    if (!this.watched.has(entityId)) return;
    const old = this.entities.get(entityId);
    if (!newState) this.entities.delete(entityId);
    else this.entities.set(entityId, { state: newState.state, attributes: newState.attributes || {} });
    if (this.ready) this._detectEvents(entityId, old, newState);
    this.emit('change');
  }

  _detectEvents(entityId, old, next) {
    if (!next || next.state !== 'on' || (old && old.state === 'on')) return;
    for (const cam of E.cameras) {
      for (const [kind, ids] of Object.entries(cam.detect)) {
        if (ids.includes(entityId)) { this.log(`${cam.name} · ${kind} detected`, 'Camera'); return; }
      }
    }
  }

  log(text, tag) {
    this.activity.unshift({ t: Date.now(), text, tag });
    if (this.activity.length > 50) this.activity.length = 50;
    this.emit('change');
  }

  setHaConnected(v) { this.haConnected = v; this.emit('change'); }
  setFatal(msg) { this.fatal = msg; this.emit('change'); }

  // ---- typed getters ----
  raw(id) { return this.entities.get(id); }
  str(id) { const e = this.entities.get(id); return e && !BAD.has(String(e.state).toLowerCase()) ? String(e.state) : null; }
  num(id) { const s = this.str(id); if (s === null) return null; const n = parseFloat(s); return Number.isFinite(n) ? n : null; }
  isOn(id) { const e = this.entities.get(id); return !!e && e.state === 'on'; }
  attr(id, name) { const e = this.entities.get(id); const v = e && e.attributes ? e.attributes[name] : undefined; return v === undefined ? null : v; }

  // ---- view model sent to the browser ----
  viewModel() {
    const n = (id) => this.num(id);
    const en = E.energy;

    const battPower = n(en.battPower);
    const battDir = this.isOn(en.battCharging) ? 'charging' : this.isOn(en.battDischarging) ? 'discharging' : 'idle';
    const gImp = n(en.gridImport);
    const gExp = n(en.gridExport);
    const gridDir = gImp > 0.01 ? 'import' : gExp > 0.01 ? 'export' : 'idle';
    const dailyLoad = n(en.dailyLoad);
    const dailyImport = n(en.dailyImport);

    const energy = {
      pv: round(n(en.pv)),
      load: round(n(en.load)),
      battery: { power: round(battPower === null ? null : Math.abs(battPower)), dir: battDir, soc: round(n(en.soc), 1) },
      grid: { power: round(gridDir === 'export' ? gExp : gImp), dir: gridDir },
      mode: this.str(en.emsMode),
    };

    const today = {
      generated: round(n(en.dailyPv)),
      used: round(dailyLoad),
      import: round(dailyImport),
      export: round(n(en.dailyExport)),
      selfSufficiency: dailyLoad && dailyImport !== null ? round(clamp(1 - dailyImport / dailyLoad, 0, 1) * 100, 0) : null,
      capacity: round(n(en.capacity)),
      yesterday: round(n(en.prevDayPv)),
      lifetimeMwh: round(n(en.totalPv), 3),
      co2: round(n(E.environment.co2), 0),
    };

    const zone = (z) => ({
      id: z.id,
      name: z.name,
      current: round(this.attr(z.climate, 'current_temperature'), 1),
      target: round(this.attr(z.climate, 'temperature'), 1),
      mode: this.str(z.climate) || 'unavailable',
      modes: this.attr(z.climate, 'hvac_modes') || [],
    });
    const hw = E.heating.hotWater;
    const heating = {
      main: zone(E.heating.main),
      zones: E.heating.zones.map(zone),
      hotWater: { heatingNow: this.isOn(hw.heatingNow), boosting: this.isOn(hw.boosting), mode: this.str(hw.mode) || this.str(hw.waterHeater) },
      limits: E.heating.target,
      modes: E.heating.modes,
    };

    const security = {
      // The Tapo D230 doorbells expose only battery + detection switches in HA - no press event yet.
      doorbellPressAvailable: false,
      doorbells: E.doorbells.map((d) => ({
        id: d.id, name: d.name, battery: round(n(d.battery), 0), motion: this.isOn(d.motion), person: this.isOn(d.person),
      })),
      cameras: E.cameras.map((c) => {
        const active = ['person', 'vehicle', 'animal', 'motion'].find((k) => c.detect[k].some((id) => this.isOn(id)));
        const fl = this.raw(c.floodlight);
        return { id: c.id, name: c.name, status: active || 'clear', floodlight: fl ? fl.state === 'on' : null, floodlightAvailable: !!fl && fl.state !== 'unavailable' };
      }),
    };

    const plugState = (p) => {
      const e = this.raw(p.switch);
      return { id: p.id, name: p.name, state: e ? e.state : 'unavailable', watts: round(n(p.power), 1), protected: !!p.protected, control: !!p.control && !p.protected };
    };
    const byId = new Map(E.plugs.map((p) => [p.id, p]));
    const devices = E.quickControls.map((id) => plugState(byId.get(id)));
    const consumers = E.plugs.map(plugState).filter((p) => p.watts && p.watts > 0.5).sort((a, b) => b.watts - a.watts).slice(0, 7).map((p) => ({ name: p.name, watts: p.watts }));

    const w = this.str(E.environment.weather);
    return {
      ts: Date.now(),
      connection: { mode: this.mode, ha: this.haConnected, ready: this.ready, error: this.fatal },
      environment: { outsideTemp: round(n(E.environment.outsideTemp), 1), weather: w ? WEATHER[w] || w : null },
      energy, today, heating, security, devices, consumers,
      activity: this.activity.slice(0, 12),
    };
  }

  /** One chart sample (kW). battery is signed: + charging, - discharging. */
  sample() {
    const pv = this.num(E.energy.pv);
    const load = this.num(E.energy.load);
    if (pv === null && load === null) return null;
    const bp = this.num(E.energy.battPower) || 0;
    const batt = this.isOn(E.energy.battDischarging) ? -Math.abs(bp) : Math.abs(bp);
    return { t: Date.now(), pv: pv || 0, load: load || 0, batt, soc: this.num(E.energy.soc) };
  }
}

module.exports = { Store };
