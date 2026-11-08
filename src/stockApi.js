'use strict';

const config = require('./config');
const log = require('./logger');

/**
 * Fetch wrapper with timeout via AbortController.
 * Returns the Response object (caller checks status).
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

const inFlightStockChecks = new Map();

/**
 * Check stock for a given SKU.
 * Concurrent calls for the same SKU share the in-flight stock API call.
 * Returns { in_stock, quantity, name, price, currency, image } or throws.
 */
async function checkStock(sku) {
  if (inFlightStockChecks.has(sku)) {
    return inFlightStockChecks.get(sku);
  }

  const promise = (async () => {
    try {
      const url = `${config.STOCK_API_URL}/${encodeURIComponent(sku)}`;
      const res = await fetchWithTimeout(url, {
        headers: { 'Authorization': `Bearer ${config.STOCK_API_KEY}` },
      });
      if (!res.ok) {
        throw new Error(`Stock API returned ${res.status} for SKU ${sku}`);
      }
      const data = await res.json();
      return {
        in_stock: data.in_stock === true || (data.quantity != null && data.quantity > 0),
        quantity: data.quantity || 0,
        name: data.name || null,
        price: data.price ?? null,
        currency: data.currency || null,
        image: data.image || null,
      };
    } finally {
      inFlightStockChecks.delete(sku);
    }
  })();

  inFlightStockChecks.set(sku, promise);
  return promise;
}

/**
 * Fetch full catalogue from the stock API.
 * Returns array of products or throws.
 */
async function fetchCatalogue() {
  const res = await fetchWithTimeout(config.STOCK_API_URL, {
    headers: { 'Authorization': `Bearer ${config.STOCK_API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`Stock API catalogue returned ${res.status}`);
  }
  const data = await res.json();
  return data.products || [];
}

/**
 * Send email via Resend-compatible API.
 * @param {object} opts - { to, subject, html, text, idempotencyKey }
 * @returns {{ success: boolean, id?: string, error?: string, statusCode?: number }}
 */
async function sendEmail({ to, subject, html, text, idempotencyKey }) {
  const url = `${config.RESEND_BASE_URL}/emails`;
  const headers = {
    'Authorization': `Bearer ${config.RESEND_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const body = JSON.stringify({
    from: config.FROM_EMAIL,
    to: [to],
    subject,
    html,
    text,
  });

  const res = await fetchWithTimeout(url, { method: 'POST', headers, body });
  const data = await res.json();

  if (res.ok) {
    return { success: true, id: data.id };
  }
  return {
    success: false,
    statusCode: res.status,
    error: data.message || data.name || `HTTP ${res.status}`,
  };
}

module.exports = { checkStock, fetchCatalogue, sendEmail };
