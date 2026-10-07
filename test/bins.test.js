'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BinService, parseBins, collectionDays, demoEvents } = require('../server/bins');

// Real events from the council calendar (Vale 1 / South 2 Monday), as Home Assistant returns them.
const REAL = [
  { summary: 'Bin reminder - Grey rubbish and food waste and small electrical items', start: { dateTime: '2026-10-11T18:00:00+01:00' } },
  { summary: 'GREY+FOOD BINS+SMALL ELECTRICAL ITEMS', start: { date: '2026-10-12' }, end: { date: '2026-10-13' }, description: 'Green recycling bin\nBrown garden waste bin - http://example' },
  { summary: 'Bin reminder - Green recycling, brown garden, food waste, textiles and batteries', start: { dateTime: '2026-10-18T18:00:00+01:00' } },
  { summary: 'RECYCLING+GARDEN+FOOD+TEXTILES + BATTERIES', start: { date: '2026-10-19' }, end: { date: '2026-10-20' } },
  { summary: 'GREY+FOOD BINS+SMALL ELECTRICAL ITEMS', start: { date: '2026-10-26' }, end: { date: '2026-10-27' } },
  { summary: 'RECYCLING+EXTRA GARDEN+FOOD+TEXTILES + BATTERIES', start: { date: '2026-11-02' }, end: { date: '2026-11-03' } },
];

async function service(now) {
  const s = new BinService({ calendar: 'calendar.x', fetchEvents: async () => REAL, now: () => now });
  await s.refresh();
  return s;
}
const ids = (day) => day.bins.map((b) => b.id);
// UK clocks: BST until 25 Oct 2026, so a UTC time is one hour behind the wall clock.
const at = (iso) => new Date(iso);

test('reads the council wording: which bins and extras each week', () => {
  assert.deepEqual(parseBins('GREY+FOOD BINS+SMALL ELECTRICAL ITEMS'), { bins: ['grey', 'food'], extras: ['Small electricals'] });
  assert.deepEqual(parseBins('RECYCLING+GARDEN+FOOD+TEXTILES + BATTERIES'), { bins: ['green', 'brown', 'food'], extras: ['Textiles', 'Batteries'] });
  assert.deepEqual(parseBins('RECYCLING+EXTRA GARDEN+FOOD+TEXTILES + BATTERIES').extras, ['Textiles', 'Batteries', 'Extra garden collection']);
  assert.deepEqual(parseBins('something new the council invented'), { bins: [], extras: [] });
});

test('the "evening before" reminders are ignored and only collection days remain', () => {
  const days = collectionDays(REAL);
  assert.deepEqual(days.map((d) => d.date), ['2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02']);
});

test('midweek: next is Monday, with grey + food, extras listed, and the week after is green', async () => {
  const s = await service(at('2026-10-07T10:00:00Z'));
  const v = s.view(at('2026-10-07T10:00:00Z'));
  assert.equal(v.available, true);
  assert.equal(v.next.weekday, 'Monday');
  assert.equal(v.next.dayMonth, '12 October');
  assert.equal(v.next.when, 'In 5 days');
  assert.deepEqual(ids(v.next), ['grey', 'food']);
  assert.deepEqual(v.next.extras, ['Small electricals']);
  assert.deepEqual(ids(v.then[0]), ['green', 'brown', 'food']);
  assert.equal(v.putOutTonight, false);
});

test('food waste is collected every week, even if a title does not mention it', async () => {
  const s = new BinService({ calendar: 'c', fetchEvents: async () => [{ summary: 'RECYCLING ONLY', start: { date: '2026-10-12' } }], now: () => at('2026-10-07T10:00:00Z') });
  await s.refresh();
  assert.deepEqual(ids(s.view(at('2026-10-07T10:00:00Z')).next), ['green', 'food']);
});

test('the evening before it says to put the bins out; earlier in the day it does not', async () => {
  const s = await service(at('2026-10-11T12:00:00Z'));
  const morning = s.view(at('2026-10-11T09:00:00Z'));   // Sunday 10:00 BST
  assert.equal(morning.next.when, 'Tomorrow');
  assert.equal(morning.putOutTonight, false);
  const evening = s.view(at('2026-10-11T16:30:00Z'));   // Sunday 17:30 BST
  assert.equal(evening.next.when, 'Tomorrow');
  assert.equal(evening.putOutTonight, true);
});

test('on collection day it says Today, then moves on to the next collection after 2pm', async () => {
  const s = await service(at('2026-10-12T07:00:00Z'));
  const morning = s.view(at('2026-10-12T07:00:00Z'));   // Monday 08:00 BST
  assert.equal(morning.next.when, 'Today');
  assert.equal(morning.next.date, '2026-10-12');
  const afternoon = s.view(at('2026-10-12T14:30:00Z')); // Monday 15:30 BST
  assert.equal(afternoon.next.date, '2026-10-19');
  assert.deepEqual(ids(afternoon.next), ['green', 'brown', 'food']);
});

test('the clocks changing does not shift the day (calendar dates are whole days)', async () => {
  const s = await service(at('2026-10-24T12:00:00Z'));
  const v = s.view(at('2026-10-25T23:30:00Z')); // Sunday night after the change: 23:30 GMT
  assert.equal(v.next.date, '2026-10-26');
  assert.equal(v.next.when, 'Tomorrow');
  assert.equal(v.putOutTonight, true);
});

test('if the calendar cannot be read: not available at first, then the last good answer is kept', async () => {
  let fail = false;
  const s = new BinService({ calendar: 'c', fetchEvents: async () => { if (fail) throw new Error('Home Assistant is not reachable'); return REAL; }, now: () => at('2026-10-07T10:00:00Z') });
  fail = true;
  assert.equal(await s.refresh(), false);
  assert.equal(s.view().available, false);
  assert.match(s.view().error, /not reachable/);
  fail = false;
  assert.equal(await s.refresh(), true);
  fail = true;
  await s.refresh();
  const v = s.view();
  assert.equal(v.available, true);
  assert.equal(v.stale, true);
  assert.equal(v.next.date, '2026-10-12');
});

test('demo mode makes alternating weeks that the service understands', async () => {
  const now = at('2026-10-07T10:00:00Z');
  const s = new BinService({ calendar: 'c', fetchEvents: async () => demoEvents(now), now: () => now });
  await s.refresh();
  const v = s.view(now);
  assert.equal(v.next.weekday, 'Monday');
  assert.notDeepEqual(ids(v.next), ids(v.then[0]), 'consecutive weeks differ');
  assert.ok(ids(v.next).includes('food') && ids(v.then[0]).includes('food'));
});
