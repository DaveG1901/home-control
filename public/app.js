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
const opt = (key, real) => {
  const o = optimistic.get(key);
  if (o && o.until > Date.now()) return o.value;
  optimistic.delete(key);
  return real;
};
const holdOptimistic = (key, value) => optimistic.set(key, { value, until: Date.now() + 5000 });

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
  const id = t.dataset.cmd;
  let value;
  if (t.dataset.n !== undefined) value = Number(t.dataset.n);
  else if (t.dataset.toggle !== undefined) value = t.classList.contains('on') ? 'off' : 'on';
  else value = t.dataset.v;
  const msg = id === 'hotwater.boost' ? (value === 0 ? 'Hot water boost cancelled' : `Hot water boost for ${value} min`) : undefined;
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
      : `<button class="sw${on ? ' on' : ''}" data-cmd="plug:${esc(d.id)}" data-toggle aria-label="${esc(d.name)}"></button>`;
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

function renderHeating(m) {
  const h = m.heating;
  const main = h.main;
  const off = main.mode === 'unavailable';
  const target = opt('heating.target', main.target);
  const mode = opt('heating.mode', main.mode);
  const modeBtn = (label, v) => `<button data-cmd="heating.mode" data-v="${esc(v)}" class="${mode === v ? 'on' : ''}"${off ? ' disabled' : ''}>${label}</button>`;
  const bar = (c) => clamp(((c - 10) / 15) * 100, 4, 100);
  const hw = h.hotWater;
  const hwText = hw.boosting ? 'Boost active' : hw.heatingNow ? 'Heating now' : 'Not heating';
  const boostBtns = hw.boosting
    ? '<button class="btn on" data-cmd="hotwater.boost" data-n="0">Cancel boost</button>'
    : '<button class="btn" data-cmd="hotwater.boost" data-n="30">Boost 30m</button><button class="btn" data-cmd="hotwater.boost" data-n="60">1h</button>';

  setHTML($('#heating'), `
    <div class="hd"><h2>Heating &amp; hot water</h2><span class="tag">Hive</span></div>
    <div class="big">
      <div><div class="t">${fx(main.current, 1)}<sup>°C</sup></div><div class="sub" style="margin-top:6px">${esc(main.name)}</div></div>
      <div class="stepper"><button data-act="step" data-d="-0.5" aria-label="Lower target"${off ? ' disabled' : ''}>−</button><div><b>${target === null ? dash : `${fx(target, 1)}°`}</b><small>target</small></div><button data-act="step" data-d="0.5" aria-label="Raise target"${off ? ' disabled' : ''}>+</button></div>
    </div>
    <div class="seg">${modeBtn('Off', h.modes.off)}${modeBtn('Schedule', h.modes.schedule)}${modeBtn('Heat', h.modes.heat)}</div>
    <div class="zones">${h.zones.map((z) => `<div class="zone"><small>${esc(z.name)}</small><b>${z.current === null ? dash : `${fx(z.current, 1)}°`}</b><div class="bar"><div style="width:${z.current === null ? 0 : bar(z.current)}%"></div></div></div>`).join('')}</div>
    <div class="hw">
      <div class="l"><div class="ico">${icon('drop')}</div><div><b>Hot water</b><div class="sub" style="font-size:12px">${hwText}${hw.mode ? ` · ${esc(hw.mode)}` : ''}</div></div></div>
      <div style="display:flex;gap:8px">${boostBtns}</div>
    </div>`);
}

function renderSecurity(m) {
  const s = m.security;
  const bellDetect = (d) => (d.motion && d.person ? 'Motion & person detection on' : d.motion ? 'Motion detection on' : d.person ? 'Person detection on' : 'Detection off');
  const status = (c) => (c.status === 'clear' ? 'Clear' : `${c.status[0].toUpperCase()}${c.status.slice(1)} detected`);
  setHTML($('#security'), `
    <div class="hd"><h2>Security</h2>${s.doorbellPressAvailable ? '' : '<span class="tag warn">Doorbell press alerts: not available yet</span>'}</div>
    <div class="bells">${s.doorbells.map((d) => `
      <div class="bell"><div class="ico">${icon('bell')}</div><div><b>${esc(d.name)}</b><small>${bellDetect(d)}</small></div><div class="batt">${d.battery === null ? dash : `${d.battery}%`}<br><small style="color:var(--mute)">battery</small></div></div>`).join('')}
    </div>
    <div class="cams">${s.cameras.map((c) => {
      const on = opt(`floodlight:${c.id}`, c.floodlight ? 'on' : 'off') === 'on';
      return `<div class="cam${c.status === 'clear' ? '' : ' alert'}"><div class="view"><span class="live">${c.status === 'clear' ? 'LIVE' : 'ALERT'}</span>${icon('cam')}</div>
        <div class="m"><div><b>${esc(c.name)}</b><small>${status(c)}</small></div>${c.floodlightAvailable
    ? `<button class="sw${on ? ' on' : ''}" data-cmd="floodlight:${esc(c.id)}" data-toggle title="Floodlight" aria-label="${esc(c.name)} floodlight"></button>`
    : '<button class="sw lock" disabled title="Floodlight unavailable"></button>'}</div></div>`;
    }).join('')}</div>
    <div class="sub" style="margin-top:12px;font-size:12px">Toggles are floodlights. Full live video stays in the Reolink app.</div>`);
}

function renderControls(m) {
  setHTML($('#controls'), `
    <div class="hd"><h2>Quick controls</h2><span class="tag">Tapo plugs</span></div>
    <div class="dev">${m.devices.map((d) => {
      const unavailable = d.state === 'unavailable';
      const on = opt(`plug:${d.id}`, d.state) === 'on';
      const sub = unavailable ? 'unavailable' : `${d.watts === null ? dash : `${fx(d.watts, 1)} W`}${d.protected ? ' · protected' : ''}`;
      const sw = d.control && !unavailable
        ? `<button class="sw${on ? ' on' : ''}" data-cmd="plug:${esc(d.id)}" data-toggle aria-label="${esc(d.name)}"></button>`
        : `<button class="sw${on ? ' on' : ''} lock" disabled title="${d.protected ? 'Protected: can’t be switched off here' : 'Unavailable'}"></button>`;
      return `<div class="d"><div class="ico">${icon(d.protected ? 'lock' : 'plug')}</div><div><b>${esc(d.name)}</b><small>${sub}</small></div>${sw}</div>`;
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
  renderHeating(m);
  renderSecurity(m);
  renderControls(m);
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
  overview: null, // everything
  energy: ['energy', 'today', 'surplus', 'power', 'consumers'],
  heating: ['heating', 'activity'],
  security: ['security', 'activity'],
  devices: ['surplus', 'controls', 'consumers'],
  reports: ['power', 'today'],
};
const VIEW_TITLES = { overview: 'Overview', energy: 'Energy', heating: 'Heating', security: 'Security', devices: 'Devices', reports: 'Reports' };

function setView(name) {
  if (!Object.prototype.hasOwnProperty.call(VIEWS, name)) name = 'overview';
  const show = VIEWS[name];
  document.querySelector('.grid').dataset.view = name;
  document.querySelectorAll('.grid > .card').forEach((c) => { c.hidden = !!show && !show.includes(c.id); });
  document.querySelectorAll('nav a[data-view]').forEach((a) => a.classList.toggle('on', a.dataset.view === name));
  document.title = name === 'overview' ? 'Home Control' : `${VIEW_TITLES[name]} · Home Control`;
  window.scrollTo(0, 0);
  requestAnimationFrame(drawChart); // the chart needs a visible container to measure its width
}
const viewFromHash = () => location.hash.replace(/^#\/?/, '');
window.addEventListener('hashchange', () => setView(viewFromHash()));

buildEnergy();
buildPower();
setView(viewFromHash());
connect();
loadHistory();
setInterval(loadHistory, 60_000);
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(drawChart, 150); });
