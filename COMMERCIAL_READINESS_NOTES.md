# Commercial Readiness Notes

> Created: 2026-06-13 (Phase Q complete)
> Status: Recommendations only — billing NOT yet implemented
> Author: Engineering / Operations

---

## Decision

Phase Q has confirmed commercial readiness. 5 shops onboarded, 1,367 orders, 0 lost, 0 unresolved P0/P1. The system is stable enough for commercial launch with billing.

**Billing must NOT be implemented until Phase R.** This document records recommendations only.

---

## Suggested Pricing Model

### Tier recommendation: usage-based with a base fee

OrderHub is a B2B SaaS for restaurants. The most appropriate model combines a base monthly fee (predictable for the restaurant) with a small per-order fee (scales with usage and aligns incentives).

| Tier | Description | Suggested price |
|---|---|---|
| **Starter** | 1 location, up to 2 providers, 500 orders/month | £49/month + £0.05/order above 500 |
| **Growth** | 1–3 locations, unlimited providers, 2,000 orders/month | £149/month + £0.04/order above 2,000 |
| **Scale** | 4+ locations, all features, custom limits | Custom — contact sales |

**Rationale:**
- Small restaurants (< 500 orders/month) get a predictable cost
- System costs (Redis, DB, worker) scale with order volume — per-order fee keeps margins healthy at scale
- Flat monthly fee provides stable ARR for forecasting

### Free pilot tier (existing shops)

The 5 Phase Q rollout shops are on a free pilot arrangement. Recommend:
- Free until 2026-09-01 (3 months post-commercial launch)
- After that, automatically move to Starter tier unless they upgrade
- Give explicit written notice 30 days before free period ends

---

## What Usage Should Be Tracked

The following events need to be recorded for billing purposes. **These are not yet stored** — add in Phase R.

| Event | Purpose | Field |
|---|---|---|
| Order created | Per-order billing | `Order.createdAt`, `Order.tenantId`, `Order.locationId` |
| Order platform | Provider usage metrics | `Order.platform` |
| Print job created | Print volume (future add-on) | `PrintJob.createdAt`, `PrintJob.tenantId` |
| Integration activated | Feature usage | `Integration.status → ACTIVE`, `Integration.platform` |
| Location go-live | Subscription start | `Location.goLiveStatus → LIVE` |
| Location paused | Subscription pause/credit | `Location.goLiveStatus → PAUSED` |
| Staff user created | Seat-based billing option | `User.tenantId`, `User.role`, `User.createdAt` |

### Current gap

None of the above are aggregated per billing period today. The Order and PrintJob models have the raw data. Phase R must add:
1. A `BillingPeriod` or `UsageSnapshot` model
2. A monthly cron job that aggregates order counts per tenant per location
3. Webhook or API call to the billing provider (Stripe recommended)

---

## What Events Need Billing Records Later

These are the "billing line items" to generate monthly:

1. **Monthly base fee**: trigger on the 1st of each month per active subscription
2. **Per-order fee**: aggregate `Order.count` grouped by `(tenantId, locationId, month)` above the tier limit
3. **Location activation**: trigger when `Location.goLiveStatus` transitions to `LIVE`
4. **Provider integration**: optionally charge per active integration per month (not recommended for Starter/Growth — include in tier)

---

## Which Shops Are Free Pilot vs Paid

| Shop | Status | Free until | Post-free tier |
|---|---|---|---|
| Spice Garden (Shop 1) | Free pilot | 2026-09-01 | Starter |
| The Curry Leaf (Shop 2) | Free pilot | 2026-09-01 | Starter |
| Naan & Co (Shop 3) | Free pilot | 2026-09-01 | Starter |
| Peri Palace (Shop 4) | Free pilot | 2026-09-01 | Starter |
| Masala Express (Shop 5) | Free pilot | 2026-09-01 | Starter |

All 5 shops should receive written notice before 2026-08-01 explaining the transition.

---

## Trial Period Recommendation

For all new restaurants signing up post-Phase Q:

- **30-day free trial** on Starter tier
- Full access to all features during trial
- No credit card required during trial
- Trial start = `Location.goLiveStatus → LIVE`
- Trial end = 30 calendar days later
- Automated email at: trial start, day 15 warning, day 27 warning, day 30 (conversion or churn)

---

## Billing Infrastructure Recommendations (Phase R work)

Do not implement in Phase Q. Plan for Phase R:

1. **Stripe** — recommended for subscription billing, invoice management, webhook-driven events
2. **Stripe Billing** — supports both flat monthly fees and usage-based metered billing
3. `Tenant` model needs: `stripeCustomerId`, `subscriptionStatus`, `billingEmail`, `trialEndsAt`
4. `Location` model needs: `billingActive Boolean` — locations on trial or paid plan are active
5. Usage sync: a nightly job aggregates `Order.count` for the current billing period and reports to Stripe Metered API
6. Invoice preview: `GET /v1/billing/usage` (tenant-scoped) shows current period usage before invoice is generated

---

## What Must NOT Be Built in Phase Q

- No Stripe integration
- No subscription creation
- No payment processing
- No invoice generation
- No credit card collection
- No trial expiry enforcement
- No automated downgrades or suspensions

Phase Q ends with this document. Phase R begins billing implementation.

---

## Phase R Billing Scope (preview)

When Phase R begins, the billing work should be scoped to:

1. Add `stripeCustomerId` and billing fields to `Tenant` model (migration)
2. Stripe customer creation on tenant signup
3. Stripe subscription creation when trial starts
4. Metered usage reporting (nightly cron)
5. Stripe webhook handler for `invoice.payment_failed`, `customer.subscription.deleted`
6. Admin view: tenant subscription status
7. Tenant view: current usage, next invoice estimate
8. Automated trial-to-paid conversion email sequence

**Billing must not gate any features during the trial period.** Keep the product fully functional and convert through value, not friction.
