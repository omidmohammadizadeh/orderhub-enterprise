# Phase AA Report — First Staging Deployment & Environment Wiring

> Date: 2026-05-19
> Status: **DEPLOYMENT READY — Infrastructure complete, first Render deploy pending**

---

## Summary

Phase AA fixed three blocking issues that would have caused the first staging deployment to fail, wired the full environment variable set for Render, and produced comprehensive operational documentation for running and maintaining the staging environment.

The codebase is deployment-ready. The actual Render deployment is pending execution following `RENDER_SETUP.md`.

---

## Blocking Issues Fixed

### 1. `shadowDatabaseUrl` would crash startup (CRITICAL)

**Problem:** `packages/database/prisma/schema.prisma` had `shadowDatabaseUrl = env("SHADOW_DATABASE_URL")`. Prisma 5 throws `P1012: Environment variable not found: SHADOW_DATABASE_URL` if the env var is referenced but not set — even when running `prisma migrate deploy` (which never uses the shadow DB). Every staging startup would have failed at migration time.

**Fix:** Removed `shadowDatabaseUrl` from the datasource block. The shadow DB is only needed for `prisma migrate dev` (local migration authoring). Added a comment directing devs to set `SHADOW_DATABASE_URL` in local `.env` if needed.

### 2. No `directUrl` — Supabase PgBouncer would break migrations (CRITICAL)

**Problem:** Supabase recommends using PgBouncer pooled connections (port 6543) as `DATABASE_URL` for production efficiency. However, PgBouncer in transaction mode does not support the Postgres session commands Prisma uses for migrations (`SET search_path`, advisory locks). `prisma migrate deploy` via the pooled URL would fail or behave unpredictably.

**Fix:** Added `directUrl = env("DIRECT_URL")` to the datasource block. Prisma uses `DIRECT_URL` (direct Supabase connection, port 5432) for migrations and `DATABASE_URL` (pooled) for all runtime queries. Updated `start-api.sh` to validate `DIRECT_URL` is set before running migrations.

### 3. Startup scripts not in Docker images (CRITICAL)

**Problem:** `scripts/start-api.sh` and `scripts/start-worker.sh` existed in the repo but were not copied into the Docker images by `Dockerfile.api` and `Dockerfile.worker`. The Dockerfiles used `CMD ["node", "dist/main"]` directly, bypassing all migration and env validation logic. On Render, migrations would never run.

**Fix:** Added `COPY --chown=nestjs:nodejs scripts/start-api.sh ./scripts/start-api.sh` and `RUN chmod +x ./scripts/start-api.sh` to the API Dockerfile runner stage. Updated CMD to `["./scripts/start-api.sh"]`. Same for worker. Startup now validates env → runs migrations → starts node.

---

## All Changes in Phase AA

### Code Changes

| File | Change | Reason |
|---|---|---|
| `packages/database/prisma/schema.prisma` | Removed `shadowDatabaseUrl`, added `directUrl = env("DIRECT_URL")` | Supabase PgBouncer compatibility for migrations |
| `packages/database/generated/prisma/*` | Regenerated Prisma client | Schema change |
| `infrastructure/docker/Dockerfile.api` | Added COPY scripts/, changed CMD to `./scripts/start-api.sh` | Migrations must run at startup |
| `infrastructure/docker/Dockerfile.worker` | Added COPY scripts/, changed CMD to `./scripts/start-worker.sh` | Worker env validation at startup |
| `scripts/start-api.sh` | Added `DIRECT_URL` validation, improved documentation | New required env var |
| `render.yaml` | Added `DIRECT_URL: sync: false` to api and worker services | Supabase migration connectivity |
| `.env` | Added `DIRECT_URL`, commented out `SHADOW_DATABASE_URL` | Local dev compatibility |
| `.env.example` | Added `DIRECT_URL` | Documentation |
| `.github/workflows/ci.yml` | Added `DIRECT_URL` env var to test, migration-safety steps | CI compatibility with new schema |

### Documentation Created

| File | Purpose |
|---|---|
| `RENDER_SETUP.md` | Step-by-step Render deployment guide (9 steps, ~20 min) |
| `ENVIRONMENT_VARIABLES_CHECKLIST.md` | Every env var with set/unset checkbox for all 3 services |
| `OPERATOR_STAGING_CHECKLIST.md` | Daily health checks, post-deploy verification, smoke tests |
| `STAGING_DEPLOYMENT_STATUS.md` | Live deployment status tracker with URL placeholders |
| `PHASE_AA_REPORT.md` | This file |

### Documentation Updated

| File | Change |
|---|---|
| `RELEASE_CHECKLIST.md` | Added Section 10p: Staging Environment Verification Gate (16 items) |
| `KNOWN_LIMITATIONS.md` | Added Phase AA staging limitations (6 items) |

---

## Deployment Architecture (Confirmed for Staging)

```
Render (Frankfurt)
├── orderhub-api   (Web Service, port 4000)
│   ├── Startup: validate env → prisma migrate deploy → node dist/main
│   ├── DATABASE_URL → Supabase pooler (port 6543)
│   ├── DIRECT_URL  → Supabase direct (port 5432)  ← migrations use this
│   └── REDIS_URL   → Upstash (rediss://)
│
├── orderhub-worker (Background Worker, no HTTP)
│   ├── Startup: validate env → node dist/main
│   ├── DATABASE_URL / DIRECT_URL → Supabase (same as API)
│   └── QUEUE_REDIS_URL → Upstash (same instance)
│
└── orderhub-web   (Web Service, port 3000)
    └── API_URL → fromService: orderhub-api

External:
├── Supabase Postgres (Frankfurt) — managed, SSL
└── Upstash Redis     (Frankfurt) — managed, TLS (rediss://)
```

---

## Environment Variable Summary

### orderhub-api

| Variable | How Set |
|---|---|
| `NODE_ENV=production` | render.yaml auto |
| `PORT=4000` | render.yaml auto |
| `JWT_SECRET` | Render `generateValue: true` |
| `JWT_REFRESH_SECRET` | Render `generateValue: true` |
| `JWT_ACCESS_TTL=15m` | render.yaml auto |
| `JWT_REFRESH_TTL=7d` | render.yaml auto |
| `LOG_LEVEL=info` | render.yaml auto |
| `APP_URL` | render.yaml fromService |
| `API_PUBLIC_URL` | render.yaml fromService |
| `SOCKET_CORS_ORIGIN` | render.yaml fromService |
| `DATABASE_URL` | Manual (Render Dashboard) |
| `DIRECT_URL` | Manual (Render Dashboard) |
| `REDIS_URL` | Manual (Render Dashboard) |
| `QUEUE_REDIS_URL` | Manual (Render Dashboard) |
| `CREDENTIAL_ENCRYPTION_KEY` | Manual (Render Dashboard) |
| `STRIPE_SECRET_KEY` | Manual (Render Dashboard) |
| `STRIPE_WEBHOOK_SECRET` | Manual (Render Dashboard) |
| `STRIPE_PUBLISHABLE_KEY` | Manual (Render Dashboard) |

---

## Database Migration Status

All 4 migration files present:

| Migration | Status |
|---|---|
| `20260518180000_phase_f` | Applied at startup via `prisma migrate deploy` |
| `20260518210000_phase_i` | Applied at startup |
| `20260519000000_phase_k` | Applied at startup |
| `20260619000000_phase_r` | Applied at startup |

The startup script runs `prisma migrate deploy` on every container start. This is idempotent — if migrations are already applied, it skips them.

---

## Seed Data

The seed script (`packages/database/prisma/seed.ts`) creates:

| Entity | Value |
|---|---|
| Tenant | `Demo Restaurant Group` (slug: `demo-restaurant-group`) |
| Admin user | `admin@demo.orderhub.io` / `Demo1234!` |
| Brand | `Burger Co` |
| Location | `Burger Co — London Bridge` (id: `loc_demo_001`) |
| Menu | `Main Menu` with `Burgers` category and `Classic Cheeseburger` item |

Run via:
```bash
DATABASE_URL=<supabase-direct-url> DIRECT_URL=<supabase-direct-url> \
pnpm --filter @orderhub/database db:seed
```

---

## Staging Deployment Status

**Status: DEPLOYMENT READY — Awaiting first Render deploy execution.**

Infrastructure is fully prepared:
- All 3 Dockerfiles build the startup scripts into the images
- render.yaml defines all services with correct env var references
- Prisma schema uses `directUrl` for safe Supabase migrations
- CI workflow includes `DIRECT_URL` for all test steps

**Next action:** Follow `RENDER_SETUP.md` to execute the first Render deployment.

After deployment, update `STAGING_DEPLOYMENT_STATUS.md` with:
- Actual Render service URLs
- Verification checklist status
- Deployment log entries

---

## Production Readiness Decision

**NOT production-ready.** Reasons:

1. No live staging environment verified yet
2. Staging deployment pending execution
3. End-to-end order flow not verified in cloud environment
4. Smoke test not run against staging
5. Provider sandbox webhooks not registered

**Gate to production-ready:** Complete `STAGING_DEPLOYMENT_STATUS.md` verification checklist + smoke test passes + first end-to-end order flow works in staging.

---

## Tests and Typecheck

All verified clean before this commit:

| Check | Result |
|---|---|
| `pnpm --filter @orderhub/api type-check` | ✅ 0 errors |
| `pnpm --filter @orderhub/worker type-check` | ✅ 0 errors |
| `pnpm --filter @orderhub/api test` | ✅ 327/327 passing |
| Prisma schema validation | ✅ `prisma validate` passes |

---

## Files Changed in Phase AA

```
packages/database/prisma/schema.prisma          (removed shadowDatabaseUrl, added directUrl)
packages/database/generated/prisma/*            (regenerated)
infrastructure/docker/Dockerfile.api            (COPY scripts/, CMD updated)
infrastructure/docker/Dockerfile.worker         (COPY scripts/, CMD updated)
scripts/start-api.sh                            (DIRECT_URL validation added)
render.yaml                                     (DIRECT_URL added to api + worker)
.env                                            (DIRECT_URL added, SHADOW_DATABASE_URL commented)
.env.example                                    (DIRECT_URL added)
.github/workflows/ci.yml                        (DIRECT_URL added to test steps)
RENDER_SETUP.md                                 (new)
ENVIRONMENT_VARIABLES_CHECKLIST.md             (new)
OPERATOR_STAGING_CHECKLIST.md                   (new)
STAGING_DEPLOYMENT_STATUS.md                    (new)
PHASE_AA_REPORT.md                              (new)
RELEASE_CHECKLIST.md                            (Section 10p added)
KNOWN_LIMITATIONS.md                            (Phase AA section added)
```
