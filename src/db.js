'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('./config');
const log = require('./logger');

// Ensure data directory exists
fs.mkdirSync(config.DATA_DIR, { recursive: true });

const dbPath = path.join(config.DATA_DIR, 'back-in-stock.db');
const db = new Database(dbPath);

// WAL mode for concurrency, plus safety settings
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    sku TEXT NOT NULL,
    product_name TEXT,
    product_price REAL,
    product_currency TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','notified','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT ${config.MAX_EMAIL_ATTEMPTS},
    last_error TEXT,
    next_retry_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    notified_at TEXT
  );

  -- Prevent duplicate open requests: only one pending/sending per (email, sku)
  CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_open_request
    ON requests (email, sku)
    WHERE status IN ('pending', 'sending');

  CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);
  CREATE INDEX IF NOT EXISTS idx_requests_sku ON requests (sku);

  CREATE TABLE IF NOT EXISTS processed_events (
    event_id TEXT PRIMARY KEY,
    sku TEXT NOT NULL,
    processed_at TEXT NOT NULL DEFAULT (datetime('now')),
    result TEXT
  );
`);

log.info('Database initialized', { path: dbPath });

module.exports = db;
