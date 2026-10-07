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

class HAClient extends EventEmitter {
  constructor({ url, token }) {
    super();
    this.url = toWsUrl(url);
    this.baseUrl = String(url).replace(/\/+$/, ''); // for the few things only the REST API offers
    this.token = token;
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
        if (msg.event && msg.event.event_type === 'state_changed') {
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
      // Subscribe first so nothing is missed between the snapshot and the subscription.
      await this._send({ type: 'subscribe_events', event_type: 'state_changed' });
      const states = await this._send({ type: 'get_states' });
      this.connected = true;
      this.backoff = 1000;
      this._startPing();
      this.emit('connected');
      this.emit('states', states);
    } catch (err) {
      this.emit('log', `startup failed: ${err.message}`);
      try { this.ws.close(); } catch { /* ignore */ }
    }
  }

  _onClose() {
    const wasConnected = this.connected;
    this.connected = false;
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

  /** Call a Home Assistant service, e.g. callService('switch', 'turn_off', { entity_id: 'switch.x' }). */
  callService(domain, service, serviceData = {}) {
    if (!this.connected) return Promise.reject(new Error('Not connected to Home Assistant'));
    return this._send({ type: 'call_service', domain, service, service_data: serviceData });
  }
}

module.exports = { HAClient, toWsUrl };
