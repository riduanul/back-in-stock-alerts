# Back-in-Stock Email Alerts

Customers sign up to be emailed when a sold-out product comes back in stock. They submit their email + product SKU via an embeddable form (iframe). When the product is genuinely restocked, each waiting customer gets exactly one email.

## Quick start (local)

```bash
cp .env.example .env
# Edit .env with your real keys (from the test harness or production)
npm install
npm start
# Server starts on http://localhost:3000
```

## Docker

```bash
docker build -t back-in-stock .
docker run -p 3000:3000 --env-file .env -v bis-data:/app/data back-in-stock
```

> **Note:** SQLite needs a persistent volume mounted at `DATA_DIR` (default `/app/data`). Without a volume, data is lost when the container restarts.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `STOCK_API_URL` | ✅ | — | Base URL for the stock API (`GET /{sku}` and `GET /` catalogue) |
| `STOCK_API_KEY` | ✅ | — | Bearer token for the stock API |
| `RESEND_API_KEY` | ✅ | — | API key for the Resend-compatible email API |
| `RESEND_BASE_URL` | ✅ | — | Base URL for the email API (send `POST /emails`) |
| `WEBHOOK_SECRET` | ✅ | — | Shared secret for webhook verification |
| `ADMIN_PASSWORD` | ✅ | — | Password for the `/admin` dashboard (HTTP Basic auth) |
| `PORT` | | `3000` | Port to listen on |
| `DATA_DIR` | | `./data` | Directory for the SQLite database file |
| `STORE_NAME` | | `Demo Store` | Store name used in the UI and emails |
| `STORE_URL` | | — | URL for the "Shop now" button in emails |
| `STORE_PRODUCT_URL_TEMPLATE` | | — | Template URL for product pages (e.g. `https://store.com/products/{sku}`) |
| `FROM_EMAIL` | | `alerts@example.com` | Sender address for notification emails |
| `RECONCILE_INTERVAL_MS` | | `60000` | Reconcile sweep interval in ms |
| `LOG_LEVEL` | | `info` | Minimum log level (`debug`, `info`, `warn`, `error`) |

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/embed` | Embeddable form (iframe-friendly) for email + SKU signup |
| `POST` | `/api/requests` | JSON `{ email, sku }` — create a notification request |
| `POST` | `/webhooks/stock` | Webhook receiver for stock updates. Header: `X-Webhook-Secret` |
| `GET` | `/admin` | Admin dashboard (HTTP Basic auth) with request table, filters, stats |
| `GET` | `/healthz` | Health check endpoint — returns `{ ok: true }` |

## How we prevent duplicate or missed emails

This is the core reliability guarantee. Multiple layers work together:

### 1. Database unique constraint for open requests
A partial unique index `(email, sku) WHERE status IN ('pending', 'sending')` prevents duplicate signup rows at the database level, even under concurrent inserts.

### 2. Event ID idempotency
Every webhook carries an `event_id`. The `processed_events` table has a `UNIQUE` constraint on `event_id`. The same event delivered twice (even simultaneously) is processed exactly once — the second insert fails and returns 200.

### 3. Atomic claim before send
Before sending an email, the worker does `UPDATE ... SET status='sending' WHERE id=? AND status='pending'` and checks `changes === 1`. This is an atomic compare-and-swap. If two workers race on the same request, only one succeeds — the other sees `changes === 0` and skips.

### 4. Idempotency-Key on the email call
Every email send includes an `Idempotency-Key: notify-{requestId}` header. If the app crashes after sending but before marking the DB, the retry will hit the email API with the same key, which returns the cached success instead of sending a second email.

### 5. Retry with exponential backoff
If the email API returns 500 or times out, the request stays retryable: `status` goes back to `pending` with a `next_retry_at` set via exponential backoff + jitter. After `MAX_EMAIL_ATTEMPTS` (default 5), it moves to `failed`.

### 6. Startup recovery
On startup, requests stuck in `sending` for more than 5 minutes (crashed mid-flight) are reset to `pending`. The idempotency key ensures no duplicate email even if the first send actually went through.

### 7. Reconcile worker
A periodic background worker checks the stock API for every SKU that has open requests. This catches missed or lost webhooks — if a product came back while the app was down, the reconcile loop picks it up.

### 8. Never trust the webhook
The webhook payload's `quantity` is only a hint. On every webhook, the worker calls `GET {STOCK_API_URL}/{sku}` with the API key and only proceeds if the stock API confirms `in_stock: true`. This prevents phantom notifications from lying webhook payloads.

## Architecture

```
server.js              → Express app entry point, graceful shutdown
src/
  config.js            → Environment variable loading + validation
  db.js                → SQLite schema, WAL mode, indexes
  routes.js            → All HTTP endpoints
  worker.js            → Background notification worker, retry, reconcile
  stockApi.js          → HTTP clients for stock + email APIs (with timeouts)
  emailTemplate.js     → HTML + plain-text email builder
  rateLimit.js         → In-memory per-IP rate limiter
  logger.js            → Structured JSON logger (masks secrets + emails)
tests/
  integration.test.js  → Automated tests
```

## Running tests

```bash
npm test
```

## Which AI tools were used

## AI tools used and time taken


- **Google Antigravity (agent)**: wrote the implementation, tests and Dockerfile from a detailed spec I prepared, and later made the follow-up improvements (lower stock-check load, currency formatting, admin hardening, more tests).
- **Claude (Anthropic)**: used for planning, writing the specs and prompts, and reviewing the results.

**What I did myself**
- Ran the full test suite and built and ran the Docker image locally.
- Tested the app end to end against the challenge harness through a Cloudflare tunnel: duplicate and concurrent webhooks, a phantom restock (webhook says in stock, stock API says sold out), an injected email 500 with retry, and a restart with a missed webhook.
- Checked that no secrets are committed.

**Time taken:** about X hours in total, including testing against the harness and the follow-up improvements. The first working version was ready after roughly Y minutes.
