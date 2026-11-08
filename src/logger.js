'use strict';

const config = require('./config');

// Structured logger — never logs secrets, masks email addresses
const MASKED_KEYS = new Set(['apikey', 'secret', 'password', 'token', 'authorization']);
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function maskEmail(email) {
  if (!email || typeof email !== 'string') return email;
  const at = email.indexOf('@');
  if (at < 1) return '***';
  return email[0] + '***@' + email.slice(at + 1);
}

function sanitize(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (MASKED_KEYS.has(k.toLowerCase())) { out[k] = '***'; continue; }
    if (k === 'email' || k === 'to') { out[k] = typeof v === 'string' ? maskEmail(v) : v; continue; }
    out[k] = typeof v === 'object' ? sanitize(v) : v;
  }
  return out;
}

function shouldLog(level) {
  const currentLevel = (config.LOG_LEVEL || 'info').toLowerCase();
  const currentVal = LOG_LEVELS[currentLevel] ?? LOG_LEVELS.info;
  const targetVal = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  return targetVal >= currentVal;
}

function log(level, msg, data) {
  if (!shouldLog(level)) return;
  const entry = { ts: new Date().toISOString(), level, msg };
  if (data) entry.data = sanitize(data);
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(JSON.stringify(entry));
}

module.exports = {
  debug: (msg, data) => log('debug', msg, data),
  info: (msg, data) => log('info', msg, data),
  warn: (msg, data) => log('warn', msg, data),
  error: (msg, data) => log('error', msg, data),
  maskEmail,
};
