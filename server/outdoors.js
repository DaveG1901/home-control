'use strict';

// "Outside": weather, rain in the next two hours, rain radar, the best time to run big appliances (solar forecast plus the
// grid's carbon intensity), the northern lights, solar output compared with the whole UK, and flood warnings.
// All from free public services. Only the AREA (middle of the postcode district) is sent to them, never the address.
// Each source refreshes on its own timer; a failure keeps the last good answer and is reported, never fatal.

const UA = 'home-control (personal home dashboard)';

const SOURCES = {
  weather: { everyMs: 10 * 60_000 },  // Open-Meteo (UK Met Office models)
  radar: { everyMs: 10 * 60_000 },    // RainViewer
  carbon: { everyMs: 30 * 60_000 },   // National Grid ESO carbon intensity, regional by postcode
  aurora: { everyMs: 10 * 60_000 },   // AuroraWatch UK (Lancaster University) asks for no more than one request every 3 minutes
  ukSolar: { everyMs: 15 * 60_000 },  // Sheffield Solar PV_Live, national
  floods: { everyMs: 15 * 60_000 },   // Environment Agency flood monitoring
};

// WMO weather codes (Open-Meteo) to words and to the effect drawn on the house picture.
const WMO = {
  0: ['Clear', 'clear'], 1: ['Mainly clear', 'clear'], 2: ['Partly cloudy', 'cloud'], 3: ['Overcast', 'overcast'],
  45: ['Fog', 'fog'], 48: ['Freezing fog', 'fog'],
  51: ['Light drizzle', 'rain'], 53: ['Drizzle', 'rain'], 55: ['Heavy drizzle', 'rain'], 56: ['Freezing drizzle', 'rain'], 57: ['Freezing drizzle', 'rain'],
  61: ['Light rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy rain', 'rain'], 66: ['Freezing rain', 'rain'], 67: ['Freezing rain', 'rain'],
  71: ['Light snow', 'snow'], 73: ['Snow', 'snow'], 75: ['Heavy snow', 'snow'], 77: ['Snow grains', 'snow'],
  80: ['Light showers', 'rain'], 81: ['Showers', 'rain'], 82: ['Heavy showers', 'rain'], 85: ['Snow showers', 'snow'], 86: ['Heavy snow showers', 'snow'],
  95: ['Thunderstorm', 'storm'], 96: ['Thunderstorm with hail', 'storm'], 99: ['Thunderstorm with hail', 'storm'],
};

const AURORA = {
  green: { level: 0, text: 'Quiet. No aurora expected' },
  yellow: { level: 1, text: 'Minor activity. Possibly visible in Scotland' },
  amber: { level: 2, text: 'Possible aurora. May be visible from the UK' },
  red: { level: 3, text: 'Aurora likely to be visible from anywhere in the UK' },
};

const WET_MM = 0.1; // per 15 minutes: anything less is not "rain"

// ---------- pure helpers (tested directly) ----------

/** Rain in the next two hours from 15-minute precipitation totals. */
function rainSummary(times, mm, now = Date.now()) {
  const slots = times.map((t, i) => ({ t: t * 1000, mm: Number(mm[i]) || 0 })).filter((s) => s.t + 15 * 60_000 > now).slice(0, 8);
  if (!slots.length) return { known: false, text: 'No rain forecast available', slots: [] };
  const wet = (s) => s.mm >= WET_MM;
  const mins = (t) => Math.max(0, Math.round((t - now) / 60_000 / 5) * 5);
  const intensity = (s) => { const h = s.mm * 4; return h < 2.5 ? 'Light rain' : h < 7.6 ? 'Rain' : 'Heavy rain'; };
  const out = { known: true, slots: slots.map((s) => ({ t: s.t, mm: s.mm })), raining: wet(slots[0]), startsInMin: null, stopsInMin: null };
  if (out.raining) {
    const dry = slots.findIndex((s) => !wet(s));
    out.stopsInMin = dry < 0 ? null : mins(slots[dry].t);
    out.text = dry < 0 ? `${intensity(slots[0])} for the next 2 hours` : `${intensity(slots[0])}, easing in about ${out.stopsInMin} min`;
  } else {
    const w = slots.findIndex(wet);
    out.startsInMin = w < 0 ? null : mins(slots[w].t);
    out.text = w < 0 ? 'Dry for the next 2 hours' : out.startsInMin <= 5 ? `${intensity(slots[w])} starting now` : `${intensity(slots[w])} in about ${out.startsInMin} min`;
  }
  return out;
}

/**
 * The best two hours for a big appliance in the next day: plenty of solar (estimated from the radiation forecast and the
 * panel size) and a low-carbon grid. Only windows starting between 07:00 and 21:00 London time are suggested.
 */
function bestTime({ carbon, radiation, kwp, now = Date.now(), windowSlots = 4 }) {
  if (!carbon || !carbon.length) return { known: false, slots: [] };
  const radAt = (t) => {
    if (!radiation || !radiation.length) return 0;
    const i = radiation.findIndex((r) => r.t > t); // Open-Meteo radiation is the mean over the hour ending at r.t
    return i < 0 ? 0 : radiation[i].w;
  };
  const slots = carbon.filter((c) => c.to > now).slice(0, 48).map((c) => {
    const mid = (c.from + c.to) / 2;
    const solarKw = Math.round(Math.max(0, kwp * Math.min(1, radAt(mid) / 1000) * 0.85) * 10) / 10;
    return { from: c.from, to: c.to, carbon: c.intensity, index: c.index, solarKw };
  });
  if (!slots.length) return { known: false, slots: [] };
  const cs = slots.map((s) => s.carbon);
  const lo = Math.min(...cs); const hi = Math.max(...cs);
  for (const s of slots) {
    const solarScore = Math.min(1, s.solarKw / 2.5);              // a 2-3 kW appliance mostly covered by the panels
    const carbonScore = hi === lo ? 1 : (hi - s.carbon) / (hi - lo); // 1 = the cleanest grid in the period
    s.score = Math.round((0.65 * solarScore + 0.35 * carbonScore) * 100) / 100;
  }
  const hour = (t) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false }).format(new Date(t))) % 24;
  let best = null;
  for (let i = 0; i + windowSlots <= slots.length; i++) {
    const w = slots.slice(i, i + windowSlots);
    const h = hour(w[0].from);
    if (h < 7 || h >= 21) continue;
    const score = w.reduce((a, s) => a + s.score, 0) / w.length;
    if (!best || score > best.score + 1e-9) best = { from: w[0].from, to: w[w.length - 1].to, score, slots: w };
  }
  if (best) {
    const solar = best.slots.reduce((a, s) => a + s.solarKw, 0) / best.slots.length;
    const carbonAvg = Math.round(best.slots.reduce((a, s) => a + s.carbon, 0) / best.slots.length);
    const reasons = [];
    if (solar >= 1) reasons.push(`about ${solar.toFixed(1)} kW of sun`);
    reasons.push(`grid ${carbonAvg} g/kWh${carbonAvg <= lo * 1.05 ? ' (about the cleanest of the day)' : ''}`);
    best = { from: best.from, to: best.to, solarKw: Math.round(solar * 10) / 10, carbon: carbonAvg, reason: reasons.join(', ') };
  }
  return { known: true, slots, best, now: slots[0] };
}

function parseAurora(xml) {
  const m = /status_id="(green|yellow|amber|red)"/.exec(String(xml || ''));
  return m ? m[1] : null;
}

/** Is it dark enough to see anything (an hour after sunset to an hour before sunrise)? */
function isDark(now, sun) {
  if (!sun || !sun.length) return false;
  for (const d of sun) if (now > d.sunrise - 3600_000 && now < d.sunset + 3600_000) return false;
  return true;
}

function floodModel(items) {
  const LEVEL = { 1: 'Severe flood warning', 2: 'Flood warning', 3: 'Flood alert' };
  return (items || []).filter((w) => w.severityLevel >= 1 && w.severityLevel <= 3).map((w) => ({
    level: w.severityLevel,
    severity: LEVEL[w.severityLevel],
    area: w.description || w.eaAreaName || 'Nearby',
    river: (w.floodArea && w.floodArea.riverOrSea) || null,
    raised: w.timeRaised ? Date.parse(w.timeRaised) : null,
    message: String(w.message || '').trim().slice(0, 600),
  })).sort((a, b) => a.level - b.level);
}

// ---------- the service ----------

class Outdoors {
  constructor({ area, getKwp = () => 6.6, fetch: fetchFn = globalThis.fetch, now = () => Date.now(), demo = false }) {
    this.area = area;
    this.getKwp = getKwp;
    this.fetch = fetchFn;
    this.now = now;
    this.demo = demo;
    this.data = {};    // raw-ish data per source
    this.errors = {};  // source -> last error text
    this.updated = {}; // source -> time of the last good answer
    this.timers = [];
    this.onChange = () => {};
  }

  async getJson(url) {
    const r = await this.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async getText(url) {
    const r = await this.fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  }

  async load(name) {
    const { lat, lon, postcode, floodRadiusKm } = this.area;
    switch (name) {
      case 'weather': {
        const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timeformat=unixtime&timezone=Europe%2FLondon`
          + '&current=temperature_2m,weather_code,cloud_cover,precipitation,is_day&minutely_15=precipitation&forecast_minutely_15=12'
          + '&hourly=cloud_cover,shortwave_radiation&forecast_days=2&daily=sunrise,sunset&models=ukmo_seamless';
        const j = await this.getJson(u);
        return {
          temp: j.current.temperature_2m, code: j.current.weather_code, cloud: j.current.cloud_cover, isDay: !!j.current.is_day,
          rainTimes: j.minutely_15.time, rainMm: j.minutely_15.precipitation,
          radiation: j.hourly.time.map((t, i) => ({ t: t * 1000, w: Number(j.hourly.shortwave_radiation[i]) || 0, cloud: j.hourly.cloud_cover[i] })),
          sun: j.daily.time.map((t, i) => ({ sunrise: j.daily.sunrise[i] * 1000, sunset: j.daily.sunset[i] * 1000 })),
        };
      }
      case 'radar': {
        const j = await this.getJson('https://api.rainviewer.com/public/weather-maps.json');
        return { host: j.host, frames: [...(j.radar.past || []).slice(-8), ...(j.radar.nowcast || [])].map((f) => ({ t: f.time * 1000, path: f.path })) };
      }
      case 'carbon': {
        const from = new Date(this.now() - 30 * 60_000).toISOString().slice(0, 16) + 'Z';
        const j = await this.getJson(`https://api.carbonintensity.org.uk/regional/intensity/${from}/fw24h/postcode/${encodeURIComponent(postcode)}`);
        return { region: j.data.shortname, slots: j.data.data.map((d) => ({ from: Date.parse(d.from), to: Date.parse(d.to), intensity: d.intensity.forecast, index: d.intensity.index })) };
      }
      case 'aurora': {
        const status = parseAurora(await this.getText('https://aurorawatch-api.lancs.ac.uk/0.2/status/current-status.xml'));
        if (!status) throw new Error('unrecognised AuroraWatch reply');
        return { status };
      }
      case 'ukSolar': {
        const j = await this.getJson('https://api.pvlive.uk/pvlive/api/v4/pes/0?extra_fields=capacity_mwp');
        const [, t, mw, cap] = j.data[0];
        return { t: Date.parse(t), gw: mw / 1000, percent: cap ? Math.round((mw / cap) * 1000) / 10 : null };
      }
      case 'floods': {
        const j = await this.getJson(`https://environment.data.gov.uk/flood-monitoring/id/floods?lat=${lat}&long=${lon}&dist=${floodRadiusKm}`);
        return { warnings: floodModel(j.items) };
      }
      default: throw new Error(`unknown source ${name}`);
    }
  }

  async refresh(name) {
    try {
      this.data[name] = this.demo ? demoData(name, this.now()) : await this.load(name);
      this.updated[name] = this.now();
      delete this.errors[name];
    } catch (err) {
      this.errors[name] = err.message;
      console.warn(`[outdoors] ${name} unavailable: ${err.message}`);
    }
  }

  async refreshAll() {
    await Promise.all(Object.keys(SOURCES).map((n) => this.refresh(n)));
    this.onChange();
  }

  start(onChange) {
    this.onChange = onChange || (() => {});
    this.refreshAll();
    for (const [name, { everyMs }] of Object.entries(SOURCES)) {
      const t = setInterval(() => this.refresh(name).then(() => this.onChange()), everyMs);
      t.unref();
      this.timers.push(t);
    }
  }

  stop() { this.timers.forEach(clearInterval); this.timers = []; }

  /** What the owner's page receives. `pvKw` is the house's solar output right now. */
  view(pvKw = null) {
    const now = this.now();
    const w = this.data.weather;
    const [text, effect] = w ? (WMO[w.code] || ['', 'cloud']) : ['', null];
    const sun = w ? w.sun : [];
    const today = sun.find((d) => d.sunset > now - 12 * 3600_000) || null;
    const kwp = this.getKwp();
    const aurora = this.data.aurora ? this.data.aurora.status : null;
    const dark = isDark(now, sun);
    const cloudTonight = w ? (w.radiation.find((r) => r.t > now) || {}).cloud : null;
    return {
      area: `${this.area.name} (${this.area.postcode})`,
      weather: w ? { temp: w.temp, code: w.code, text, effect, cloud: w.cloud, isDay: w.isDay, sunrise: today && today.sunrise, sunset: today && today.sunset, nextSunrise: (sun.find((d) => d.sunrise > now) || {}).sunrise || null } : null,
      rain: w ? rainSummary(w.rainTimes, w.rainMm, now) : { known: false, text: '', slots: [] },
      radar: this.data.radar && !this.demo ? { host: this.data.radar.host, frames: this.data.radar.frames, lat: this.area.lat, lon: this.area.lon } : null,
      bestTime: bestTime({ carbon: this.data.carbon && this.data.carbon.slots, radiation: w && w.radiation, kwp, now }),
      carbonRegion: this.data.carbon ? this.data.carbon.region : null,
      aurora: aurora ? {
        status: aurora, ...AURORA[aurora], dark, cloud: cloudTonight,
        worthLooking: AURORA[aurora].level >= 2 && dark && (cloudTonight === null || cloudTonight === undefined || cloudTonight < 70),
      } : null,
      solarVsUk: this.data.ukSolar ? {
        ukPercent: this.data.ukSolar.percent, ukGw: Math.round(this.data.ukSolar.gw * 10) / 10,
        homePercent: pvKw === null || !kwp ? null : Math.round((Math.max(0, pvKw) / kwp) * 1000) / 10, kwp,
      } : null,
      floods: this.data.floods ? { radiusKm: this.area.floodRadiusKm, warnings: this.data.floods.warnings } : null,
      errors: { ...this.errors },
    };
  }
}

// ---------- demo mode: believable made-up data, no network ----------

function demoData(name, now) {
  const hourStart = Math.floor(now / 3600_000) * 3600_000;
  const day0 = new Date(now); day0.setHours(0, 0, 0, 0);
  const d = day0.getTime();
  switch (name) {
    case 'weather': {
      const q = Math.floor(now / 900_000) * 900;
      return {
        temp: 12.4, code: 3, cloud: 85, isDay: true,
        rainTimes: Array.from({ length: 12 }, (_, i) => q + i * 900), rainMm: [0, 0, 0.2, 0.4, 0.5, 0.3, 0.1, 0, 0, 0, 0, 0],
        radiation: Array.from({ length: 48 }, (_, i) => { const t = hourStart + i * 3600_000; const h = new Date(t).getHours(); return { t, w: h > 7 && h < 18 ? Math.round(600 * Math.sin(((h - 7) / 11) * Math.PI)) : 0, cloud: 60 }; }),
        sun: [0, 1].map((k) => ({ sunrise: d + k * 864e5 + 7.4 * 3600_000, sunset: d + k * 864e5 + 18.1 * 3600_000 })),
      };
    }
    case 'radar': return { host: '', frames: [] };
    case 'carbon': return { region: 'South England', slots: Array.from({ length: 48 }, (_, i) => { const from = Math.floor(now / 1800_000) * 1800_000 + i * 1800_000; const h = new Date(from).getHours(); const v = Math.round(140 - 60 * Math.sin(((h - 6) / 14) * Math.PI) + (h > 16 && h < 20 ? 60 : 0)); return { from, to: from + 1800_000, intensity: Math.max(40, v), index: v < 100 ? 'low' : v < 180 ? 'moderate' : 'high' }; }) };
    case 'aurora': return { status: 'green' };
    case 'ukSolar': return { t: now, gw: 4.2, percent: 18.5 };
    case 'floods': return { warnings: [] };
    default: return null;
  }
}

module.exports = { Outdoors, rainSummary, bestTime, parseAurora, isDark, floodModel, WMO, AURORA };
