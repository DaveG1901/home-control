'use strict';

const { EventEmitter } = require('node:events');
const E = require('./entities');

const WEATHER = {
  'clear-night': 'Clear night', cloudy: 'Cloudy', exceptional: 'Exceptional', fog: 'Fog', hail: 'Hail',
  lightning: 'Thunder', 'lightning-rainy': 'Thunderstorms', partlycloudy: 'Partly cloudy', pouring: 'Heavy rain',
  rainy: 'Rain', snowy: 'Snow', 'snowy-rainy': 'Sleet', sunny: 'Sunny', windy: 'Windy', 'windy-variant': 'Windy',
};

const SPARE_TAU_S = 30;
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
    this.now = () => Date.now(); // overridable in tests
    this.spareAvg = null; // smoothed spare solar (kW), so the card does not flicker with every cloud
    this.spareT = 0;
    this.binsSource = null; // set by the server: the bin collection service
  }

  setBins(service) { this.binsSource = service; }

  applyStates(list) {
    this.entities.clear();
    for (const s of list) if (this.watched.has(s.entity_id)) this.entities.set(s.entity_id, { state: s.state, attributes: s.attributes || {} });
    this.ready = true;
    this._updateSpare();
    this.emit('change');
  }

  applyChange(entityId, newState) {
    if (!this.watched.has(entityId)) return;
    const old = this.entities.get(entityId);
    if (!newState) this.entities.delete(entityId);
    else this.entities.set(entityId, { state: newState.state, attributes: newState.attributes || {} });
    if (entityId === E.energy.pv || entityId === E.energy.load) this._updateSpare();
    if (this.ready) this._detectEvents(entityId, old, newState);
    this.emit('change');
  }

  /** Exponential moving average of (solar - home use), time constant SPARE_TAU_S. */
  _updateSpare() {
    const pv = this.num(E.energy.pv);
    const load = this.num(E.energy.load);
    if (pv === null || load === null) return;
    const x = Math.max(0, pv - load);
    const t = this.now();
    if (this.spareAvg === null) this.spareAvg = x;
    else this.spareAvg += (x - this.spareAvg) * (1 - Math.exp(-Math.max(0, t - this.spareT) / 1000 / SPARE_TAU_S));
    this.spareT = t;
  }

  /** The "Solar surplus" card: spare solar, where it is going now, and which appliances it could cover. */
  surplusModel(plugState, plugsById) {
    const en = E.energy;
    const pv = this.num(en.pv);
    const load = this.num(en.load);
    if (pv === null || load === null || this.spareAvg === null) return { state: 'unknown', spare: null, split: null, devices: [] };

    const spare = pv < 0.05 ? 0 : Math.max(0, this.spareAvg);
    const state = pv < 0.05 ? 'night' : spare < 0.2 ? 'low' : 'good';
    const toBattery = this.isOn(en.battCharging) ? Math.abs(this.num(en.battPower) || 0) : 0;
    const split = { home: round(Math.min(pv, load)), battery: round(toBattery), grid: round(this.num(en.gridExport) || 0) };

    const devices = E.surplusDevices.map((d) => {
      const plug = plugsById.get(d.id);
      const p = plugState(plug);
      const running = p.state === 'on' && p.watts !== null && p.watts > Math.max(30, d.kw * 150);
      const share = d.kw > 0 ? clamp(spare / d.kw, 0, 1) : 0;
      const fit = p.state === 'unavailable' ? 'unavailable' : running ? 'running' : share >= 0.9 ? 'good' : share >= 0.5 ? 'marginal' : 'no';
      return { id: d.id, name: plug.name, kw: d.kw, state: p.state, watts: p.watts, fit, solarShare: Math.round(share * 100) };
    });
    return { state, spare: round(spare), split, devices };
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
      mode: (this.raw(z.climate) || { state: 'unavailable' }).state,
      modes: this.attr(z.climate, 'hvac_modes') || [],
      boost: this.attr(z.climate, 'preset_mode') === 'boost',
      hvacAction: this.attr(z.climate, 'hvac_action'),
    });
    const hw = E.heating.hotWater;
    const heating = {
      main: zone(E.heating.main),
      zones: E.heating.zones.map(zone),
      hotWater: { heatingNow: this.isOn(hw.heatingNow), boosting: this.isOn(hw.boosting), mode: this.str(hw.mode) || this.str(hw.waterHeater) },
      limits: E.heating.target,
      modes: E.heating.modes,
      boost: E.heating.boost,
    };

    const security = {
      // The Tapo D230 doorbells expose only battery + detection switches in HA (no press event), so that is all we show.
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
      return { id: p.id, name: p.name, state: e ? e.state : 'unavailable', watts: round(n(p.power), 1), warn: p.warn || null, control: true };
    };
    const byId = new Map(E.plugs.map((p) => [p.id, p]));
    const devices = E.quickControls.map((id) => plugState(byId.get(id)));
    const consumers = E.plugs.map(plugState).filter((p) => p.watts && p.watts > 0.5).sort((a, b) => b.watts - a.watts).slice(0, 7).map((p) => ({ name: p.name, watts: p.watts }));

    // Everything switchable, grouped for the Devices page. Locked plugs are listed (read-only) so nothing is hidden.
    const lightState = (l) => {
      const e = this.raw(l.light);
      return { id: l.id, name: l.name, state: e ? e.state : 'unavailable', control: true };
    };
    const catalogue = {
      plugs: E.groupBy(E.plugs).map((g) => ({ name: g.name, items: g.items.map(plugState) })),
      lights: E.groupBy(E.lights).map((g) => ({ name: g.name, items: g.items.map(lightState) })),
    };

    const w = this.str(E.environment.weather);
    return {
      ts: Date.now(),
      connection: { mode: this.mode, ha: this.haConnected, ready: this.ready, error: this.fatal },
      environment: { outsideTemp: round(n(E.environment.outsideTemp), 1), weather: w ? WEATHER[w] || w : null },
      energy, today, heating, security, devices, consumers, catalogue,
      surplus: this.surplusModel(plugState, byId),
      bins: this.binsSource ? this.binsSource.view() : { available: false, next: null, then: [] },
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
