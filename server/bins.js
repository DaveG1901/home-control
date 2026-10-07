'use strict';

// "Bindicator": works out the next bin collection from the council's calendar in Home Assistant.
//
// The calendar has, for each collection Monday, an all-day event such as "GREY+FOOD BINS+SMALL ELECTRICAL ITEMS" or
// "RECYCLING+GARDEN+FOOD+TEXTILES + BATTERIES", plus an "evening before" reminder ("Bin reminder - ...") which is ignored here.

const { bins: config } = require('./entities');

const TZ = 'Europe/London';
const SWITCH_AFTER_HOUR = 14;   // on collection day, show the NEXT collection once it is past 2pm (the bins have gone)
const PUT_OUT_FROM_HOUR = 15;   // from 3pm the day before: "put the bins out tonight"
const REFRESH_EVERY_MS = 3 * 3600_000;

/** Which bins and extras a council event title means. Unknown wording is kept as plain text, never guessed at. */
function parseBins(summary) {
  const s = String(summary || '').toUpperCase();
  const bins = [];
  if (/GREY|GRAY|RUBBISH|REFUSE|RESIDUAL/.test(s)) bins.push('grey');
  if (/RECYCL/.test(s)) bins.push('green');
  if (/GARDEN/.test(s)) bins.push('brown');
  if (/FOOD/.test(s)) bins.push('food');
  const extras = [];
  if (/TEXTILE/.test(s)) extras.push('Textiles');
  if (/BATTER/.test(s)) extras.push('Batteries');
  if (/SMALL ELECTRIC/.test(s)) extras.push('Small electricals');
  if (/EXTRA GARDEN/.test(s)) extras.push('Extra garden collection');
  return { bins, extras };
}

/** Collection days from raw calendar events: all-day events only, reminders removed, one per date, sorted. */
function collectionDays(events) {
  const byDate = new Map();
  for (const e of events || []) {
    const date = e && e.start && e.start.date;
    if (!date || /^\s*bin reminder/i.test(e.summary || '')) continue;
    if (!byDate.has(date)) byDate.set(date, { date, summary: String(e.summary || '').trim() });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function londonParts(now) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(now);
  const get = (t) => p.find((x) => x.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: parseInt(get('hour'), 10) % 24 };
}

const dayNumber = (isoDate) => Math.round(Date.parse(`${isoDate}T00:00:00Z`) / 86400000);
const fmt = (isoDate, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(new Date(`${isoDate}T12:00:00Z`));

const ORDER = ['grey', 'green', 'brown', 'food'];

function decorate(day, todayIso) {
  const parsed = parseBins(day.summary);
  const extras = parsed.extras;
  const bins = ORDER.filter((k) => parsed.bins.includes(k) || (config.always || []).includes(k));
  const daysAway = dayNumber(day.date) - dayNumber(todayIso);
  return {
    date: day.date,
    weekday: fmt(day.date, { weekday: 'long' }),
    dayMonth: fmt(day.date, { day: 'numeric', month: 'long' }),
    short: fmt(day.date, { weekday: 'short', day: 'numeric', month: 'short' }),
    daysAway,
    when: daysAway === 0 ? 'Today' : daysAway === 1 ? 'Tomorrow' : `In ${daysAway} days`,
    bins: bins.map((k) => ({ id: k, ...config.kinds[k] })),
    extras,
    summary: day.summary, // the council's own wording, used if nothing above was recognised
  };
}

class BinService {
  constructor({ calendar, fetchEvents, now = () => new Date() }) {
    this.calendar = calendar;
    this.fetchEvents = fetchEvents;
    this.now = now;
    this.days = [];
    this.updatedAt = null;
    this.error = null;
    this.timer = null;
  }

  /** Reads the next ~10 weeks of the calendar. On failure the previous answer is kept. */
  async refresh() {
    try {
      const start = new Date(this.now().getTime() - 2 * 86400_000);
      const end = new Date(this.now().getTime() + 70 * 86400_000);
      const events = await this.fetchEvents(this.calendar, start.toISOString(), end.toISOString());
      this.days = collectionDays(events);
      this.updatedAt = this.now().getTime();
      this.error = null;
      return true;
    } catch (err) {
      this.error = err.message;
      return false;
    }
  }

  start(onChange) {
    const tick = async () => { if (await this.refresh() && onChange) onChange(); };
    this.timer = setInterval(tick, REFRESH_EVERY_MS);
    this.timer.unref();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  /** What the page shows. Recomputed on every call, so "Tomorrow" becomes "Today" at midnight with no refresh needed. */
  view(now = this.now()) {
    const { date: today, hour } = londonParts(now);
    if (this.updatedAt === null) return { available: false, error: this.error, next: null, then: [] };
    let upcoming = this.days.filter((d) => d.date >= today);
    if (upcoming.length && upcoming[0].date === today && hour >= SWITCH_AFTER_HOUR) upcoming = upcoming.slice(1);
    const next = upcoming[0] ? decorate(upcoming[0], today) : null;
    return {
      available: true,
      stale: !!this.error,
      next,
      then: upcoming.slice(1, 3).map((d) => decorate(d, today)),
      putOutTonight: !!next && next.daysAway === 1 && hour >= PUT_OUT_FROM_HOUR,
    };
  }
}

/** Made-up but realistic Mondays (grey week / green week alternating) for demo mode. */
function demoEvents(now = new Date()) {
  const events = [];
  const { date: today } = londonParts(now);
  const t = new Date(`${today}T12:00:00Z`);
  const daysToMonday = (8 - t.getUTCDay()) % 7; // 0 if today is Monday
  for (let w = -1; w < 9; w++) {
    const d = new Date(t.getTime() + (daysToMonday + w * 7) * 86400_000);
    const iso = d.toISOString().slice(0, 10);
    const grey = Math.round(dayNumber(iso) / 7) % 2 === 0;
    events.push({
      summary: grey ? 'GREY+FOOD BINS+SMALL ELECTRICAL ITEMS' : 'RECYCLING+GARDEN+FOOD+TEXTILES + BATTERIES',
      start: { date: iso },
      end: { date: new Date(d.getTime() + 86400_000).toISOString().slice(0, 10) },
    });
    events.push({ summary: 'Bin reminder - demo', start: { dateTime: `${iso}T18:00:00+00:00` }, end: { dateTime: `${iso}T20:00:00+00:00` } });
  }
  return events;
}

module.exports = { BinService, parseBins, collectionDays, demoEvents, REFRESH_EVERY_MS };
