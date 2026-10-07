'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { History } = require('../server/history');

// A stand-in for the Postgres pool that records every query.
function fakePool({ failInserts = 0 } = {}) {
  const queries = [];
  let failures = failInserts;
  return {
    queries,
    inserts: () => queries.filter((q) => /^\s*INSERT/i.test(q.sql)),
    async query(sql, params) {
      queries.push({ sql, params });
      if (/^\s*INSERT/i.test(sql) && failures-- > 0) throw new Error('database asleep');
      return { rows: [] };
    },
  };
}
const sample = (t) => ({ t, pv: 1, load: 0.5, batt: 0.2, soc: 50 });

test('samples are not written one by one: nothing hits the database until a flush', async () => {
  const pool = fakePool();
  const h = new History(pool);
  await h.init();
  for (let i = 0; i < 10; i++) h.add(sample(1_000 + i * 30_000));
  assert.equal(pool.inserts().length, 0, 'no per-sample inserts');
  assert.equal(h.range(0).length, 10, 'the chart still sees them immediately (kept in memory)');
});

test('a flush writes every pending sample in a single INSERT, then does nothing until there is more', async () => {
  const pool = fakePool();
  const h = new History(pool);
  await h.init();
  for (let i = 0; i < 20; i++) h.add(sample(1_000 + i * 30_000));
  await h.flush();
  assert.equal(pool.inserts().length, 1);
  assert.equal(pool.inserts()[0].params.length, 20 * 5);
  await h.flush();
  assert.equal(pool.inserts().length, 1, 'nothing left to send');
});

test('if the database is unreachable the samples are kept and sent at the next flush', async () => {
  const pool = fakePool({ failInserts: 1 });
  const h = new History(pool);
  await h.init();
  h.add(sample(1_000)); h.add(sample(31_000));
  await h.flush(); // fails
  h.add(sample(61_000));
  await h.flush(); // succeeds, with all three
  const last = pool.inserts().at(-1);
  assert.equal(last.params.length, 3 * 5);
  assert.equal(h.pending.length, 0);
});

test('stop() writes whatever is left, and without a database nothing is queued', async () => {
  const pool = fakePool();
  const h = new History(pool);
  await h.init();
  h.start();
  h.add(sample(1_000));
  await h.stop();
  assert.equal(pool.inserts().length, 1);

  const memoryOnly = new History(null);
  memoryOnly.add(sample(1_000));
  await memoryOnly.flush();
  assert.equal(memoryOnly.pending.length, 0);
  assert.equal(memoryOnly.range(0).length, 1);
});
