'use strict';

const express = require('express');
const crypto = require('node:crypto');
const db = require('./db');
const config = require('./config');
const log = require('./logger');
const { checkStock, fetchCatalogue } = require('./stockApi');
const { rateLimit } = require('./rateLimit');
const { processSku } = require('./worker');
const { esc } = require('./emailTemplate');

const router = express.Router();

// ---------- Validation helpers ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SKU_RE = /^[A-Za-z0-9._-]{1,64}$/;

function validateEmail(raw) {
  if (!raw || typeof raw !== 'string') return { valid: false, error: 'Email is required' };
  const email = raw.trim().toLowerCase();
  if (email.length > 254) return { valid: false, error: 'Email too long' };
  if (!EMAIL_RE.test(email)) return { valid: false, error: 'Invalid email format' };
  return { valid: true, value: email };
}

function validateSku(raw) {
  if (!raw || typeof raw !== 'string') return { valid: false, error: 'SKU is required' };
  const sku = raw.trim();
  if (sku.length > 64) return { valid: false, error: 'SKU too long' };
  if (!SKU_RE.test(sku)) return { valid: false, error: 'SKU contains invalid characters' };
  return { valid: true, value: sku };
}

// ---------- Prepared statements ----------
const stmtInsertRequest = db.prepare(`
  INSERT INTO requests (email, sku, product_name, product_price, product_currency)
  VALUES (?, ?, ?, ?, ?)
`);

const stmtFindOpenRequest = db.prepare(`
  SELECT id FROM requests WHERE email = ? AND sku = ? AND status IN ('pending', 'sending')
`);

const stmtInsertEvent = db.prepare(`
  INSERT INTO processed_events (event_id, sku, result) VALUES (?, ?, ?)
`);

const stmtFindEvent = db.prepare(`
  SELECT event_id FROM processed_events WHERE event_id = ?
`);

const stmtAllRequests = db.prepare(`
  SELECT * FROM requests ORDER BY created_at DESC
`);

const stmtRequestsByStatus = db.prepare(`
  SELECT * FROM requests WHERE status = ? ORDER BY created_at DESC
`);

const stmtRequestsBySku = db.prepare(`
  SELECT * FROM requests WHERE sku = ? ORDER BY created_at DESC
`);

const stmtRequestsByStatusAndSku = db.prepare(`
  SELECT * FROM requests WHERE status = ? AND sku = ? ORDER BY created_at DESC
`);

const stmtCountByStatus = db.prepare(`
  SELECT status, COUNT(*) as count FROM requests GROUP BY status
`);

// ---------- GET /embed ----------
router.get('/embed', async (req, res) => {
  let products = [];
  try {
    products = await fetchCatalogue();
  } catch (err) {
    log.warn('Failed to fetch catalogue for embed', { error: err.message });
  }

  const soldOut = products.filter(p => !p.in_stock);
  const hasCatalogue = products.length > 0;

  res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  res.send(embedPage({ products, soldOut, hasCatalogue, storeName: config.STORE_NAME }));
});

// ---------- POST /api/requests ----------
router.post('/api/requests', express.json({ limit: config.MAX_BODY_BYTES }), async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress;
  if (rateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const emailV = validateEmail(req.body?.email);
  if (!emailV.valid) return res.status(400).json({ error: emailV.error });

  const skuV = validateSku(req.body?.sku);
  if (!skuV.valid) return res.status(400).json({ error: skuV.error });

  const email = emailV.value;
  const sku = skuV.value;

  // Check if already subscribed
  const existing = stmtFindOpenRequest.get(email, sku);
  if (existing) {
    return res.status(200).json({
      message: 'You\'re already on the list! We\'ll email you as soon as it\'s back.',
      alreadySubscribed: true,
    });
  }

  // Check current stock — if in stock, tell the customer instead of creating a request
  let stockInfo = null;
  try {
    stockInfo = await checkStock(sku);
  } catch (err) {
    log.warn('Stock check failed during request creation', { sku, error: err.message });
    // Continue — we'll create the request anyway
  }

  if (stockInfo?.in_stock) {
    return res.status(200).json({
      message: `Good news — ${stockInfo.name || sku} is currently in stock! No need to wait.`,
      inStock: true,
    });
  }

  // Insert the request (DB unique index prevents duplicates even under concurrent inserts)
  try {
    stmtInsertRequest.run(
      email, sku,
      stockInfo?.name || null,
      stockInfo?.price ?? null,
      stockInfo?.currency || null
    );
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(200).json({
        message: 'You\'re already on the list! We\'ll email you as soon as it\'s back.',
        alreadySubscribed: true,
      });
    }
    log.error('Failed to insert request', { error: err.message });
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }

  log.info('New request created', { sku, email: log.maskEmail(email) });

  res.status(201).json({
    message: 'You\'re on the list! We\'ll email you once, as soon as it\'s back in stock.',
    subscribed: true,
  });
});

// ---------- POST /webhooks/stock ----------
router.post('/webhooks/stock', express.json({ limit: config.MAX_BODY_BYTES }), (req, res) => {
  // Verify webhook secret with constant-time comparison
  const providedSecret = req.headers['x-webhook-secret'];
  if (!providedSecret || typeof providedSecret !== 'string') {
    return res.status(401).json({ error: 'Missing webhook secret' });
  }

  const a = Buffer.from(providedSecret);
  const b = Buffer.from(config.WEBHOOK_SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  // Validate payload shape
  const { event_id, sku, quantity } = req.body || {};
  if (!event_id || typeof event_id !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid event_id' });
  }
  if (!sku || typeof sku !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid sku' });
  }
  if (quantity == null || typeof quantity !== 'number') {
    return res.status(400).json({ error: 'Missing or invalid quantity' });
  }

  // Idempotency: check if event already processed
  const existingEvent = stmtFindEvent.get(event_id);
  if (existingEvent) {
    return res.status(200).json({ message: 'Event already processed', duplicate: true });
  }

  // Try to record the event (handles concurrent identical webhooks)
  try {
    stmtInsertEvent.run(event_id, sku, 'processing');
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(200).json({ message: 'Event already processed', duplicate: true });
    }
    log.error('Failed to insert event', { error: err.message });
    return res.status(500).json({ error: 'Internal error' });
  }

  log.info('Webhook received', { event_id, sku, quantity });

  // Respond immediately, process asynchronously
  res.status(202).json({ message: 'Event accepted, processing' });

  // Async: verify stock and send notifications
  processSku(sku).catch(err => {
    log.error('Async webhook processing failed', { event_id, sku, error: err.message });
  });
});

// In-memory failed-login tracker for /admin to mitigate brute-force
const adminFailedLogins = new Map(); // ip -> { count, resetAt }

function checkAdminRateLimit(ip) {
  const now = Date.now();
  const entry = adminFailedLogins.get(ip);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= config.ADMIN_RATE_LIMIT_MAX_FAILS;
}

function recordAdminFailedLogin(ip) {
  const now = Date.now();
  let entry = adminFailedLogins.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + config.ADMIN_RATE_LIMIT_WINDOW_MS };
    adminFailedLogins.set(ip, entry);
  }
  entry.count++;
}

function clearAdminFailedLogin(ip) {
  adminFailedLogins.delete(ip);
}

// ---------- GET /admin ----------
router.get('/admin', async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  if (checkAdminRateLimit(ip)) {
    return res.status(429).send('Too many failed login attempts. Please try again later.');
  }

  // HTTP Basic Auth
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Authentication required');
  }

  // Ignore username — extract password after first colon
  let password = '';
  try {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    password = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded;
  } catch {
    password = '';
  }

  // Hash both sides with SHA-256 first (fixed 32 bytes) to eliminate password-length leakage
  const hashA = crypto.createHash('sha256').update(password).digest();
  const hashB = crypto.createHash('sha256').update(config.ADMIN_PASSWORD).digest();
  const isValid = crypto.timingSafeEqual(hashA, hashB);

  if (!isValid) {
    recordAdminFailedLogin(ip);
    if (config.ADMIN_FAILED_DELAY_MS > 0) {
      await new Promise(r => setTimeout(r, config.ADMIN_FAILED_DELAY_MS));
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Invalid credentials');
  }

  clearAdminFailedLogin(ip);

  const statusFilter = req.query.status || '';
  const skuFilter = req.query.sku || '';

  let requests;
  if (statusFilter && skuFilter) {
    requests = stmtRequestsByStatusAndSku.all(statusFilter, skuFilter);
  } else if (statusFilter) {
    requests = stmtRequestsByStatus.all(statusFilter);
  } else if (skuFilter) {
    requests = stmtRequestsBySku.all(skuFilter);
  } else {
    requests = stmtAllRequests.all();
  }

  const counts = {};
  for (const row of stmtCountByStatus.all()) counts[row.status] = row.count;
  const total = Object.values(counts).reduce((s, n) => s + n, 0);

  const skus = [...new Set(db.prepare('SELECT DISTINCT sku FROM requests').all().map(r => r.sku))];

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(adminPage({ requests, counts, total, statusFilter, skuFilter, skus, storeName: config.STORE_NAME }));
});

// ---------- GET /healthz ----------
router.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

// ---------- HTML Builders ----------

function embedPage({ products, soldOut, hasCatalogue, storeName }) {
  const options = hasCatalogue
    ? products.map(p => {
        const label = `${esc(p.name || p.sku)}${p.price ? ` — ${p.currency || 'GBP'} ${p.price}` : ''}${!p.in_stock ? ' (Sold out)' : ' (In stock)'}`;
        return `<option value="${esc(p.sku)}" ${p.in_stock ? 'disabled' : ''} data-in-stock="${p.in_stock}">${label}</option>`;
      }).join('\n')
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Back in Stock Alerts — ${esc(storeName)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --text: #1a1a2e;
      --text-secondary: #555;
      --bg: transparent;
      --input-bg: #ffffff;
      --input-border: #d1d5db;
      --input-focus: #2457d6;
      --btn-bg: linear-gradient(135deg, #2457d6, #1a3fa0);
      --btn-text: #ffffff;
      --success-bg: #ecfdf5;
      --success-text: #065f46;
      --success-border: #6ee7b7;
      --error-bg: #fef2f2;
      --error-text: #991b1b;
      --error-border: #fca5a5;
      --info-bg: #eff6ff;
      --info-text: #1e40af;
      --info-border: #93c5fd;
      --radius: 10px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --text: #e5e7eb;
        --text-secondary: #9ca3af;
        --input-bg: #1f2937;
        --input-border: #374151;
        --input-focus: #6d97ff;
        --btn-bg: linear-gradient(135deg, #3b6df0, #2457d6);
        --success-bg: #064e3b;
        --success-text: #a7f3d0;
        --success-border: #065f46;
        --error-bg: #450a0a;
        --error-text: #fca5a5;
        --error-border: #7f1d1d;
        --info-bg: #1e3a5f;
        --info-text: #93c5fd;
        --info-border: #1e40af;
      }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 16px;
      max-width: 420px;
    }
    h2 {
      font-size: 1.15rem;
      font-weight: 700;
      margin-bottom: 4px;
      letter-spacing: -0.3px;
    }
    .subtitle {
      color: var(--text-secondary);
      font-size: 0.85rem;
      margin-bottom: 16px;
      line-height: 1.4;
    }
    label {
      display: block;
      font-size: 0.85rem;
      font-weight: 600;
      margin-bottom: 4px;
      color: var(--text);
    }
    input, select {
      width: 100%;
      font: inherit;
      font-size: 0.95rem;
      padding: 10px 12px;
      border: 1.5px solid var(--input-border);
      border-radius: var(--radius);
      background: var(--input-bg);
      color: var(--text);
      transition: border-color 0.2s, box-shadow 0.2s;
      margin-bottom: 12px;
      appearance: none;
    }
    input:focus, select:focus {
      outline: none;
      border-color: var(--input-focus);
      box-shadow: 0 0 0 3px rgba(36, 87, 214, 0.15);
    }
    select {
      background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23666' fill='none' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 12px center;
      padding-right: 32px;
    }
    button {
      width: 100%;
      font: inherit;
      font-size: 1rem;
      font-weight: 600;
      padding: 12px;
      border: none;
      border-radius: var(--radius);
      background: var(--btn-bg);
      color: var(--btn-text);
      cursor: pointer;
      transition: opacity 0.2s, transform 0.1s;
      letter-spacing: 0.2px;
    }
    button:hover { opacity: 0.92; }
    button:active { transform: scale(0.98); }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .spinner {
      display: inline-block;
      width: 16px; height: 16px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      vertical-align: middle;
      margin-right: 6px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .msg {
      padding: 10px 14px;
      border-radius: var(--radius);
      font-size: 0.88rem;
      line-height: 1.4;
      margin-top: 12px;
      display: none;
    }
    .msg.success { display: block; background: var(--success-bg); color: var(--success-text); border: 1px solid var(--success-border); }
    .msg.error   { display: block; background: var(--error-bg); color: var(--error-text); border: 1px solid var(--error-border); }
    .msg.info    { display: block; background: var(--info-bg); color: var(--info-text); border: 1px solid var(--info-border); }
    .field-error {
      color: var(--error-text);
      font-size: 0.8rem;
      margin-top: -8px;
      margin-bottom: 8px;
      display: none;
    }
  </style>
</head>
<body>
  <h2>🔔 Get notified when it's back</h2>
  <p class="subtitle">Enter your email and we'll send you a one-time alert as soon as this item is restocked.</p>

  <form id="bis-form" novalidate>
    <label for="bis-email">Email address</label>
    <input type="email" id="bis-email" name="email" placeholder="you@example.com" required autocomplete="email" aria-describedby="email-error">
    <div class="field-error" id="email-error" role="alert"></div>

    <label for="bis-sku">Product</label>
    ${hasCatalogue
      ? `<select id="bis-sku" name="sku" required aria-describedby="sku-error">
           <option value="">Select a product…</option>
           ${options}
         </select>`
      : `<input type="text" id="bis-sku" name="sku" placeholder="Enter product SKU" required aria-describedby="sku-error">`
    }
    <div class="field-error" id="sku-error" role="alert"></div>

    <button type="submit" id="bis-submit">Notify me</button>
  </form>

  <div class="msg" id="bis-msg" role="status" aria-live="polite"></div>

  <script>
  (function() {
    const form = document.getElementById('bis-form');
    const emailInput = document.getElementById('bis-email');
    const skuInput = document.getElementById('bis-sku');
    const btn = document.getElementById('bis-submit');
    const msgEl = document.getElementById('bis-msg');
    const emailErr = document.getElementById('email-error');
    const skuErr = document.getElementById('sku-error');

    function showFieldError(el, msg) {
      el.textContent = msg;
      el.style.display = 'block';
    }
    function clearFieldError(el) {
      el.textContent = '';
      el.style.display = 'none';
    }
    function showMsg(type, text) {
      msgEl.className = 'msg ' + type;
      msgEl.textContent = text;
    }
    function hideMsg() {
      msgEl.className = 'msg';
      msgEl.textContent = '';
    }

    emailInput.addEventListener('input', () => clearFieldError(emailErr));
    skuInput.addEventListener('input', () => clearFieldError(skuErr));
    skuInput.addEventListener('change', () => clearFieldError(skuErr));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideMsg();
      clearFieldError(emailErr);
      clearFieldError(skuErr);

      const email = emailInput.value.trim();
      const sku = skuInput.value.trim();
      let valid = true;

      if (!email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
        showFieldError(emailErr, 'Please enter a valid email address');
        valid = false;
      }
      if (!sku) {
        showFieldError(skuErr, 'Please select or enter a product');
        valid = false;
      }
      if (!valid) return;

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Submitting…';

      try {
        const res = await fetch('/api/requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, sku }),
        });
        const data = await res.json();

        if (res.status === 429) {
          showMsg('error', 'Too many requests. Please wait a moment and try again.');
        } else if (res.status >= 400) {
          showMsg('error', data.error || 'Something went wrong. Please try again.');
        } else if (data.inStock) {
          showMsg('info', data.message);
        } else if (data.alreadySubscribed) {
          showMsg('info', data.message);
        } else {
          showMsg('success', data.message || "You're on the list! We'll email you once, as soon as it's back.");
          form.reset();
        }
      } catch (err) {
        showMsg('error', 'Network error. Please check your connection and try again.');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Notify me';
      }
    });
  })();
  </script>
</body>
</html>`;
}

function adminPage({ requests, counts, total, statusFilter, skuFilter, skus, storeName }) {
  const statusBadge = (status) => {
    const colors = {
      pending: '#eab308',
      sending: '#3b82f6',
      notified: '#22c55e',
      failed: '#ef4444',
    };
    const color = colors[status] || '#888';
    return `<span style="display:inline-block;padding:2px 8px;border-radius:9999px;font-size:12px;font-weight:600;background:${color}22;color:${color};border:1px solid ${color}44;">${esc(status)}</span>`;
  };

  const rows = requests.map(r => `
    <tr>
      <td>${esc(r.email)}</td>
      <td><code>${esc(r.sku)}</code>${r.product_name ? `<br><small style="color:var(--muted)">${esc(r.product_name)}</small>` : ''}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${esc(r.created_at || '')}</td>
      <td>${esc(r.notified_at || '—')}</td>
      <td>${r.attempts}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(r.last_error || '')}">${esc(r.last_error || '—')}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — Back in Stock Alerts</title>
  <style>
    :root { --bg:#f5f6f7; --card:#fff; --text:#16191d; --muted:#5f6b76; --border:#dde1e5; --accent:#2457d6; }
    @media (prefers-color-scheme:dark) { :root { --bg:#111417; --card:#1a1e23; --text:#e6e9ec; --muted:#98a3ad; --border:#2d333a; --accent:#6d97ff; } }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; }
    main { max-width:1100px; margin:0 auto; padding:28px 16px 64px; }
    h1 { font-size:1.5rem; margin:0 0 4px; }
    .muted { color:var(--muted); }
    .card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px; margin-bottom:14px; overflow-x:auto; }
    .stats { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
    .stat { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:12px 16px; min-width:100px; text-align:center; }
    .stat-value { font-size:1.5rem; font-weight:700; }
    .stat-label { font-size:0.8rem; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; }
    .filters { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:16px; }
    select, input { font:inherit; color:var(--text); background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:6px 10px; }
    button { font:inherit; font-weight:600; border:0; border-radius:6px; padding:7px 14px; background:var(--accent); color:#fff; cursor:pointer; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); vertical-align:top; }
    th { color:var(--muted); font-weight:600; white-space:nowrap; }
    code { font-family:ui-monospace,Consolas,monospace; font-size:12px; }
    @media (max-width: 768px) {
      table { font-size:12px; }
      th, td { padding:6px 4px; }
    }
  </style>
</head>
<body>
<main>
  <h1>📦 Back in Stock — Admin</h1>
  <p class="muted" style="margin-bottom:16px;">${esc(storeName)} • ${total} total request${total !== 1 ? 's' : ''}</p>

  <div class="stats">
    <div class="stat"><div class="stat-value">${counts.pending || 0}</div><div class="stat-label">Pending</div></div>
    <div class="stat"><div class="stat-value">${counts.sending || 0}</div><div class="stat-label">Sending</div></div>
    <div class="stat"><div class="stat-value">${counts.notified || 0}</div><div class="stat-label">Notified</div></div>
    <div class="stat"><div class="stat-value">${counts.failed || 0}</div><div class="stat-label">Failed</div></div>
  </div>

  <form class="filters" method="get" action="/admin">
    <select name="status">
      <option value="">All statuses</option>
      <option value="pending" ${statusFilter === 'pending' ? 'selected' : ''}>Pending</option>
      <option value="sending" ${statusFilter === 'sending' ? 'selected' : ''}>Sending</option>
      <option value="notified" ${statusFilter === 'notified' ? 'selected' : ''}>Notified</option>
      <option value="failed" ${statusFilter === 'failed' ? 'selected' : ''}>Failed</option>
    </select>
    <select name="sku">
      <option value="">All SKUs</option>
      ${skus.map(s => `<option value="${esc(s)}" ${skuFilter === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
    </select>
    <button type="submit">Filter</button>
  </form>

  <div class="card">
    <table>
      <thead>
        <tr>
          <th>Email</th>
          <th>SKU</th>
          <th>Status</th>
          <th>Created</th>
          <th>Notified</th>
          <th>Attempts</th>
          <th>Last Error</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px;">No requests found</td></tr>'}
      </tbody>
    </table>
  </div>
</main>
</body>
</html>`;
}

module.exports = router;
