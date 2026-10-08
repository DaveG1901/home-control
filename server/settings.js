'use strict';

// Small values the app must remember across restarts, kept in the same database as the chart history.
// Today just one: when "sign out everywhere" was last used (sessions from before then are refused).

const KEY = 'sessions_valid_after';
const ensure = (db) => db.query('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

async function loadValidAfter(db) {
  if (!db) return 0;
  await ensure(db);
  const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [KEY]);
  return rows[0] ? Number(rows[0].value) || 0 : 0;
}

async function saveValidAfter(db, ms) {
  if (!db) return;
  await ensure(db);
  await db.query('INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [KEY, String(ms)]);
}

module.exports = { loadValidAfter, saveValidAfter };
