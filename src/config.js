'use strict';

const path = require('node:path');

// Load .env file (dev only — in Docker, env vars come from the runtime)
try { require('dotenv').config(); } catch { /* dotenv not installed in prod */ }

function required(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`FATAL: Required environment variable ${name} is not set.`);
    process.exit(1);
  }
  return val;
}

const config = {
  PORT: Number(process.env.PORT) || 3000,
  DATA_DIR: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
  STOCK_API_URL: required('STOCK_API_URL').replace(/\/+$/, ''),
  STOCK_API_KEY: required('STOCK_API_KEY'),
  RESEND_API_KEY: required('RESEND_API_KEY'),
  RESEND_BASE_URL: required('RESEND_BASE_URL').replace(/\/+$/, ''),
  WEBHOOK_SECRET: required('WEBHOOK_SECRET'),
  ADMIN_PASSWORD: required('ADMIN_PASSWORD'),
  STORE_NAME: process.env.STORE_NAME || 'Demo Store',
  STORE_URL: process.env.STORE_URL || '',
  STORE_PRODUCT_URL_TEMPLATE: process.env.STORE_PRODUCT_URL_TEMPLATE || '',
  FROM_EMAIL: process.env.FROM_EMAIL || 'alerts@example.com',
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  // Tuning
  MAX_EMAIL_ATTEMPTS: 5,
  RETRY_BASE_MS: 2000,
  WORKER_INTERVAL_MS: 10_000,
  RECONCILE_INTERVAL_MS: Number(process.env.RECONCILE_INTERVAL_MS) || 60_000,
  HTTP_TIMEOUT_MS: 8000,
  EMAIL_CONCURRENCY: 3,
  STALE_SENDING_MINUTES: Number(process.env.STALE_SENDING_MINUTES) || 5,
  RATE_LIMIT_WINDOW_MS: 60_000,
  RATE_LIMIT_MAX: 20,
  ADMIN_RATE_LIMIT_MAX_FAILS: Number(process.env.ADMIN_RATE_LIMIT_MAX_FAILS) || 5,
  ADMIN_RATE_LIMIT_WINDOW_MS: 60_000,
  ADMIN_FAILED_DELAY_MS: Number(process.env.ADMIN_FAILED_DELAY_MS) || 200,
  MAX_BODY_BYTES: 10_000,
};

module.exports = config;
