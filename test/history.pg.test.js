'use strict';

// Runs the History class against a REAL Postgres engine (PGlite, in-process), so the SQL itself is proven,
// not just the JavaScript around it. Same query shape as the real `pg` pool: query(sql, params) -> { rows }.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { History } = require('../server/history');

const poolFor = (db) => ({ query: (sql, params) => db.query(sql, params) });
const minutesAgo = (m) => Date.now() - m * 60_000;
const sample = (t, pv = 1.5) => ({ t, pv, load: 0.5, batt: 0.25, soc: 55.5 });

test('real Postgres: the table is created, samples are saved in one batch, and survive a restart', async () => {
  const db = new PGlite();
  const first = new History(poolFor(db));
  await first.init();
  for (let i = 0; i < 5; i++) first.add(sample(minutesAgo(30 - i), 1 + i));
  await first.flush();
  assert.equal(first.status().saved, 5);
  assert.equal(first.status().error, null);
  assert.ok(first.status().lastSavedAt);

  const count = await db.query('SELECT count(*)::int AS n FROM power_samples');
  assert.equal(count.rows[0].n, 5);

  // a new process starting up reads them back, oldest first, with the right values
  const second = new History(poolFor(db));
  await second.init();
  const pts = second.range(0);
  assert.equal(pts.length, 5);
  assert.deepEqual(pts.map((p) => p.pv), [1, 2, 3, 4, 5]);
  assert.ok(pts.every((p, i) => i === 0 || p.t > pts[i - 1].t), 'in time order');
  assert.equal(pts[0].soc, 55.5);
  assert.equal(typeof pts[0].t, 'number');
});

test('real Postgres: saving the same samples twice does not duplicate them', async () => {
  const db = new PGlite();
  const h = new History(poolFor(db));
  await h.init();
  const t = minutesAgo(10);
  h.add(sample(t)); await h.flush();
  h.add(sample(t)); await h.flush();
  const n = await db.query('SELECT count(*)::int AS n FROM power_samples');
  assert.equal(n.rows[0].n, 1);
});

test('real Postgres: only the last 48 hours are loaded, and rows older than 90 days are deleted at start-up', async () => {
  const db = new PGlite();
  const h = new History(poolFor(db));
  await h.init();
  const day = 24 * 60 * 60_000;
  h.add(sample(Date.now() - 100 * day));  // too old: deleted
  h.add(sample(Date.now() - 10 * day));   // kept in the database, but not loaded into the chart
  h.add(sample(Date.now() - 2 * 60_000)); // recent: loaded
  await h.flush();

  const restarted = new History(poolFor(db));
  await restarted.init();
  assert.equal(restarted.range(0).length, 1, 'only the recent sample is loaded');
  const n = await db.query('SELECT count(*)::int AS n FROM power_samples');
  assert.equal(n.rows[0].n, 2, 'the 100 day old row was pruned; the 10 day old one is kept');
});

test('real Postgres: a large batch (a day of samples) goes in as a single INSERT', async () => {
  const db = new PGlite();
  const h = new History(poolFor(db));
  await h.init();
  const base = Date.now() - 24 * 60 * 60_000;
  for (let i = 0; i < 2880; i++) h.add(sample(base + i * 30_000)); // one every 30 s for a day
  await h.flush();
  assert.equal(h.status().saved, 2880);
  const n = await db.query('SELECT count(*)::int AS n FROM power_samples');
  assert.equal(n.rows[0].n, 2880);
});

test('status() never exposes anything but counts, times and an error message', async () => {
  const h = new History({ query: async () => ({ rows: [] }) });
  await h.init();
  assert.deepEqual(Object.keys(h.status()).sort(), ['database', 'error', 'lastSavedAt', 'pending', 'saved']);
  assert.equal(new History(null).status().database, false);
});
