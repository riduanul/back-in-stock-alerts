'use strict';

const config = require('./config');

// Simple in-memory per-IP rate limiter
const hits = new Map(); // IP -> { count, resetAt }

function rateLimit(ip) {
  const now = Date.now();
  let entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + config.RATE_LIMIT_WINDOW_MS };
    hits.set(ip, entry);
  }
  entry.count++;
  return entry.count > config.RATE_LIMIT_MAX;
}

// Periodically clean stale entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) {
    if (now > entry.resetAt) hits.delete(ip);
  }
}, 60_000).unref();

module.exports = { rateLimit };
