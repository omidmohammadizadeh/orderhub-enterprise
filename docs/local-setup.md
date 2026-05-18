# Local Development Setup

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 20 | [nodejs.org](https://nodejs.org) or `nvm` |
| pnpm | ≥ 9 | `npm i -g pnpm` |
| Docker Desktop | latest | [docker.com](https://docs.docker.com/get-docker/) |
| jq | any | `brew install jq` |

## First-time Setup

```bash
# 1. Clone the repo
git clone git@github.com:your-org/orderhub-enterprise.git
cd orderhub-enterprise

# 2. Install all workspace dependencies
pnpm install

# 3. Copy environment file
cp .env.example .env

# 4. Start infrastructure (Postgres + Redis)
pnpm docker:dev

# Wait for Postgres and Redis to be ready (~ 5 seconds)

# 5. Apply database schema and seed
cd packages/database
npx prisma db push
npx tsx prisma/seed.ts
cd ../..

# 6. Build workspace packages (shared types)
pnpm --filter @orderhub/shared build

# 7. Start all apps in parallel
pnpm dev
```

## Services After `pnpm dev`

| Service | URL |
|---|---|
| API | http://localhost:4000 |
| Swagger UI | http://localhost:4000/docs |
| Web Dashboard | http://localhost:3000 |
| pgAdmin | http://localhost:5050 (dev@orderhub.io / devpassword) |
| Redis Commander | http://localhost:8081 |
| Bull Dashboard | http://localhost:3001 |
| Mailpit (email) | http://localhost:8025 |

## Test Login

```
Email:    admin@demo.orderhub.io
Password: Demo1234!
```

## Getting a JWT Token

```bash
TOKEN=$(curl -s -X POST http://localhost:4000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.orderhub.io","password":"Demo1234!"}' \
  | jq -r '.accessToken')

echo $TOKEN
```

## Running the Full Order Flow

```bash
./scripts/simulate-order-flow.sh loc_demo_001 "$TOKEN"
```

## Simulating Platform Webhooks

```bash
# First, create an integration with webhookSecret = "test-secret-for-dev"
# via POST /api/v1/integrations

./scripts/simulate-webhook.sh uber-eats loc_demo_001
./scripts/simulate-webhook.sh deliveroo loc_demo_001
```

## Common Commands

```bash
# Reset database completely (drops + recreates + seeds)
cd packages/database && npx prisma db push --force-reset && npx tsx prisma/seed.ts

# Open Prisma Studio (database GUI)
cd packages/database && npx prisma studio

# Run type checks
pnpm type-check

# Run unit tests
pnpm test

# Run tests in watch mode
pnpm --filter @orderhub/api exec jest --watch

# Lint
pnpm lint

# Stop all Docker services
pnpm docker:down
```

## Troubleshooting

**API won't start — "Cannot find module dist/main"**
```bash
# Clear build cache and restart
cd apps/api && rm -rf dist node_modules/.cache && cd ../.. && pnpm dev
```

**Prisma type errors after schema change**
```bash
cd packages/database && npx prisma generate && npx tsc && cd ../..
pnpm --filter @orderhub/api exec tsc --noEmit
```

**Redis connection refused**
```bash
docker compose up -d redis
```

**Port 5432 already in use**
The dev Postgres uses port 5433 by default (to avoid conflicts with local Postgres on 5432). Check `.env` — `DATABASE_URL` should use port `5433`.
