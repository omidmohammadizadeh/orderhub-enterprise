# Phase S — Billing Automation, Enforcement & Paid Launch Readiness

## What was built

Phase S wires the billing infrastructure from Phase R into live enforcement. It adds automation jobs, plan limit enforcement, billing warnings, admin controls, and applies the BillingGuard globally — while explicitly protecting every live trading operation from billing interference.

---

## 1. Billing automation cron jobs (`billing.cron.ts`)

Four scheduled jobs cover the full subscription lifecycle automatically:

| Schedule | Job | Effect |
|----------|-----|--------|
| Every hour (`:00`) | `expireGracePeriods` | Moves PAST_DUE tenants past `gracePeriodEndsAt` → UNPAID. Safe: idempotent `updateMany`. |
| Daily 07:00 UTC | `warnExpiringPilots` | Logs structured warning for FREE_PILOT tenants expiring within 14 days. No state change. |
| Daily 08:00 UTC | `expireFreePilots` | Moves FREE_PILOT → TRIALING (30-day trial) when `trialEndsAt` has passed. **Never ACTIVE, never auto-charges.** |
| Daily 02:00 UTC | `aggregateUsage` | Upserts monthly `UsageRecord` for every active tenant location. Idempotent. `USAGE_CRON_DRY_RUN=true` skips writes. |

**Concurrency protection:** both grace and usage jobs use `running` flags to prevent overlapping executions — same pattern as `OutboxDispatcherCron`.

**Audit trail:** every pilot expiry writes an `AuditLog` entry (`billing.pilot_expired`) with before/after status and timestamps.

---

## 2. Plan limits and feature flags (`plan-limits.service.ts`)

`PlanLimitsService` enforces plan limits at service call sites. Key behaviours:

- **FREE_PILOT and TRIALING bypass all limits** — protecting the 5 pilot shops and any tenant in trial from hitting artificial walls during onboarding.
- **PAST_DUE is warned but not hard-blocked** for existing resources (the grace period is handled by the guard, not the limits service).
- **Unlimited plans** (`maxLocations: null`, `maxUsers: null`) are supported for ENTERPRISE.

Methods available for use in domain services:

```typescript
planLimits.assertLocationLimit(tenantId)  // throws ForbiddenException if over plan max
planLimits.assertUserLimit(tenantId)      // throws ForbiddenException if over plan max
planLimits.assertFeature(tenantId, key)   // throws ForbiddenException if feature not in plan
planLimits.hasFeature(tenantId, key)      // returns boolean, no throw
planLimits.getBillingWarnings(tenantId)   // returns string[] for UI banners
```

---

## 3. BillingGuard applied globally (`app.module.ts`)

`BillingGuard` is now registered as an `APP_GUARD`, running after `JwtAuthGuard` and `RolesGuard` on every authenticated request:

```typescript
{ provide: APP_GUARD, useClass: JwtAuthGuard },
{ provide: APP_GUARD, useClass: RolesGuard },
{ provide: APP_GUARD, useClass: BillingGuard },   // Phase S
{ provide: APP_GUARD, useClass: ThrottlerGuard },
```

Access is blocked (`ForbiddenException`) only for:
- `UNPAID` or `CANCELLED` subscriptions
- `PAST_DUE` after `gracePeriodEndsAt` has passed

---

## 4. Billing-exempt controllers

The following controllers are decorated with `@BillingExempt()` at class level, ensuring they are **never blocked** by billing state:

| Controller | Reason |
|------------|--------|
| `OrdersController` | Live order operations must never be interrupted |
| `KdsController` | Kitchen display — live order visibility is safety-critical |
| `HealthController` | Readiness probes and release checks must always respond |
| `StaffHealthController` | Live support tool; must always be accessible |
| `WebhooksController` | Provider webhooks; 200 responses prevent retry storms |
| `AuthController` | Login/logout must always work |
| `OnboardingController` | Emergency pause/resume of providers and printers |
| `PrintersController` | Flutter polling and print-job status updates must never be blocked |
| `StoreOpsController` | Emergency store close and resume must always be accessible |

The Stripe webhook controller (`StripeWebhookController`) is already `@Public()` so the guard never touches it.

---

## 5. Admin billing controls

Five admin endpoints (PLATFORM_ADMIN only, all with required `reason` param for audit trail):

```
GET  /v1/billing/admin/tenants/:tenantId          — full billing detail
POST /v1/billing/admin/tenants/:tenantId/extend-pilot   — extend FREE_PILOT trialEndsAt
POST /v1/billing/admin/tenants/:tenantId/convert-to-trial — FREE_PILOT → TRIALING (manual)
PATCH /v1/billing/admin/tenants/:tenantId/plan    — assign a different plan
POST /v1/billing/admin/tenants/:tenantId/grant-exception — override to ACTIVE for N days
```

Every admin action writes an `AuditLog` entry with `event: "billing.*"`, `userId`, `reason`, and before/after state.

---

## 6. Billing warnings endpoint

```
GET /v1/billing/warnings
```

Returns `{ warnings: string[] }` scoped to the authenticated tenant. Used for UI banners. Never blocks access. Warning conditions:

- FREE_PILOT ending within 14 days
- Trial ending within 7 days  
- PAST_DUE (with grace period countdown)
- UNPAID (access restricted message)
- CANCELLED

---

## 7. Tests

| Suite | Tests | What it covers |
|-------|-------|----------------|
| `billing.cron.spec.ts` | 12 | Grace expiry idempotency, FREE_PILOT → TRIALING (not ACTIVE, not auto-charge), 30-day trial window, audit log, usage aggregation concurrency, dry-run |
| `plan-limits.service.spec.ts` | 17 | FREE_PILOT/TRIALING bypass, location/user limit enforcement, feature flags, billing warning strings for all statuses |
| `billing-guard.spec.ts` (Phase R) | 11 | All status variants, grace window, admin bypass, exempt routes |
| `billing.service.spec.ts` (Phase R) | 18 | Plan queries, subscription lifecycle, grace period, pilot migration |
| `usage.service.spec.ts` (Phase R) | 9 | Aggregation, idempotency, billing month calculation |
| `stripe-webhook.spec.ts` (Phase R) | 16 | Idempotency, duplicate skip, error handling |
| **Total** | **83** | |

---

## 8. Critical constraints honoured

- **Live shops not broken** — all 5 FREE_PILOT tenants continue with unrestricted access; pilot expiry is TRIALING (access continues), never ACTIVE (no charge), never CANCELLED.
- **Live trading flows unblocked** — orders, KDS, printers, webhooks, store-ops all marked `@BillingExempt()`.
- **No auto-charge** — `expireFreePilots` cron creates no Stripe subscriptions. Tenant must complete Stripe Checkout.
- **No card storage** — all payment handled by Stripe; zero card data in OrderHub DB.
- **No Stripe secrets exposed** — all keys read from env; `StripeService.isConfigured` prevents startup failure when key absent.
- **Server-side billing status** — `BillingGuard` reads from DB on every request; no client-side trust.

---

## Next steps (Phase T)

- Stripe metered usage reporting (daily cron → `stripe.reportMeteredUsage()`)
- Per-tenant billing portal link in dashboard
- Billing email notifications (trial ending, payment failed, account restricted)
- Mass rollout controls (invite flow, slug-based signup)
- First paid customer onboarding runbook
