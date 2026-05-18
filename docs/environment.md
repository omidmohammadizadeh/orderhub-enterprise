# Environment Guide

OrderHub uses four runtime environments. Each maps to a different configuration profile and deployment target.

## Environments

| Name | `NODE_ENV` | Purpose |
|---|---|---|
| `local` | `local` | Individual developer laptops; infrastructure via Docker |
| `development` | `development` | Shared dev server; CI preview deployments |
| `staging` | `staging` | Pre-production; mirrors production config |
| `production` | `production` | Live customer traffic |

## Config Loading Order

The API loads environment variables in this priority order (higher wins):

1. `.env.local` — machine-specific overrides (gitignored)
2. `.env.<NODE_ENV>` — e.g. `.env.staging`, `.env.production`
3. `.env` — project-level defaults (committed; contains no secrets)

## Boot-time Validation

All environment variables are validated via Zod at startup (`apps/api/src/config/env.validation.ts`). If any required variable is missing or invalid, the process exits with a clear error listing every problem:

```
❌  Environment validation failed. Fix the following before starting:

  - JWT_SECRET: String must contain at least 32 character(s)
  - ENCRYPTION_KEY: ENCRYPTION_KEY must be a 64-char hex string (32 bytes)
```

In production, the validator also rejects insecure default values for `JWT_SECRET`, `JWT_REFRESH_SECRET`, and `ENCRYPTION_KEY`.

## Required Variables by Environment

### Always Required

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | `postgresql://user:pass@host:5432/db` |
| `REDIS_URL` | Redis connection (cache) | `redis://localhost:6379` |
| `QUEUE_REDIS_URL` | Redis connection (Bull queues) | `redis://localhost:6379` |
| `JWT_SECRET` | ≥ 32 chars; signs access tokens | `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | ≥ 32 chars; signs refresh tokens | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | 64-char hex (32 bytes); encrypts integration credentials | `openssl rand -hex 32` |

### Production Only

| Variable | Description |
|---|---|
| `SENTRY_DSN` | Sentry error tracking project DSN |
| `DATADOG_API_KEY` | Datadog metrics/APM |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry collector endpoint |

## Generating Secure Secrets

```bash
# JWT secrets
openssl rand -hex 32

# Encryption key (must be 32 bytes = 64 hex chars)
openssl rand -hex 32

# Verify length
echo -n "your-key-here" | wc -c  # should be 64
```

## Platform Webhook Secrets

Each integration can store its own webhook secret in the `Integration.credentials` JSON in the database. The env vars (`UBER_EATS_WEBHOOK_SECRET`, etc.) are **global fallbacks** used when no per-integration secret is set. Per-tenant overrides always take precedence.

## Feature Flags

Feature flags are controlled by environment variables and accessible via `FeatureFlagsService`. They can be checked anywhere by injecting the service:

```typescript
constructor(private readonly flags: FeatureFlagsService) {}

if (this.flags.isEnabled("kds")) {
  // KDS-specific logic
}
```

| Flag | Variable | Default |
|---|---|---|
| `analytics` | `ENABLE_ANALYTICS` | `true` |
| `dispatch` | `ENABLE_DISPATCH` | `true` |
| `kds` | `ENABLE_KDS` | `true` |
| `maintenanceMode` | `ENABLE_MAINTENANCE_MODE` | `false` |

## Maintenance Mode

Set `ENABLE_MAINTENANCE_MODE=true` to return HTTP 503 on all endpoints except the health probes. The response includes a `retryAfter: 300` hint. The maintenance message can be customised via `MAINTENANCE_MESSAGE`.

This is designed for zero-downtime database migrations that require quiescing writes.
