'use strict';

const db = require('./db');
const config = require('./config');
const log = require('./logger');
const { checkStock, sendEmail } = require('./stockApi');
const { buildEmailHtml, buildEmailText } = require('./emailTemplate');

// Prepared statements
const stmtClaimRequest = db.prepare(`
  UPDATE requests SET status = 'sending', attempts = attempts + 1, updated_at = datetime('now')
  WHERE id = ? AND status = 'pending'
`);

const stmtMarkNotified = db.prepare(`
  UPDATE requests SET status = 'notified', notified_at = datetime('now'), updated_at = datetime('now'), last_error = NULL
  WHERE id = ?
`);

const stmtMarkFailed = db.prepare(`
  UPDATE requests SET status = 'failed', last_error = ?, updated_at = datetime('now')
  WHERE id = ?
`);

const stmtMarkRetryable = db.prepare(`
  UPDATE requests SET status = 'pending', last_error = ?, next_retry_at = ?, updated_at = datetime('now')
  WHERE id = ?
`);

const stmtPendingBySku = db.prepare(`
  SELECT * FROM requests
  WHERE sku = ? AND status = 'pending'
    AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
`);

const stmtRetryDue = db.prepare(`
  SELECT * FROM requests
  WHERE status = 'pending'
    AND next_retry_at IS NOT NULL
    AND next_retry_at <= datetime('now')
  ORDER BY created_at ASC
`);

const stmtDistinctPendingSkus = db.prepare(`
  SELECT DISTINCT sku FROM requests WHERE status IN ('pending', 'sending')
`);

const stmtResetStaleSending = db.prepare(`
  UPDATE requests SET status = 'pending', updated_at = datetime('now')
  WHERE status = 'sending'
    AND updated_at <= datetime('now', '-' || ? || ' minutes')
`);

// Concurrency limiter for outbound emails
let activeEmails = 0;
const emailQueue = [];

function acquireEmailSlot() {
  return new Promise(resolve => {
    if (activeEmails < config.EMAIL_CONCURRENCY) {
      activeEmails++;
      resolve();
    } else {
      emailQueue.push(resolve);
    }
  });
}

function releaseEmailSlot() {
  activeEmails--;
  if (emailQueue.length > 0) {
    activeEmails++;
    emailQueue.shift()();
  }
}

/**
 * Process a single notification request:
 * 1. Claim atomically (pending -> sending)
 * 2. Send email with idempotency key
 * 3. Mark notified or schedule retry
 */
async function processRequest(req) {
  // Atomic claim
  const claimed = stmtClaimRequest.run(req.id);
  if (claimed.changes === 0) {
    return; // Already claimed by another worker/instance
  }

  const idempotencyKey = `notify-${req.id}`;
  const subject = `${req.product_name || req.sku} is back in stock!`;

  try {
    await acquireEmailSlot();
    try {
      const result = await sendEmail({
        to: req.email,
        subject,
        html: buildEmailHtml({
          productName: req.product_name,
          productPrice: req.product_price,
          productCurrency: req.product_currency,
          sku: req.sku,
        }),
        text: buildEmailText({
          productName: req.product_name,
          productPrice: req.product_price,
          productCurrency: req.product_currency,
          sku: req.sku,
        }),
        idempotencyKey,
      });

      if (result.success) {
        stmtMarkNotified.run(req.id);
        log.info('Email sent', { requestId: req.id, sku: req.sku, emailId: result.id });
      } else {
        handleSendFailure(req, result.error || `HTTP ${result.statusCode}`);
      }
    } finally {
      releaseEmailSlot();
    }
  } catch (err) {
    handleSendFailure(req, err.message);
  }
}

function handleSendFailure(req, errorMsg) {
  const attempts = (req.attempts || 0) + 1; // already incremented in claim
  if (attempts >= config.MAX_EMAIL_ATTEMPTS) {
    stmtMarkFailed.run(errorMsg, req.id);
    log.error('Email permanently failed', { requestId: req.id, sku: req.sku, attempts, error: errorMsg });
  } else {
    // Exponential backoff with jitter
    const delayMs = config.RETRY_BASE_MS * Math.pow(2, attempts - 1) + Math.random() * 1000;
    const retryAt = new Date(Date.now() + delayMs).toISOString().replace('T', ' ').slice(0, 19);
    stmtMarkRetryable.run(errorMsg, retryAt, req.id);
    log.warn('Email send failed, will retry', { requestId: req.id, sku: req.sku, attempts, nextRetry: retryAt, error: errorMsg });
  }
}

// In-flight coalescing for processSku: concurrent webhook/worker calls for the same SKU share execution
const inFlightProcessSku = new Map();

/**
 * Process all pending requests for a given SKU.
 * Webhook-triggered checks for the same SKU arriving at the same moment share one stock check.
 */
function processSku(sku) {
  if (inFlightProcessSku.has(sku)) {
    return inFlightProcessSku.get(sku);
  }

  const promise = (async () => {
    try {
      return await doProcessSku(sku);
    } finally {
      inFlightProcessSku.delete(sku);
    }
  })();

  inFlightProcessSku.set(sku, promise);
  return promise;
}

/**
 * Internal execution of SKU processing:
 * 1. Checks if any pending requests exist before calling stock API.
 * 2. Verifies stock via API.
 * 3. Sends emails if genuinely restocked.
 */
async function doProcessSku(sku) {
  // Never call the stock API if there is nothing to send
  const pending = stmtPendingBySku.all(sku);
  if (pending.length === 0) return;

  let stock;
  try {
    stock = await checkStock(sku);
  } catch (err) {
    log.warn('Stock check failed, skipping SKU', { sku, error: err.message });
    return;
  }

  if (!stock.in_stock) {
    // Downgraded to debug level to prevent log flooding
    log.debug('SKU not actually in stock, skipping notifications', { sku });
    return;
  }

  log.info('Processing notifications', { sku, count: pending.length });

  // Enrich requests with product info from stock API
  const enriched = pending.map(r => ({
    ...r,
    product_name: r.product_name || stock.name,
    product_price: r.product_price ?? stock.price,
    product_currency: r.product_currency || stock.currency,
  }));

  // Process concurrently (limited by email pool)
  await Promise.allSettled(enriched.map(r => processRequest(r)));
}

/**
 * Retry worker: only touches requests whose next retry time is due
 * and never calls the stock API for SKUs that have nothing to send.
 */
async function retryWorker() {
  try {
    const due = stmtRetryDue.all();
    if (due.length === 0) return;

    // Group by SKU for efficiency
    const bysku = {};
    for (const r of due) {
      (bysku[r.sku] ||= []).push(r);
    }

    for (const sku of Object.keys(bysku)) {
      await processSku(sku);
    }
  } catch (err) {
    log.error('Retry worker error', { error: err.message });
  }
}

/**
 * Reconcile worker: checks stock for every SKU with open requests.
 * Deduplicates so each SKU is checked at most once per sweep.
 * Covers missed/lost webhooks.
 */
async function reconcileWorker() {
  try {
    const rows = stmtDistinctPendingSkus.all();
    const skus = [...new Set(rows.map(r => r.sku))];
    if (skus.length === 0) return;

    log.info('Reconcile: checking SKUs with open requests', { count: skus.length });
    for (const sku of skus) {
      await processSku(sku);
    }
  } catch (err) {
    log.error('Reconcile worker error', { error: err.message });
  }
}

/**
 * Recover stale 'sending' requests on startup.
 * Relies on Idempotency-Key to prevent duplicates on retry.
 */
function recoverStaleSending() {
  const result = stmtResetStaleSending.run(config.STALE_SENDING_MINUTES);
  if (result.changes > 0) {
    log.warn('Recovered stale sending requests on startup', { count: result.changes });
  }
}

let retryInterval = null;
let reconcileInterval = null;

function startWorkers() {
  // Recover from crash
  recoverStaleSending();

  // Run reconcile once at startup
  reconcileWorker();

  // Periodic workers
  retryInterval = setInterval(retryWorker, config.WORKER_INTERVAL_MS);
  retryInterval.unref();

  reconcileInterval = setInterval(reconcileWorker, config.RECONCILE_INTERVAL_MS);
  reconcileInterval.unref();

  log.info('Background workers started');
}

function stopWorkers() {
  if (retryInterval) clearInterval(retryInterval);
  if (reconcileInterval) clearInterval(reconcileInterval);
}

module.exports = { processSku, retryWorker, reconcileWorker, startWorkers, stopWorkers, processRequest };
