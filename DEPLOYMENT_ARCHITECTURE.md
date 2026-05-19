# Deployment Architecture — OrderHub

> Last updated: Phase Z — Cloud Deployment & Production Infrastructure (2026-05-19)

---

## Overview

OrderHub is deployed as three discrete services backed by two external managed services. All services run on Render (preferred) or a self-managed VPS (Docker Compose). Infrastructure is declaratively described in `render.yaml` (Render Blueprint).

```
┌──────────────────────────────────────────────────────────────────┐
│                        Internet / CDN                            │
└────────────────────────┬───────────────────────────┬─────────────┘
                         │                           │
                ┌────────▼───────┐         ┌─────────▼──────┐
                │  orderhub-web  │         │  orderhub-api  │
                │  Next.js 15    │         │  NestJS + WS   │
                │  port 3000     │◄────────│  port 4000     │
                └────────────────┘  proxy  └───────┬────────┘
                                               /api/*     │
                                                          │ Bull queues
                                               ┌──────────▼──────────┐
                                               │  orderhub-worker     │
                                               │  NestJS + Bull       │
                                               │  no HTTP port        │
                                               └──────────────────────┘
                                                          │
                                    ┌─────────────────────┼──────────────────────┐
                                    │                     │                      │
                         ┌──────────▼──────┐   ┌─────────▼───────┐   ┌──────────▼──────┐
                         │  Supabase       │   │  Upstash Redis   │   │  External APIs  │
                         │  Postgres 15    │   │  (SSL, TLS)      │   │  (Uber/Deliveroo│
                         │  (external)     │   │  (external)      │   │   Stripe)       │
                         └─────────────────┘   └──────────────────┘   └─────────────────┘
```

---

## Services

### 1. orderhub-api (NestJS REST + WebSocket)

| Property | Value |
|---|---|
| Runtime | Docker (multi-stage Node 20 Alpine) |
| Dockerfile | `infrastructure/docker/Dockerfile.api` |
| Port | 4000 |
| Health check | `GET /api/v1/health` |
| Startup script | `scripts/start-api.sh` |
| Render type | `web` |
| Render plan | `starter` (upgrade to `standard` for production) |
| Region | Frankfurt (eu-central) |

**Startup sequence:**
1. Validate required env vars (`DATABASE_URL`, `JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`)
2. Run `prisma generate` — regenerates Prisma client
3. Run `prisma migrate deploy` — applies pending migrations
4. Start `node dist/main`

**Handles:**
- REST API for dashboard (`/api/v1/*`)
- Webhook ingestion from Uber Eats, Deliveroo, Stripe (`/api/v1/webhooks/*`)
- WebSocket gateway (Socket.IO) for real-time order updates
- Background outbox dispatcher (Bull producer)

---

### 2. orderhub-worker (Bull Queue Processor)

| Property | Value |
|---|---|
| Runtime | Docker (multi-stage Node 20 Alpine) |
| Dockerfile | `infrastructure/docker/Dockerfile.worker` |
| Port | none — no HTTP server |
| Startup script | `scripts/start-worker.sh` |
| Render type | `worker` |
| Render plan | `starter` |
| Region | Frankfurt (eu-central) |

**Startup sequence:**
1. Validate required env vars (`DATABASE_URL`, `QUEUE_REDIS_URL` or `REDIS_URL`)
2. Start `node dist/main` (NestJS `createApplicationContext` — no HTTP server)

**Handles:**
- `ORDER_SYNC` queue — status push-back to Uber Eats / Deliveroo / Just Eat / HubRise
- `PRINT_JOBS` queue — routes print jobs to the Flutter printer app

---

### 3. orderhub-web (Next.js Dashboard)

| Property | Value |
|---|---|
| Runtime | Docker (multi-stage Node 20 Alpine) |
| Dockerfile | `infrastructure/docker/Dockerfile.web` |
| Port | 3000 |
| Health check | `GET /` |
| Output | `standalone` (required for Docker) |
| Render type | `web` |
| Render plan | `starter` |
| Region | Frankfurt (eu-central) |

**Notes:**
- `next.config.ts` sets `output: "standalone"` — the Dockerfile copies `.next/standalone` for self-contained deployment.
- Server-side rewrites proxy `/api/*` → `orderhub-api` (set via `API_URL` env var, resolved by Render's `fromService` reference).

---

## External Services

### Supabase (Postgres)

- Managed Postgres 15, hosted on Supabase.
- Connection via `DATABASE_URL` (pooled connection string recommended for production).
- Enable **pgBouncer** pooler in Supabase for connection efficiency.
- Row-level security is NOT used by OrderHub (application-level tenant isolation).
- Backups: Supabase daily backups + pre-deploy `pg_dump` (see `DEPLOYMENT_RUNBOOK.md`).

### Upstash Redis

- Managed Redis, TLS-only (`rediss://` URL).
- Two connections: `REDIS_URL` (general) and `QUEUE_REDIS_URL` (Bull queues).
- Can point both to the same Upstash instance.
- Configure max connections to avoid exhaustion under load.

---

## Domain / URL Structure

| Service | URL Pattern |
|---|---|
| Dashboard (Web) | `https://app.orderhubsolutions.com` |
| API (public) | `https://api.orderhubsolutions.com` |
| Health check | `https://api.orderhubsolutions.com/api/v1/health` |
| Webhooks — Uber Eats | `https://api.orderhubsolutions.com/api/v1/webhooks/uber-eats` |
| Webhooks — Deliveroo | `https://api.orderhubsolutions.com/api/v1/webhooks/deliveroo` |
| Webhooks — Stripe | `https://api.orderhubsolutions.com/api/v1/webhooks/stripe` |
| Flutter printer polling | `https://api.orderhubsolutions.com/api/v1/print-jobs/pending/:shopCode` |

**Staging URLs** (Render auto-generated, configure custom domains after initial deploy):

| Service | Staging URL |
|---|---|
| Dashboard | `https://orderhub-web.onrender.com` |
| API | `https://orderhub-api.onrender.com` |

---

## CI/CD Pipeline

```
Push / PR
    │
    ▼
GitHub Actions: ci.yml
    ├── Lint
    ├── Type check (API + Worker + Web)
    ├── Prisma schema validation
    ├── Unit tests (327 suites, postgres + redis services)
    ├── Docker build validation (api, worker, web) — PRs + main/develop only
    └── Migration safety check — PRs to main only

    │ (on merge to main)
    ▼
GitHub Actions: staging-deploy.yml
    ├── Build Docker images
    ├── Push to GHCR (ghcr.io/orderhub/*)
    └── SSH deploy to staging

    │ (manual workflow_dispatch, requires approval)
    ▼
GitHub Actions: production-deploy.yml
    └── Manual deploy gate — requires team approval
```

---

## Security Boundaries

| Concern | Approach |
|---|---|
| Secrets management | Never in repo. `sync: false` in render.yaml = manual dashboard entry. |
| JWT signing | `generateValue: true` in render.yaml — Render generates on first deploy. |
| Credential encryption | AES-256-GCM. Key: 64 hex chars (`openssl rand -hex 32`). Must match `CREDENTIAL_ENCRYPTION_KEY`. |
| CORS | `SOCKET_CORS_ORIGIN` locked to production frontend domain. |
| Webhook signatures | HMAC-SHA256 verified for Uber Eats, Deliveroo, Stripe. |
| Provider credentials | Stored encrypted in DB via `CredentialService`. Never in env after backfill. |
| Sandbox guards | `SandboxService.guardNonProd()` throws in `NODE_ENV=production`. |

---

## Infrastructure as Code

| File | Purpose |
|---|---|
| `render.yaml` | Render Blueprint — declarative service definitions |
| `infrastructure/docker/Dockerfile.api` | API Docker image |
| `infrastructure/docker/Dockerfile.worker` | Worker Docker image |
| `infrastructure/docker/Dockerfile.web` | Web Docker image |
| `docker-compose.prod.yml` | VPS self-hosted deployment alternative |
| `.github/workflows/ci.yml` | CI pipeline |
| `.github/workflows/staging-deploy.yml` | Staging deploy |
| `.github/workflows/production-deploy.yml` | Production deploy (manual gate) |
| `scripts/start-api.sh` | API production startup (migrate + start) |
| `scripts/start-worker.sh` | Worker production startup |

---

## Scaling Considerations

- **API**: Stateless HTTP + WebSocket. Socket.IO uses Redis adapter (`REDIS_URL`) for multi-instance pub/sub. Scale to `numInstances: 2` on `standard` plan when needed.
- **Worker**: Single instance is fine for initial scale. Bull deduplicates jobs by `jobId`. Multiple workers can run the same queue safely.
- **Web**: Stateless Next.js. Scale freely. Cookie sessions are server-side via API.
- **Database**: Supabase connection pooling via PgBouncer. Upgrade Supabase tier before scaling beyond 10 concurrent API instances.
