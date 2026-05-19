# Phase R Report — Billing, Subscriptions & Commercial Activation

> Phase R start: 2026-06-19
> Status: Implementation complete — awaiting Stripe configuration and production migration.

---

## Summary

Phase R implements the commercial billing and subscription infrastructure documented in `COMMERCIAL_READINESS_NOTES.md`. The system is built but not yet activated — Stripe credentials must be configured and the pilot shop migration must be run before billing is live.

**Test results:** 271 total (241 API + 30 worker), 0 failures.

---

## What Was Built

### 1. Database Schema (Phase R migration)

Migration: `20260619000000_phase_r`

- `SubscriptionStatus` enum: added `FREE_PILOT` and `UNPAID`
- `TenantSubscription`: added `billingEmail`, `paymentMethodStatus`, `lastInvoiceStatus`, `gracePeriodEndsAt`
- New table: `usage_records` — monthly aggregation per tenant per location
- New table: `stripe_webhook_events` — idempotency log for Stripe events

### 2. StripeService

`apps/api/src/modules/billing/stripe.service.ts`

Thin Stripe SDK wrapper. Handles:
- Customer creation (no card details stored)
- Subscription creation with optional trial
- Checkout session (redirects to Stripe Checkout)
- Billing portal session (for self-service payment management)
- Metered usage reporting
- Webhook signature verification

Loaded lazily — if `STRIPE_SECRET_KEY` is absent, throws on first Stripe call (not at startup). FREE_PILOT shops work without Stripe configured.

### 3. BillingService (extended)

`apps/api/src/modules/billing/billing.service.ts`

Phase R additions:
- `FREE_PILOT` and `UNPAID` in the status mirror enum
- `applyGracePeriod(tenantId)` — sets PAST_DUE + gracePeriodEndsAt (7 days)
- `expireGracePeriods()` — bulk moves PAST_DUE→UNPAID after grace expiry
- `createCheckoutSession(...)` — creates Stripe customer if needed, returns checkout URL
- `createPortalSession(...)` — returns Stripe Billing Portal URL
- `migrateToFreePilot(tenantId, trialEndsAt)` — marks existing subscription as FREE_PILOT
- `getTenantBillingStatus(tenantId)` — tenant-scoped status (no Stripe IDs exposed)
- `getAdminBillingOverview()` — all tenant subscriptions for PLATFORM_ADMIN

### 4. StripeWebhookController

`apps/api/src/modules/billing/stripe-webhook.controller.ts`

`POST /v1/webhooks/stripe`
- `@Public()` — no JWT required (verified by Stripe signature)
- Verifies `stripe-signature` header
- Checks `StripeWebhookEvent` for duplicate events (idempotent)
- Records event before processing
- Returns 200 even on processing errors (prevents Stripe retry storms)

### 5. BillingGuard

`apps/api/src/common/guards/billing.guard.ts`

- Reads `TenantSubscription.status` from DB (never from client)
- `@BillingExempt()` decorator — marks routes that must never be blocked (order ingestion, printer polling, KDS)
- PLATFORM_ADMIN always bypasses billing check
- Grace period: PAST_DUE tenants allowed until `gracePeriodEndsAt`
- UNPAID/CANCELLED/INCOMPLETE: ForbiddenException with clear message

### 6. UsageService

`apps/api/src/modules/billing/usage.service.ts`

- `aggregateMonthlyUsage(tenantId, locationId)` — upserts usage record
- `getUsageSummary(tenantId, month?)` — returns period totals
- `markReportedToStripe(...)` — marks record as synced to Stripe

Designed to be called by a nightly cron (not yet wired). Never on the order hot path.

### 7. Scripts

- `apps/api/src/scripts/seed-billing-plans.ts` — creates Starter/Professional/Enterprise plans
- `apps/api/src/scripts/migrate-pilot-shops.ts` — marks 5 Phase Q shops as FREE_PILOT

Both are idempotent / dry-run safe.

### 8. New Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /v1/billing/status` | Any tenant | Current billing status, plan, invoices |
| `POST /v1/billing/checkout` | TENANT_OWNER | Start Stripe Checkout |
| `POST /v1/billing/portal` | TENANT_OWNER | Open Stripe Billing Portal |
| `GET /v1/billing/admin/overview` | PLATFORM_ADMIN | All tenant subscriptions |
| `POST /v1/webhooks/stripe` | Public (sig-verified) | Stripe event receiver |

### 9. Tests (47 new, all passing)

| File | Tests | Coverage |
|------|-------|---------|
| `billing/tests/billing.service.spec.ts` | 18 | Plan queries, subscription lifecycle, grace period, pilot migration, tenant isolation, idempotent webhook |
| `billing/tests/billing-guard.spec.ts` | 11 | All status variants, grace window, admin bypass, exempt routes, tenantId isolation |
| `billing/tests/usage.service.spec.ts` | 9 | Aggregation, scope, billing month calculation, summary, reporting |
| `billing/tests/stripe-webhook.spec.ts` | 9 | Idempotency, duplicate skip, error handling, no-block guarantee |

### 10. Documentation

- `BILLING_ARCHITECTURE.md` — data model, flows, components, security, limitations
- `PRICING_AND_PLANS.md` — plan features, pricing, trial policy, pilot shop policy
- `STRIPE_SETUP.md` — step-by-step Stripe configuration guide
- `PHASE_R_REPORT.md` — this file

---

## What Was Explicitly NOT Built (by design)

Per Phase R constraints:
- No Stripe credentials hardcoded
- No card details stored
- No frontend billing enforcement (server-side only)
- No automated grace-period expiry cron (designed, not wired)
- No usage-to-Stripe reporting cron (designed, not wired)
- No mass rollout — existing 5 shops remain FREE_PILOT
- Flutter printer app contract unchanged — no `@BillingExempt()` needed (already public)
- Just Eat and HubRise status unchanged — not production-validated

---

## Before Going Live with Billing

1. Run the Phase R migration: `prisma migrate deploy` (includes `20260619000000_phase_r`)
2. Configure Stripe (see `STRIPE_SETUP.md`)
3. Seed billing plans: `node apps/api/src/scripts/seed-billing-plans.ts`
4. Run pilot shop migration: `node apps/api/src/scripts/migrate-pilot-shops.ts`
5. Send written notice to 5 pilot shops before 2026-08-01
6. Add `@BillingExempt()` to order ingestion, KDS, printer endpoints before applying BillingGuard globally

---

## Phase S (Next Phase) Checklist

- [ ] Nightly cron: `UsageService.aggregateMonthlyUsage()` for all active locations
- [ ] Nightly cron: `BillingService.expireGracePeriods()`
- [ ] FREE_PILOT → TRIALING conversion job (runs after `trialEndsAt` passes)
- [ ] Stripe metered usage reporting (after aggregation)
- [ ] Payment method status sync from `customer.updated` Stripe webhook
- [ ] Apply `BillingGuard` globally (after all live-order endpoints are `@BillingExempt()`)
- [ ] Trial conversion email sequence (Day 15, Day 27, Day 30)
- [ ] KDS colour contrast fix (Issue Q-003)
- [ ] WebSocket reconnection with exponential backoff (Issue Q-005)
- [ ] `PENDING_APPROVAL` integration status enum value
- [ ] Multi-shop analytics cross-location permission fix
