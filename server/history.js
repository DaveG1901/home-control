'use strict';

// Rolling power history for the "Power today" chart.
// Always kept in memory; also persisted to Postgres when DATABASE_URL is set so it survives restarts.

const MAX_POINTS = 3 * 24 * 120; // ~3 days at 30s
// Samples are written to Postgres in batches, not one at a time. A write every 30 s would keep a serverless database
// (e.g. Neon's free tier, which sleeps after 5 idle minutes) awake all day and use up its free compute hours.
const FLUSH_EVERY_MS = 10 * 60_000;
const MAX_PENDING = 5000; // if the database is unreachable for a long time, keep at most this many unsent samples

class History {
  constructor(pool) {
    this.pool = pool || null;
    this.points = [];
    this.pending = []; // samples not yet written to the database
    this.timer = null;
  }

  /** Start the periodic database write. Call stop() on shutdown to write whatever is left. */
  start() {
    if (!this.pool || this.timer) return;
    this.timer = setInterval(() => this.flush(), FLUSH_EVERY_MS);
    this.timer.unref();
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  /** Write all pending samples in a single INSERT. On failure they are kept and retried at the next flush. */
  async flush() {
    if (!this.pool || !this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    const values = [];
    const params = [];
    batch.forEach((p, i) => {
      const o = i * 5;
      values.push(`(${o + 1},${o + 2},${o + 3},${o + 4},${o + 5})`);
      params.push(new Date(p.t), p.pv, p.load, p.batt, p.soc);
    });
    try {
      await this.pool.query(`INSERT INTO power_samples (ts, pv, load, batt, soc) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params);
    } catch (err) {
      console.error(`[history] could not save ${batch.length} samples, will retry:`, err.message);
      this.pending = batch.concat(this.pending).slice(-MAX_PENDING);
    }
  }

  async init() {
    if (!this.pool) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS power_samples (
        ts   TIMESTAMPTZ PRIMARY KEY,
        pv   REAL NOT NULL,
        load REAL NOT NULL,
        batt REAL NOT NULL,
        soc  REAL
      )`);
    await this.pool.query(`DELETE FROM power_samples WHERE ts < now() - interval '90 days'`);
    const { rows } = await this.pool.query(
      `SELECT ts, pv, load, batt, soc FROM power_samples WHERE ts > now() - interval '48 hours' ORDER BY ts`);
    this.points = rows.map((r) => ({ t: r.ts.getTime(), pv: r.pv, load: r.load, batt: r.batt, soc: r.soc }));
  }

  add(sample) {
    if (!sample) return;
    this.points.push(sample);
    if (this.points.length > MAX_POINTS) this.points.splice(0, this.points.length - MAX_POINTS);
    if (this.pool) this.pending.push(sample);
  }

  range(fromMs) {
    const out = this.points.filter((p) => p.t >= fromMs);
    // Thin to ~400 points so the payload and chart stay light.
    const step = Math.ceil(out.length / 400) || 1;
    return step === 1 ? out : out.filter((_, i) => i % step === 0);
  }

  /** Demo mode only: synthesise a believable day so the chart is not empty on first load. */
  backfillDemo(hoursBack = 24) {
    if (this.points.length) return;
    const now = Date.now();
    for (let t = now - hoursBack * 3600_000; t < now; t += 5 * 60_000) {
      const h = londonHour(t);
      const pv = h < 6.3 || h > 17.5 ? 0 : 3.1 * Math.sin(((h - 6.3) / 11.2) * Math.PI) ** 1.4 * (0.85 + 0.15 * Math.sin(h * 2.3));
      const load = 0.35 + 0.2 * Math.sin(h * 1.7) ** 2 + (h > 6.5 && h < 9 ? 0.7 : 0) + (h > 17 && h < 21 ? 1.1 : 0);
      this.points.push({ t, pv: +pv.toFixed(3), load: +load.toFixed(3), batt: +Math.max(-1.5, Math.min(0.9, pv - load)).toFixed(3), soc: null });
    }
  }
}

function londonHour(ms) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(ms));
  const get = (type) => parseInt(p.find((x) => x.type === type).value, 10);
  return (get('hour') % 24) + get('minute') / 60;
}

module.exports = { History, londonHour };
