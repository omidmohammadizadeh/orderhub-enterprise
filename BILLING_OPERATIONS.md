# Billing Operations

> Operational reference for the OrderHub billing system.
> For support issue resolution, see PAID_CUSTOMER_SUPPORT_RUNBOOK.md.
> For Stripe dashboard setup, see STRIPE_PRODUCTION_CHECKLIST.md.
> For first paid activation steps, see FIRST_PAID_CUSTOMER_PLAN.md.

---

## Architecture Overview

```
Tenant → POST /billing/checkout
            ↓
       Stripe Checkout (hosted page)
            ↓
       Stripe fires webhooks → POST /api/v1/webhooks/stripe
            ↓
       StripeWebhookController → signature verification → BillingService.handleStripeWebhookBilling()
            ↓
       TenantSubscription updated in DB
            ↓
       BillingGuard reads TenantSubscription on each request
```

**No card data is stored in OrderHub.** All payment information is held by Stripe.

---

## Billing Status States

| Status | Meaning | Commercial Actions | Critical Trading |
|--------|---------|-------------------|-----------------|
| `FREE_PILOT` | Complimentary pilot period | ✅ Allowed | ✅ Always |
| `TRIALING` | Stripe trial active | ✅ Allowed | ✅ Always |
| `ACTIVE` | Paid and current | ✅ Allowed | ✅ Always |
| `PAST_DUE` (within grace) | Payment failed, 7-day grace | ✅ Allowed | ✅ Always |
| `PAST_DUE` (grace expired) | Grace period ended | 🔒 Blocked | ✅ Always |
| `UNPAID` | Grace expired, no payment | 🔒 Blocked | ✅ Always |
| `CANCELLED` | Subscription cancelled | 🔒 Blocked | ✅ Always |
| `INCOMPLETE` | Checkout started but not completed | 🔒 Blocked | ✅ Always |

**Critical trading endpoints are NEVER blocked regardless of billing status.** See BILLING_ENFORCEMENT_MATRIX.md.

---

## Stripe Webhook Event Flow

### Normal checkout → active subscription

```
checkout.session.completed
  → stores stripeSubId on TenantSubscription

customer.subscription.created
  → maps Stripe status (active/trialing) to internal status
  → syncs payment method status and period dates

invoice.finalized
  → creates Invoice record in DB with OPEN status

invoice.paid
  → marks Invoice PAID
  → sets lastInvoiceStatus: "PAID" on TenantSubscription
  → if PAST_DUE: moves to ACTIVE and clears gracePeriodEndsAt
```

### Payment failure and recovery

```
invoice.payment_failed
  → status: PAST_DUE
  → lastInvoiceStatus: "OPEN"
  → gracePeriodEndsAt: now + 7 days

[Hourly cron — if gracePeriodEndsAt expires]
  → status: UNPAID

[Customer updates payment via Stripe Billing Portal]
  → customer.updated → paymentMethodStatus: "attached"
  → customer.subscription.updated → status: active → ACTIVE

[Stripe retries invoice]
  → invoice.paid → ACTIVE + lastInvoiceStatus: "PAID" + gracePeriodEndsAt: null
```

### Cancellation

```
customer.subscription.deleted
  → status: CANCELLED
```

---

## Cron Jobs

| Job | Schedule | Effect |
|-----|----------|--------|
| `expireGracePeriods` | Every hour | PAST_DUE with expired grace → UNPAID |
| `expireFreePilots` | Daily 01:00 UTC | FREE_PILOT with past trialEndsAt → TRIALING |
| `aggregateUsage` | Daily 02:00 UTC | Aggregates orders + prints per location into usage_records |
| `warnFreePilots` | Daily 09:00 UTC | Logs approaching FREE_PILOT end dates |

**Concurrency protection:** `expireGracePeriods` and `aggregateUsage` have `private runningFlag` guards to prevent overlapping executions.

**Dry run:** Set `USAGE_CRON_DRY_RUN=true` to run usage aggregation without writing to DB.

---

## Admin API Reference

### View all tenant subscriptions
```
GET /api/v1/billing/admin/overview
Authorization: PLATFORM_ADMIN
```

### View single tenant billing detail (includes Stripe IDs)
```
GET /api/v1/billing/admin/tenants/:id
Authorization: PLATFORM_ADMIN
```

### Assign subscription plan (reason required)
```
PATCH /api/v1/billing/admin/tenants/:id/plan
Body: { planId, reason }
Authorization: PLATFORM_ADMIN
```

### Grant exception (manual status override, reason required)
```
POST /api/v1/billing/admin/tenants/:id/grant-exception
Body: { status, reason }
Authorization: PLATFORM_ADMIN
```
Valid statuses: `ACTIVE`, `TRIALING`, `FREE_PILOT`

### Extend FREE_PILOT (reason required)
```
POST /api/v1/billing/admin/tenants/:id/extend-pilot
Body: { newTrialEndsAt, reason }
Authorization: PLATFORM_ADMIN
```

### Convert FREE_PILOT or UNPAID to trial (reason required)
```
POST /api/v1/billing/admin/tenants/:id/convert-to-trial
Body: { reason }
Authorization: PLATFORM_ADMIN
```

---

## Security Controls

| Control | Implementation |
|---------|----------------|
| Stripe secret key | Read from env at runtime; never in source code |
| Webhook signature | `constructWebhookEvent` validates HMAC signature before any processing |
| Duplicate events | `stripe_webhook_events` table deduplicates by `stripeEventId` |
| Stripe IDs in responses | `getTenantBillingStatus` strips `stripeCustomerId` and `stripeSubId` |
| Card data | Not stored — Stripe handles all card data |
| Audit trail | All billing state changes write to `audit_log` table |

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `subscription_plans` | Billing plans (STARTER, PROFESSIONAL, ENTERPRISE) with Stripe price IDs |
| `tenant_subscriptions` | One per tenant: status, stripeCustomerId, stripeSubId, trial/grace dates |
| `invoices` | One per Stripe invoice: amount, status (OPEN/PAID), period |
| `stripe_webhook_events` | Deduplication table: one row per Stripe event ID |
| `audit_log` | Immutable log of all billing events with actor and reason |
| `usage_records` | Daily aggregated order/print counts per location for billing metrics |

---

## Monitoring Checklist (Weekly for Each Paid Tenant)

- [ ] `tenantSubscription.status` is `ACTIVE` (not PAST_DUE or UNPAID)
- [ ] `paymentMethodStatus` is `attached`
- [ ] `lastInvoiceStatus` is `PAID`
- [ ] `gracePeriodEndsAt` is null (no active payment issue)
- [ ] `currentPeriodEnd` is in the future
- [ ] Stripe webhook deliveries: all 200 in last 7 days
- [ ] `stripe_webhook_events` table: no entries with error body
- [ ] `audit_log`: billing events present and making sense
- [ ] `usage_records`: orders and prints aggregated correctly

---

## Interpreting Billing Warnings

`GET /api/v1/billing/warnings` (billing-exempt, accessible at all times)

| Warning type | Meaning | Action |
|-------------|---------|--------|
| `FREE_PILOT expiring in N days` | trialEndsAt within 14 days | Contact customer, agree on paid plan |
| `TRIALING expiring in N days` | trialEndsAt within 7 days | Contact customer, confirm card added |
| `PAST_DUE: N days until access restricted` | gracePeriodEndsAt within grace | Contact customer, prompt portal visit |
| `UNPAID: access restricted` | Grace expired | Customer must pay via checkout |
| `CANCELLED: access restricted` | Subscription cancelled | Customer must start new checkout |

---

## Seeding Billing Plans

### Test mode (staging)
```bash
STRIPE_MODE=test node apps/api/src/scripts/seed-billing-plans.ts
```

### Live mode (production)
```bash
STRIPE_MODE=live node apps/api/src/scripts/seed-billing-plans.ts
```

Required env vars: `STRIPE_SECRET_KEY`, `DATABASE_URL`

This seeds or updates the `subscription_plans` table with Stripe price IDs. Re-run after creating new prices in Stripe dashboard.

---

## FREE_PILOT → Paid Transition

When a FREE_PILOT tenant agrees to start paying:

1. Confirm written agreement (price, plan, trial terms)
2. Admin assigns plan: `PATCH /billing/admin/tenants/:id/plan` with reason
3. Do NOT use `adminGrantException` — the tenant needs to complete Stripe checkout to have a real subscription
4. Send the tenant the checkout URL (create checkout session via their token or via admin)
5. Tenant completes checkout → Stripe webhooks → status becomes TRIALING or ACTIVE
6. Verify in admin API: `stripeSubId` is now set, status is correct

**Never force-move a FREE_PILOT to ACTIVE without a Stripe subscription**, unless it's an enterprise manual billing arrangement with documented agreement.
