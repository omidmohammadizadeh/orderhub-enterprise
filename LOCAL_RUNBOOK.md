# LOCAL_RUNBOOK — OrderHub Enterprise

> Exact commands to run the full system on your Mac.  
> Follow every step in order. Tested on macOS Sonoma/Sequoia with Node 20 + pnpm 9.

---

## Prerequisites

Install once:

```bash
# Node.js 20+ (use nvm for version management)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 20 && nvm use 20

# pnpm 9
npm install -g pnpm@9

# Docker Desktop — download from https://docs.docker.com/get-docker/
# Then start Docker Desktop before proceeding.

# jq (for curl helpers)
brew install jq
```

Verify:
```bash
node -v          # v20.x.x
pnpm -v          # 9.x.x
docker --version # Docker version 27.x or later
```

---

## One-Time Setup

### Step 1 — Clone and checkout the branch

```bash
git clone git@github.com:your-org/orderhub-enterprise.git
cd orderhub-enterprise

# All Phase work is on this branch:
git checkout claude/xenodochial-brahmagupta-5521f8
```

Or if you already cloned:
```bash
git fetch origin
git checkout claude/xenodochial-brahmagupta-5521f8
```

---

### Step 2 — Install dependencies

```bash
pnpm install
```

> **Important:** Always use `pnpm`, not `npm` or `yarn`. The workspace uses pnpm symlinks.

---

### Step 3 — Create your .env file

```bash
cp .env.example .env
```

Open `.env` and set these minimum values for local dev:

```env
# Already correct for the Docker setup below:
DATABASE_URL="postgresql://orderhub:orderhub_secret@localhost:5433/orderhub_dev?schema=public"
REDIS_URL=redis://localhost:6379
QUEUE_REDIS_URL=redis://localhost:6379

# Generate these:
JWT_SECRET=<run: openssl rand -base64 48>
JWT_REFRESH_SECRET=<run: openssl rand -base64 48>

# Credential encryption — 64 hex chars:
CREDENTIAL_ENCRYPTION_KEY=<run: openssl rand -hex 32>

# Stripe test keys (get from Stripe dashboard → Developers → API keys):
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PUBLISHABLE_KEY=pk_test_...

# Leave blank for local dev — provider integrations will be sandbox-only:
UBER_EATS_CLIENT_ID=
UBER_EATS_CLIENT_SECRET=
DELIVEROO_CLIENT_ID=
DELIVEROO_CLIENT_SECRET=
JUST_EAT_CLIENT_ID=
JUST_EAT_CLIENT_SECRET=
HUBRISE_CLIENT_ID=
HUBRISE_CLIENT_SECRET=

# Web app URL (for CORS):
APP_URL=http://localhost:3000
SOCKET_CORS_ORIGIN=http://localhost:3000
```

Generate secrets in one step:
```bash
echo "JWT_SECRET=$(openssl rand -base64 48)"
echo "JWT_REFRESH_SECRET=$(openssl rand -base64 48)"
echo "CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32)"
```

---

### Step 4 — Start Postgres and Redis

```bash
pnpm docker:dev
```

Wait ~10 seconds for containers to be healthy:
```bash
docker ps   # should show orderhub_postgres, orderhub_redis (and optional dev tools)
```

> Postgres runs on port **5433** (not 5432) to avoid conflicts with any local Postgres install.  
> Redis runs on port **6379**.

---

### Step 5 — Build shared packages

```bash
pnpm --filter @orderhub/shared build
```

This compiles `packages/shared` TypeScript types that the API and web app import.

---

### Step 6 — Generate Prisma client

```bash
cd packages/database
npx prisma generate
cd ../..
```

This generates the typed database client from the schema. **Must be re-run after any schema change.**

---

### Step 7 — Apply migrations and seed

```bash
cd packages/database

# Apply all migrations (creates tables):
npx prisma migrate deploy

# OR for a fresh local setup (faster, no migration history):
npx prisma db push

# Seed demo data (admin user, billing plans, demo tenant):
npx tsx prisma/seed.ts

cd ../..
```

> `db push` is fine for local dev. Use `migrate deploy` for production or staging.

---

### Step 8 — Start all apps

```bash
pnpm dev
```

This starts API + web + worker in parallel using Turborepo.

---

## Services After `pnpm dev`

| Service | URL | Notes |
|---------|-----|-------|
| **Web Dashboard** | http://localhost:3000 | Login URL |
| **API** | http://localhost:4000 | NestJS REST API |
| **Swagger UI** | http://localhost:4000/docs | API documentation |
| **pgAdmin** | http://localhost:5050 | DB browser (dev@orderhub.io / devpassword) |
| **Redis Commander** | http://localhost:8081 | Redis browser |
| **Bull Dashboard** | http://localhost:3001 | Queue monitoring |
| **Mailpit** | http://localhost:8025 | Catch-all email (no real email sent) |

---

## Login

### Web app login

Navigate to: **http://localhost:3000/login**

After seeding, the demo admin account is:

```
Email:    admin@demo.orderhub.io
Password: Demo1234!
```

> If the seed ran successfully, this account has:
> - Role: TENANT_OWNER
> - Billing status: TRIALING (active plan features)
> - Demo brand + location pre-configured

### Create your own admin

If you want a real account:

```bash
# Use the API directly:
curl -s -X POST http://localhost:4000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "you@example.com",
    "password": "YourPassword123!",
    "firstName": "Your",
    "lastName": "Name",
    "tenantName": "My Restaurant Group"
  }' | jq '.'
```

---

## Getting a JWT Token (API testing)

```bash
TOKEN=$(curl -s -X POST http://localhost:4000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.orderhub.io","password":"Demo1234!"}' \
  | jq -r '.accessToken')

echo "Token: $TOKEN"

# Test it:
curl -s http://localhost:4000/api/v1/health/ready | jq '.'
curl -s http://localhost:4000/api/v1/auth/me \
  -H "Authorization: Bearer $TOKEN" | jq '.'
```

---

## Simulating Orders (Dev/Test)

### Via sandbox endpoint (requires auth)

```bash
curl -s -X POST http://localhost:4000/api/v1/sandbox/simulate-order \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"locationId":"<your-location-id>","platform":"UBER_EATS"}' | jq '.'
```

### Via webhook simulation

```bash
# Simulate an Uber Eats webhook (replace locationId):
curl -s -X POST "http://localhost:4000/api/v1/webhooks/uber-eats/<locationId>" \
  -H "Content-Type: application/json" \
  -H "x-uber-signature: test-sig" \
  -d '{
    "event_type": "orders.notification",
    "order": {
      "id": "test-order-001",
      "display_id": "ABC123",
      "cart": {
        "items": [{"title":"Burger","quantity":1,"base_unit_price":{"amount":1200},"price":{"amount":1200}}]
      },
      "payment": {"charges":{"total":{"amount":1200},"subtotal":{"amount":1200}}},
      "eater": {"first_name":"Test","last_name":"Customer"}
    }
  }' | jq '.'
```

---

## Common Development Commands

```bash
# Type-check all packages:
pnpm type-check

# Run all tests:
pnpm test

# Run API tests only (watch mode):
pnpm --filter @orderhub/api exec jest --watch

# Run a specific test file:
pnpm --filter @orderhub/api exec jest billing-guard

# Lint:
pnpm lint

# Open Prisma Studio (database GUI):
cd packages/database && npx prisma studio

# Reset database completely (drops all data, re-applies schema, re-seeds):
cd packages/database
npx prisma db push --force-reset
npx tsx prisma/seed.ts
cd ../..

# Stop all Docker services:
pnpm docker:down

# View Docker logs:
pnpm docker:logs
```

---

## Troubleshooting

### "Cannot find module dist/main" on API start

```bash
cd apps/api
rm -rf dist node_modules/.cache
cd ../..
pnpm dev
```

### Prisma type errors after a schema change

```bash
cd packages/database && npx prisma generate && cd ../..
pnpm --filter @orderhub/shared build
```

### "Port 5432 already in use"

The dev Postgres uses port **5433** by default. Check your `.env` — `DATABASE_URL` must use port `5433`.

### Redis connection refused

```bash
docker compose up -d redis
```

### "BillingGuard blocks my request" during dev

If the demo tenant has billing state UNPAID, update it:
```bash
cd packages/database
npx prisma studio
# In Studio: find the Tenant record → set billingStatus to TRIALING
```

Or via SQL:
```bash
docker exec -it orderhub_postgres psql -U orderhub -d orderhub_dev \
  -c "UPDATE tenants SET \"billingStatus\" = 'TRIALING' WHERE id = '<tenant-id>';"
```

### Web app can't connect to API (CORS error)

Ensure `SOCKET_CORS_ORIGIN=http://localhost:3000` is set in `.env` and the API has been restarted.

### Just Eat / HubRise integrations

Do NOT attempt to activate Just Eat or HubRise integrations locally — they are not production-validated. See `KNOWN_LIMITATIONS.md`.

---

## Stripe Local Testing

For billing flows (checkout, subscription management):

1. Install Stripe CLI: `brew install stripe/stripe-cli/stripe`
2. Login: `stripe login`
3. Forward webhooks to local API:
   ```bash
   stripe listen --forward-to http://localhost:4000/api/v1/billing/webhook
   ```
4. Copy the webhook signing secret shown and set it in `.env`:
   ```env
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```
5. Trigger test events:
   ```bash
   stripe trigger checkout.session.completed
   stripe trigger customer.subscription.updated
   ```

---

## Health Check

Verify everything is running:

```bash
curl -s http://localhost:4000/api/v1/health/ready | jq '.'
# Expected: { "status": "ok", "checks": { "database": {"status":"ok"}, "redis": {"status":"ok"} } }

curl -s http://localhost:4000/api/v1/health | jq '.'
# Expected: { "status": "ok", "timestamp": "..." }
```
