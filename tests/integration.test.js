'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

// ─── Mini mock stock + email harness ─────────────────────────────────

let mockServer;
let mockPort;
const stockCatalogue = [
  { sku: 'TEST-SKU-1', name: 'Test Product 1', price: 25, currency: 'GBP', category: 'Test', quantity: 0, in_stock: false },
  { sku: 'TEST-SKU-2', name: 'Test Product 2', price: 50, currency: 'GBP', category: 'Test', quantity: 10, in_stock: true },
];
let stockState = {};        // sku -> { quantity, in_stock }
let stockCheckCalls = [];
let emailsSent = [];
let failNextEmails = 0;
let processedIdempotencyKeys = new Map(); // key -> response id

function resetMock() {
  stockState = {
    'TEST-SKU-1': { quantity: 0, in_stock: false },
    'TEST-SKU-2': { quantity: 10, in_stock: true },
  };
  stockCheckCalls = [];
  emailsSent = [];
  failNextEmails = 0;
  processedIdempotencyKeys.clear();
}

function startMockServer() {
  return new Promise((resolve) => {
    mockServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;

      // Stock API: GET /api/stock/:sku
      const skuMatch = p.match(/^\/api\/stock\/(.+)$/);
      if (req.method === 'GET' && skuMatch) {
        const sku = decodeURIComponent(skuMatch[1]);
        stockCheckCalls.push(sku);
        const item = stockState[sku];
        const cat = stockCatalogue.find(c => c.sku === sku);
        const quantity = item ? item.quantity : 0;
        const in_stock = item ? item.in_stock : false;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          sku,
          name: cat?.name || `Item ${sku}`,
          price: cat?.price || 10,
          currency: 'GBP',
          quantity,
          in_stock,
        }));
        return;
      }

      // Stock catalogue: GET /api/stock
      if (req.method === 'GET' && p === '/api/stock') {
        const products = stockCatalogue.map(c => ({
          ...c,
          quantity: stockState[c.sku]?.quantity ?? c.quantity,
          in_stock: stockState[c.sku]?.in_stock ?? c.in_stock,
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ products }));
        return;
      }

      // Email API: POST /emails
      if (req.method === 'POST' && p === '/emails') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const idemKey = req.headers['idempotency-key'] || null;

        // Handle idempotency
        if (idemKey && processedIdempotencyKeys.has(idemKey)) {
          const prevId = processedIdempotencyKeys.get(idemKey);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: prevId }));
          return;
        }

        if (failNextEmails > 0) {
          failNextEmails--;
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ statusCode: 500, message: 'Injected failure' }));
          return;
        }

        const id = crypto.randomUUID();
        emailsSent.push({ id, to: body.to, subject: body.subject, html: body.html, text: body.text, idemKey });
        if (idemKey) processedIdempotencyKeys.set(idemKey, id);

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id }));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });
}

// ─── Helper to spawn the actual app ─────────────────────────────────

const { execSync, spawn } = require('node:child_process');
let appProcess;
let appPort;
let currentAppDataDir;

function startApp(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    appPort = 3100 + Math.floor(Math.random() * 900);
    const dataDir = extraEnv.DATA_DIR || path.join(__dirname, '..', 'data', 'test-' + Date.now());
    currentAppDataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });

    const env = {
      ...process.env,
      PORT: String(appPort),
      DATA_DIR: dataDir,
      STOCK_API_URL: `http://127.0.0.1:${mockPort}/api/stock`,
      STOCK_API_KEY: 'test-key',
      RESEND_API_KEY: 'test-key',
      RESEND_BASE_URL: `http://127.0.0.1:${mockPort}`,
      WEBHOOK_SECRET: 'test-webhook-secret',
      ADMIN_PASSWORD: 'test-admin-password',
      STORE_NAME: 'Test Store',
      FROM_EMAIL: 'test@example.com',
      NODE_ENV: 'test',
      ...extraEnv,
    };

    // Don't load .env in test
    delete env.DOTENV_CONFIG_PATH;

    appProcess = spawn('node', [path.join(__dirname, '..', 'server.js')], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let started = false;
    const onData = (data) => {
      const line = data.toString();
      if (line.includes('"msg":"Server started"') && !started) {
        started = true;
        resolve({ port: appPort, dataDir });
      }
    };

    appProcess.stdout.on('data', onData);
    appProcess.stderr.on('data', onData);

    appProcess.on('error', reject);
    appProcess.on('exit', (code) => {
      if (!started) reject(new Error(`App exited with code ${code}`));
    });

    // Timeout
    setTimeout(() => {
      if (!started) reject(new Error('App did not start in time'));
    }, 10000);
  });
}

function stopApp() {
  return new Promise((resolve) => {
    if (!appProcess) return resolve();
    const proc = appProcess;
    appProcess = null;
    proc.on('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve();
    }, 5000);
  });
}

// ─── HTTP helpers ───────────────────────────────────────────────────

function request(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `http://127.0.0.1:${appPort}`);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { ...headers },
    };
    if (body) {
      const data = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['content-type'] = 'application/json';
      opts.headers['content-length'] = Buffer.byteLength(data);
    }
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function postWebhook(payload, secret = 'test-webhook-secret') {
  return request('POST', '/webhooks/stock', {
    body: payload,
    headers: { 'x-webhook-secret': secret },
  });
}

function postRequest(email, sku) {
  return request('POST', '/api/requests', { body: { email, sku } });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Tests ──────────────────────────────────────────────────────────

describe('Back-in-Stock Service', () => {
  before(async () => {
    resetMock();
    await startMockServer();
    await startApp();
  });

  after(async () => {
    await stopApp();
    mockServer.close();
  });

  describe('GET /healthz', () => {
    it('returns 200 ok', async () => {
      const res = await request('GET', '/healthz');
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
    });
  });

  describe('POST /api/requests — validation', () => {
    it('rejects missing email', async () => {
      const res = await postRequest('', 'TEST-SKU-1');
      assert.equal(res.status, 400);
    });

    it('rejects invalid email', async () => {
      const res = await postRequest('not-an-email', 'TEST-SKU-1');
      assert.equal(res.status, 400);
    });

    it('rejects missing sku', async () => {
      const res = await postRequest('test@example.com', '');
      assert.equal(res.status, 400);
    });

    it('rejects invalid sku characters', async () => {
      const res = await postRequest('test@example.com', 'sku with spaces!');
      assert.equal(res.status, 400);
    });

    it('rejects body too large', async () => {
      const res = await request('POST', '/api/requests', {
        body: JSON.stringify({ email: 'a'.repeat(20000), sku: 'X' }),
        headers: { 'content-type': 'application/json' },
      });
      assert.ok(res.status === 413 || res.status === 400);
    });
  });

  describe('POST /api/requests — duplicate handling', () => {
    it('creates a request for a sold-out item', async () => {
      const res = await postRequest('dup-test@example.com', 'TEST-SKU-1');
      assert.equal(res.status, 201);
      assert.ok(res.json.subscribed);
    });

    it('returns friendly message for duplicate', async () => {
      const res = await postRequest('dup-test@example.com', 'TEST-SKU-1');
      assert.ok(res.status === 200 || res.status === 409);
      assert.ok(res.json.alreadySubscribed);
    });
  });

  describe('POST /api/requests — in-stock item', () => {
    it('tells user item is in stock', async () => {
      const res = await postRequest('stock-test@example.com', 'TEST-SKU-2');
      assert.equal(res.status, 200);
      assert.ok(res.json.inStock);
    });
  });

  describe('POST /webhooks/stock — authentication', () => {
    it('rejects missing secret with 401', async () => {
      const res = await request('POST', '/webhooks/stock', {
        body: { event_id: 'e1', sku: 'TEST-SKU-1', quantity: 5 },
      });
      assert.equal(res.status, 401);
    });

    it('rejects wrong secret with 401', async () => {
      const res = await postWebhook(
        { event_id: 'e2', sku: 'TEST-SKU-1', quantity: 5 },
        'wrong-secret'
      );
      assert.equal(res.status, 401);
    });
  });

  describe('POST /webhooks/stock — validation', () => {
    it('rejects missing event_id', async () => {
      const res = await postWebhook({ sku: 'TEST-SKU-1', quantity: 5 });
      assert.equal(res.status, 400);
    });

    it('rejects missing sku', async () => {
      const res = await postWebhook({ event_id: 'e3', quantity: 5 });
      assert.equal(res.status, 400);
    });

    it('rejects missing quantity', async () => {
      const res = await postWebhook({ event_id: 'e4', sku: 'TEST-SKU-1' });
      assert.equal(res.status, 400);
    });
  });

  describe('POST /webhooks/stock — idempotency', () => {
    it('same event_id sent twice sequentially → processed once', async () => {
      // Set up: create a request for TEST-SKU-1
      await postRequest('idempotent-test@example.com', 'TEST-SKU-1');

      // Restock
      stockState['TEST-SKU-1'] = { quantity: 5, in_stock: true };
      emailsSent = [];

      const eventId = 'evt-idem-' + Date.now();
      const res1 = await postWebhook({ event_id: eventId, sku: 'TEST-SKU-1', quantity: 5 });
      assert.equal(res1.status, 202);

      // Wait for async processing
      await sleep(2000);

      const res2 = await postWebhook({ event_id: eventId, sku: 'TEST-SKU-1', quantity: 5 });
      assert.equal(res2.status, 200);
      assert.ok(res2.json.duplicate);

      // Give time for any double processing
      await sleep(1000);

      // Only one email should have been sent for this user
      const sent = emailsSent.filter(e => e.to?.includes('idempotent-test@example.com'));
      assert.equal(sent.length, 1, `Expected 1 email, got ${sent.length}`);

      // Reset stock for other tests
      stockState['TEST-SKU-1'] = { quantity: 0, in_stock: false };
    });

    it('same event_id sent 20x concurrently → processed once', async () => {
      // New request
      await postRequest('concurrent-test@example.com', 'TEST-SKU-1');
      stockState['TEST-SKU-1'] = { quantity: 5, in_stock: true };
      emailsSent = [];

      const eventId = 'evt-concurrent-' + Date.now();
      const promises = Array.from({ length: 20 }, () =>
        postWebhook({ event_id: eventId, sku: 'TEST-SKU-1', quantity: 5 })
      );
      const results = await Promise.all(promises);

      // Exactly one 202, rest should be 200 (duplicate)
      const accepted = results.filter(r => r.status === 202);
      const dupes = results.filter(r => r.status === 200 && r.json?.duplicate);
      assert.equal(accepted.length, 1, `Expected exactly 1 accepted, got ${accepted.length}`);
      assert.equal(dupes.length, 19, `Expected 19 duplicates, got ${dupes.length}`);

      // Wait for async processing
      await sleep(3000);

      const sent = emailsSent.filter(e => e.to?.includes('concurrent-test@example.com'));
      assert.equal(sent.length, 1, `Expected 1 email, got ${sent.length}`);

      stockState['TEST-SKU-1'] = { quantity: 0, in_stock: false };
    });
  });

  describe('Phantom webhook — stock API says sold out', () => {
    it('does not send email when stock API says not in stock', async () => {
      await postRequest('phantom-test@example.com', 'TEST-SKU-1');
      stockState['TEST-SKU-1'] = { quantity: 0, in_stock: false }; // Still sold out
      emailsSent = [];

      const res = await postWebhook({
        event_id: 'evt-phantom-' + Date.now(),
        sku: 'TEST-SKU-1',
        quantity: 10,  // Webhook lies about quantity
      });
      assert.equal(res.status, 202);

      await sleep(2000);

      const sent = emailsSent.filter(e => e.to?.includes('phantom-test@example.com'));
      assert.equal(sent.length, 0, 'Should not send email for phantom restock');
    });
  });

  describe('Email API failure → retry and deliver exactly once', () => {
    it('retries after 500 and eventually delivers', async () => {
      await postRequest('retry-test@example.com', 'TEST-SKU-1');
      stockState['TEST-SKU-1'] = { quantity: 5, in_stock: true };
      emailsSent = [];
      failNextEmails = 1; // Fail the first attempt

      const res = await postWebhook({
        event_id: 'evt-retry-' + Date.now(),
        sku: 'TEST-SKU-1',
        quantity: 5,
      });
      assert.equal(res.status, 202);

      // Wait for retry cycle (worker runs every 10s, retry after backoff)
      await sleep(15000);

      const sent = emailsSent.filter(e => e.to?.includes('retry-test@example.com'));
      assert.equal(sent.length, 1, `Expected exactly 1 email after retry, got ${sent.length}`);

      stockState['TEST-SKU-1'] = { quantity: 0, in_stock: false };
    });
  });

  describe('GET /admin — auth hardening', () => {
    it('requires authentication', async () => {
      const res = await request('GET', '/admin');
      assert.equal(res.status, 401);
    });

    it('returns 200 with valid credentials regardless of username', async () => {
      const creds = Buffer.from('different-user:test-admin-password').toString('base64');
      const res = await request('GET', '/admin', {
        headers: { 'authorization': `Basic ${creds}` },
      });
      assert.equal(res.status, 200);
      assert.ok(res.text.includes('Back in Stock'));
    });

    it('rejects invalid password with 401', async () => {
      const creds = Buffer.from('admin:wrong-password').toString('base64');
      const res = await request('GET', '/admin', {
        headers: { 'authorization': `Basic ${creds}` },
      });
      assert.equal(res.status, 401);
      assert.equal(res.text, 'Invalid credentials');
    });

    it('rate limits after repeated failed logins', async () => {
      const creds = Buffer.from('admin:bad-pass').toString('base64');
      // Send failed attempts up to the threshold (5)
      for (let i = 0; i < 4; i++) {
        await request('GET', '/admin', { headers: { 'authorization': `Basic ${creds}` } });
      }
      // 5th attempt: should record failure and 6th should be 429
      await request('GET', '/admin', { headers: { 'authorization': `Basic ${creds}` } });
      const res = await request('GET', '/admin', { headers: { 'authorization': `Basic ${creds}` } });
      assert.equal(res.status, 429);
      assert.ok(res.text.includes('Too many failed login attempts'));
    });
  });

  describe('GET /embed', () => {
    it('returns form page without X-Frame-Options', async () => {
      const res = await request('GET', '/embed');
      assert.equal(res.status, 200);
      assert.ok(res.text.includes('Notify me'));
      assert.ok(!res.headers['x-frame-options']);
      assert.ok(res.headers['content-security-policy']?.includes('frame-ancestors *'));
    });
  });

  describe('Email polish — currency formatting & shop URL', () => {
    const { formatPrice, resolveShopUrl } = require('../src/emailTemplate');

    it('formats price with Intl.NumberFormat currency symbol', () => {
      assert.equal(formatPrice(24, 'GBP'), '£24.00');
      assert.equal(formatPrice(50.5, 'USD'), '$50.50');
      assert.equal(formatPrice(100, 'EUR'), '€100.00');
      assert.equal(formatPrice(null, 'GBP'), '');
    });

    it('resolves product URL with template or hides when unset', () => {
      assert.equal(resolveShopUrl('SKU-1', null), null);
      assert.equal(resolveShopUrl('SKU-1', 'https://override.example.com'), 'https://override.example.com');
    });
  });

  describe('Stock check load reduction & coalescing', () => {
    it('webhook-triggered checks for the same SKU at the same moment share one stock API call', async () => {
      await postRequest('coalesce-test@example.com', 'TEST-SKU-1');
      stockState['TEST-SKU-1'] = { quantity: 10, in_stock: true };
      emailsSent = [];
      stockCheckCalls = [];

      // Send 5 webhooks for the same SKU at the exact same moment with distinct event IDs
      const promises = Array.from({ length: 5 }, (_, i) =>
        postWebhook({ event_id: `evt-coalesce-${Date.now()}-${i}`, sku: 'TEST-SKU-1', quantity: 10 })
      );
      const responses = await Promise.all(promises);
      for (const r of responses) {
        assert.equal(r.status, 202);
      }

      // Wait for async processing
      await sleep(2500);

      // Verify that all 5 webhook checks coalesced into a single stock API call
      const checks = stockCheckCalls.filter(s => s === 'TEST-SKU-1');
      assert.equal(checks.length, 1, `Expected exactly 1 stock check call for coalesced webhooks, got ${checks.length}`);

      // Reset stock
      stockState['TEST-SKU-1'] = { quantity: 0, in_stock: false };
    });
  });

  describe('Restart recovery (Requirement 4)', () => {
    it('(a) pending request restocked while offline → exactly one email sent on startup', async () => {
      const email = `restart-pending-${Date.now()}@example.com`;
      stockState['TEST-SKU-1'] = { quantity: 0, in_stock: false };
      await postRequest(email, 'TEST-SKU-1');

      emailsSent = [];

      // Stop the running application
      await stopApp();

      // Product is restocked while the application is down; no webhook arrives
      stockState['TEST-SKU-1'] = { quantity: 10, in_stock: true };

      // Restart application with the existing DATA_DIR
      await startApp({ DATA_DIR: currentAppDataDir });

      // Startup reconcile worker runs and detects stock
      await sleep(3000);

      const sent = emailsSent.filter(e => e.to?.includes(email));
      assert.equal(sent.length, 1, `Expected exactly 1 email sent on restart, got ${sent.length}`);

      // Verify email formatting contains currency symbol
      assert.ok(sent[0].html.includes('£25.00'), 'Email HTML should contain formatted price £25.00');

      stockState['TEST-SKU-1'] = { quantity: 0, in_stock: false };
    });

    it('(b) request stuck in sending (crash mid-flight simulation) → recovered and exactly one email sent', async () => {
      const email = `restart-stuck-${Date.now()}@example.com`;
      stockState['TEST-SKU-1'] = { quantity: 0, in_stock: false };
      await postRequest(email, 'TEST-SKU-1');

      emailsSent = [];

      // Stop the running application
      await stopApp();

      // Directly update database to simulate a process crash while sending (> 5 min ago)
      const Database = require('better-sqlite3');
      const directDb = new Database(path.join(currentAppDataDir, 'back-in-stock.db'));
      directDb.prepare(`
        UPDATE requests
        SET status = 'sending',
            attempts = 1,
            updated_at = datetime('now', '-10 minutes')
        WHERE email = ? AND sku = 'TEST-SKU-1'
      `).run(email);
      directDb.close();

      // Product is in stock
      stockState['TEST-SKU-1'] = { quantity: 10, in_stock: true };

      // Restart application with the existing DATA_DIR
      await startApp({ DATA_DIR: currentAppDataDir });

      // Startup stale recovery resets sending -> pending, and reconcile delivers email
      await sleep(3000);

      const sent = emailsSent.filter(e => e.to?.includes(email));
      assert.equal(sent.length, 1, `Expected exactly 1 email sent after crash recovery, got ${sent.length}`);

      // Verify the request is now marked notified
      const verifyDb = new Database(path.join(currentAppDataDir, 'back-in-stock.db'));
      const row = verifyDb.prepare('SELECT status FROM requests WHERE email = ?').get(email);
      verifyDb.close();
      assert.equal(row.status, 'notified');

      stockState['TEST-SKU-1'] = { quantity: 0, in_stock: false };
    });
  });
});
