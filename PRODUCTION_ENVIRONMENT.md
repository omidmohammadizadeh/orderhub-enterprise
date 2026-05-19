# Production Environment Variables

> Every variable the API and worker need in a production deployment.
> Generate secrets with `openssl rand -hex 32` (for hex keys) or `openssl rand -base64 48` (for JWT secrets).

---

## Core Application

| Variable | Required | Example | Notes |
|---|---|---|---|
| `NODE_ENV` | Yes | `production` | Must be `production` for safety checks to activate |
| `PORT` | No | `4000` | Default 4000 |
| `APP_URL` | Yes | `https://app.orderhub.io` | Frontend origin — must not be localhost in production |
| `API_URL` | Yes | `https://api.orderhub.io` | API base URL |
| `WEB_URL` | No | `https://app.orderhub.io` | Web frontend URL (same as APP_URL unless split) |
| `CORS_ALLOWED_ORIGINS` | No | `https://app.orderhub.io` | Comma-separated allowed CORS origins |

---

## Database

| Variable | Required | Example | Notes |
|---|---|---|---|
| `DATABASE_URL` | Yes | `postgresql://user:pass@db:5432/orderhub?sslmode=require` | Must include SSL in production |
| `DATABASE_POOL_MIN` | No | `2` | Prisma connection pool minimum |
| `DATABASE_POOL_MAX` | No | `10` | Prisma connection pool maximum |

**Notes:**
- Apply migrations before starting the API: `prisma migrate deploy`
- Verify all migrations applied: `prisma migrate status`
- Required migrations: up to `20260519000000_phase_k` inclusive

---

## Redis / Queues

| Variable | Required | Example | Notes |
|---|---|---|---|
| `REDIS_URL` | Yes | `redis://:password@redis:6379/0` | Main Redis instance |
| `QUEUE_REDIS_URL` | Yes | `redis://:password@redis:6379/1` | Bull queue Redis (can share REDIS_URL) |
| `REDIS_PASSWORD` | No | `<random>` | Only if not embedded in URL |
| `OUTBOX_PROCESSING_TIMEOUT_SECONDS` | No | `300` | Seconds before stuck PROCESSING events are recovered |

---

## Authentication

| Variable | Required | Min length | Example |
|---|---|---|---|
| `JWT_SECRET` | Yes | 32 chars | `openssl rand -base64 48` |
| `JWT_REFRESH_SECRET` | Yes | 32 chars | `openssl rand -base64 48` |
| `JWT_ACCESS_TTL` | No | — | `15m` |
| `JWT_REFRESH_TTL` | No | — | `7d` |

**Rules:**
- Must not contain `change-me`, `secret`, or `password`
- Must not be all-zero or default values
- Rotate if ever exposed

---

## Credential Encryption

| Variable | Required | Format | Notes |
|---|---|---|---|
| `CREDENTIAL_ENCRYPTION_KEY` | Yes* | 64 hex chars | Legacy/primary key — superseded by `_CURRENT` if rotating |
| `CREDENTIAL_ENCRYPTION_KEY_CURRENT` | Yes* | 64 hex chars | Takes precedence over `CREDENTIAL_ENCRYPTION_KEY` |
| `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` | No | 64 hex chars | Set only during key rotation window |
| `CREDENTIAL_ENCRYPTION_KEY_ID` | No | string | Label for current key (default: `v1`) |

*At least one of `CREDENTIAL_ENCRYPTION_KEY` or `CREDENTIAL_ENCRYPTION_KEY_CURRENT` must be set.

Generate:
```bash
openssl rand -hex 32
```

**Rules:**
- Never log this value
- Never commit to source control
- Store in secrets manager (AWS SSM, Vault, Doppler, etc.)
- Rotate on schedule or if compromised — see `CREDENTIAL_ENCRYPTION.md`

---

## Socket.IO / WebSockets

| Variable | Required | Example | Notes |
|---|---|---|---|
| `SOCKET_CORS_ORIGIN` | Yes | `https://app.orderhub.io` | Must not be `*` in production |
| `SOCKET_MAX_CONNECTIONS_PER_LOCATION` | No | `100` | Per-location socket limit |

---

## Provider Integrations (Optional — stored in DB per integration)

Global fallback env vars are optional; per-integration credentials are stored encrypted in the database.

| Variable | Notes |
|---|---|
| `UBER_EATS_CLIENT_ID` | Global fallback only |
| `UBER_EATS_CLIENT_SECRET` | Global fallback only |
| `UBER_EATS_WEBHOOK_SECRET` | Global fallback only |
| `UBER_EATS_BASE_URL` | Default: `https://api.uber.com/v2` — must be production URL |
| `DELIVEROO_CLIENT_ID` | Global fallback only |
| `DELIVEROO_CLIENT_SECRET` | Global fallback only |
| `DELIVEROO_WEBHOOK_SECRET` | Global fallback only |
| `DELIVEROO_BASE_URL` | Default: `https://api.developers.deliveroo.com` |
| `JUST_EAT_API_KEY` | Global fallback only |
| `JUST_EAT_BASE_URL` | Default: `https://uk.api.just-eat.io` |
| `HUBRISE_APP_ID` | Global fallback only |
| `HUBRISE_APP_SECRET` | Global fallback only |

**Rule:** Provider base URLs must point to production endpoints. If a provider's sandbox URL is used it must be intentional and the integration must be clearly marked.

---

## Rate Limiting

| Variable | Default | Notes |
|---|---|---|
| `THROTTLE_WEBHOOK_TTL` | `60000` | Webhook rate limit window (ms) |
| `THROTTLE_WEBHOOK_LIMIT` | `300` | Max webhook requests per window |
| `THROTTLE_LOGIN_TTL` | `60000` | Login rate limit window (ms) |
| `THROTTLE_LOGIN_LIMIT` | `10` | Max login attempts per window |

---

## Logging and Observability

| Variable | Default | Notes |
|---|---|---|
| `LOG_LEVEL` | `info` | One of: `error`, `warn`, `info`, `debug`, `verbose` |
| `SENTRY_DSN` | — | Error tracking DSN (optional) |
| `DATADOG_API_KEY` | — | Datadog API key (optional) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OpenTelemetry collector endpoint |
| `OTEL_SERVICE_NAME` | `orderhub-api` | Service name in traces |

---

## Feature Flags

| Variable | Default | Notes |
|---|---|---|
| `ENABLE_ANALYTICS` | `true` | |
| `ENABLE_DISPATCH` | `true` | |
| `ENABLE_KDS` | `true` | |
| `ENABLE_MAINTENANCE_MODE` | `false` | Set `true` to activate maintenance page |
| `MAINTENANCE_MESSAGE` | — | Custom message when maintenance mode is active |

---

## Email

| Variable | Required | Notes |
|---|---|---|
| `RESEND_API_KEY` | No | For transactional email via Resend |
| `EMAIL_FROM` | No | Default: `OrderHub <noreply@orderhub.io>` |

---

## Security Checklist

Before go-live:

- [ ] `NODE_ENV=production`
- [ ] `CREDENTIAL_ENCRYPTION_KEY` or `CREDENTIAL_ENCRYPTION_KEY_CURRENT` set (64 hex chars)
- [ ] `JWT_SECRET` and `JWT_REFRESH_SECRET` are ≥ 32 chars, randomly generated, no insecure defaults
- [ ] `SOCKET_CORS_ORIGIN` set to production frontend domain (not `*`)
- [ ] `APP_URL` set to production URL (not localhost)
- [ ] No provider base URLs pointing to sandbox endpoints
- [ ] All values stored in secrets manager, not in `.env` files committed to git
- [ ] `ENCRYPTION_KEY` and `CREDENTIAL_ENCRYPTION_KEY` not logged anywhere

---

## Startup Validation

The API validates all required variables at boot via `validateEnv()` in `src/config/env.validation.ts`.

In addition, `ProductionStartupService` (`src/modules/health/production-startup.service.ts`) performs:
- Encryption key format validation + roundtrip
- JWT secret strength check
- Database connectivity check
- Redis/queue connectivity check

A failure in any of these exits the process with code 1 before accepting any traffic.
