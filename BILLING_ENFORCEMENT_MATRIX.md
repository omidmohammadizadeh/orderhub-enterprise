# Billing Enforcement Matrix

This document defines the billing access rules for every key endpoint group.

**Guard execution order per request:** JwtAuthGuard → RolesGuard → BillingGuard → ThrottlerGuard

**BillingGuard behaviour:**
- `@BillingExempt()` at class or method level → always pass (no DB query)
- `PLATFORM_ADMIN` role → always pass (no DB query)
- No authenticated user → pass (JWT guard handles authentication)
- `FREE_PILOT`, `TRIALING`, `ACTIVE` → pass
- `PAST_DUE` within `gracePeriodEndsAt` → pass
- `PAST_DUE` after grace expiry → **ForbiddenException**
- `UNPAID`, `CANCELLED`, `INCOMPLETE`, `PAUSED` → **ForbiddenException**

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Always accessible (billing-exempt or public) |
| 🔒 | Blocked when UNPAID or CANCELLED |
| ⚠️ | Allowed during PAST_DUE grace; blocked after expiry |
| 👑 | PLATFORM_ADMIN bypass (guard passes regardless of status) |

---

## Endpoint Access Matrix

### Provider Webhooks (`/api/v1/webhooks/*`)

| Endpoint | Exempt | UNPAID | CANCELLED | PAST_DUE grace | PLATFORM_ADMIN | Reason |
|----------|--------|--------|-----------|----------------|----------------|--------|
| `POST /webhooks/:platform/:locationId` | ✅ | ✅ | ✅ | ✅ | ✅ | Provider webhooks must always be accepted — 200 prevents retry storms |

### Order Operations (`/api/v1/orders/*`)

| Endpoint | Exempt | UNPAID | CANCELLED | PAST_DUE grace | PLATFORM_ADMIN | Reason |
|----------|--------|--------|-----------|----------------|----------------|--------|
| `POST /orders` | ✅ | ✅ | ✅ | ✅ | ✅ | Live POS order creation must never be blocked |
| `GET /orders` | ✅ | ✅ | ✅ | ✅ | ✅ | Order listing/viewing for live operations |
| `GET /orders/live` | ✅ | ✅ | ✅ | ✅ | ✅ | Live order display for kitchen/floor staff |
| `GET /orders/:id` | ✅ | ✅ | ✅ | ✅ | ✅ | Single order view for live operations |
| `PATCH /orders/:id/status` | ✅ | ✅ | ✅ | ✅ | ✅ | Order status transitions (accept/ready/complete) |

### Kitchen Display (`/api/v1/kds/*`)

| Endpoint | Exempt | UNPAID | CANCELLED | PAST_DUE grace | PLATFORM_ADMIN | Reason |
|----------|--------|--------|-----------|----------------|----------------|--------|
| All KDS endpoints | ✅ | ✅ | ✅ | ✅ | ✅ | Live kitchen display — safety-critical during service |

### Printer Operations (`/api/v1/printers/*`)

| Endpoint | Exempt | UNPAID | CANCELLED | PAST_DUE grace | PLATFORM_ADMIN | Reason |
|----------|--------|--------|-----------|----------------|----------------|--------|
| `GET /printers` | ✅ | ✅ | ✅ | ✅ | ✅ | Read-only — support/emergency context |
| **`POST /printers`** | ❌ | 🔒 | 🔒 | ⚠️ | 👑 | **Commercial expansion — registering new printer** |
| `PATCH /printers/:id` | ✅ | ✅ | ✅ | ✅ | ✅ | Config update for existing printer — live ops |
| `DELETE /printers/:id` | ✅ | ✅ | ✅ | ✅ | ✅ | Remove existing printer — live ops |
| `GET /printers/:id/jobs` | ✅ | ✅ | ✅ | ✅ | ✅ | Job history view — live ops |
| `POST /printers/:id/jobs/:id/reprint` | ✅ | ✅ | ✅ | ✅ | ✅ | Reprint live order receipt |
| `POST /printers/:id/jobs/:id/retry` | ✅ | ✅ | ✅ | ✅ | ✅ | Retry failed live print |
| `POST /printers/:id/test` | ✅ | ✅ | ✅ | ✅ | ✅ | Diagnostic test print |
| `GET /printers/jobs` (Flutter) | ✅ | ✅ | ✅ | ✅ | ✅ | Flutter contract — must never be blocked |
| `PATCH /printers/jobs/:id` (Flutter) | ✅ | ✅ | ✅ | ✅ | ✅ | Flutter contract — must never be blocked |

### Store Operations (`/api/v1/store-ops/*`)

| Endpoint | Exempt | UNPAID | CANCELLED | PAST_DUE grace | PLATFORM_ADMIN | Reason |
|----------|--------|--------|-----------|----------------|----------------|--------|
| All store-ops endpoints | ✅ | ✅ | ✅ | ✅ | ✅ | Emergency close/resume and live status management |

### Onboarding (`/api/v1/onboarding/*`)

| Endpoint | Exempt | UNPAID | CANCELLED | PAST_DUE grace | PLATFORM_ADMIN | Reason |
|----------|--------|--------|-----------|----------------|----------------|--------|
| `GET /onboarding/locations` | ✅ | ✅ | ✅ | ✅ | ✅ | Read-only — needed to find location before emergency pause |
| `GET /onboarding/locations/:id/readiness` | ✅ | ✅ | ✅ | ✅ | ✅ | Read-only diagnostic — support use |
| **`POST /onboarding/locations/:id/transition`** | ❌ | 🔒 | 🔒 | ⚠️ | 👑 | **Marks location live — commercial expansion** |
| `POST /onboarding/locations/:id/admin-override` | ❌ | 👑 | 👑 | 👑 | 👑 | PLATFORM_ADMIN only — guard always passes |
| **`POST /onboarding/locations/:id/record-test-order`** | ❌ | 🔒 | 🔒 | ⚠️ | 👑 | **Onboarding step for new locations — commercial** |
| **`POST /onboarding/locations/:id/record-test-print`** | ❌ | 🔒 | 🔒 | ⚠️ | 👑 | **Onboarding step for new locations — commercial** |
| `POST .../providers/:id/pause` | ✅ | ✅ | ✅ | ✅ | ✅ | Emergency: disable broken provider during trading |
| `POST .../providers/:id/resume` | ✅ | ✅ | ✅ | ✅ | ✅ | Emergency: re-enable provider |
| `POST .../printers/:id/pause` | ✅ | ✅ | ✅ | ✅ | ✅ | Emergency: deactivate faulty printer |
| `POST .../printers/:id/resume` | ✅ | ✅ | ✅ | ✅ | ✅ | Emergency: re-enable printer |

### Health (`/api/v1/health/*`)

| Endpoint | Exempt | UNPAID | CANCELLED | PAST_DUE grace | PLATFORM_ADMIN | Reason |
|----------|--------|--------|-----------|----------------|----------------|--------|
| All health endpoints | ✅ | ✅ | ✅ | ✅ | ✅ | Liveness/readiness probes and release readiness checks |

### Staff Health (`/api/v1/health/staff-status`)

| Endpoint | Exempt | UNPAID | CANCELLED | PAST_DUE grace | PLATFORM_ADMIN | Reason |
|----------|--------|--------|-----------|----------------|----------------|--------|
| `GET /health/staff-status` | ✅ | ✅ | ✅ | ✅ | ✅ | Live support panel — never blocked |

### Auth (`/api/v1/auth/*`)

| Endpoint | Exempt | UNPAID | CANCELLED | PAST_DUE grace | PLATFORM_ADMIN | Reason |
|----------|--------|--------|-----------|----------------|----------------|--------|
| All auth endpoints | ✅ | ✅ | ✅ | ✅ | ✅ | Login/logout/refresh must always work |

### Billing (`/api/v1/billing/*`)

| Endpoint | Exempt | UNPAID | CANCELLED | PAST_DUE grace | PLATFORM_ADMIN | Reason |
|----------|--------|--------|-----------|----------------|----------------|--------|
| `GET /billing/plans` | ✅ `@Public()` | ✅ | ✅ | ✅ | ✅ | Unauthenticated plan browsing |
| `GET /billing/status` | ❌ | 🔒 | 🔒 | ⚠️ | 👑 | Tenant billing page — restricted when blocked |
| `GET /billing/warnings` | ✅ | ✅ | ✅ | ✅ | ✅ | Warnings must always show (especially for UNPAID) |
| `POST /billing/checkout` | ❌ | 🔒 | 🔒 | ⚠️ | 👑 | Checkout initiates payment — blocked when unpaid |
| `POST /billing/portal` | ✅ | ✅ | ✅ | ✅ | ✅ | UNPAID tenants must reach this to fix their payment method |
| Admin endpoints (`/admin/*`) | ✅ `@BillingExempt()` + `@Roles("PLATFORM_ADMIN")` | ✅ | ✅ | ✅ | ✅ | Admin management always accessible |


### Stripe Webhook (`/api/v1/webhooks/stripe`)

| Endpoint | Exempt | UNPAID | CANCELLED | PAST_DUE grace | PLATFORM_ADMIN | Reason |
|----------|--------|--------|-----------|----------------|----------------|--------|
| `POST /webhooks/stripe` | ✅ `@Public()` | ✅ | ✅ | ✅ | ✅ | Stripe webhooks are public — verified by signature |

---

## Commercial Expansion Endpoints (Billing-Restricted)

The following actions are blocked for UNPAID or CANCELLED tenants. PAST_DUE tenants within grace period are allowed.

| Action | Endpoint | Blocked For |
|--------|----------|-------------|
| Register new printer | `POST /printers` | UNPAID, CANCELLED |
| Mark location live | `POST /onboarding/locations/:id/transition` | UNPAID, CANCELLED |
| Record test order (onboarding) | `POST /onboarding/locations/:id/record-test-order` | UNPAID, CANCELLED |
| Record test print (onboarding) | `POST /onboarding/locations/:id/record-test-print` | UNPAID, CANCELLED |
| Create subscription | `POST /billing/subscription` | UNPAID, CANCELLED |
| Create new location | `POST /locations` | UNPAID, CANCELLED (no exemption) |
| Create new brand | `POST /brands` | UNPAID, CANCELLED (no exemption) |
| Connect new integration | `POST /integrations` | UNPAID, CANCELLED (no exemption) |
| Create staff user | `POST /users` | UNPAID, CANCELLED (no exemption) |
| Generate manual invoice | `POST /billing/invoices` | UNPAID, CANCELLED |

> Plan limits (location count, user count, feature flags) are enforced separately by `PlanLimitsService` — independent of billing status. See `PRICING_AND_PLANS.md`.

---

## Emergency Controls (Always Accessible)

These endpoints use `@BillingExempt()` regardless of billing status:

| Endpoint | Use Case |
|----------|----------|
| `POST /onboarding/locations/:id/providers/:id/pause` | Stop receiving orders from a broken provider |
| `POST /onboarding/locations/:id/providers/:id/resume` | Re-enable a provider after issue resolved |
| `POST /onboarding/locations/:id/printers/:id/pause` | Deactivate a printer that's printing incorrectly |
| `POST /onboarding/locations/:id/printers/:id/resume` | Re-enable a printer after fix |
| `POST /store-ops/:locationId/emergency-close` | Immediately close the store |
| `POST /store-ops/:locationId/resume` | Reopen after emergency close |
| `GET /printers/jobs` (Flutter) | Printer app job polling — Flutter contract |
| `PATCH /printers/jobs/:id` (Flutter) | Printer app status update — Flutter contract |

---

## PLATFORM_ADMIN Override

A `PLATFORM_ADMIN` can always bypass billing restrictions. Additionally, specific admin endpoints exist to manage billing state with required audit trail:

| Endpoint | Effect | Reason Required |
|----------|--------|-----------------|
| `POST /billing/admin/tenants/:id/extend-pilot` | Extend FREE_PILOT end date | ✅ |
| `POST /billing/admin/tenants/:id/convert-to-trial` | FREE_PILOT/UNPAID → TRIALING | ✅ |
| `PATCH /billing/admin/tenants/:id/plan` | Assign subscription plan | ✅ |
| `POST /billing/admin/tenants/:id/grant-exception` | Override to ACTIVE/TRIALING | ✅ |

---

## Known Gaps (Phase U)

1. **Menu publish not restricted** — `MenusController` has no plan-limit or billing-guard integration. Publishing menus for UNPAID tenants is currently not restricted.
2. **Integration CRUD not audited against plan limits** — Connecting a new provider isn't checked against plan feature flags in `IntegrationsController`.
3. **Billing portal checkout access** — `POST /billing/checkout` is currently restricted for UNPAID tenants. Consider exempting it too so tenants with INCOMPLETE subscriptions can self-serve into a paid plan.
