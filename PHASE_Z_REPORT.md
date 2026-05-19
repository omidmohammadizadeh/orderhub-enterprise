# Phase Z Report — Cloud Deployment & Production Infrastructure

> Date: 2026-05-19
> Status: **INFRASTRUCTURE READY — Staging deployment pending first cloud run**

---

## Summary

Phase Z established the complete cloud deployment infrastructure for OrderHub. The codebase was already functionally complete (0 TypeScript errors after Phase X/Y). Phase Z focused exclusively on infrastructure, deployment configuration, operational documentation, and security verification.

No business logic was changed. No existing APIs were modified. The printer app contract is unchanged.

---

## What Was Delivered

### Infrastructure Files

| File | Purpose | Status |
|---|---|---|
| `render.yaml` | Render Blueprint — all 3 services declaratively defined | Created |
| `scripts/start-api.sh` | API production startup: validate env → prisma generate → migrate deploy → start | Created |
| `scripts/start-worker.sh` | Worker production startup: validate env → start | Created |
| `apps/web/next.config.ts` | Added `output: "standalone"` — was blocking Docker web builds | Fixed |
| `.github/workflows/ci.yml` | Added `claude/**` to branch triggers | Updated |

### Documentation

| File | Purpose | Status |
|---|---|---|
| `DEPLOYMENT_ARCHITECTURE.md` | Infrastructure overview: services, networking, scaling, CI/CD | Created |
| `PRODUCTION_ENVIRONMENT_TEMPLATE.md` | Every env var documented with how to generate | Created |
| `STAGING_ENVIRONMENT.md` | Step-by-step Render Blueprint deploy guide | Created |
| `RESTAURANT_ONBOARDING_RUNBOOK.md` | End-to-end onboarding: tenant → location → provider → printer → go-live → handover | Created |
| `PHASE_Z_REPORT.md` | This file | Created |
| `KNOWN_LIMITATIONS.md` | Added Phase Z infrastructure limitations section | Updated |
| `RELEASE_CHECKLIST.md` | Added Section 10o: Cloud Infrastructure Gate | Updated |

### Pre-existing Infrastructure Confirmed Working

These files were already in place and verified compatible with the Phase Z approach:

| File | Status |
|---|---|
| `infrastructure/docker/Dockerfile.api` | Verified — multi-stage Node 20 Alpine, copies `dist/` |
| `infrastructure/docker/Dockerfile.worker` | Verified — identical pattern to API |
| `infrastructure/docker/Dockerfile.web` | Verified — multi-stage, copies `.next/standalone` (now fixed with `output: "standalone"`) |
| `docker-compose.prod.yml` | Verified — VPS alternative deployment path |
| `.github/workflows/staging-deploy.yml` | Verified — builds images, pushes GHCR, SSH deploys |
| `.github/workflows/production-deploy.yml` | Verified — manual-only gate with team approval |
| `.env.staging.example` | Already existed — comprehensive, Upstash/Supabase patterns included |
| `.env.production.example` | Already existed — live key guidance included |

---

## Critical Fix: next.config.ts

**The most important code change in Phase Z.**

`apps/web/next.config.ts` was missing `output: "standalone"`. The Dockerfile copies `.next/standalone` — without this setting, that directory is never created, and Docker builds of the web service would fail silently (the build succeeds but the image has nothing to run).

```typescript
// BEFORE (Dockerfile.web would produce an empty/broken image)
const nextConfig: NextConfig = {
  transpilePackages: ["@orderhub/shared", "@orderhub/ui"],
  // ...

// AFTER (correct)
const nextConfig: NextConfig = {
  output: "standalone",  // required — Dockerfile.web copies .next/standalone
  transpilePackages: ["@orderhub/shared", "@orderhub/ui"],
  // ...
```

---

## Architecture Decision Log

### Decision 1: Render over Railway

**Chosen:** Render

**Reason:** `render.yaml` (Render Blueprint) allows the entire deployment to be version-controlled as a single declarative YAML file. Render supports Background Workers (no HTTP port required) as a first-class service type — matching our Worker service exactly. Railway supports similar features but Render's Blueprint is more mature for multi-service monorepo patterns.

The existing staging/production GitHub Actions workflows use SSH deploy (compatible with any hosting). The `render.yaml` Blueprint is an additional, simpler path for initial staging.

### Decision 2: Supabase + Upstash over Render-managed DB

**Chosen:** External Supabase (Postgres) + Upstash (Redis)

**Reason:** Render's managed databases are more expensive and their PostgreSQL offering does not provide a connection pooler (required for Prisma with many short-lived connections). Supabase provides PgBouncer pooling out-of-the-box and a generous free tier. Upstash provides serverless Redis with TLS, pay-per-request billing suitable for staging load.

Both are the industry standard choices for Render-based NestJS deployments.

### Decision 3: `sync: false` for all sensitive env vars

**Chosen:** No secrets in `render.yaml`

**Reason:** `render.yaml` is committed to the repository. All sensitive values (`DATABASE_URL`, `REDIS_URL`, `CREDENTIAL_ENCRYPTION_KEY`, provider keys, Stripe keys) use `sync: false` — they must be entered manually in the Render Dashboard and are stored encrypted by Render. `JWT_SECRET` and `JWT_REFRESH_SECRET` use `generateValue: true` — Render generates a cryptographically random value on first deploy and never exposes it in logs.

### Decision 4: `start-api.sh` runs migrations at startup

**Chosen:** Migrate-on-startup (in `start-api.sh`)

**Reason:** Render has no pre-deploy hooks at the free/starter tier. Running `prisma migrate deploy` in the startup script ensures migrations are applied before the API accepts traffic. This is safe: `prisma migrate deploy` is idempotent and fast when no new migrations are pending. The alternative (migration job as a separate Render service) adds complexity for marginal benefit at this scale.

---

## Deployment Architecture Summary

```
Internet
  │
  ├── orderhub-web (Next.js, port 3000)
  │     └── proxies /api/* → orderhub-api
  │
  └── orderhub-api (NestJS, port 4000)
        ├── REST API + WebSocket
        ├── Webhook ingestion (Uber Eats, Deliveroo, Stripe)
        ├── Outbox dispatcher (Bull producer)
        └── ─ reads/writes ─► Supabase Postgres
                            ─ pub/sub ─► Upstash Redis
  │
  └── orderhub-worker (no HTTP)
        ├── ORDER_SYNC queue (Bull consumer)
        ├── PRINT_JOBS queue (Bull consumer)
        ├── ─ reads/writes ─► Supabase Postgres
        └── ─ queue ─────── ► Upstash Redis
```

---

## URL Structure

| Surface | URL |
|---|---|
| Dashboard | `https://app.orderhubsolutions.com` |
| API | `https://api.orderhubsolutions.com` |
| Health | `https://api.orderhubsolutions.com/api/v1/health` |
| Uber Eats webhook | `https://api.orderhubsolutions.com/api/v1/webhooks/uber-eats` |
| Deliveroo webhook | `https://api.orderhubsolutions.com/api/v1/webhooks/deliveroo` |
| Stripe webhook | `https://api.orderhubsolutions.com/api/v1/webhooks/stripe` |
| Flutter printer polling | `https://api.orderhubsolutions.com/api/v1/print-jobs/pending/:shopCode` |
| Staging (Render auto) | `https://orderhub-{api,web}.onrender.com` |

---

## Staging Deployment Status

**Status: Infrastructure ready. Awaiting first cloud deploy.**

All configuration is complete. The staging environment can be brought up by following `STAGING_ENVIRONMENT.md`:

1. Create Supabase project + Upstash Redis (external, ~5 minutes)
2. Render Blueprint deploy via `render.yaml` (~5 minutes)
3. Fill in 6 secret env vars in Render Dashboard
4. First deploy triggered — startup script runs migrations
5. Smoke test to verify

The environment is NOT marked production-ready because no actual staging deployment has been verified end-to-end. This will be confirmed in the next session when the staging environment is live.

---

## What Is NOT Changed

Per Phase Z constraints, none of the following were modified:

- Business logic in API modules (orders, integrations, billing, analytics, etc.)
- Prisma schema (no new migrations)
- Existing API endpoints or response shapes
- Printer app polling contract (`GET /api/v1/print-jobs/pending/:shopCode`)
- WebSocket event names or payload shapes
- Just Eat or HubRise activation status (remain inactive)
- Provider webhook handling code

---

## Known Limitations Added This Phase

See `KNOWN_LIMITATIONS.md` — Phase Z Infrastructure Limitations section:

- Render starter plan sleeps on free tier
- Supabase free tier pauses after inactivity
- No internal networking for Upstash (public TLS, ~5ms overhead)
- Single Upstash instance used for all Redis in staging
- Socket.IO multi-instance not load-tested
- Docker build CI skipped on `claude/**` push branches

---

## Next Steps

1. **Execute first staging deploy** following `STAGING_ENVIRONMENT.md`
2. **Verify smoke test passes** against live Render environment
3. **Register webhook URLs** in Uber Eats and Deliveroo developer portals for staging
4. **Add custom domains** (`staging.orderhubsolutions.com`, `api-staging.orderhubsolutions.com`)
5. **Mark staging as production-ready** once smoke test passes and first test order flows end-to-end
6. **Proceed to Phase AA** (first live restaurant or commercial launch prep)

---

## Files Changed in Phase Z

```
apps/web/next.config.ts                     (fixed: output: "standalone")
scripts/start-api.sh                        (new)
scripts/start-worker.sh                     (new)
render.yaml                                 (new)
.github/workflows/ci.yml                    (updated: claude/** branch trigger)
DEPLOYMENT_ARCHITECTURE.md                 (new)
PRODUCTION_ENVIRONMENT_TEMPLATE.md         (new)
STAGING_ENVIRONMENT.md                     (new)
RESTAURANT_ONBOARDING_RUNBOOK.md           (new)
PHASE_Z_REPORT.md                          (new)
KNOWN_LIMITATIONS.md                       (updated: Phase Z section added)
RELEASE_CHECKLIST.md                       (updated: Section 10o added)
```
