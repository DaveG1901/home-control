'use strict';

// Home Assistant WebSocket API client.
// Protocol: https://developers.home-assistant.io/docs/api/websocket
// Works against a local HA, the Nabu Casa remote URL, or the built-in fake HA (demo mode).

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const PING_EVERY_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 10_000;

function toWsUrl(base) {
  const u = new URL(base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol;
  u.pathname = u.pathname.replace(/\/+$/, '') + '/api/websocket';
  return u.toString();
}

const INITIAL_TIMEOUT_MS = 20_000;

/**
 * Applies one subscribe_entities message (Home Assistant's compact format: "a" = added/full, "c" = changed, "r" = removed)
 * to the cache, and returns [entityId, newStateOrNull] for every entity it touched.
 */
function applyCompressed(cache, ev) {
  const out = [];
  const full = (id, v) => ({ entity_id: id, state: v.s, attributes: v.a || {}, last_changed: v.lc, last_updated: v.lu || v.lc });
  for (const [id, v] of Object.entries(ev.a || {})) { const s = full(id, v); cache.set(id, s); out.push([id, s]); }
  for (const [id, d] of Object.entries(ev.c || {})) {
    const cur = cache.get(id) || { entity_id: id, state: '', attributes: {} };
    const next = { ...cur, attributes: { ...cur.attributes } };
    const plus = d['+'] || {};
    if ('s' in plus) next.state = plus.s;
    if (plus.a) Object.assign(next.attributes, plus.a);
    if (plus.lc) { next.last_changed = plus.lc; next.last_updated = plus.lc; }
    if (plus.lu) next.last_updated = plus.lu;
    for (const k of (d['-'] && d['-'].a) || []) delete next.attributes[k];
    cache.set(id, next);
    out.push([id, next]);
  }
  for (const id of ev.r || []) { cache.delete(id); out.push([id, null]); }
  return out;
}

class HAClient extends EventEmitter {
  /**
   * entities: the entity ids the app uses. When given, only those are subscribed to (subscribe_entities), instead of every
   * state change in Home Assistant (a busy house sends several times more than the app needs).
   */
  constructor({ url, token, entities = null }) {
    super();
    this.url = toWsUrl(url);
    this.baseUrl = String(url).replace(/\/+$/, ''); // for the few things only the REST API offers
    this.token = token;
    this.entities = entities && entities.length ? [...entities] : null;
    this.cache = new Map();   // subscribe_entities: the latest full state of each subscribed entity
    this.entSubId = null;     // id of the subscribe_entities subscription on the current connection
    this.initialTimer = null;
    this.todoSubs = new Map(); // subscription id -> to-do entity, for the current connection
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.connected = false;
    this.stopped = false;
    this.fatal = null; // set on auth_invalid: we stop retrying
    this.backoff = 1000;
    this.pingTimer = null;
    this.pongTimer = null;
  }

  start() {
    this.stopped = false;
    this._open();
  }

  stop() {
    this.stopped = true;
    this._clearTimers();
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
  }

  _open() {
    if (this.stopped) return;
    const ws = new WebSocket(this.url, { handshakeTimeout: 15_000 });
    this.ws = ws;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this._onMessage(msg);
    });
    ws.on('error', (err) => this.emit('log', `socket error: ${err.message}`));
    ws.on('close', () => this._onClose());
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'auth_required':
        this._raw({ type: 'auth', access_token: this.token });
        break;
      case 'auth_ok':
        this._onAuthed();
        break;
      case 'auth_invalid':
        this.fatal = `Home Assistant rejected the token (${msg.message || 'auth_invalid'})`;
        this.emit('fatal', this.fatal);
        this.stop();
        break;
      case 'pong': {
        clearTimeout(this.pongTimer);
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); clearTimeout(p.timer); p.resolve(null); }
        break;
      }
      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p) break;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.success) p.resolve(msg.result);
        else p.reject(new Error((msg.error && msg.error.message) || 'Home Assistant returned an error'));
        break;
      }
      case 'event':
        if (this.todoSubs.has(msg.id) && msg.event) {
          this.emit('todo', this.todoSubs.get(msg.id), Array.isArray(msg.event.items) ? msg.event.items : []);
        } else if (this.entSubId !== null && msg.id === this.entSubId && msg.event) {
          const touched = applyCompressed(this.cache, msg.event);
          if (!this.connected) {
            // the first message after subscribing is the full current state of every subscribed entity
            clearTimeout(this.initialTimer);
            this._becameConnected([...this.cache.values()]);
          } else for (const [id, s] of touched) this.emit('state_changed', id, s);
        } else if (msg.event && msg.event.event_type === 'state_changed') {
          const d = msg.event.data;
          this.emit('state_changed', d.entity_id, d.new_state);
        }
        break;
      default:
        break;
    }
  }

  async _onAuthed() {
    try {
      if (this.entities) {
        // Only the entities the app uses: Home Assistant sends their full state once, then just what changes.
        this.cache = new Map();
        this.entSubId = this.nextId; // the id _send is about to use; events for this subscription carry it
        const ws = this.ws;
        this.initialTimer = setTimeout(() => { if (!this.connected && this.ws === ws) { this.emit('log', 'no initial states received'); try { ws.terminate(); } catch { /* ignore */ } } }, INITIAL_TIMEOUT_MS);
        await this._send({ type: 'subscribe_entities', entity_ids: this.entities });
        return; // connected once the initial states arrive (see 'event')
      }
      // Everything: subscribe first so nothing is missed between the snapshot and the subscription.
      await this._send({ type: 'subscribe_events', event_type: 'state_changed' });
      const states = await this._send({ type: 'get_states' });
      this._becameConnected(states);
    } catch (err) {
      this.emit('log', `startup failed: ${err.message}`);
      try { this.ws.close(); } catch { /* ignore */ }
    }
  }

  _becameConnected(states) {
    this.connected = true;
    this.backoff = 1000;
    this._startPing();
    this.emit('connected');
    this.emit('states', states);
  }

  _onClose() {
    const wasConnected = this.connected;
    this.connected = false;
    this.entSubId = null;
    this.todoSubs.clear();
    clearTimeout(this.initialTimer);
    this._clearTimers();
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Disconnected from Home Assistant')); }
    this.pending.clear();
    if (wasConnected) this.emit('disconnected');
    if (this.stopped) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    this.emit('log', `disconnected, retrying in ${Math.round(wait / 1000)}s`);
    setTimeout(() => this._open(), wait);
  }

  _startPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this._send({ type: 'ping' }).catch(() => {});
      clearTimeout(this.pongTimer);
      // No pong => the connection is dead (common over mobile/NAT); force a reconnect.
      this.pongTimer = setTimeout(() => { try { this.ws.terminate(); } catch { /* ignore */ } }, PONG_TIMEOUT_MS);
    }, PING_EVERY_MS);
  }

  _clearTimers() {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
  }

  _raw(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  _send(obj) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected to Home Assistant'));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Home Assistant did not respond in time')); }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, ...obj }));
    });
  }

  /** Events from a Home Assistant calendar between two ISO times (REST API: calendars have no WebSocket equivalent). */
  async calendarEvents(entityId, startIso, endIso) {
    const url = `${this.baseUrl}/api/calendars/${encodeURIComponent(entityId)}?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Calendar request failed (HTTP ${res.status})`);
    return res.json();
  }

  /** Ask HA to start a live HLS stream for a camera. Resolves to a path such as /api/hls/<token>/master_playlist.m3u8 */
  async cameraStream(entityId) {
    if (!this.connected) throw new Error('Not connected to Home Assistant');
    const r = await this._send({ type: 'camera/stream', entity_id: entityId, format: 'hls' });
    if (!r || typeof r.url !== 'string') throw new Error('Home Assistant did not return a stream address');
    return r.url;
  }

  /** Follow a to-do list: emits 'todo' (entityId, items) now and whenever it changes. Call again after each reconnect. */
  async subscribeTodo(entityId) {
    if (!this.connected) throw new Error('Not connected to Home Assistant');
    const id = this.nextId; // the id _send is about to use; the list's events carry it
    this.todoSubs.set(id, entityId);
    try { await this._send({ type: 'todo/item/subscribe', entity_id: entityId }); } catch (err) { this.todoSubs.delete(id); throw err; }
  }

  /** Call a Home Assistant service, e.g. callService('switch', 'turn_off', { entity_id: 'switch.x' }). */
  callService(domain, service, serviceData = {}) {
    if (!this.connected) return Promise.reject(new Error('Not connected to Home Assistant'));
    return this._send({ type: 'call_service', domain, service, service_data: serviceData });
  }
}

module.exports = { HAClient, toWsUrl, applyCompressed };
