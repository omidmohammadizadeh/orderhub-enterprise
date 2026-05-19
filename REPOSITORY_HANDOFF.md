# Repository Handoff

> Complete instructions for cloning, setting up, and running the OrderHub Enterprise codebase.

---

## Repository

| Field | Value |
|-------|-------|
| GitHub URL | `https://github.com/omidmohammadizadeh/orderhub-enterprise` |
| Active branch | `claude/xenodochial-brahmagupta-5521f8` |
| Latest commit | `04473b2` — Phase V: first paid activation and paid rollout readiness |
| Main branch | `main` — contains only the initial commit scaffold |
| Push status | ✅ Branch is pushed to GitHub (verified: `git ls-remote` confirms `04473b2` on remote) |

> **Warning:** `main` only contains a README scaffold. All working code is on `claude/xenodochial-brahmagupta-5521f8`. Do not merge to `main` until a full PR review is complete.

---

## Clone and Checkout

```bash
# Clone the repo
git clone https://github.com/omidmohammadizadeh/orderhub-enterprise.git
cd orderhub-enterprise

# Checkout the working branch (all Phase R–V code lives here)
git checkout claude/xenodochial-brahmagupta-5521f8
```

If you already have the repo locally (e.g. you see only README.md in your folder):

```bash
cd ~/orderhub-enterprise
git fetch origin
git checkout claude/xenodochial-brahmagupta-5521f8
```

---

## Repository Structure

```
orderhub-enterprise/
├── apps/
│   ├── api/        NestJS REST API — main backend
│   ├── web/        Next.js frontend dashboard
│   └── worker/     BullMQ background job worker
├── packages/
│   ├── database/   Prisma schema + generated client
│   ├── shared/     Shared types and utilities
│   ├── ui/         Shared React component library
│   ├── config/     Shared ESLint/TypeScript configs
│   └── eslint-config/
├── scripts/        Seed and migration scripts
├── docs/           Architecture documentation
└── *.md            Phase reports and operational docs
```

---

## Install Dependencies

```bash
# Install all workspace dependencies (requires pnpm)
npm install -g pnpm
pnpm install
```

> Note: `node_modules` uses pnpm symlinks. Do not use `npm install` or `yarn install` — they will not resolve workspace packages correctly. See `feedback_prisma_monorepo.md` in memory.

---

## Database Setup

```bash
# Apply all migrations
cd apps/api
DATABASE_URL="postgresql://..." npx prisma migrate deploy

# Generate Prisma client (must be run after migrations)
DATABASE_URL="postgresql://..." npx prisma generate
```

> The generated Prisma client lives at `packages/database/generated/prisma/`. The custom output path is required to avoid type resolution failures with pnpm symlinks (see `feedback_prisma_monorepo.md`).

---

## Environment Variables

Copy `.env.example` to `.env.local` and fill in:

```bash
# Required for API
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_SECRET=<32+ random chars>
JWT_REFRESH_SECRET=<32+ random chars>
CREDENTIAL_ENCRYPTION_KEY=<64 hex chars — openssl rand -hex 32>

# Stripe (use test keys for development)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Optional for development
USAGE_CRON_DRY_RUN=true
```

See `PRODUCTION_ENVIRONMENT.md` for complete production variable reference.

---

## Run Tests

```bash
cd apps/api

# All tests
npx jest --forceExit

# Billing tests only
npx jest --testPathPattern="billing" --forceExit

# Expected: 327 tests passing, 0 failures, 23 test suites
```

---

## TypeScript Check (Billing Module)

```bash
cd apps/api
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "^src/modules/billing"
# Expected: no output (billing module is clean)
```

**Known pre-existing TS errors** (unrelated to billing work, present since Phase Q):
- `src/modules/analytics/analytics.service.ts` — Prisma schema lag (snapshots, customer models not in generated client)
- `src/infrastructure/socket/redis-subscriber.service.ts` — WorkerEventType mismatch
- `src/modules/branding/branding.service.ts` — tenantBranding, customDomain not in generated client
- `src/modules/onboarding/onboarding.service.ts` — goLiveStatus Prisma lag

These resolve after running `prisma migrate deploy && prisma generate` in production.

---

## Build

```bash
cd apps/api
npm run build
```

> **Note:** `nest build` will report the pre-existing TS errors listed above and exit non-zero. This is a pre-existing issue. In production, run `prisma generate` before building to resolve Prisma schema lag. Alternatively, CI can skip TS errors with `nest build --tsc --skip-type-check` (NestJS v10+) or configure `skipLibCheck: true` in tsconfig.

---

## Start Development Server

```bash
cd apps/api
npm run dev   # NestJS watch mode (clears dist on start)

cd apps/web
npm run dev   # Next.js dev server

cd apps/worker
npm run dev   # BullMQ worker watch mode
```

---

## Seed Billing Plans

```bash
# Test mode (staging)
STRIPE_MODE=test STRIPE_SECRET_KEY=sk_test_... DATABASE_URL=... \
  node apps/api/src/scripts/seed-billing-plans.ts

# Live mode (production — run only once with live keys)
STRIPE_MODE=live STRIPE_SECRET_KEY=sk_live_... DATABASE_URL=... \
  node apps/api/src/scripts/seed-billing-plans.ts
```

---

## Smoke Test

```bash
SMOKE_BASE_URL=https://<api-domain> \
SMOKE_TENANT_ID=<uuid> \
SMOKE_ADMIN_TOKEN=<jwt> \
npx ts-node -P apps/api/tsconfig.json apps/api/src/scripts/smoke-test.ts
```

Expected: all 9 checks pass, exit code 0.

---

## Key Operational Documents

| Document | Purpose |
|----------|---------|
| `FIRST_PAID_CUSTOMER_PLAN.md` | Step-by-step first paid activation runbook |
| `STRIPE_PRODUCTION_CHECKLIST.md` | Pre-production Stripe checklist |
| `BILLING_ENFORCEMENT_MATRIX.md` | Every endpoint's billing access rules |
| `BILLING_OPERATIONS.md` | Live operations reference for billing |
| `PAID_ROLLOUT_PLAN.md` | 10–20 shop paid rollout process |
| `PAID_CUSTOMER_SUPPORT_RUNBOOK.md` | Support issue resolution guide |
| `FIRST_REAL_PAID_CUSTOMER_SIGNOFF.md` | First activation approval template |
| `RELEASE_CHECKLIST.md` | Full go-live checklist |
| `KNOWN_LIMITATIONS.md` | All documented limitations by phase |
| `PHASE_W_REPORT.md` | Phase W verification results |

---

## Phase History

| Phase | Commit | Summary |
|-------|--------|---------|
| R | `50caab5` | Billing, subscriptions, Stripe & commercial activation |
| S | `8ba3a92` | Billing automation, global BillingGuard, cron jobs |
| T | `6d66807` | Billing enforcement audit, Stripe webhook fixes |
| U | `1df0834` | Complete Stripe event flow, production readiness |
| V | `04473b2` | Checkout exemption fix, paid rollout documentation |
| W | _(current)_ | Repository safety, TS fix, Phase W documentation |

---

## Creating a Pull Request

```bash
# From any machine with GitHub access
gh pr create \
  --base main \
  --head claude/xenodochial-brahmagupta-5521f8 \
  --title "Phase R–W: Complete billing, Stripe integration, and paid activation readiness" \
  --body "All billing work from Phase R through W. See PHASE_W_REPORT.md for full summary."
```

Or via GitHub web UI: `https://github.com/omidmohammadizadeh/orderhub-enterprise/compare/main...claude/xenodochial-brahmagupta-5521f8`
