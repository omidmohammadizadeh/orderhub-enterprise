# Production Environment Variables — Reference

> Last updated: Phase Z — Cloud Deployment & Production Infrastructure (2026-05-19)
>
> This file documents every environment variable the OrderHub platform consumes.
> **Never commit actual values to the repository.**
> Copy `.env.staging.example` as a starting point and fill in real values.

---

## Critical — API will refuse to start without these

| Variable | Required By | Description | How to generate |
|---|---|---|---|
| `NODE_ENV` | API, Worker, Web | Must be `production` | Set to literal `production` |
| `DATABASE_URL` | API, Worker | Postgres connection string (Supabase) | From Supabase dashboard → Settings → Database → Connection string (URI) |
| `REDIS_URL` | API | General Redis (Socket.IO adapter, cache) | From Upstash console → REST URL or TLS URL (`rediss://`) |
| `QUEUE_REDIS_URL` | API, Worker | Bull queue Redis (may be same as `REDIS_URL`) | Same Upstash instance OK; use `rediss://` URL |
| `JWT_SECRET` | API | Signs access tokens. Min 32 random chars. | `openssl rand -base64 48` |
| `JWT_REFRESH_SECRET` | API | Signs refresh tokens. Different from `JWT_SECRET`. | `openssl rand -base64 48` |
| `CREDENTIAL_ENCRYPTION_KEY` | API, Worker | AES-256 key. Exactly 64 hex chars. | `openssl rand -hex 32` |

---

## Application URLs — must be set for CORS and server actions

| Variable | Service | Description | Example |
|---|---|---|---|
| `APP_URL` | API, Web | Production frontend URL | `https://app.orderhubsolutions.com` |
| `API_PUBLIC_URL` | API | Publicly reachable API URL | `https://api.orderhubsolutions.com` |
| `SOCKET_CORS_ORIGIN` | API | Frontend domain for WebSocket CORS | `https://app.orderhubsolutions.com` |
| `API_URL` | Web | Internal API URL for Next.js rewrites | `https://api.orderhubsolutions.com` |

> On Render: `APP_URL`, `API_URL`, and `SOCKET_CORS_ORIGIN` are auto-populated from `fromService` references in `render.yaml`. No manual entry required.

---

## JWT / Auth

| Variable | Default | Description |
|---|---|---|
| `JWT_ACCESS_TTL` | `15m` | Access token lifetime |
| `JWT_REFRESH_TTL` | `7d` | Refresh token lifetime |

---

## Stripe (required for billing)

| Variable | Description | Where to find |
|---|---|---|
| `STRIPE_SECRET_KEY` | Live secret key (`sk_live_...`) | Stripe Dashboard → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret (`whsec_...`) | Stripe Dashboard → Webhooks → endpoint secret |
| `STRIPE_PUBLISHABLE_KEY` | Publishable key (`pk_live_...`) | Stripe Dashboard → Developers → API keys |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Same as above, exposed to browser | Same |

> **Never use test keys (`sk_test_`, `pk_test_`) in production.**

---

## Provider Credentials (optional, set per-integration)

These are set manually in the Render dashboard. If a provider is not used, omit the variable.

| Variable | Provider | Description |
|---|---|---|
| `UBER_EATS_CLIENT_ID` | Uber Eats | OAuth2 client ID from Uber Developer portal |
| `UBER_EATS_CLIENT_SECRET` | Uber Eats | OAuth2 client secret |
| `DELIVEROO_CLIENT_ID` | Deliveroo | API client ID from Deliveroo Partner portal |
| `DELIVEROO_CLIENT_SECRET` | Deliveroo | API client secret |

> Per-restaurant provider credentials are stored **encrypted in the database** via `CredentialService`. The above env vars are platform-level OAuth app credentials, not per-restaurant.

---

## Key Rotation (only during active rotation)

Set these during credential encryption key rotation. Remove after rotation is complete.

| Variable | Description |
|---|---|
| `CREDENTIAL_ENCRYPTION_KEY_CURRENT` | New key (replaces `CREDENTIAL_ENCRYPTION_KEY`) |
| `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` | Old key — keep until all credentials re-encrypted |
| `CREDENTIAL_ENCRYPTION_KEY_ID` | String label for current key version, e.g. `v2` |

---

## Logging / Observability

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | Logging level: `debug`, `info`, `warn`, `error` |
| `NEXT_TELEMETRY_DISABLED` | `1` | Disables Next.js telemetry. Set to `1` in production. |

---

## Maintenance Mode (temporary use only)

| Variable | Description |
|---|---|
| `ENABLE_MAINTENANCE_MODE` | Set to `true` to return 503 for all non-health routes |
| `MAINTENANCE_MESSAGE` | Message shown in 503 response body |

---

## Web-only Variables

| Variable | Description |
|---|---|
| `PORT` | Port Next.js listens on. Set to `3000`. |
| `NEXT_TELEMETRY_DISABLED` | Set to `1` |

---

## API-only Variables

| Variable | Description |
|---|---|
| `PORT` | Port NestJS listens on. Set to `4000`. |

---

## Worker-only Variables

No HTTP port. All other variables shared with API.

---

## What Render Generates Automatically

These are set by Render's Blueprint engine and do NOT need manual entry:

| Variable | How set |
|---|---|
| `JWT_SECRET` | `generateValue: true` — random on first deploy |
| `JWT_REFRESH_SECRET` | `generateValue: true` — random on first deploy |
| `APP_URL` (api service) | `fromService: orderhub-web` |
| `API_PUBLIC_URL` | `fromService: orderhub-api` |
| `SOCKET_CORS_ORIGIN` | `fromService: orderhub-web` |
| `API_URL` (web service) | `fromService: orderhub-api` |
| `APP_URL` (web service) | `fromService: orderhub-web` |

---

## Variables That MUST Be Set Manually in Render Dashboard

| Variable | Service |
|---|---|
| `DATABASE_URL` | API, Worker |
| `REDIS_URL` | API, Worker |
| `QUEUE_REDIS_URL` | API, Worker |
| `CREDENTIAL_ENCRYPTION_KEY` | API, Worker |
| `STRIPE_SECRET_KEY` | API |
| `STRIPE_WEBHOOK_SECRET` | API |
| `STRIPE_PUBLISHABLE_KEY` | API |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Web |
| `UBER_EATS_CLIENT_ID` | API, Worker |
| `UBER_EATS_CLIENT_SECRET` | API, Worker |
| `DELIVEROO_CLIENT_ID` | API, Worker |
| `DELIVEROO_CLIENT_SECRET` | API, Worker |

---

## Security Checklist Before First Production Deploy

- [ ] `CREDENTIAL_ENCRYPTION_KEY` is exactly 64 hex chars
- [ ] `JWT_SECRET` is at least 32 random chars (not a default or empty)
- [ ] `JWT_REFRESH_SECRET` is different from `JWT_SECRET`
- [ ] `DATABASE_URL` uses Supabase pooled connection (port 6543 with `?pgbouncer=true`)
- [ ] `REDIS_URL` and `QUEUE_REDIS_URL` use `rediss://` (TLS) not `redis://`
- [ ] `APP_URL` does not contain `localhost`
- [ ] `SOCKET_CORS_ORIGIN` does not contain `*`
- [ ] No Stripe test keys (`sk_test_`, `pk_test_`) in production env
- [ ] No provider test/sandbox credentials in production env
- [ ] `NODE_ENV=production`

---

## See Also

- `.env.staging.example` — starter template with placeholder values
- `DEPLOYMENT_ARCHITECTURE.md` — how services connect
- `DEPLOYMENT_RUNBOOK.md` — step-by-step deploy procedure
- `STAGING_ENVIRONMENT.md` — how to deploy to Render staging
