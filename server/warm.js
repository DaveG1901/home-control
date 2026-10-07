'use strict';

// Starts the camera streams in Home Assistant a moment BEFORE you look at them.
//
// Home Assistant starts a camera's live stream on the first request, and a cold start takes ~10 seconds, which is the wait
// you see when you first open a camera. Once started, a stream keeps running for about 70 seconds even if nobody watches it.
// So when the app is opened we ask for each camera's playlist straight away (a tiny request, no video travels): if you open the
// Security tab within the next minute or so the pictures appear almost at once.
//
// (Tested: asking again every few seconds does NOT extend that minute: Home Assistant only counts real video requests.
// To have cameras open instantly at any time, switch on "Preload stream" for each camera in Home Assistant.)

const COOLDOWN_MS = 30_000;        // no point asking again while the streams we just started are still warm
const REQUEST_TIMEOUT_MS = 45_000; // a cold start takes ~10 s

class CameraWarmer {
  /**
   * ha            the Home Assistant client (needs cameraStream(entityId) -> path)
   * cameras       [{ id, stream }]
   * baseUrl       Home Assistant's address, e.g. https://home.example.co.uk
   * isConnected() true while the link to Home Assistant is up
   */
  constructor({ ha, cameras, baseUrl, isConnected, cooldownMs = COOLDOWN_MS, fetchImpl = fetch, now = () => Date.now() }) {
    this.ha = ha;
    this.cameras = cameras;
    this.baseUrl = baseUrl;
    this.isConnected = isConnected;
    this.cooldownMs = cooldownMs;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.lastKick = -Infinity;
    this.busy = new Set(); // cameras with a request still in flight (a cold start blocks for ~10 s): never pile up
    this.pings = 0;
    this.lastError = null;
  }

  /** Start every camera stream now (e.g. the moment someone opens the app). Returns once all have answered or failed. */
  async kick() {
    if (!this.isConnected()) return false;
    const t = this.now();
    if (t - this.lastKick < this.cooldownMs) return false;
    this.lastKick = t;
    await Promise.allSettled(this.cameras.map((c) => this.warm(c)));
    return true;
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
      this.lastError = err.message; // a camera that is offline simply is not warmed
    } finally {
      this.busy.delete(cam.id);
    }
  }

  /** Safe for /healthz: counts only. */
  status() { return { pings: this.pings, error: this.lastError }; }
}

module.exports = { CameraWarmer, COOLDOWN_MS };
