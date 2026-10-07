'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { config: defaultConfig, validate } = require('./config');
const { HAClient } = require('./ha');
const { Store } = require('./state');
const { History } = require('./history');
const { createAuth } = require('./auth');
const { buildCommands, cameras } = require('./entities');
const { createFakeHa } = require('./fakeHa');
const { BinService, demoEvents } = require('./bins');
const { CameraWarmer } = require('./warm');
const { bins: binsConfig } = require('./entities');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const OPEN_PATHS = new Set(['/login', '/login.html', '/login.js', '/healthz', '/favicon.svg']);
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
    ha = new HAClient({ url: fake.url, token: 'demo-token' });
  } else {
    ha = new HAClient({ url: config.haUrl, token: config.haToken });
  }
  ha.on('log', (m) => console.log('[ha]', m));
  ha.on('connected', () => { console.log('[ha] connected'); store.setHaConnected(true); });
  ha.on('disconnected', () => { console.log('[ha] disconnected'); store.setHaConnected(false); });
  ha.on('fatal', (m) => { console.error('[ha] FATAL:', m); store.setFatal(m); });
  ha.on('states', (list) => { store.applyStates(list); history.add(store.sample()); });
  ha.on('state_changed', (id, s) => store.applyChange(id, s));
  ha.start();

  // Bin collections: read from the council calendar in Home Assistant (made-up Mondays in demo mode)
  const bins = new BinService({
    calendar: binsConfig.calendar,
    fetchEvents: config.mode === 'demo' ? async () => demoEvents() : (id, from, to) => ha.calendarEvents(id, from, to),
  });
  store.setBins(bins);
  ha.on('connected', () => { bins.refresh().then(() => store.emit('change')); });
  bins.start(() => store.emit('change'));

  const sampler = setInterval(() => { if (store.haConnected && store.ready) history.add(store.sample()); }, SAMPLE_EVERY_MS);

  // ---- web app ----
  const auth = createAuth({ password: config.appPassword, secret: config.sessionSecret, secure: config.production });
  const boostMemory = new Map(); // zone id -> the mode it was in before an app-started boost
  const commands = buildCommands({
    mode: (id) => { const e = store.raw(id); return e ? e.state : null; },
    preset: (id) => store.attr(id, 'preset_mode'),
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
    res.setHeader('Content-Security-Policy',
      `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self' ws://${host} wss://${host} ${haOrigin}; media-src 'self' blob: ${haOrigin}; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    next();
  });
  app.use(express.json({ limit: '10kb' }));

  const commit = (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null; // set by Render; shows which version is running
app.get('/healthz', (req, res) => res.json({ ok: true, ha: store.haConnected, mode: config.mode, commit, uptimeSeconds: Math.round(process.uptime()), history: history.status(), cameraWarmup: warmer.status() }));
  app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
  app.post('/api/login', (req, res) => (sameOrigin(req) ? auth.login(req, res) : res.status(403).json({ error: 'Bad origin' })));
  app.post('/api/logout', (req, res) => auth.logout(req, res));

  // Everything below requires a session.
  app.use((req, res, next) => {
    if (OPEN_PATHS.has(req.path) || auth.isAuthed(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
    return res.redirect('/login');
  });

  app.get('/api/state', (req, res) => res.json(store.viewModel()));

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
      return res.status(502).json({ error: err.message });
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
      store.log(cmd.describe(value), 'You');
      return res.json({ ok: true });
    } catch (err) {
      console.error(`[cmd] ${id} failed:`, err.message);
      return res.status(502).json({ error: err.message });
    }
  });

  app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  app.use(express.static(PUBLIC_DIR, { index: false }));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // ---- live updates over WebSocket ----
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  // Start the camera streams in Home Assistant the moment someone opens the app, so they are already running (for about a
  // minute) if the Security tab is opened next. Live mode only: the demo has no real cameras.
  const warmer = new CameraWarmer({ ha, cameras, baseUrl: config.haUrl, isConnected: () => store.haConnected });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/live' || !auth.isAuthed(req) || !sameOrigin(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    if (config.mode === 'live') warmer.kick(); // start the streams the moment the app opens
    ws.send(JSON.stringify({ type: 'state', data: store.viewModel() }));
  });

  let pending = null;
  store.on('change', () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      if (!wss.clients.size) return;
      const msg = JSON.stringify({ type: 'state', data: store.viewModel() });
      for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
    }, 250);
  });
  const heartbeat = setInterval(() => {
    for (const c of wss.clients) { if (!c.isAlive) { c.terminate(); continue; } c.isAlive = false; c.ping(); }
  }, 30_000);

  // Without a password only listen on localhost.
  const host = auth.enabled ? '0.0.0.0' : '127.0.0.1';
  await new Promise((resolve) => server.listen(config.port, host, resolve));
  const port = server.address().port;
  if (!auth.enabled) console.warn('[auth] APP_PASSWORD not set: login disabled, listening on 127.0.0.1 only');

  async function close() {
    clearInterval(sampler); clearInterval(heartbeat);
    ha.stop();
    bins.stop();
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
