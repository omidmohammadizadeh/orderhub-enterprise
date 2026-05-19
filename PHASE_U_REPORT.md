# Phase U — First Paid Customer Billing Activation

## Summary

Phase U completed the remaining code gaps for the first paid customer flow, wrote comprehensive end-to-end activation tests, and produced the operational documentation needed for a live Stripe activation.

**Decision: System is production-ready for first paid customer activation in Stripe test mode. Production activation requires completing the manual steps in `STRIPE_PRODUCTION_CHECKLIST.md`.**

---

## 1. Code Changes

### Stripe Webhook Handler Gaps Filled

Three gaps in `handleStripeWebhookBilling` were identified and fixed:

#### `customer.updated` handler (new)
- Syncs `billingEmail` when Stripe customer email changes
- Sets `paymentMethodStatus: "attached"` when `invoice_settings.default_payment_method` is set
- No-op when neither field is present (safe against spurious events)

#### `customer.subscription.updated` — payment method sync
- Now also reads `default_payment_method` from the subscription event
- Sets `paymentMethodStatus: "attached"` when a default method is present
- Ensures billing page shows correct payment status after checkout

#### `invoice.paid` / `invoice.payment_succeeded` — lastInvoiceStatus sync
- Now sets `lastInvoiceStatus: "PAID"` on the `TenantSubscription` record
- Runs as a separate `updateMany` before the PAST_DUE recovery update
- Billing page can show invoice status without a separate query

#### `invoice.payment_failed` — lastInvoiceStatus sync
- Now also sets `lastInvoiceStatus: "OPEN"` on the subscription (invoice is open/unpaid)

---

## 2. Complete Stripe Event Flow (Verified by Tests)

After a customer completes Stripe Checkout, these events fire in order:

```
checkout.session.completed
  → stores stripeSubId on TenantSubscription
  → writes billing.checkout_completed audit log

customer.subscription.created (or updated)
  → maps Stripe status to internal status (trialing/active → TRIALING/ACTIVE)
  → syncs paymentMethodStatus if default_payment_method present
  → syncs period dates and trial end

invoice.finalized
  → creates Invoice record in DB with OPEN status

invoice.paid
  → marks Invoice record as PAID
  → sets lastInvoiceStatus: "PAID" on TenantSubscription
  → if PAST_DUE: sets ACTIVE, clears gracePeriodEndsAt

customer.updated (when card is added/changed)
  → syncs billingEmail
  → sets paymentMethodStatus: "attached"
```

**Payment failure flow:**

```
invoice.payment_failed
  → sets PAST_DUE + lastInvoiceStatus: "OPEN" on subscription

[BillingCron hourly — if gracePeriodEndsAt expires]
  → sets UNPAID

[Customer updates payment method via Stripe Billing Portal]
  → customer.updated → paymentMethodStatus: "attached"
  → customer.subscription.updated → status: "active" → ACTIVE

[Stripe retries invoice]
  → invoice.paid → ACTIVE + lastInvoiceStatus: "PAID" + gracePeriodEndsAt: null
```

---

## 3. Test Results

### New Phase U test file: `phase-u-activation.spec.ts`

| Section | Tests | What is verified |
|---------|-------|-----------------|
| Full checkout → ACTIVE sequence | 4 | Each event step, full chain |
| Payment failure and recovery | 3 | PAST_DUE set, ACTIVE restored, lastInvoiceStatus |
| customer.updated sync | 3 | billingEmail, paymentMethodStatus, no-op case |
| Tenant isolation / secret hygiene | 4 | No Stripe IDs in tenant response, admin can see them, cross-tenant isolation |
| Cancellation and UNPAID | 3 | subscription.deleted, expireGracePeriods, adminGrantException |
| FREE_PILOT not auto-charged | 3 | No matching sub → no update, TRIALING≠ACTIVE, no Stripe call on extend |
| Webhook idempotency | 1 | Same event twice is safe at service layer |

**Total tests: 323 (0 failures)**

---

## 4. Stripe Production Readiness Assessment

| Category | Status |
|----------|--------|
| Secret key isolation | ✅ Read from env, never hardcoded, lazy-loaded |
| Webhook signature verification | ✅ `constructWebhookEvent` validates sig before any processing |
| Duplicate event handling | ✅ `stripe_webhook_events` table deduplicates by `stripeEventId` |
| checkout.session.completed | ✅ Stores stripeSubId, writes audit log |
| invoice.paid → ACTIVE recovery | ✅ Clears PAST_DUE and gracePeriodEndsAt |
| invoice.payment_failed → PAST_DUE | ✅ Sets grace period |
| customer.subscription.deleted → CANCELLED | ✅ |
| customer.updated → field sync | ✅ (Phase U addition) |
| paymentMethodStatus synced | ✅ (Phase U addition) |
| lastInvoiceStatus synced | ✅ (Phase U addition) |
| No Stripe IDs in tenant responses | ✅ `getTenantBillingStatus` confirmed by test |
| Billing portal accessible to UNPAID | ✅ (Phase T fix: `@BillingExempt()` on portal endpoint) |
| No card data stored | ✅ Stripe handles all card data |

---

## 5. FREE_PILOT Safety

| Check | Status |
|-------|--------|
| FREE_PILOT status not changed by any Stripe webhook | ✅ No `stripeSubId` = no match = no update |
| FREE_PILOT → TRIALING via cron (not ACTIVE, not auto-charge) | ✅ Confirmed in cron tests |
| FREE_PILOT extension requires reason + audit log | ✅ `adminExtendFreePilot` |
| Live orders/printers/KDS remain accessible for FREE_PILOT | ✅ All billing-exempt |
| FREE_PILOT tenants can view billing warnings | ✅ `GET /billing/warnings` is billing-exempt |

---

## 6. Usage Aggregation

- Daily cron (`02:00 UTC`) aggregates orders + print jobs per location into `usage_records`
- Scoped to `isSandbox: false` — test orders excluded from billing metrics
- Idempotent: upsert on `(tenantId, locationId, billingMonth)` unique constraint
- Does not affect order ingestion hot path
- `USAGE_CRON_DRY_RUN=true` env var available for testing
- Usage visible in `GET /billing/admin/tenants/:id` (PLATFORM_ADMIN only)
- Stripe metered billing reporting is **not wired** — usage stays internal for now

---

## 7. Manual Activation Steps Required

The following cannot be automated (require human action):

1. **Set Stripe env vars** — `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in production
2. **Register webhook endpoint** in Stripe dashboard
3. **Seed live billing plans** with live Stripe price IDs (run `seed-billing-plans.ts`)
4. **Select first customer** and confirm agreement
5. **Run activation steps** from `FIRST_PAID_CUSTOMER_PLAN.md`
6. **Verify webhook delivery** in Stripe dashboard after checkout
7. **Run smoke test** on orders/printers/KDS after activation

---

## 8. Remaining Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Menu publish not billing-gated for UNPAID tenants | Low | Phase V — `MenusController` has no `BillingGuard` integration |
| Integration CRUD not checked against plan feature flags | Medium | Phase V — `IntegrationsController` has no plan limit check |
| No email notification on payment failure | Medium | Phase V — UNPAID tenants may not know their access is restricted |
| Stripe metered usage not reported to Stripe | Low | Phase V — usage tracked internally, not yet sent to Stripe |
| Mass rollout controls (invite flow) not built | N/A | Phase V |
| No Stripe test mode run performed in this worktree | Medium | Operator must complete `FIRST_PAID_CUSTOMER_PLAN.md` steps manually |

---

## 9. Decision

**Ready for first paid customer in Stripe test mode** ✅

Pre-conditions confirmed:
- ✅ 323 tests passing, 0 failures
- ✅ Complete Stripe event flow implemented and tested
- ✅ No Stripe secrets in any API response
- ✅ No card data stored
- ✅ FREE_PILOT shops protected from auto-charge
- ✅ All critical trading endpoints remain billing-exempt
- ✅ Emergency controls accessible regardless of billing state
- ✅ Billing portal accessible to UNPAID tenants (for self-service recovery)
- ✅ All billing state changes audit-logged
- ✅ BILLING_ENFORCEMENT_MATRIX.md, STRIPE_PRODUCTION_CHECKLIST.md, FIRST_PAID_CUSTOMER_PLAN.md in place

**NOT ready for mass paid rollout** — complete `STRIPE_PRODUCTION_CHECKLIST.md` first.
