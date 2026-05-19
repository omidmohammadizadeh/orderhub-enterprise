# Paid Rollout Plan — 10 to 20 Shops

> This document governs the controlled expansion from the first paid customer to 10–20 paid shops.
> No shop may be activated commercially unless all criteria in this document are met.

---

## Prerequisites

Before starting the paid rollout, all of the following must be true:

- [ ] First paid activation completed and smoke test passed (FIRST_REAL_PAID_CUSTOMER_SIGNOFF.md signed)
- [ ] Payment failure + recovery confirmed in Stripe test mode
- [ ] FREE_PILOT protection verified (5 pilot shops unaffected)
- [ ] 327 tests passing, 0 failures
- [ ] PAID_CUSTOMER_SUPPORT_RUNBOOK.md reviewed by support team
- [ ] BILLING_OPERATIONS.md reviewed by operations team
- [ ] Stripe production webhook health confirmed (all events receiving 200)
- [ ] 0 unresolved P0/P1 issues across all live shops

---

## Rollout Rules

These rules apply to **every** paid activation after the first:

### Pace Limits

| Rule | Limit |
|------|-------|
| Maximum paid activations per day | **2** |
| Minimum gap between activations | **24 hours** |
| Activation window | **08:00–10:00 BST, Mon–Thu only** |
| Blocked periods | Bank holidays, peak trading hours (12:00–14:00, 17:00–21:00) |
| Blocked condition | Previous activation has unresolved billing issue |

### Criteria Per Shop

Before activating any shop commercially:

**Commercial agreement (mandatory):**
- [ ] Written agreement on record (email, contract, or signed proposal)
- [ ] Billing email confirmed with shop owner
- [ ] Plan confirmed (STARTER / PROFESSIONAL / ENTERPRISE)
- [ ] Monthly price confirmed
- [ ] Trial period terms confirmed (if any)
- [ ] First charge date confirmed
- [ ] Cancellation process explained to customer

**Technical stability (mandatory):**
- [ ] At least 3 consecutive trading days with 0 lost orders
- [ ] 0 unresolved P0/P1 issues for this shop
- [ ] All provider integrations stable (no repeated webhook failures)
- [ ] Printer online and heartbeat confirmed < 90s
- [ ] KDS confirmed working
- [ ] Flutter app polling confirmed working

**Setup completeness (mandatory):**
- [ ] Tenant and location correctly created
- [ ] shopCode unique and assigned
- [ ] Billing email on TenantSubscription record
- [ ] Subscription plan assigned via admin API before checkout
- [ ] Staff trained on dashboard and KDS

### Exclusion Criteria

Do **not** activate commercially:

- Shops without explicit written agreement
- Shops with unstable printer or provider (repeated failures last 7 days)
- Shops still waiting for provider API approval (Just Eat, Deliveroo POS)
- Shops with unresolved P0/P1 support issues
- Shops on HubRise or Just Eat (not production-validated — see KNOWN_LIMITATIONS.md)
- Shops converting from FREE_PILOT without explicit owner agreement

---

## Candidate Selection Criteria

Priority order for selecting shops for paid rollout:

1. **New shops** — no existing relationship to disrupt, clean start
2. **Stable pilot shops** — only if they have explicitly agreed to convert, with clear price/trial terms
3. **Shops on Uber Eats or Deliveroo only** — most stable provider setup
4. **Shops with Epson printers** — most tested hardware

Deprioritise:
- Shops using Just Eat (not production-validated)
- Shops using HubRise (not production-validated)
- Shops with Star printers (less tested, character width edge cases)
- Shops with recent P1 issues

---

## Per-Activation Process

For each new paid shop:

### Step 1 — Pre-activation review (day before)
1. Confirm written agreement on file
2. Confirm billing email in TenantSubscription
3. Confirm plan seeded with correct Stripe price ID
4. Run smoke test for the shop
5. Confirm 0 lost orders in last 3 trading days
6. Confirm 0 unresolved P0/P1 for this shop
7. Confirm no other shop has unresolved billing issue from previous activation

### Step 2 — Assign plan (admin action)
```bash
curl -X PATCH https://<api>/api/v1/billing/admin/tenants/<tenantId>/plan \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{ "planId": "<plan-uuid>", "reason": "Paid rollout: <shop-name> agreed on <date>" }'
```

### Step 3 — Send checkout link to customer
Create checkout session (TENANT_OWNER token) and share the URL with the customer.

### Step 4 — Customer completes checkout
Monitor Stripe dashboard for webhook delivery:
- checkout.session.completed ✓
- customer.subscription.created ✓
- invoice.finalized ✓
- invoice.paid ✓

### Step 5 — Confirm ACTIVE status
```bash
curl https://<api>/api/v1/billing/admin/tenants/<tenantId> \
  -H "Authorization: Bearer <admin-token>"
```
Expected: `"status": "ACTIVE"`, `"paymentMethodStatus": "attached"`, `"lastInvoiceStatus": "PAID"`

### Step 6 — Post-activation smoke test
Run all checks from PHASE_V_REPORT.md Section 4 for this shop.

### Step 7 — Monitor for 30 minutes
Check:
- Orders still flowing
- Printers online
- No 5xx errors in logs
- Bull Board: no failed jobs accumulating
- stripe_webhook_events: no error entries

### Step 8 — Record activation
Add a row to the rollout log below.

---

## Rollout Log

| Shop Name | Tenant ID | Plan | Activated | Activation By | Smoke Test | Notes |
|-----------|-----------|------|-----------|---------------|------------|-------|
| _(Customer 1)_ | | STARTER | _(first activation)_ | | ⬜ | First paid customer |
| | | | | | ⬜ | |
| | | | | | ⬜ | |
| | | | | | ⬜ | |
| | | | | | ⬜ | |

---

## Monitoring Requirements for Each Paid Tenant

For every active paid customer, monitor weekly:

| Metric | Alert Threshold |
|--------|----------------|
| Billing status | Alert if status != ACTIVE (and not within grace period) |
| Stripe webhook delivery rate | Alert if any webhook returns non-200 for > 10 min |
| Last invoice status | Alert if OPEN for > 7 days |
| Payment method status | Alert if null on an ACTIVE subscription |
| gracePeriodEndsAt | Alert if within 2 days of expiry |
| Orders processed | Alert if zero orders in last 24h during business hours |
| Printer heartbeat | Alert if lastHeartbeatAt > 90s |
| BillingGuard blocks | Alert if any ForbiddenException logged for an ACTIVE tenant |

---

## Rollback Process

If a rollout activation fails:

1. Immediate: run `adminGrantException` to restore tenant access if billing state is wrong
2. Within 1h: check `stripe_webhook_events` for processing errors
3. Within 1h: replay missing webhooks from Stripe dashboard
4. If subscription was created incorrectly: cancel in Stripe, re-run checkout with correct plan
5. If customer was not charged but should be: re-send checkout link
6. Record the issue and resolution in ROLLOUT_ISSUES.md
7. Do not activate another shop until previous issue is resolved

---

## Go / No-Go for Each New Shop

| Check | Required for Activation |
|-------|------------------------|
| Previous activation has no unresolved billing issue | ✅ Mandatory |
| Written customer agreement on file | ✅ Mandatory |
| 3 stable trading days, 0 lost orders | ✅ Mandatory |
| 0 P0/P1 issues for this shop | ✅ Mandatory |
| Provider on Uber Eats or Deliveroo (not Just Eat/HubRise) | Recommended |
| Activation window: 08:00–10:00 BST Mon–Thu | ✅ Mandatory |
| Billing email confirmed | ✅ Mandatory |
| Subscription plan assigned via admin API | ✅ Mandatory |

---

## Mass Rollout Gate

Do **not** progress to mass rollout (> 20 shops) until:

- [ ] 10 paid activations completed with 0 billing failures
- [ ] Payment failure + recovery confirmed in production (real customer, test card)
- [ ] Automated email on payment failure implemented (currently Phase W gap)
- [ ] BillingGuard block monitoring alerting confirmed
- [ ] Admin dashboard shows all paid tenants' billing state at a glance
- [ ] Support team has handled at least 2 billing support incidents
