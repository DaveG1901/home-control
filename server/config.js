'use strict';

const env = process.env;

const config = {
  port: parseInt(env.PORT, 10) || 3000,
  mode: (env.HA_MODE || 'demo').toLowerCase(), // 'demo' | 'live'
  haUrl: (env.HA_URL || '').replace(/\/+$/, ''),
  haToken: env.HA_TOKEN || '',
  appPassword: env.APP_PASSWORD || '',
  sessionSecret: env.SESSION_SECRET || '',
  databaseUrl: env.DATABASE_URL || '',
  production: env.NODE_ENV === 'production',
};

function validate(c) {
  const problems = [];
  if (!['demo', 'live'].includes(c.mode)) problems.push('HA_MODE must be "demo" or "live"');
  if (c.mode === 'live') {
    if (!c.haUrl) problems.push('HA_URL is required in live mode');
    if (!c.haToken) problems.push('HA_TOKEN is required in live mode');
  }
  if (c.production) {
    // Exposed to the internet and able to switch things: never run without a password.
    if (c.appPassword.length < 8) problems.push('APP_PASSWORD (min 8 chars) is required in production');
    if (c.sessionSecret.length < 32) problems.push('SESSION_SECRET (min 32 chars) is required in production');
  }
  return problems;
}

module.exports = { config, validate };
