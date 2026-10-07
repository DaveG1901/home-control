'use strict';

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dash = '—';
const fx = (n, dp = 2) => (n === null || n === undefined || Number.isNaN(n) ? dash : Number(n).toFixed(dp));
const kw = (n) => (n === null || n === undefined ? dash : `${Number(n).toFixed(2)} kW`);
const icon = (id) => `<svg><use href="#i-${id}"/></svg>`;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const setHTML = (el, html) => { if (el._h !== html) { el.innerHTML = html; el._h = html; } };

let model = null;
let wsOpen = false;
let history = [];

// Optimistic overlay: show the user's action immediately, until Home Assistant confirms (or 5s passes).
const optimistic = new Map();
// Boosts can take Hive up to ~10 s to confirm, so those are held longer, and dropped as soon as Home Assistant agrees.
const BOOST_KEY = /^(boost:|hotwater.boost)/;
const opt = (key, real) => {
  const o = optimistic.get(key);
  if (o && o.until > Date.now()) {
    if (BOOST_KEY.test(key) && (o.value > 0) === (real > 0)) { optimistic.delete(key); return real; }
    return o.value;
  }
  optimistic.delete(key);
  return real;
};
const holdOptimistic = (key, value) => optimistic.set(key, { value, until: Date.now() + (BOOST_KEY.test(key) ? 25_000 : 5_000) });

// ---------- toast ----------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- commands ----------
async function send(id, value) {
  const res = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, value }) });
  if (res.status === 401) { location.href = '/login'; return; }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
}

async function command(id, value, okMsg) {
  holdOptimistic(id, value);
  if (model) renderAll();
  try {
    await send(id, value);
    if (okMsg) toast(okMsg);
  } catch (err) {
    optimistic.delete(id);
    if (model) renderAll();
    toast(`Failed: ${err.message}`);
  }
}

let targetTimer;
function stepTarget(delta) {
  const h = model.heating;
  const current = opt('heating.target', h.main.target);
  if (current === null) return;
  const next = clamp(Math.round((current + delta) * 2) / 2, h.limits.min, h.limits.max);
  holdOptimistic('heating.target', next);
  renderAll();
  clearTimeout(targetTimer);
  targetTimer = setTimeout(async () => {
    try { await send('heating.target', next); toast(`Target set to ${next.toFixed(1)}°`); }
    catch (err) { optimistic.delete('heating.target'); renderAll(); toast(`Failed: ${err.message}`); }
  }, 700);
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-cmd],[data-act]');
  if (!t || t.disabled || !model) return;
  if (t.dataset.act === 'step') return stepTarget(Number(t.dataset.d));
  if (t.dataset.act === 'boostmenu') { openBoost = openBoost === t.dataset.z ? null : t.dataset.z; return renderAll(); }
  const id = t.dataset.cmd;
  let value;
  if (t.dataset.n !== undefined) value = Number(t.dataset.n);
  else if (t.dataset.toggle !== undefined) value = t.classList.contains('on') ? 'off' : 'on';
  else value = t.dataset.v;
  if (t.dataset.toggle !== undefined && value === 'off') {
    const name = t.dataset.name || 'This device';
    const watts = Number(t.dataset.watts) || 0;
    let question = null;
    if (t.dataset.warn === 'network') question = `${name} powers your network or cameras. Switching it off could cut your connection, and you may not be able to switch it back on from here. Switch it off?`;
    else if (t.dataset.warn === 'critical') question = `${name} is marked as important. Switch it off?`;
    else if (watts > 50) question = `${name} is using ${Math.round(watts)} W right now. Switch it off?`;
    if (question && !window.confirm(question)) return;
  }
  if (t.hasAttribute('data-close')) openBoost = null;
  let msg;
  if (id === 'hotwater.boost') msg = value === 0 ? 'Hot water boost cancelled' : `Hot water boost for ${durText(value)}`;
  else if (id.startsWith('boost:')) msg = value === 0 ? 'Boost cancelled' : `Boost started for ${durText(value)}`;
  command(id, value, msg);
});

document.querySelectorAll('#logout, #logout-m').forEach((b) => b.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
}));

// ---------- header ----------
function renderHeader(m) {
  const hr = new Date().getHours();
  $('#greeting').textContent = `Good ${hr < 12 ? 'morning' : hr < 18 ? 'afternoon' : 'evening'}, Dave`;
  $('#subtitle').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  const chips = [];
  if (m.connection.mode === 'demo') chips.push('<div class="chip demo">Demo mode · sample data</div>');
  if (m.environment.outsideTemp !== null) {
    chips.push(`<div class="chip">${fx(m.environment.outsideTemp, 1)}°C${m.environment.weather ? ` · ${esc(m.environment.weather)}` : ''}</div>`);
  }
  // Next bin day, on every page. Links to the full Bindicator card on the Overview.
  const bn = m.bins && m.bins.available ? m.bins.next : null;
  if (bn) {
    const urgent = m.bins.putOutTonight || bn.daysAway === 0;
    const text = m.bins.putOutTonight ? 'Bins out tonight' : bn.daysAway === 0 ? 'Bins today' : bn.daysAway === 1 ? 'Bins tomorrow' : `Bins ${bn.short}`;
    const dots = bn.bins.map((k) => `<i class="cdot" style="background:${esc(k.color)}" title="${esc(k.label)}"></i>`).join('');
    chips.push(`<a class="chip binchip${urgent ? ' urgent' : ''}" href="#/overview" title="Next bin collection: ${esc(`${bn.weekday} ${bn.dayMonth}`)}">${dots}<span>${esc(text)}</span></a>`);
  }
  if (m.connection.error) chips.push(`<div class="chip bad"><span class="dot red"></span>${esc(m.connection.error)}</div>`);
  else if (!wsOpen) chips.push('<div class="chip demo"><span class="dot amber"></span>Reconnecting…</div>');
  else if (!m.connection.ha) chips.push('<div class="chip bad"><span class="dot red"></span>Home Assistant offline</div>');
  else chips.push('<div class="chip"><span class="dot"></span>Live</div>');
  setHTML($('#chips'), chips.join(''));
}

// ---------- energy (structure built once so the flow animation never restarts) ----------
function buildEnergy() {
  $('#energy').innerHTML = `
    <div class="hd"><h2>Energy now</h2><span class="tag" id="ems"></span></div>
    <div class="stage">
      <div class="base"></div>
      <img class="house" alt="" src="/house.png">
      <svg class="flows" viewBox="0 0 560 320" aria-hidden="true">
        <defs><radialGradient id="sun" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#7dd3fc" stop-opacity=".5"/><stop offset=".45" stop-color="#3b82f6" stop-opacity=".16"/><stop offset="1" stop-color="#3b82f6" stop-opacity="0"/></radialGradient></defs>
        <circle cx="70" cy="42" r="130" fill="url(#sun)"/>
        <g style="filter:drop-shadow(0 0 4px rgba(34,211,238,.9))"><path id="fl-solar" class="flow" d="M126 58 C148 62 162 72 186 86" fill="none" stroke="#22d3ee" stroke-width="2.4"/></g>
        <g style="filter:drop-shadow(0 0 4px rgba(96,165,250,.9))"><path id="fl-batt" class="flow off" d="M196 200 L106 200" fill="none" stroke="#60a5fa" stroke-width="2.4"/></g>
        <g style="filter:drop-shadow(0 0 4px rgba(129,140,248,.9))"><path id="fl-grid" class="flow off" d="M466 186 L404 186" fill="none" stroke="#818cf8" stroke-width="2.4"/></g>
      </svg>
      <div class="node" style="left:14%;top:15%"><small><i style="background:#22d3ee"></i>Solar</small><b id="n-solar">${dash}</b></div>
      <div class="node" style="left:10%;top:62%"><small><i style="background:#60a5fa"></i><span id="n-batt-l">Battery</span></small><b id="n-batt">${dash}</b></div>
      <div class="node" style="left:91%;top:58%"><small><i style="background:#818cf8"></i><span id="n-grid-l">Grid</span></small><b id="n-grid">${dash}</b></div>
      <div class="node" style="left:50%;top:94%;min-width:150px;text-align:center"><small style="justify-content:center"><i style="background:#818cf8"></i>Home using</small><b id="n-home">${dash}</b></div>
    </div>`;
}

function setFlow(id, active, reverse) {
  const el = $(id);
  el.classList.toggle('off', !active);
  el.style.animationDirection = reverse ? 'reverse' : 'normal';
}

function updateEnergy(e) {
  $('#ems').textContent = e.mode || 'Energy';
  $('#n-solar').textContent = kw(e.pv);
  $('#n-home').textContent = kw(e.load);

  const b = e.battery;
  $('#n-batt-l').textContent = `Battery${b.dir === 'idle' ? ' · idle' : ` · ${b.dir}`}`;
  const sign = b.dir === 'charging' ? '+' : b.dir === 'discharging' ? '−' : '';
  $('#n-batt').innerHTML = `${b.soc === null ? dash : `${fx(b.soc, 0)}%`}${b.power > 0.01 ? ` <span style="font-size:13px;color:var(--mute);font-weight:500">${sign}${fx(b.power)} kW</span>` : ''}`;

  const g = e.grid;
  $('#n-grid-l').textContent = `Grid · ${g.dir === 'import' ? 'importing' : g.dir === 'export' ? 'exporting' : 'idle'}`;
  $('#n-grid').textContent = kw(g.power);

  setFlow('#fl-solar', e.pv > 0.02, false);
  setFlow('#fl-batt', b.dir !== 'idle', b.dir === 'discharging');
  setFlow('#fl-grid', g.dir !== 'idle', g.dir === 'export');
}

// ---------- cards ----------
function renderToday(m) {
  const t = m.today;
  const batt = m.energy.battery.soc;
  setHTML($('#today'), `
    <div class="hd"><h2>Today</h2><span class="tag">${m.connection.ha ? 'Live' : 'Stale'}</span></div>
    <div class="kpis">
      <div class="kpi"><span>Generated</span><b>${fx(t.generated)}<em>kWh</em></b></div>
      <div class="kpi"><span>Home used</span><b>${fx(t.used)}<em>kWh</em></b></div>
      <div class="kpi"><span>Grid import</span><b>${fx(t.import)}<em>kWh</em></b></div>
      <div class="kpi"><span>Grid export</span><b>${fx(t.export)}<em>kWh</em></b></div>
    </div>
    <div class="soc">
      <div class="row"><span>Battery</span><b>${batt === null ? dash : `${fx(batt, 1)}%`}${t.capacity ? ` · ${fx(t.capacity)} kWh capacity` : ''}</b></div>
      <div class="bar"><div style="width:${clamp(batt || 0, 0, 100)}%"></div></div>
      <div class="row" style="margin-top:14px"><span>Self-sufficiency today</span><b>${t.selfSufficiency === null ? dash : `${t.selfSufficiency}%`}</b></div>
      <div class="bar"><div style="width:${clamp(t.selfSufficiency || 0, 0, 100)}%;background:linear-gradient(90deg,#4f46e5,#818cf8)"></div></div>
      <div class="row" style="margin-top:14px"><span>Grid carbon intensity</span><b>${t.co2 === null ? dash : `${t.co2} g/kWh`}</b></div>
      <div class="row" style="margin-top:14px"><span>Yesterday's generation</span><b>${t.yesterday === null ? dash : `${fx(t.yesterday)} kWh`}</b></div>
      <div class="row" style="margin-top:14px"><span>Lifetime generation</span><b>${t.lifetimeMwh === null ? dash : `${fx(t.lifetimeMwh)} MWh`}</b></div>
    </div>`);
}

function renderSurplus(m) {
  const s = m.surplus;
  const heading = {
    good: ['Spare solar available', 'Solar is producing more than the house needs right now.'],
    low: ['Little spare right now', 'Solar is mostly covering the house, with little left over.'],
    night: ['No solar right now', 'Check back when the sun is up.'],
    unknown: ['Waiting for data', 'Solar readings are not available yet.'],
  }[s.state] || ['', ''];
  const sp = s.split;
  const total = sp ? sp.home + sp.battery + sp.grid : 0;
  const pct = (v) => (total > 0 ? (v / total) * 100 : 0);
  const bar = sp && total > 0.01
    ? `<div class="splitbar"><i style="width:${pct(sp.home)}%;background:#818cf8"></i><i style="width:${pct(sp.battery)}%;background:#60a5fa"></i><i style="width:${pct(sp.grid)}%;background:#22d3ee"></i></div>`
    : '<div class="splitbar"></div>';
  const legend = sp
    ? `<div class="sp-legend"><span style="--c:#818cf8">Home <b>${fx(sp.home)} kW</b></span><span style="--c:#60a5fa">Battery <b>${fx(sp.battery)} kW</b></span><span style="--c:#22d3ee">Exported <b>${fx(sp.grid)} kW</b></span></div>`
    : '';
  const fitText = (d) => ({
    running: 'Running now',
    good: 'Enough sun to run on solar',
    marginal: `About ${d.solarShare}% on solar`,
    no: s.state === 'night' ? 'No solar' : 'Not enough surplus',
    unavailable: 'Unavailable',
  }[d.fit]);
  const devs = s.devices.map((d) => {
    const on = opt(`plug:${d.id}`, d.state) === 'on';
    const sw = d.fit === 'unavailable'
      ? '<button class="sw lock" disabled title="Unavailable"></button>'
      : `<button class="sw${on ? ' on' : ''}" data-cmd="plug:${esc(d.id)}" data-toggle data-name="${esc(d.name)}" data-watts="${d.watts ?? 0}" aria-label="${esc(d.name)}"></button>`;
    return `<div class="spd ${esc(d.fit)}"><div class="top"><b>${esc(d.name)}</b>${sw}</div>
      <small>Typically ${fx(d.kw, 1)} kW</small><span class="fit ${esc(d.fit)}">${esc(fitText(d))}</span></div>`;
  }).join('');

  setHTML($('#surplus'), `
    <div class="hd"><h2>Solar surplus</h2><span class="tag${s.state === 'good' ? '' : ' warn'}">${esc(heading[0])}</span></div>
    <div class="surplus">
      <div>
        <div class="sp-big">${s.spare === null ? dash : fx(s.spare)}<em>kW spare</em></div>
        <div class="sub" style="margin-top:6px">${esc(heading[1])}</div>
        ${bar}${legend}
        <div class="sub" style="margin-top:10px;font-size:12px">The bar shows where your solar is going right now. The spare figure is a 30 second average, so it doesn't jump with every cloud.</div>
      </div>
      <div>
        <div class="sp-devs">${devs}</div>
        <div class="sub" style="margin-top:12px;font-size:12px">Switching a plug only powers the socket: start the appliance yourself, and only run dryers and heaters while you are home.</div>
      </div>
    </div>`);
}

// ---------- heating (with boost on the main thermostat, every zone and hot water) ----------
let openBoost = null; // id of the zone whose boost menu is open
const durText = (m) => (m % 60 === 0 ? `${m / 60}h` : `${m}m`);

// ---------- bindicator ----------
function renderBins(m) {
  const b = m.bins;
  const head = (tag, warn) => `<div class="hd"><h2>Bindicator</h2>${tag ? `<span class="tag${warn ? ' warn' : ''}">${esc(tag)}</span>` : ''}</div>`;

  if (!b || !b.available) {
    setHTML($('#bins'), `${head('Not available', true)}<div class="empty">The bin collection dates could not be read from Home Assistant yet.</div>`);
    return;
  }
  const n = b.next;
  if (!n) {
    setHTML($('#bins'), `${head('', false)}<div class="empty">No bin collections found in the next few weeks.</div>`);
    return;
  }

  const bin = (k) => `<div class="bin"><svg class="binpic" style="color:${esc(k.color)}" role="img" aria-label="${esc(k.label)}"><use href="#${k.caddy ? 'i-caddy' : 'i-bin'}"/></svg><span>${esc(k.label)}</span></div>`;
  const pics = n.bins.length ? n.bins.map(bin).join('') : `<div class="empty">${esc(n.summary)}</div>`;
  const extras = n.extras.length ? `<div class="bin-extras">${n.extras.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : '';
  const banner = b.putOutTonight ? '<div class="bin-banner">Put the bins out tonight</div>'
    : n.daysAway === 0 ? '<div class="bin-banner">Collection day: bins out by the kerb</div>' : '';
  const then = b.then.slice(0, 2).map((d) => `<div class="bin-then"><span>${esc(d.short)}</span><span class="dots">${d.bins.map((k) => `<i style="background:${esc(k.color)}" title="${esc(k.label)}"></i>`).join('')}</span></div>`).join('');

  setHTML($('#bins'), `
    ${head(n.when, n.daysAway <= 1)}
    <div class="bin-date"><b>${esc(n.weekday)}</b><span>${esc(n.dayMonth)}</span></div>
    ${banner}
    <div class="bin-row">${pics}</div>
    ${extras}
    ${then ? `<div class="bin-after"><small>After that</small>${then}</div>` : ''}
    ${b.stale ? '<div class="sub" style="margin-top:10px;font-size:11.5px">Showing the last dates read: the council calendar could not be refreshed.</div>' : ''}`);
}

function renderHeating(m) {
  const h = m.heating;
  const main = h.main;
  const off = main.mode === 'unavailable';
  const target = opt('heating.target', main.target);
  const mode = opt('heating.mode', main.mode);
  const minutes = h.boost.minutes;
  const modeBtn = (label, v) => `<button data-cmd="heating.mode" data-v="${esc(v)}" class="${mode === v ? 'on' : ''}"${off ? ' disabled' : ''}>${label}</button>`;
  const bar = (c) => clamp(((c - 10) / 15) * 100, 4, 100);
  const isBoosting = (id, real) => opt(`boost:${id}`, real ? 1 : 0) > 0;

  // main thermostat: boost buttons are always visible
  const mainBoost = isBoosting('main', main.boost);
  const mainRow = `<div class="boostrow${mainBoost ? ' on' : ''}">
      <span>${mainBoost ? `Boost on: heating to ${h.boost.temperature}°` : `Boost heating to ${h.boost.temperature}°`}</span>
      <div class="bbtns">${mainBoost
    ? '<button class="btn on" data-cmd="boost:main" data-n="0">Cancel boost</button>'
    : minutes.map((v) => `<button class="btn" data-cmd="boost:main" data-n="${v}"${off ? ' disabled' : ''}>${durText(v)}</button>`).join('')}</div>
    </div>`;

  // zones: tap Boost on a tile to pick a duration
  const zoneTile = (z) => {
    const boosting = isBoosting(z.id, z.boost);
    let control;
    if (boosting) control = `<button class="zb on" data-cmd="boost:${esc(z.id)}" data-n="0">Cancel boost</button>`;
    else if (openBoost === z.id) {
      control = `<div class="bmenu">${minutes.map((v) => `<button data-cmd="boost:${esc(z.id)}" data-n="${v}" data-close>${durText(v)}</button>`).join('')}<button class="x" data-act="boostmenu" data-z="${esc(z.id)}" aria-label="Close">✕</button></div>`;
    } else control = `<button class="zb" data-act="boostmenu" data-z="${esc(z.id)}"${z.mode === 'unavailable' ? ' disabled' : ''}>Boost</button>`;
    return `<div class="zone${boosting ? ' boosting' : ''}"><small>${esc(z.name)}${boosting ? ' · boost' : ''}</small><b>${z.current === null ? dash : `${fx(z.current, 1)}°`}</b><div class="bar"><div style="width:${z.current === null ? 0 : bar(z.current)}%"></div></div>${control}</div>`;
  };

  const hw = h.hotWater;
  const hwBoost = opt('hotwater.boost', hw.boosting ? 1 : 0) > 0;
  const hwText = hwBoost ? 'Boost active' : hw.heatingNow ? 'Heating now' : 'Not heating';
  const hwBtns = hwBoost
    ? '<button class="btn on" data-cmd="hotwater.boost" data-n="0">Cancel boost</button>'
    : minutes.map((v) => `<button class="btn" data-cmd="hotwater.boost" data-n="${v}">${v === minutes[0] ? 'Boost ' : ''}${durText(v)}</button>`).join('');

  setHTML($('#heating'), `
    <div class="hd"><h2>Heating &amp; hot water</h2><span class="tag">Hive</span></div>
    <div class="big">
      <div><div class="t">${fx(main.current, 1)}<sup>°C</sup></div><div class="sub" style="margin-top:6px">${esc(main.name)}</div></div>
      <div class="stepper"><button data-act="step" data-d="-0.5" aria-label="Lower target"${off ? ' disabled' : ''}>−</button><div><b>${target === null ? dash : `${fx(target, 1)}°`}</b><small>target</small></div><button data-act="step" data-d="0.5" aria-label="Raise target"${off ? ' disabled' : ''}>+</button></div>
    </div>
    <div class="seg">${modeBtn('Off', h.modes.off)}${modeBtn('Schedule', h.modes.schedule)}${modeBtn('Heat', h.modes.heat)}</div>
    ${mainRow}
    <div class="zones">${h.zones.map(zoneTile).join('')}</div>
    <div class="hw">
      <div class="l"><div class="ico">${icon('drop')}</div><div><b>Hot water</b><div class="sub" style="font-size:12px">${hwText}${hw.mode ? ` · ${esc(hw.mode)}` : ''}</div></div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${hwBtns}</div>
    </div>`);
}

// ---------- all plugs and lights (each switched on its own; there is deliberately no "all" button) ----------
// Which room each list is showing ('' = all rooms). Remembered on this device, separately for plugs and lights.
const rooms = { plug: '', light: '' };
for (const kind of Object.keys(rooms)) {
  try { rooms[kind] = localStorage.getItem(`${kind}Room`) || ''; } catch { /* storage unavailable: fine */ }
}

function buildDevices() {
  const card = (id, title, kind) => {
    $(id).innerHTML = `
      <div class="hd"><h2>${title}</h2><span class="tag" id="${kind}-count"></span></div>
      <select class="filter" id="${kind}-room" aria-label="Show ${kind}s in room"><option value="">All rooms</option></select>
      <div class="dgroups" id="${kind}-rows"></div>`;
    $(`#${kind}-room`).addEventListener('change', (e) => {
      rooms[kind] = e.target.value;
      try { localStorage.setItem(`${kind}Room`, rooms[kind]); } catch { /* ignore */ }
      if (model) renderDeviceList(kind, kind === 'plug' ? model.catalogue.plugs : model.catalogue.lights);
    });
  };
  card('#plugs', 'Plugs', 'plug');
  card('#lights', 'Lights', 'light');
}

// Plugs marked important ask for confirmation before they are switched off (see the click handler).
const WARN_NOTE = { critical: 'Important', network: 'Powers network or cameras' };

function deviceRow(item, kind) {
  const unavailable = item.state === 'unavailable';
  const on = opt(`${kind}:${item.id}`, item.state) === 'on';
  const hasWatts = item.watts !== null && item.watts !== undefined;
  const status = on ? `On${hasWatts ? ` · ${fx(item.watts, 1)} W` : ''}` : 'Off';
  const sub = unavailable ? 'Unavailable' : `${item.warn ? `${WARN_NOTE[item.warn] || 'Important'} · ` : ''}${status}`;
  const sw = unavailable
    ? '<button class="sw lock" disabled title="Unavailable"></button>'
    : `<button class="sw${on ? ' on' : ''}" data-cmd="${kind}:${esc(item.id)}" data-toggle data-name="${esc(item.name)}" data-watts="${item.watts ?? 0}"${item.warn ? ` data-warn="${esc(item.warn)}"` : ''} aria-label="${esc(item.name)}"></button>`;
  return `<div class="drow${unavailable ? ' off' : ''}"><div class="ico">${icon(kind === 'light' ? 'bulb' : 'plug')}</div><div class="dn"><b>${esc(item.name)}</b><small>${esc(sub)}</small></div>${sw}</div>`;
}

function groupsHtml(groups, kind, room) {
  return groups.filter((g) => !room || g.name === room).map((g) => {
    const items = g.items;
    if (!items.length) return '';
    const onCount = items.filter((i) => i.state === 'on').length;
    return `<div class="dgroup"><div class="dgh"><span>${esc(g.name)}</span><small>${onCount} of ${items.length} on</small></div>${items.map((i) => deviceRow(i, kind)).join('')}</div>`;
  }).join('');
}

function countText(groups) {
  const all = groups.flatMap((g) => g.items).filter((i) => i.state !== 'unavailable');
  return `${all.filter((i) => i.state === 'on').length} of ${all.length} on`;
}

// One renderer for both lists: the room dropdown, the grouped rows and the "N of M on" count.
function renderDeviceList(kind, groups) {
  // keep the dropdown in step with the rooms Home Control knows about (only rebuilt when they change)
  const sel = $(`#${kind}-room`);
  const optionsHtml = `<option value="">All rooms (${groups.reduce((n, g) => n + g.items.length, 0)})</option>${groups.map((g) => `<option value="${esc(g.name)}">${esc(g.name)} (${g.items.length})</option>`).join('')}`;
  if (sel._h !== optionsHtml) { sel.innerHTML = optionsHtml; sel._h = optionsHtml; }
  if (rooms[kind] && !groups.some((g) => g.name === rooms[kind])) rooms[kind] = ''; // a remembered room that no longer exists
  sel.value = rooms[kind];
  const shown = groups.filter((g) => !rooms[kind] || g.name === rooms[kind]);
  setHTML($(`#${kind}-rows`), groupsHtml(groups, kind, rooms[kind]) || `<div class="empty">No ${kind}s in this room.</div>`);
  $(`#${kind}-count`).textContent = countText(shown);
}

const renderPlugs = (m) => renderDeviceList('plug', m.catalogue.plugs);
const renderLights = (m) => renderDeviceList('light', m.catalogue.lights);

// ---------- security + live cameras ----------
// The camera tiles are built once and then only updated in place, so a redraw never tears down a playing video.
let currentView = 'overview';
const camTiles = new Map(); // camera id -> { el, view, video, msg, label, status, sw, stream, manual, alert }

const STREAM_TEXT = {
  idle: 'Tap to watch live',
  connecting: 'Connecting… this can take 15 seconds',
  live: '',
  error: 'Stream unavailable, retrying…',
  demo: 'Demo mode: no live video',
};

class CamStream {
  constructor(id, video, onState) {
    this.id = id;
    this.video = video;
    this.onState = onState;
    this.active = false;
    this.state = 'idle';
    this.hls = null;
    this.retryTimer = null;
    this.watchdog = null;
    this.delay = 4000;
    video.addEventListener('playing', () => { this.delay = 4000; clearTimeout(this.watchdog); this.set('live'); });
    video.addEventListener('waiting', () => { if (this.active && this.state === 'live') this.set('connecting'); });
  }

  set(state) { this.state = state; this.onState(state); }

  start() {
    if (this.active) return;
    this.active = true;
    this.set('connecting');
    this.connect();
  }

  stop() {
    if (!this.active && this.state === 'idle') return;
    this.active = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.watchdog);
    this.teardown();
    this.set('idle');
  }

  retryNow() { if (this.active) { this.teardown(); this.set('connecting'); this.connect(); } }

  teardown() {
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  }

  async connect() {
    try {
      const res = await fetch(`/api/camera/${encodeURIComponent(this.id)}/stream`);
      if (res.status === 401) { location.href = '/login'; return; }
      const body = await res.json().catch(() => ({}));
      if (!this.active) return;
      if (body.demo) { this.set('demo'); return; }
      if (!res.ok || !body.url) throw new Error(body.error || `HTTP ${res.status}`);
      this.play(body.url);
    } catch (err) {
      this.fail(err.message);
    }
  }

  play(url) {
    const v = this.video;
    this.teardown();
    // The first connection makes Home Assistant start the stream, which can take ~15s. Give up and retry after 50s.
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.fail('timed out'), 50_000);
    // Prefer hls.js: recent Chrome/Edge claim native HLS support but cannot parse Home Assistant's low-latency streams.
    // Native playback is only the fallback (older iPhones without Media Source support).
    if (window.Hls && window.Hls.isSupported()) {
      this.hls = new window.Hls({ lowLatencyMode: true, manifestLoadingTimeOut: 30_000, levelLoadingTimeOut: 30_000, fragLoadingTimeOut: 30_000 });
      this.hls.on(window.Hls.Events.ERROR, (_e, data) => { if (data.fatal) this.fail(data.details); });
      this.hls.loadSource(url);
      this.hls.attachMedia(v);
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = url;
    } else {
      this.fail('This browser cannot play live video');
      return;
    }
    v.play().catch(() => {});
  }

  fail() {
    if (!this.active) return;
    clearTimeout(this.watchdog);
    this.teardown();
    this.set('error');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (this.active) { this.set('connecting'); this.connect(); } }, this.delay);
    this.delay = Math.min(this.delay * 2, 30_000);
  }
}

function buildSecurity() {
  $('#security').innerHTML = `
    <div class="hd"><h2>Security</h2><span id="sec-tag"></span></div>
    <div class="bells" id="sec-bells"></div>
    <div class="cams" id="cams"></div>
    <div class="sub" style="margin-top:12px;font-size:12px">Toggles are floodlights. Live video plays straight from your Home Assistant to this screen and only runs while you are looking at it. Tap a live picture for full screen.</div>`;
  $('#cams').addEventListener('click', (e) => {
    const view = e.target.closest('.view');
    if (!view) return;
    const t = camTiles.get(view.closest('.cam').dataset.cam);
    if (!t) return;
    if (t.stream.state === 'live') {
      const v = t.video;
      if (document.fullscreenElement) document.exitFullscreen();
      else if (v.requestFullscreen) v.requestFullscreen().catch(() => {});
      else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
    } else if (t.stream.state === 'error') {
      t.stream.retryNow();
    } else if (!t.stream.active) {
      t.manual = true;
      syncStreams();
    }
  });
  $('#cams').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('view')) { e.preventDefault(); e.target.click(); } });
}

function ensureCamTiles(cameras) {
  const host = $('#cams');
  let created = false;
  for (const c of cameras) {
    if (camTiles.has(c.id)) continue;
    created = true;
    const el = document.createElement('div');
    el.className = 'cam';
    el.dataset.cam = c.id;
    el.innerHTML = `
      <div class="view" role="button" tabindex="0" aria-label="Watch ${esc(c.name)} live">
        <video muted playsinline autoplay></video>
        <span class="live"></span>
        ${icon('cam')}
        <div class="vmsg"></div>
      </div>
      <div class="m"><div><b>${esc(c.name)}</b><small class="cstat"></small></div><span class="swslot"></span></div>`;
    host.appendChild(el);
    const t = { el, video: el.querySelector('video'), msg: el.querySelector('.vmsg'), label: el.querySelector('.live'), status: el.querySelector('.cstat'), sw: el.querySelector('.swslot'), manual: false, alert: false };
    t.stream = new CamStream(c.id, t.video, (state) => { updateCamTile(t); });
    camTiles.set(c.id, t);
    updateCamTile(t);
  }
  if (created) syncStreams();
}

function updateCamTile(t) {
  const st = t.stream.state;
  t.el.classList.toggle('playing', st === 'live');
  t.msg.textContent = STREAM_TEXT[st] || '';
  t.label.textContent = t.alert ? 'ALERT' : st === 'live' ? 'LIVE' : '';
  t.label.style.display = t.label.textContent ? '' : 'none';
}

// Streams run only while someone is actually looking: the Security tab (all four), or a tile tapped on the overview.
function syncStreams() {
  const visible = document.visibilityState === 'visible';
  const securityShown = !$('#security').hidden;
  for (const t of camTiles.values()) {
    const want = visible && securityShown && (currentView === 'security' || t.manual);
    if (want) t.stream.start(); else t.stream.stop();
  }
}
document.addEventListener('visibilitychange', syncStreams);
window.addEventListener('pagehide', () => { for (const t of camTiles.values()) t.stream.stop(); });

function renderSecurity(m) {
  const s = m.security;
  ensureCamTiles(s.cameras);
  const bellDetect = (d) => (d.motion && d.person ? 'Motion & person detection on' : d.motion ? 'Motion detection on' : d.person ? 'Person detection on' : 'Detection off');
  const status = (c) => (c.status === 'clear' ? 'Clear' : `${c.status[0].toUpperCase()}${c.status.slice(1)} detected`);

  setHTML($('#sec-tag'), s.doorbellPressAvailable ? '' : '<span class="tag warn">Doorbell press alerts: not available yet</span>');
  setHTML($('#sec-bells'), s.doorbells.map((d) => `
      <div class="bell"><div class="ico">${icon('bell')}</div><div><b>${esc(d.name)}</b><small>${bellDetect(d)}</small></div><div class="batt">${d.battery === null ? dash : `${d.battery}%`}<br><small style="color:var(--mute)">battery</small></div></div>`).join(''));

  for (const c of s.cameras) {
    const t = camTiles.get(c.id);
    t.alert = c.status !== 'clear';
    t.el.classList.toggle('alert', t.alert);
    t.status.textContent = status(c);
    const on = opt(`floodlight:${c.id}`, c.floodlight ? 'on' : 'off') === 'on';
    setHTML(t.sw, c.floodlightAvailable
      ? `<button class="sw${on ? ' on' : ''}" data-cmd="floodlight:${esc(c.id)}" data-toggle title="Floodlight" aria-label="${esc(c.name)} floodlight"></button>`
      : '<button class="sw lock" disabled title="Floodlight unavailable"></button>');
    updateCamTile(t);
  }
}

function renderControls(m) {
  setHTML($('#controls'), `
    <div class="hd"><h2>Quick controls</h2><a class="tag" href="#/devices">All plugs &amp; lights →</a></div>
    <div class="dev">${m.devices.map((d) => {
      const unavailable = d.state === 'unavailable';
      const on = opt(`plug:${d.id}`, d.state) === 'on';
      const sub = unavailable ? 'unavailable' : `${d.watts === null ? dash : `${fx(d.watts, 1)} W`}${d.warn ? ` · ${(WARN_NOTE[d.warn] || 'important').toLowerCase()}` : ''}`;
      const sw = unavailable
        ? '<button class="sw lock" disabled title="Unavailable"></button>'
        : `<button class="sw${on ? ' on' : ''}" data-cmd="plug:${esc(d.id)}" data-toggle data-name="${esc(d.name)}" data-watts="${d.watts ?? 0}"${d.warn ? ` data-warn="${esc(d.warn)}"` : ''} aria-label="${esc(d.name)}"></button>`;
      return `<div class="d"><div class="ico">${icon('plug')}</div><div><b>${esc(d.name)}</b><small>${sub}</small></div>${sw}</div>`;
    }).join('')}</div>`);
}

function renderActivity(m) {
  const time = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  setHTML($('#activity'), `
    <div class="hd"><h2>Activity</h2><span class="tag">Recent</span></div>
    ${m.activity.length ? `<ul class="feed">${m.activity.map((a) => `<li><time>${time(a.t)}</time><span>${esc(a.text)}</span><span class="tag" style="flex:none">${esc(a.tag)}</span></li>`).join('')}</ul>` : '<div class="empty">Nothing yet. Camera detections and your own actions appear here.</div>'}`);
}

function renderConsumers(m) {
  const max = Math.max(1, ...m.consumers.map((c) => c.watts));
  setHTML($('#consumers'), `
    <div class="hd"><h2>Biggest consumers now</h2><span class="tag">Live</span></div>
    ${m.consumers.length ? `<ul class="cons">${m.consumers.map((c) => `<li><div class="row"><span>${esc(c.name)}</span><b>${fx(c.watts, 1)} W</b></div><div class="bar"><div style="width:${(c.watts / max) * 100}%"></div></div></li>`).join('')}</ul>` : '<div class="empty">Nothing measurable is drawing power.</div>'}`);
}

// ---------- chart ----------
function buildPower() {
  $('#power').innerHTML = `
    <div class="hd"><h2>Power today</h2>
      <div class="legend"><span><i style="background:#22d3ee"></i>Solar</span><span><i style="background:#818cf8"></i>Home</span><span><i style="background:#60a5fa"></i>Battery</span></div></div>
    <div class="chartwrap"><svg id="chart"></svg></div>`;
}

function midnight() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

async function loadHistory() {
  try {
    const res = await fetch(`/api/history?from=${midnight()}`);
    if (res.status === 401) { location.href = '/login'; return; }
    history = (await res.json()).points || [];
    drawChart();
  } catch { /* keep the old chart */ }
}

function drawChart() {
  const svg = $('#chart');
  if (!svg) return;
  const W = Math.max(300, svg.clientWidth || svg.parentElement.clientWidth), H = 240;
  const pad = { l: 34, r: 8, t: 10, b: 24 };
  const t0 = midnight(), t1 = t0 + 24 * 3600_000;
  const pts = history.filter((p) => p.t >= t0);
  const maxV = Math.max(2, ...pts.map((p) => Math.max(p.pv, p.load)));
  const top = Math.ceil(maxV * 1.1);
  const x = (t) => pad.l + ((W - pad.l - pad.r) * (t - t0)) / (t1 - t0);
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  let h = '';
  const stepV = top > 6 ? 2 : 1;
  for (let v = 0; v <= top; v += stepV) h += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="#7ca6ff" stroke-opacity=".12"/><text x="${pad.l - 8}" y="${y(v) + 4}" fill="#5f739f" font-size="11" text-anchor="end">${v}</text>`;
  [0, 6, 12, 18, 24].forEach((hr) => { h += `<text x="${x(t0 + hr * 3600_000)}" y="${H - 6}" fill="#5f739f" font-size="11" text-anchor="${hr === 0 ? 'start' : hr === 24 ? 'end' : 'middle'}">${String(hr % 24).padStart(2, '0')}:00</text>`; });
  if (pts.length > 1) {
    const line = (get) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(get(p)).toFixed(1)}`).join('');
    const last = pts[pts.length - 1];
    h += `<defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22d3ee" stop-opacity=".4"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/></linearGradient></defs>`;
    h += `<path d="${line((p) => p.pv)}L${x(last.t)},${y(0)}L${x(pts[0].t)},${y(0)}Z" fill="url(#ga)"/>`;
    h += `<path d="${line((p) => p.pv)}" fill="none" stroke="#22d3ee" stroke-width="2.2"/>`;
    h += `<path d="${line((p) => p.load)}" fill="none" stroke="#818cf8" stroke-width="2.2"/>`;
    h += `<path d="${line((p) => Math.abs(p.batt))}" fill="none" stroke="#60a5fa" stroke-width="1.8" stroke-dasharray="4 4"/>`;
    h += `<line x1="${x(last.t)}" x2="${x(last.t)}" y1="${pad.t}" y2="${H - pad.b}" stroke="#bfdbfe" stroke-opacity=".45" stroke-dasharray="3 4"/><circle cx="${x(last.t)}" cy="${y(last.pv)}" r="4.5" fill="#22d3ee"/><circle cx="${x(last.t)}" cy="${y(last.load)}" r="4.5" fill="#818cf8"/>`;
  } else {
    h += `<text x="${W / 2}" y="${H / 2}" fill="#5f739f" font-size="13" text-anchor="middle">Collecting data…</text>`;
  }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  svg.innerHTML = h;
}

// ---------- render ----------
function renderAll() {
  const m = model;
  renderHeader(m);
  updateEnergy(m.energy);
  renderToday(m);
  renderSurplus(m);
  renderBins(m);
  renderHeating(m);
  renderSecurity(m);
  renderControls(m);
  renderPlugs(m);
  renderLights(m);
  renderActivity(m);
  renderConsumers(m);
}

// ---------- live connection ----------
let retry = 1000;
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/live`);
  ws.onopen = () => { wsOpen = true; retry = 1000; if (model) renderHeader(model); };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'state') { model = msg.data; renderAll(); }
  };
  ws.onclose = async () => {
    wsOpen = false;
    if (model) renderHeader(model);
    // If the session expired the socket upgrade is refused: send the user to sign in.
    try { const r = await fetch('/api/state'); if (r.status === 401) { location.href = '/login'; return; } } catch { /* offline */ }
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 15_000);
  };
}


// ---------- views (side navigation) ----------
const VIEWS = {
  overview: ['energy', 'today', 'surplus', 'bins', 'heating', 'security', 'power', 'controls', 'activity', 'consumers'],
  energy: ['energy', 'today', 'surplus', 'power', 'consumers'],
  heating: ['heating', 'activity'],
  security: ['security', 'activity'],
  devices: ['plugs', 'lights', 'surplus', 'consumers'],
  reports: ['power', 'today'],
};
const VIEW_TITLES = { overview: 'Overview', energy: 'Energy', heating: 'Heating', security: 'Security', devices: 'Devices', reports: 'Reports' };

function setView(name) {
  if (!Object.prototype.hasOwnProperty.call(VIEWS, name)) name = 'overview';
  const show = VIEWS[name];
  document.querySelector('.grid').dataset.view = name;
  currentView = name;
  for (const t of camTiles.values()) t.manual = false;
  document.querySelectorAll('.grid > .card').forEach((c) => { c.hidden = !!show && !show.includes(c.id); });
  document.querySelectorAll('nav a[data-view]').forEach((a) => a.classList.toggle('on', a.dataset.view === name));
  document.title = name === 'overview' ? 'Home Control' : `${VIEW_TITLES[name]} · Home Control`;
  window.scrollTo(0, 0);
  requestAnimationFrame(drawChart); // the chart needs a visible container to measure its width
  syncStreams();
}
const viewFromHash = () => location.hash.replace(/^#\/?/, '');
window.addEventListener('hashchange', () => setView(viewFromHash()));

buildEnergy();
buildDevices();
buildSecurity();
buildPower();
setView(viewFromHash());
connect();
loadHistory();
setInterval(loadHistory, 60_000);
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(drawChart, 150); });
