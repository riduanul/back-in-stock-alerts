'use strict';

const config = require('./src/config');
const express = require('express');
const log = require('./src/logger');
const db = require('./src/db');
const routes = require('./src/routes');
const { startWorkers, stopWorkers } = require('./src/worker');

const app = express();

// Trust proxy for rate limiting (X-Forwarded-For)
app.set('trust proxy', true);

// Global middleware
app.use((req, res, next) => {
  // Remove default Express X-Powered-By
  res.removeHeader('X-Powered-By');
  next();
});

// Mount routes
app.use('/', routes);

// Global error handler
app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  log.error('Unhandled error', { error: err.message, path: req.path });
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
const server = app.listen(config.PORT, '0.0.0.0', () => {
  log.info('Server started', { port: config.PORT, store: config.STORE_NAME });
});

// Start background workers
startWorkers();

// Graceful shutdown
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Shutting down', { signal });

  // Stop accepting new connections
  server.close(() => {
    log.info('HTTP server closed');
  });

  // Stop workers
  stopWorkers();

  // Give in-flight work time to finish
  setTimeout(() => {
    try { db.close(); } catch { /* already closed */ }
    log.info('Database closed, exiting');
    process.exit(0);
  }, 3000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
