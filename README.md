# Back-in-Stock Email Alerts

A reliable back-in-stock notification system that allows customers to subscribe to sold-out products and automatically receive an email when those products become available again.

Customers submit their email address and product SKU through an embeddable form. When a product is genuinely restocked, every eligible customer receives exactly one notification email.

## Live Demo & Source Code

- **Live Application:** [https://back-in-stock-alerts-production-261d.up.railway.app/](https://back-in-stock-alerts-production-261d.up.railway.app/)
- **GitHub Repository:** [https://github.com/riduanul/back-in-stock-alerts](https://github.com/riduanul/back-in-stock-alerts)

## Features

- Embeddable, iframe-friendly subscription form.
- Email and product SKU-based notification requests.
- Secure stock webhook verification.
- Real-time stock verification against the stock API.
- Password-protected admin dashboard.
- Reliable email notifications with retry handling.
- Webhook idempotency and duplicate notification prevention.
- SQLite persistence with recovery after application restarts.
- Background stock reconciliation to detect missed webhooks.
- Docker support for consistent deployment.

## Quick Start (Local)

Clone the repository:

```bash
git clone https://github.com/riduanul/back-in-stock-alerts.git
cd back-in-stock-alerts
```

Install dependencies and configure environment variables:

```bash
cp .env.example .env
```

Edit `.env` with the required credentials from the challenge harness or your environment.

Install dependencies and start the application:

```bash
npm install
npm start
```

The server starts at:

```text
http://localhost:3000
```

## Docker

Build the Docker image:

```bash
docker build -t back-in-stock .
```

Run the application:

```bash
docker run -p 3000:3000 --env-file .env -v bis-data:/app/data back-in-stock
```

> **Important:** SQLite requires a persistent volume mounted at `DATA_DIR` (default: `/app/data`). Without persistent storage, database data may be lost when the container is recreated.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `STOCK_API_URL` | Yes | — | Base URL for the stock API (`GET /{sku}` and `GET /` catalogue) |
| `STOCK_API_KEY` | Yes | — | Bearer token for the stock API |
| `RESEND_API_KEY` | Yes | — | API key for the Resend-compatible email API |
| `RESEND_BASE_URL` | Yes | — | Base URL for the email API (`POST /emails`) |
| `WEBHOOK_SECRET` | Yes | — | Shared secret used for webhook verification |
| `ADMIN_PASSWORD` | Yes | — | Password for the `/admin` dashboard (HTTP Basic Auth) |
| `PORT` | No | `3000` | Application server port |
| `DATA_DIR` | No | `./data` | Directory for the SQLite database |
| `STORE_NAME` | No | `Demo Store` | Store name displayed in the UI and emails |
| `STORE_URL` | No | — | URL used for the "Shop Now" button |
| `STORE_PRODUCT_URL_TEMPLATE` | No | — | Product page URL template, e.g. `https://store.com/products/{sku}` |
| `FROM_EMAIL` | No | `alerts@example.com` | Sender email address |
| `RECONCILE_INTERVAL_MS` | No | `60000` | Background reconciliation interval in milliseconds |
| `LOG_LEVEL` | No | `info` | Logging level: `debug`, `info`, `warn`, or `error` |

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/embed` | Embeddable subscription form for email and SKU |
| `POST` | `/api/requests` | Creates a notification request using `{ email, sku }` |
| `POST` | `/webhooks/stock` | Receives stock update webhooks; requires `X-Webhook-Secret` |
| `GET` | `/admin` | Password-protected admin dashboard with requests, filters, and statistics |
| `GET` | `/healthz` | Health check endpoint returning `{ "ok": true }` |

## Reliability: Preventing Duplicate or Missed Emails

Reliability is a core part of this implementation. Multiple layers work together to ensure customers receive notifications correctly, even when webhooks are duplicated, requests run concurrently, or the application restarts.

### 1. Database-Level Duplicate Prevention

A partial unique index on `(email, sku)` for requests with `pending` or `sending` status prevents duplicate active subscription requests, including concurrent inserts.

### 2. Webhook Event Idempotency

Every webhook includes an `event_id`. The `processed_events` table enforces a unique constraint on this ID, ensuring the same event is processed only once, even when delivered multiple times or simultaneously.

### 3. Atomic Notification Claiming

Before sending an email, the worker atomically changes a request from `pending` to `sending`:

```sql
UPDATE requests
SET status = 'sending'
WHERE id = ? AND status = 'pending';
```

The worker checks the affected row count. Only one worker can successfully claim a request, preventing concurrent duplicate sends.

### 4. Email API Idempotency

Each email request includes an idempotency key:

```text
Idempotency-Key: notify-{requestId}
```

If the application crashes after the email API accepts a message but before the database is updated, retrying with the same key helps prevent a second email, provided the email API honors idempotency keys.

### 5. Retry with Exponential Backoff

When the email API returns an error or times out, the request remains retryable. The system schedules another attempt using exponential backoff with jitter.

After `MAX_EMAIL_ATTEMPTS` (default: 5), the request is marked as `failed`.

### 6. Startup Recovery

On startup, requests that remain in `sending` status for more than five minutes are reset to `pending`.

The email idempotency key helps prevent duplicate notifications during recovery.

### 7. Background Stock Reconciliation

A periodic background worker checks the stock API for products with active notification requests.

This helps detect missed or lost webhooks. If a product comes back in stock while the application is unavailable, the reconciliation process can identify the restock and trigger the notification.

### 8. Independent Stock Verification

The system never blindly trusts webhook payloads.

The webhook's `quantity` is treated as a hint. Before sending notifications, the application queries:

```text
GET {STOCK_API_URL}/{sku}
```

It proceeds only when the authenticated stock API confirms `in_stock: true`, preventing false notifications caused by misleading webhook payloads.

## Architecture

```text
server.js
  └── Express application entry point and graceful shutdown

src/
  ├── config.js          Environment variable loading and validation
  ├── db.js              SQLite schema, WAL mode, and indexes
  ├── routes.js           HTTP API endpoints
  ├── worker.js           Background notification worker, retry, and reconciliation
  ├── stockApi.js         Stock and email API clients with timeouts
  ├── emailTemplate.js    HTML and plain-text email templates
  ├── rateLimit.js        In-memory per-IP rate limiter
  └── logger.js           Structured JSON logging with secret and email masking

tests/
  └── integration.test.js Integration tests
```

## Running Tests

Run the automated test suite:

```bash
npm test
```

## AI Tools Used

- **Google Antigravity (AI Agent):** Used to implement the application, write tests, create the Dockerfile, and make follow-up improvements based on my technical specifications.
- **Claude (Anthropic):** Used for planning, preparing technical specifications and prompts, and reviewing implementation decisions.

## What I Did Personally

- Prepared technical specifications and implementation requirements.
- Ran the complete test suite.
- Built and ran the Docker image locally.
- Tested the application end-to-end against the challenge harness through a Cloudflare Tunnel.
- Verified duplicate and concurrent webhook handling.
- Tested phantom restocks where the webhook reports availability but the stock API reports the product as sold out.
- Tested email API failures, retry behavior, and recovery after application restarts.
- Checked that no secrets were committed to the repository.

## Time Taken

**Approximately 2 hours**, including implementation, testing, reliability improvements, and deployment.