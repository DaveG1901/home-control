'use strict';

// Keeps Home Assistant's camera streams warm while someone is using the app.
//
// Home Assistant only runs a camera's live stream while somebody keeps asking for it, and shuts it down after about a
// minute of silence. Starting one from cold takes ~10 seconds, which is the wait you see when you first open a camera.
// While anyone has the app open, this asks for each camera's playlist every few seconds (a tiny request: no video
// travels), so the streams are already running when you open the Security tab. Nothing runs when nobody is looking.

const KEEP_WARM_MS = 15_000;     // well inside Home Assistant's ~1 minute idle shutdown
const REQUEST_TIMEOUT_MS = 45_000; // a cold start takes ~10 s

class CameraWarmer {
  /**
   * ha          the Home Assistant client (needs cameraStream(entityId) -> path)
   * cameras     [{ id, stream }]
   * baseUrl     Home Assistant's address, e.g. https://home.example.co.uk
   * isNeeded()  true while someone is looking at the app (or just was)
   * isConnected() true while the link to Home Assistant is up
   */
  constructor({ ha, cameras, baseUrl, isNeeded, isConnected, intervalMs = KEEP_WARM_MS, fetchImpl = fetch }) {
    this.ha = ha;
    this.cameras = cameras;
    this.baseUrl = baseUrl;
    this.isNeeded = isNeeded;
    this.isConnected = isConnected;
    this.intervalMs = intervalMs;
    this.fetchImpl = fetchImpl;
    this.busy = new Set(); // cameras with a request still in flight (a cold start blocks for ~10 s): never pile up
    this.timer = null;
    this.pings = 0;
    this.lastError = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick(); }, this.intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Warm everything now, e.g. the moment someone opens the app. */
  kick() { return this.tick(); }

  async tick() {
    if (!this.isNeeded() || !this.isConnected()) return;
    await Promise.allSettled(this.cameras.map((c) => this.warm(c)));
  }

  async warm(cam) {
    if (this.busy.has(cam.id)) return;
    this.busy.add(cam.id);
    try {
      const path = await this.ha.cameraStream(cam.stream);
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      await res.arrayBuffer();
      this.pings++;
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message; // a camera that is offline simply is not warmed; try again next time
    } finally {
      this.busy.delete(cam.id);
    }
  }

  /** Safe for /healthz: counts only. */
  status() { return { active: !!this.timer, pings: this.pings, error: this.lastError }; }
}

module.exports = { CameraWarmer, KEEP_WARM_MS };
