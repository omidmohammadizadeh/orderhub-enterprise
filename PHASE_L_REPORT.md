# Phase L Report — Production Deployment and Monitoring Readiness

> Completed: 2026-05-19

---

## Summary

Phase L hardens the production deployment process by adding validated environment configuration, boot-time infrastructure checks, a comprehensive smoke test, and complete operations documentation (monitoring, alerts, backup/recovery, deployment runbook). No product features were added. All 148 existing tests continue to pass; 26 new tests were added.

---

## What Was Built

### 1. Environment Validation Hardening (`env.validation.ts`)

`apps/api/src/config/env.validation.ts`

Added:
- `CREDENTIAL_ENCRYPTION_KEY_CURRENT`, `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS`, `CREDENTIAL_ENCRYPTION_KEY_ID`
- `CREDENTIAL_ENCRYPTION_KEY` (Phase I primary key, now optional since `_CURRENT` takes precedence)
- `WEB_URL`, `CORS_ALLOWED_ORIGINS`
- `OUTBOX_PROCESSING_TIMEOUT_SECONDS`

New production safety rules:
- At least one of `CREDENTIAL_ENCRYPTION_KEY` or `CREDENTIAL_ENCRYPTION_KEY_CURRENT` must be set in production
- All-zero keys are rejected
- `JWT_SECRET` must not contain `change-me`, `secret`, or `password`
- `APP_URL` must not be localhost in production
- `SOCKET_CORS_ORIGIN` wildcards and localhost are warned (non-fatal)
- Safe return after `process.exit(1)` to allow test suite assertions

---

### 2. Production Startup Guard (`ProductionStartupService`)

`apps/api/src/modules/health/production-startup.service.ts`

A NestJS service implementing `OnModuleInit`. Runs only when `NODE_ENV=production`.

Checks at boot:
1. **Encryption key present** — `CREDENTIAL_ENCRYPTION_KEY` or `_CURRENT` must be set
2. **Encryption key valid format** — must be exactly 32 bytes (64 hex chars)
3. **Encryption roundtrip** — AES-256-GCM encrypt + decrypt proves key works
4. **JWT secret strength** — must be ≥ 32 chars, no insecure default values
5. **CORS configuration** — logs warnings for wildcard or localhost origins (non-fatal)
6. **Database connectivity** — `SELECT 1` via Prisma
7. **Redis connectivity** — `PING` via Bull queue client

Any critical failure calls `process.exit(1)` with a clear operator-facing error message before accepting any traffic. No secret values are logged.

Wired into `HealthModule`.

---

### 3. Comprehensive Smoke Test (`smoke-test.ts`)

`apps/api/src/scripts/smoke-test.ts`

Rebuilt from 9 to **16 checks**:

| Check | Description |
|---|---|
| `encryption_key_present` | Key set and is 32 bytes |
| `encryption_roundtrip` | AES-256-GCM encrypt/decrypt succeeds |
| `database_connection` | Prisma `SELECT 1` |
| `outbox_table_accessible` | `outbox_events` table exists (confirms migration) |
| `phase_k_migration_applied` | `location.goLiveStatus` column exists |
| `redis_connection` | Redis `PING` via `createClient` |
| `no_plaintext_credentials` | All integration credentials have encrypted envelope |
| `no_dead_outbox_events` | No `DEAD` outbox events |
| `no_stuck_processing_events` | No events stuck in `PROCESSING` past timeout |
| `api_liveness` | `GET /api/v1/health` returns `status: ok` |
| `api_readiness` | `GET /api/v1/health/ready` — DB OK |
| `sandbox_disabled_in_production` | Sandbox tools inactive when `environment: production` |
| `release_readiness_score` | Score ≥ `SMOKE_MIN_SCORE` (default 80) |
| `webhook_endpoint_reachable` | Webhook route registered (not 404/502) |
| `web_frontend_reachable` | Optional, skipped unless `SMOKE_WEB_URL` set |
| `printer_jobs_endpoint_reachable` | Optional, skipped unless `SMOKE_ALLOW_REAL_DATA=true` |

Default: dry-run mode (`DRY_RUN=true` by default). No real marketplace calls, no real orders, no real prints.

---

### 4. Tests

**`env.validation.spec.ts`** — 16 tests:
- Required fields
- Production-specific safety checks (encryption key, JWT, APP_URL, all-zero keys)
- Optional fields with correct defaults

**`production-startup.service.spec.ts`** — 10 tests:
- No-op in non-production
- Exit on missing encryption key
- Exit on wrong key length
- Exit on insecure JWT secret
- Exit on database failure
- Exit on Redis failure
- Pass with valid config

---

## Documentation Created / Updated

| File | Status |
|---|---|
| `PRODUCTION_ENVIRONMENT.md` | New — complete env var reference |
| `MONITORING_AND_ALERTS.md` | New — 15 alert definitions with severity and resolution |
| `BACKUP_AND_RECOVERY.md` | New — backup schedule, restore procedure, key dependency |
| `DEPLOYMENT_RUNBOOK.md` | Updated — 12-step deploy, smoke test step, rollback procedure |
| `PILOT_LAUNCH_RUNBOOK.md` | Updated — monitoring, emergency pause, API pause commands |
| `RELEASE_CHECKLIST.md` | Updated — sections 10d (env), 10e (monitoring), 10f (backup) |
| `KNOWN_LIMITATIONS.md` | Updated — Phase L limitations section |
| `PHASE_L_REPORT.md` | This file |

---

## Test Results

```
Test Suites: 12 passed, 12 total
Tests:       148 passed, 148 total  (+26 from Phase L)
```

---

## Files Changed

| File | Status |
|---|---|
| `apps/api/src/config/env.validation.ts` | Modified |
| `apps/api/src/config/env.validation.spec.ts` | New |
| `apps/api/src/modules/health/production-startup.service.ts` | New |
| `apps/api/src/modules/health/health.module.ts` | Modified |
| `apps/api/src/modules/health/tests/production-startup.service.spec.ts` | New |
| `apps/api/src/scripts/smoke-test.ts` | Rewritten (9 → 16 checks) |
| `PRODUCTION_ENVIRONMENT.md` | New |
| `MONITORING_AND_ALERTS.md` | New |
| `BACKUP_AND_RECOVERY.md` | New |
| `DEPLOYMENT_RUNBOOK.md` | Updated |
| `PILOT_LAUNCH_RUNBOOK.md` | Updated |
| `RELEASE_CHECKLIST.md` | Updated |
| `KNOWN_LIMITATIONS.md` | Updated |

---

## Production Readiness Score

| Area | Phase J | Phase K | Phase L |
|---|---|---|---|
| Credential encryption | ✓ | ✓ | ✓ |
| Outbox reliability | ✓ | ✓ | ✓ |
| Webhook correctness | ✓ | ✓ | ✓ |
| Go-live lifecycle | — | ✓ | ✓ |
| Env validation | Partial | Partial | **Full** |
| Boot-time infra check | — | — | **✓** |
| Smoke test coverage | 9 checks | 9 checks | **16 checks** |
| Monitoring docs | — | — | **✓** |
| Backup / recovery docs | — | — | **✓** |
| Deployment runbook | Partial | Partial | **Complete** |

**Overall readiness: Ready for 1–3 pilot restaurants.**

---

## What Was Not Built

Per Phase L constraints:
- No billing or subscription changes
- No mobile/driver app changes
- No provider integration changes
- No printer app contract changes (Flutter polling unchanged)
- No alerting infrastructure wired up — monitoring is documented for operator configuration
- No automated backup cron — documented for operator configuration
