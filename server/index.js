'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { config: defaultConfig, validate } = require('./config');
const { HAClient } = require('./ha');
const { Store } = require('./state');
const { History } = require('./history');
const { createAuth } = require('./auth');
const settings = require('./settings');
const { buildCommands, cameras, watchedEntities } = require('./entities');
const { createFakeHa } = require('./fakeHa');
const { BinService, demoEvents } = require('./bins');
const { CameraWarmer } = require('./warm');
const { Outdoors } = require('./outdoors');
const { bins: binsConfig } = require('./entities');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const OPEN_PATHS = new Set(['/login', '/login.html', '/login.js', '/theme.js', '/healthz', '/favicon.svg']);
const SAMPLE_EVERY_MS = 30_000;

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients / same-origin GETs
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function start(config = defaultConfig) {
  const problems = validate(config);
  if (problems.length) throw new Error(`Configuration problem(s):\n - ${problems.join('\n - ')}`);

  // ---- history (memory, optionally Postgres) ----
  let pool = null;
  if (config.databaseUrl) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: config.databaseUrl, max: 3, connectionTimeoutMillis: 20_000 }); // allow for a sleeping database waking up
    pool.on('error', (e) => console.error('[db] pool error:', e.message));
  }
  const history = new History(pool);
  try { await history.init(); } catch (err) {
    console.error('[history] database unavailable, using memory only:', err.message);
    history.initError = err.message;
    history.pool = null;
  }
  if (config.mode === 'demo') history.backfillDemo();
  history.start();

  // ---- Home Assistant (real, or the built-in fake in demo mode) ----
  const store = new Store(config.mode);
  let fake = null;
  let ha;
  if (config.mode === 'demo') {
    fake = await createFakeHa({ token: 'demo-token' });
    ha = new HAClient({ url: fake.url, token: 'demo-token', entities: [...watchedEntities()] });
  } else {
    ha = new HAClient({ url: config.haUrl, token: config.haToken, entities: [...watchedEntities()] }); // only what the app uses
  }
  ha.on('log', (m) => console.log('[ha]', m));
  ha.on('connected', () => { console.log('[ha] connected'); store.setHaConnected(true); });
  ha.on('disconnected', () => { console.log('[ha] disconnected'); store.setHaConnected(false); });
  ha.on('fatal', (m) => { console.error('[ha] FATAL:', m); store.setFatal(m); });
  ha.on('states', (list) => { store.applyStates(list); history.add(store.sample()); });
  ha.on('state_changed', (id, s) => store.applyChange(id, s));
  ha.on('todo', (entityId, items) => store.setTodo(entityId, items));
  ha.on('connected', () => {
    for (const l of require('./entities').todoLists) ha.subscribeTodo(l.entity).catch((err) => console.warn(`[todo] ${l.entity}: ${err.message}`));
  });
  ha.start();

  // Bin collections: read from the council calendar in Home Assistant (made-up Mondays in demo mode)
  const bins = new BinService({
    calendar: binsConfig.calendar,
    fetchEvents: config.mode === 'demo' ? async () => demoEvents() : (id, from, to) => ha.calendarEvents(id, from, to),
  });
  store.setBins(bins);
  ha.on('connected', () => { bins.refresh().then(() => store.emit('change')); });
  bins.start(() => store.emit('change'));

  // Outside: live data from free public services (live mode), or made-up data in demo mode (no network).
  let outdoors = null;
  if (config.mode === 'demo' || config.outdoors) {
    const E = require('./entities');
    outdoors = new Outdoors({ area: E.area, demo: config.mode === 'demo', getKwp: () => E.solar.kwp || store.num(E.energy.maxPower) || 6.6 });
    store.setOutdoors(outdoors);
    outdoors.start(() => store.emit('change'));
  }

  const sampler = setInterval(() => { if (store.haConnected && store.ready) history.add(store.sample()); }, SAMPLE_EVERY_MS);

  // ---- web app ----
  // "Sign out everywhere" is remembered in the database (when there is one) so a restart does not undo it.
  const auth = createAuth({
    password: config.appPassword, secret: config.sessionSecret, secure: config.production, totpSecret: config.totpSecret,
    viewerPassword: config.viewerPassword || '', viewerTotpSecret: config.viewerTotpSecret || '',
    loadValidAfter: () => settings.loadValidAfter(history.pool),
    saveValidAfter: (ms) => settings.saveValidAfter(history.pool, ms),
  });
  await auth.init();
  const boostMemory = new Map(); // zone id -> the mode it was in before an app-started boost
  const commands = buildCommands({
    mode: (id) => { const e = store.raw(id); return e ? e.state : null; },
    preset: (id) => store.attr(id, 'preset_mode'),
    attr: (id, name) => store.attr(id, name),
    todoItems: (listId) => store.todoItems(listId),
    memory: boostMemory,
  });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Live camera video is fetched by the browser straight from Home Assistant, so that origin must be allowed in the CSP.
  let haOrigin = '';
  if (config.mode === 'live') { try { haOrigin = new URL(config.haUrl).origin; } catch { /* validated elsewhere */ } }

  app.use((req, res, next) => {
    const host = req.headers.host || '';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000'); // browsers only ever use HTTPS here
    res.setHeader('Content-Security-Policy',
      `default-src 'self'; img-src 'self' data: https://tilecache.rainviewer.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self' ws://${host} wss://${host} ${haOrigin}; media-src 'self' blob: ${haOrigin}; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    next();
  });
  app.use(express.json({ limit: '10kb' }));

  const commit = (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null; // set by Render; shows which version is running
  // Public: just enough for Render's health check and to see which version is running. The details are behind the login.
  app.get('/healthz', (req, res) => res.json({ ok: true, commit }));
  app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
  app.get('/api/login-options', (req, res) => res.json({ code: auth.codeRequired }));
  app.post('/api/login', (req, res) => (sameOrigin(req) ? auth.login(req, res) : res.status(403).json({ error: 'Bad origin' })));
  app.post('/api/logout', (req, res) => (sameOrigin(req) ? auth.logout(req, res) : res.status(403).json({ error: 'Bad origin' })));

  // Everything below requires a session.
  app.use((req, res, next) => {
    if (OPEN_PATHS.has(req.path) || auth.isAuthed(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
    return res.redirect('/login');
  });
  app.use(auth.renew);

  // A camera-only (viewer) session may load the page and its files, read its own cut-down state, and fetch camera streams.
  // Every other API (commands, history, health, sign out everywhere) is refused, whatever the page does.
  const VIEWER_API = [/^\/api\/state$/, /^\/api\/camera\/[^/]+\/stream$/, /^\/api\/cameras\/warm$/, /^\/api\/logout$/];
  app.use((req, res, next) => {
    if (auth.role(req) !== 'viewer') return next();
    if (req.path.startsWith('/api/') && !VIEWER_API.some((r) => r.test(req.path))) return res.status(403).json({ error: 'Not available' });
    return next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true, ha: store.haConnected, mode: config.mode, commit, uptimeSeconds: Math.round(process.uptime()), memory: memory(), history: history.status(), cameraWarmup: warmer.status() }));

  // Ends every session on every device, then closes their live connections.
  app.post('/api/logout-all', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
    try { await auth.signOutEverywhere(); } catch (err) {
      console.error('[auth] could not save sign-out time:', err.message);
      return res.status(500).json({ error: 'Could not sign out everywhere, try again' });
    }
    for (const c of wss.clients) c.close(4001, 'Signed out');
    return auth.logout(req, res);
  });

  const modelFor = (role) => (role === 'viewer' ? store.viewerModel() : store.viewModel());
  app.get('/api/state', (req, res) => res.json(modelFor(auth.role(req))));

  // The page calls this when it comes back to the foreground, so the camera streams are started ahead of a visit to Security.
  app.post('/api/cameras/warm', (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
    if (config.mode === 'live') warmer.kick();
    return res.json({ ok: true });
  });

  // The HLS player library, served from node_modules (only this one file).
  app.get('/vendor/hls.min.js', (req, res) => res.sendFile(path.join(__dirname, '..', 'node_modules', 'hls.js', 'dist', 'hls.min.js'), { maxAge: '7d' }));

  // Hands the browser a live-stream address for one of the named cameras. The video itself never passes through this server.
  const camById = new Map(cameras.map((c) => [c.id, c]));
  let streamCount = 0;
  setInterval(() => { streamCount = 0; }, 60_000).unref();
  app.get('/api/camera/:id/stream', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cam = camById.get(req.params.id);
    if (!cam) return res.status(404).json({ error: 'Unknown camera' });
    if (config.mode === 'demo') return res.json({ demo: true });
    if (!store.haConnected) return res.status(503).json({ error: 'Home Assistant is not connected' });
    if (++streamCount > 120) return res.status(429).json({ error: 'Slow down' });
    try {
      const p = await ha.cameraStream(cam.stream);
      return res.json({ url: `${config.haUrl}${p}` });
    } catch (err) {
      console.error(`[camera] ${cam.id} stream failed:`, err.message);
      return res.status(502).json({ error: 'Home Assistant could not start this camera' });
    }
  });

  // The dark background map under the rain radar: only the 3x3 block of zoom-7 tiles around the area, fetched once from
  // Esri's free map and then served from memory. The browser never contacts the map provider.
  const MAP_LAYERS = {
    base: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile',
    ref: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile',
  };
  const mapTiles = new Map(); // "layer/x/y" -> { type, body }
  app.get('/api/maptile/:layer/:z/:x/:y', async (req, res) => {
    const { area } = require('./entities');
    const z = 7; const n = 2 ** z;
    const cx = Math.floor(((area.lon + 180) / 360) * n);
    const r = (area.lat * Math.PI) / 180;
    const cy = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
    const x = Number(req.params.x); const y = Number(req.params.y);
    if (!MAP_LAYERS[req.params.layer] || Number(req.params.z) !== z || Math.abs(x - cx) > 1 || Math.abs(y - cy) > 1) return res.status(404).json({ error: 'Not available' });
    const key = `${req.params.layer}/${x}/${y}`;
    try {
      if (!mapTiles.has(key)) {
        const t = await fetch(`${MAP_LAYERS[req.params.layer]}/${z}/${y}/${x}`, { headers: { 'User-Agent': 'home-control (personal home dashboard)' }, signal: AbortSignal.timeout(15_000) });
        if (!t.ok) throw new Error(`HTTP ${t.status}`);
        mapTiles.set(key, { type: t.headers.get('content-type') || 'image/png', body: Buffer.from(await t.arrayBuffer()) });
      }
      const tile = mapTiles.get(key);
      res.setHeader('Cache-Control', 'private, max-age=604800');
      return res.type(tile.type).send(tile.body);
    } catch (err) {
      console.warn(`[map] tile ${key} unavailable: ${err.message}`);
      return res.status(502).json({ error: 'Map unavailable' });
    }
  });

  app.get('/api/history', (req, res) => {
    const floor = Date.now() - 48 * 3600_000;
    const from = Math.max(floor, parseInt(req.query.from, 10) || Date.now() - 24 * 3600_000);
    res.json({ from, points: history.range(from) });
  });

  let cmdCount = 0;
  setInterval(() => { cmdCount = 0; }, 60_000).unref();
  app.post('/api/command', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
    if (++cmdCount > 60) return res.status(429).json({ error: 'Slow down' });
    const { id, value } = req.body || {};
    const cmd = typeof id === 'string' ? commands.get(id) : undefined;
    if (!cmd) return res.status(404).json({ error: 'Unknown or protected command' });
    if (!cmd.validate(value)) return res.status(400).json({ error: 'Invalid value' });
    if (!store.haConnected) return res.status(503).json({ error: 'Home Assistant is not connected' });
    try {
      const c = cmd.call(value);
      await ha.callService(c.domain, c.service, c.data);
      const kind = cmd.kind || (/^(heating\.|boost:|hotwater\.)/.test(id) ? 'heating' : id.startsWith('floodlight:') ? 'security' : 'devices');
      store.log(cmd.describe(value), 'You', kind);
      return res.json({ ok: true });
    } catch (err) {
      console.error(`[cmd] ${id} failed:`, err.message); // the details stay in the server log
      return res.status(502).json({ error: 'Home Assistant did not accept that' });
    }
  });

  // The page is told its role up front, so a camera-only visitor never sees the full layout flash up first.
  app.get('/', (req, res) => {
    if (auth.role(req) !== 'viewer') return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8').replace('<body', '<body data-role="viewer"');
    return res.type('html').send(html);
  });
  app.use(express.static(PUBLIC_DIR, { index: false }));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // ---- live updates over WebSocket ----
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 }); // the browser only ever sends pongs

  // Start the camera streams in Home Assistant the moment someone opens the app, so they are already running (for about a
  // minute) if the Security tab is opened next. Live mode only: the demo has no real cameras.
  const warmer = new CameraWarmer({ ha, cameras, baseUrl: config.haUrl, isConnected: () => store.haConnected });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname !== '/live' || !auth.isAuthed(req) || !sameOrigin(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return socket.destroy();
      }
      return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (err) {
      // nothing a visitor sends here may take the server down
      console.error('[live] bad upgrade request:', err.message);
      return socket.destroy();
    }
  });
  wss.on('connection', (ws, req) => {
    ws.cookie = req.headers.cookie; // re-checked by the heartbeat: the connection ends when the session does
    ws.role = auth.role(req);       // a camera-only connection only ever receives the camera-only state
    ws.on('error', (err) => console.warn('[live] connection closed:', err.message)); // e.g. an oversized message; never fatal
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    if (config.mode === 'live') warmer.kick(); // start the streams the moment the app opens
    ws.lastSent = JSON.stringify({ type: 'state', data: modelFor(ws.role) });
    ws.send(ws.lastSent);
  });

  // Live updates: at most one a second, only when something actually changed, and never piling up for a connection that
  // cannot keep up (a phone with a poor signal): that one is skipped, and closed if it falls far behind (the page reconnects).
  const BROADCAST_MS = 1000;
  const SLOW_BYTES = 256 * 1024;
  const STUCK_BYTES = 2 * 1024 * 1024;
  let pending = null;
  store.on('change', () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      if (!wss.clients.size) return;
      const msgs = {}; // built once per role, only if someone with that role is connected
      for (const c of wss.clients) {
        if (c.readyState !== 1) continue;
        msgs[c.role] = msgs[c.role] || JSON.stringify({ type: 'state', data: modelFor(c.role) });
        if (c.lastSent === msgs[c.role]) continue; // nothing new for this connection
        if (c.bufferedAmount > STUCK_BYTES) { c.terminate(); continue; }
        if (c.bufferedAmount > SLOW_BYTES) continue;
        c.lastSent = msgs[c.role];
        c.send(msgs[c.role]);
      }
    }, BROADCAST_MS);
  });

  // Memory, in the log every 30 minutes and in /api/health, so any growth shows up long before Render restarts the service.
  const memory = () => { const m = process.memoryUsage(); const mb = (n) => Math.round(n / 1048576); return { rssMb: mb(m.rss), heapMb: mb(m.heapUsed), connections: wss.clients.size }; };
  const memLog = setInterval(() => { const m = memory(); console.log(`[memory] rss ${m.rssMb} MB, heap ${m.heapMb} MB, ${m.connections} live connection(s)`); }, 30 * 60_000);
  memLog.unref();
  const heartbeat = setInterval(() => {
    for (const c of wss.clients) {
      if (!auth.isAuthed({ headers: { cookie: c.cookie } })) { c.close(4001, 'Signed out'); continue; }
      if (!c.isAlive) { c.terminate(); continue; }
      c.isAlive = false; c.ping();
    }
  }, 30_000);

  // Without a password only listen on localhost.
  const host = auth.enabled ? '0.0.0.0' : '127.0.0.1';
  await new Promise((resolve) => server.listen(config.port, host, resolve));
  const port = server.address().port;
  if (!auth.enabled) console.warn('[auth] APP_PASSWORD not set: login disabled, listening on 127.0.0.1 only');

  async function close() {
    clearInterval(sampler); clearInterval(heartbeat); auth.stop();
    ha.stop();
    bins.stop();
    if (outdoors) outdoors.stop();
    await history.stop(); // write any unsaved chart samples
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => server.close(r));
    if (fake) await fake.close();
    if (pool) await pool.end().catch(() => {});
  }

  return { server, port, store, ha, fake, history, boostMemory, bins, close };
}

if (require.main === module) {
  start().then((s) => {
    console.log(`[home-control] ${defaultConfig.mode} mode, http://localhost:${s.port}`);
    const stop = () => s.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { start };
