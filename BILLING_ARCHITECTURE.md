# Billing Architecture — Phase R

> Created: 2026-06-19
> Status: Implemented — awaiting Stripe credentials for production activation.

---

## Overview

OrderHub billing uses Stripe for subscription management and invoice generation. The billing system is designed around three principles:

1. **Live orders are never blocked by billing state.** Order ingestion, KDS, and printer endpoints are `@BillingExempt()` — billing status is never checked on the hot path.
2. **Grace period before hard block.** A failed payment gives 7 days of continued access before the tenant is moved to `UNPAID`.
3. **Server-side billing status only.** The frontend never dictates billing state — all checks read from the database, which is updated by verified Stripe webhook events.

---

## Data Model

### SubscriptionStatus enum

| Status | Meaning |
|--------|---------|
| `FREE_PILOT` | Existing Phase Q pilot shops — free until `trialEndsAt` (2026-09-01) |
| `TRIALING` | New signup in 30-day free trial |
| `ACTIVE` | Paid, in good standing |
| `PAST_DUE` | Payment failed; grace period active (`gracePeriodEndsAt` is set) |
| `UNPAID` | Grace period expired — read-only access only |
| `CANCELLED` | Subscription cancelled by tenant or admin |
| `PAUSED` | Subscription paused (managed via Stripe billing portal) |
| `INCOMPLETE` | Stripe checkout started but not completed |

### TenantSubscription fields (Phase R additions)

| Field | Type | Purpose |
|-------|------|---------|
| `billingEmail` | `String?` | Billing contact; may differ from owner email |
| `paymentMethodStatus` | `String?` | `ok` / `expiring_soon` / `expired` / `missing` — set from Stripe customer data |
| `lastInvoiceStatus` | `String?` | Mirrors `InvoiceStatus` of the most recent invoice |
| `gracePeriodEndsAt` | `DateTime?` | Set on first payment failure; `UNPAID` after this date |

### UsageRecord

Monthly aggregate of billable events per tenant per location. Written by a nightly cron — never in the order hot path.

```
(tenantId, locationId, billingMonth) UNIQUE
```

Fields: `orderCount`, `printJobCount`, `activeProviders`, `reportedToStripe`, `reportedAt`.

### StripeWebhookEvent

Idempotency log for Stripe webhook events. Every `POST /v1/webhooks/stripe` request:
1. Checks if `stripeEventId` already has `processedAt` set → returns early if yes
2. Creates the record (event received, not yet processed)
3. Calls `BillingService.handleStripeWebhookBilling()`
4. Updates record with `processedAt` (success) or `error` (failure)

---

## Billing Flow

### New tenant signup (Phase R+)

```
1. Tenant created (Tenant.plan = STARTER by default)
2. POST /v1/billing/checkout { planId, successUrl, cancelUrl }
   → creates Stripe customer (or reuses existing stripeCustomerId)
   → creates Stripe Checkout Session (with trial if plan has trialDays)
   → returns { url, sessionId } — frontend redirects to Stripe
3. Stripe sends checkout.session.completed webhook
4. StripeWebhookController verifies signature
5. BillingService updates TenantSubscription: status=TRIALING, stripeSubId, currentPeriod*
6. Tenant is now in trial
```

### Payment failure + grace period

```
1. Stripe sends invoice.payment_failed
2. BillingService.applyGracePeriod():
   - status → PAST_DUE
   - gracePeriodEndsAt → now + 7 days
3. BillingGuard still allows access (PAST_DUE within grace)
4. Nightly job: expireGracePeriods()
   - finds PAST_DUE where gracePeriodEndsAt < now
   - moves to UNPAID
5. BillingGuard now blocks non-exempt routes
```

### FREE_PILOT (existing shops)

```
1. Run: npx ts-node apps/api/src/scripts/migrate-pilot-shops.ts
   → sets status = FREE_PILOT, trialEndsAt = 2026-09-01
2. BillingGuard allows FREE_PILOT without checking grace
3. Before 2026-08-01: send written notice to all 5 shops
4. After 2026-09-01: run conversion job to move FREE_PILOT → TRIALING
   (then Stripe trial starts; card collected via billing portal)
```

---

## Components

### BillingService (`apps/api/src/modules/billing/billing.service.ts`)

Core service. Handles:
- Plan queries and subscription CRUD
- Invoice generation
- Stripe webhook event dispatch
- Grace period application and expiry
- FREE_PILOT migration helper
- Checkout/portal session creation (delegates to StripeService)
- Admin billing overview and tenant billing status

### StripeService (`apps/api/src/modules/billing/stripe.service.ts`)

Thin wrapper around Stripe SDK. Injected into BillingService. Handles:
- Customer creation
- Subscription creation and update
- Checkout session and billing portal session
- Metered usage reporting
- Webhook signature verification

Never stores card details. Never exposes Stripe secret to frontend.

### StripeWebhookController (`apps/api/src/modules/billing/stripe-webhook.controller.ts`)

`POST /v1/webhooks/stripe` — `@Public()`, verified by Stripe signature.
- Verifies `stripe-signature` header using `STRIPE_WEBHOOK_SECRET`
- Checks `StripeWebhookEvent` table for duplicate events
- Delegates to `BillingService.handleStripeWebhookBilling()`
- Returns 200 even on processing errors (prevents Stripe retry storms)

### BillingGuard (`apps/api/src/common/guards/billing.guard.ts`)

Applied globally or per-module. Reads `TenantSubscription.status` from DB.

Rules:
- `@BillingExempt()` routes → always pass (order endpoints, printer polling)
- `PLATFORM_ADMIN` → always pass
- `TRIALING`, `ACTIVE`, `FREE_PILOT` → pass
- `PAST_DUE` within grace → pass
- `PAST_DUE` after `gracePeriodEndsAt` → ForbiddenException
- `UNPAID`, `CANCELLED` → ForbiddenException
- No subscription record → pass (pre-billing tenants)

### UsageService (`apps/api/src/modules/billing/usage.service.ts`)

Called by nightly cron. Aggregates order/print/provider counts per tenant per location.

- `aggregateMonthlyUsage(tenantId, locationId, month?)` — upserts `UsageRecord`
- `getUsageSummary(tenantId, month?)` — returns current period totals
- `markReportedToStripe(...)` — marks record as reported

---

## API Endpoints

### Tenant-facing (requires auth)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/billing/plans` | List active plans (public) |
| `GET` | `/v1/billing/status` | Current billing status, plan, recent invoices |
| `GET` | `/v1/billing/subscription` | Subscription with plan details |
| `POST` | `/v1/billing/subscription` | Create subscription |
| `PATCH` | `/v1/billing/subscription` | Change plan (TENANT_OWNER) |
| `DELETE` | `/v1/billing/subscription` | Cancel at period end (TENANT_OWNER) |
| `GET` | `/v1/billing/invoices` | Invoice list |
| `GET` | `/v1/billing/invoices/:id` | Single invoice |
| `POST` | `/v1/billing/checkout` | Start Stripe Checkout (TENANT_OWNER) |
| `POST` | `/v1/billing/portal` | Open Stripe Billing Portal (TENANT_OWNER) |

### Admin (PLATFORM_ADMIN only)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/billing/admin/overview` | All tenant subscriptions |

### Webhook (public, signature-verified)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/webhooks/stripe` | Stripe event receiver |

---

## Security

- `STRIPE_SECRET_KEY` — server-side only, never exposed to frontend
- `STRIPE_WEBHOOK_SECRET` — used to verify incoming webhook signatures
- `STRIPE_PUBLISHABLE_KEY` — can be sent to frontend for Stripe.js
- No card details stored anywhere in OrderHub
- Billing status always read from DB — never from request body or client-supplied params
- All tenant billing queries scoped by `tenantId` from JWT

---

## Configuration

Required env vars (set in `.env.production`):

```bash
STRIPE_SECRET_KEY=sk_live_...          # or sk_test_... for staging
STRIPE_WEBHOOK_SECRET=whsec_...        # from Stripe Dashboard → Webhooks
STRIPE_PUBLISHABLE_KEY=pk_live_...     # safe to send to frontend

# Price IDs from Stripe Dashboard → Products
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_PROFESSIONAL=price_...
STRIPE_PRICE_ENTERPRISE=price_...      # optional — Enterprise is custom
```

See `STRIPE_SETUP.md` for setup walkthrough.

---

## Phase R Limitations

- **Stripe not yet wired to free trial conversion**: When a FREE_PILOT tenant passes `trialEndsAt`, there is no automated job to start their Stripe trial. Phase S: add a scheduled job to detect `FREE_PILOT` with `trialEndsAt` in the past and prompt conversion.
- **Metered usage not yet reported to Stripe**: `UsageService.aggregateMonthlyUsage()` computes totals but `reportedToStripe` is not yet set to true. Phase S: add the nightly cron that calls `StripeService.reportMeteredUsage()` and updates `reportedToStripe`.
- **Payment method status not synced**: `paymentMethodStatus` field is not yet populated from Stripe customer data. Phase S: sync on `customer.updated` webhook.
- **BillingGuard not globally applied**: Currently available but must be added to individual modules. Phase S: add as a global guard to APP_MODULE after confirming all live-order endpoints are `@BillingExempt()`.
