# Deployment Guide

## Architecture Overview

```
Internet → Nginx → API (port 4000)
                 → Web (port 3000)
         → API   → Worker (internal)
API/Worker → Postgres (internal)
API/Worker → Redis (internal)
```

All application containers sit on an `internal` Docker network with no direct internet access. Only Nginx has ports exposed to the host.

## Container Images

| Image | Dockerfile | Role |
|---|---|---|
| `orderhub/api` | `infrastructure/docker/Dockerfile.api` | NestJS REST + WebSocket API |
| `orderhub/worker` | `infrastructure/docker/Dockerfile.worker` | BullMQ queue processors |
| `orderhub/web` | `infrastructure/docker/Dockerfile.web` | Next.js dashboard |

All images use multi-stage builds: `deps` → `builder` → `runner`. The runner stage uses a non-root user (`nestjs`/`nextjs`) and `dumb-init` as PID 1 for proper signal forwarding.

## Single-Server Deployment

```bash
# 1. On the server, clone the repo
git clone git@github.com:your-org/orderhub-enterprise.git /opt/orderhub
cd /opt/orderhub

# 2. Create production env file
cp .env.production.example .env.production
# Edit .env.production with real credentials

# 3. Build images
IMAGE_TAG=v1.0.0 docker compose -f docker-compose.prod.yml build

# 4. Apply database migrations
docker compose -f docker-compose.prod.yml run --rm api \
  node -e "require('./dist/main')" &
# Or run migrations directly:
DATABASE_URL=... npx prisma migrate deploy

# 5. Start all services
IMAGE_TAG=v1.0.0 docker compose -f docker-compose.prod.yml up -d
```

## Rolling Deployment (zero-downtime)

The recommended deploy order avoids downtime:

1. **Pull new images** (does not restart anything)
2. **Restart worker first** — no traffic impact; processes queue jobs
3. **Wait 15s** for worker health
4. **Restart API** — new version starts, health check passes before old container stops
5. **Restart web** — new Next.js build

```bash
IMAGE_TAG=staging-abc123

# Pull
docker compose -f docker-compose.prod.yml pull api worker web

# Worker first
docker compose -f docker-compose.prod.yml up -d --no-deps worker
sleep 15

# API
docker compose -f docker-compose.prod.yml up -d --no-deps api

# Health check (repeat up to 5 times, 10s apart)
for i in $(seq 5); do
  sleep 10
  docker compose -f docker-compose.prod.yml exec api \
    wget -qO- http://localhost:4000/api/v1/health/ready && break
done

# Web
docker compose -f docker-compose.prod.yml up -d --no-deps web
```

## CI/CD Workflow

| Trigger | Workflow | What happens |
|---|---|---|
| Push to `develop` | `staging-deploy.yml` | Build → push images → migrate staging DB → deploy |
| Manual dispatch | `production-deploy.yml` | Promote staging image → migrate prod DB → rolling deploy |

See `.github/workflows/` for full workflow definitions.

## Environment Variables Injection

**Docker Compose (VPS):** `env_file: .env.production` in `docker-compose.prod.yml`

**AWS ECS:** Use Secrets Manager; inject as environment variables in task definition

**Kubernetes:** Use `secretKeyRef` in pod spec; populate via `kubectl create secret generic`

**Fly.io:** `flyctl secrets set KEY=value`

Never pass secrets as Docker build args — they appear in image history.

## Health Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/health` | Liveness — returns 200 if process alive |
| `GET /api/v1/health/live` | Kubernetes liveness probe |
| `GET /api/v1/health/ready` | Readiness probe — checks DB + Redis |

Configure your load balancer to use `/health/ready` for routing decisions. Use `/health/live` (or `/health`) for restart decisions.

## Graceful Shutdown

All containers use `dumb-init` as PID 1 and NestJS `enableShutdownHooks()`. On `SIGTERM`:

1. Docker sends SIGTERM to `dumb-init`
2. `dumb-init` forwards SIGTERM to Node process
3. NestJS runs `OnModuleDestroy` hooks in all modules
4. Prisma closes DB connections
5. BullMQ drains in-flight jobs (worker only)
6. Process exits cleanly

Set `stop_grace_period: 30s` in your orchestrator to allow enough time.

## Database Migrations

Run migrations **before** starting new application containers:

```bash
DATABASE_URL=postgresql://... npx prisma migrate deploy
```

See [migration-playbook.md](migration-playbook.md) for full guidance.
