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
const { buildCommands } = require('./entities');
const { createFakeHa } = require('./fakeHa');

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
    pool = new Pool({ connectionString: config.databaseUrl, max: 3 });
    pool.on('error', (e) => console.error('[db] pool error:', e.message));
  }
  const history = new History(pool);
  try { await history.init(); } catch (err) {
    console.error('[history] database unavailable, using memory only:', err.message);
    history.pool = null;
  }
  if (config.mode === 'demo') history.backfillDemo();

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

  const sampler = setInterval(() => { if (store.haConnected && store.ready) history.add(store.sample()); }, SAMPLE_EVERY_MS);

  // ---- web app ----
  const auth = createAuth({ password: config.appPassword, secret: config.sessionSecret, secure: config.production });
  const commands = buildCommands();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    const host = req.headers.host || '';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self' ws://${host} wss://${host}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    next();
  });
  app.use(express.json({ limit: '10kb' }));

  app.get('/healthz', (req, res) => res.json({ ok: true, ha: store.haConnected, mode: config.mode }));
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
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => server.close(r));
    if (fake) await fake.close();
    if (pool) await pool.end().catch(() => {});
  }

  return { server, port, store, ha, fake, history, close };
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
