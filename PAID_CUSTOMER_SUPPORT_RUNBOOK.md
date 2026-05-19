# Paid Customer Support Runbook

> Use this when a paid customer reports a billing or access issue.
> Every manual intervention must include a reason and be audit-logged.

---

## Quick Reference: Admin Commands

```bash
# Check tenant billing state
curl https://<api>/api/v1/billing/admin/tenants/<tenantId> \
  -H "Authorization: Bearer <admin-token>"

# Grant emergency access (reason required)
curl -X POST https://<api>/api/v1/billing/admin/tenants/<tenantId>/grant-exception \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{ "status": "ACTIVE", "reason": "<reason>" }'

# Extend FREE_PILOT (reason required)
curl -X POST https://<api>/api/v1/billing/admin/tenants/<tenantId>/extend-pilot \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{ "newTrialEndsAt": "2026-12-01", "reason": "<reason>" }'

# Check webhook events for a tenant
# (query stripe_webhook_events table by stripeCustomerId)
```

---

## Issue: Checkout Fails — Customer Cannot Pay

**Symptoms:** Customer says the checkout page doesn't work, payment was declined, or they never got a success redirect.

**Steps:**

1. Check Stripe dashboard → Checkout Sessions — find the session by customer email
2. If session expired (30 min limit): create a new checkout session
   ```bash
   curl -X POST https://<api>/api/v1/billing/checkout \
     -H "Authorization: Bearer <tenant-owner-token>" \
     -H "Content-Type: application/json" \
     -d '{ "planId": "<uuid>", "successUrl": "...", "cancelUrl": "..." }'
   ```
3. If card declined: ask customer to use a different card; suggest checking with their bank
4. If Stripe returned an error: check Stripe dashboard → Events for the error detail
5. If customer is UNPAID and cannot reach checkout: this was fixed in Phase V (`@BillingExempt()` applied) — if still blocked, check if BillingGuard was recently changed

**Safe to retry:** Yes — checkout sessions are independent. Multiple sessions can exist; only the completed one matters.

---

## Issue: Webhook Delayed — Tenant Does Not Become ACTIVE After Payment

**Symptoms:** Customer completed checkout, payment went through in Stripe, but billing status is still TRIALING or INCOMPLETE.

**Steps:**

1. Check Stripe dashboard → Webhooks → Recent deliveries
   - Look for `checkout.session.completed` and `invoice.paid`
   - If 5xx response: API was down or returned an error — resend from Stripe dashboard
   - If no delivery: webhook endpoint not configured or URL incorrect — re-register endpoint
2. Check `stripe_webhook_events` table for `stripeEventId` — if present with `processedAt`, it was processed
3. If events were delivered but status not updated: check API logs for processing errors
4. If the issue persists > 30 minutes: use `adminGrantException` to manually set ACTIVE, then replay the missing webhooks to catch up DB state

```bash
# Replay webhook from Stripe CLI
stripe events resend <event_id>
```

5. Document the incident in ROLLOUT_ISSUES.md

---

## Issue: Tenant Does Not Become ACTIVE After Checkout

**Root causes (check in order):**

| Cause | How to check | Fix |
|-------|-------------|-----|
| `stripeSubId` never stored | Check `tenantSubscription.stripeSubId` in DB | Re-send `checkout.session.completed` from Stripe |
| Subscription status mapping failed | Check logs for "Unknown Stripe status" | Check `STRIPE_STATUS_MAP` in billing.service.ts |
| No matching tenant for `stripeCustomerId` | Check logs for "No subscription found for stripeCustomerId" | Re-run admin plan assignment before checkout |
| Invoice not paid (trial start) | Check if status is TRIALING — correct if trial is expected | TRIALING is correct for trial starts; ACTIVE comes after first invoice |
| BillingGuard blocking incorrectly | Check for ForbiddenException in logs | Use adminGrantException + investigate root cause |

---

## Issue: Payment Fails — Tenant Moves to PAST_DUE

**Expected behaviour** — this is normal. The system:
1. Sets `status = PAST_DUE` with `gracePeriodEndsAt = now + 7 days`
2. Customer receives Stripe's payment failure email (configured in Stripe dashboard)
3. Billing portal remains accessible (`@BillingExempt()` on POST /billing/portal)
4. Orders, KDS, printers, and provider webhooks continue working during grace period

**If grace period expires (7 days, no payment):**
- Hourly cron moves tenant to `UNPAID`
- BillingGuard blocks commercial actions (checkout still accessible for self-service recovery)

**Support steps:**

1. Check that the customer received Stripe's failed payment email
2. Send the customer a direct link to the billing portal:
   ```
   https://<dashboard>/billing/portal
   ```
3. Customer updates card in portal → Stripe retries invoice → `invoice.paid` → ACTIVE (automatic)
4. If customer cannot self-serve: create a new checkout session as fallback

**If you need to extend the grace period manually:**
- Use `adminGrantException` to set `ACTIVE` with reason — this is an override, not a retry
- Only do this when you are in contact with the customer and they have a confirmed fix date

---

## Issue: Customer Wants to Cancel

**Steps:**

1. Confirm cancellation request in writing (email/chat transcript)
2. Check if cancellation should be immediate or at period end
3. For at-period-end (recommended): customer cancels in billing portal
   - POST /billing/portal → customer portal → Cancel subscription
   - Stripe sets `cancel_at_period_end = true`
   - Subscription continues until period end, then `customer.subscription.deleted` fires
4. For immediate cancellation: cancel in Stripe dashboard → the `customer.subscription.deleted` webhook sets CANCELLED
5. After CANCELLED: tenant loses access to commercial actions but retains read access and emergency controls
6. Confirm with customer that their data is retained (we do not delete tenant data on cancellation)

**If customer wants a refund:** Handle via Stripe dashboard → Payments → Refund. The refund does not change billing status — cancel separately if needed.

---

## Issue: Customer Wants to Change Plan

**Steps:**

1. Confirm new plan, price, and effective date with customer in writing
2. Use admin API to update the plan:
   ```bash
   curl -X PATCH https://<api>/api/v1/billing/admin/tenants/<tenantId>/plan \
     -H "Authorization: Bearer <admin-token>" \
     -H "Content-Type: application/json" \
     -d '{ "planId": "<new-plan-uuid>", "reason": "Customer requested upgrade to PROFESSIONAL" }'
   ```
3. Also update the Stripe subscription in Stripe dashboard (or via Stripe API) to use the new price ID
4. Stripe will generate a prorated invoice — confirm with customer whether proration applies
5. Verify the subscription plan update appears in `GET /billing/admin/tenants/<id>`

---

## Issue: Billing Portal Fails

**Symptoms:** Customer clicks "Manage billing" and gets an error.

**Checks:**

1. StripeService.isConfigured — verify `STRIPE_SECRET_KEY` is set in production env
2. The tenant's `stripeCustomerId` is set in `TenantSubscription` — if null, portal cannot be created
   - If null: the tenant never completed checkout — send them a checkout link instead
3. Stripe Customer Portal must be enabled in Stripe dashboard → Settings → Billing → Customer Portal
4. The `returnUrl` must be a valid URL (not localhost in production)

---

## Issue: BillingGuard Incorrectly Blocks Something

**Symptoms:** Staff report that an endpoint they should be able to use is returning 403.

**Checks:**

1. Check the tenant's current billing status via admin API
2. Check if the endpoint should be billing-exempt (see BILLING_ENFORCEMENT_MATRIX.md)
3. Check if the endpoint recently lost its `@BillingExempt()` decorator (git diff)
4. If the status is wrong (e.g. UNPAID when they've paid): use `adminGrantException` to restore ACTIVE, investigate root cause

**Emergency override:**
```bash
curl -X POST https://<api>/api/v1/billing/admin/tenants/<tenantId>/grant-exception \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{ "status": "ACTIVE", "reason": "BillingGuard incorrectly blocking — investigating" }'
```

This writes an audit log entry. Always document the root cause in ROLLOUT_ISSUES.md.

---

## Issue: BillingGuard Blocks Live Orders or Printers

**This should NEVER happen.** All order, KDS, printer, and provider webhook endpoints are `@BillingExempt()`.

If it does happen:
1. Use `adminGrantException` immediately to unblock the tenant
2. Check if a recent deploy accidentally removed `@BillingExempt()` from a controller
3. Roll back the deploy if in doubt — do not leave a live trading shop blocked
4. File a P0 incident in ROLLOUT_ISSUES.md

**Critical trading endpoints that must always be accessible (verify these are still @BillingExempt):**
- `POST /orders` (and all order endpoints)
- All KDS endpoints
- `GET /printers/jobs` (Flutter)
- `PATCH /printers/jobs/:id` (Flutter)
- `POST /webhooks/:platform/:locationId`
- `GET /health/*`
- `POST /store-ops/:locationId/emergency-close`
- `POST /onboarding/.../providers/:id/pause`
- `POST /onboarding/.../printers/:id/pause`

---

## Issue: Manual Override with adminGrantException

Use this sparingly and always with a reason.

```bash
curl -X POST https://<api>/api/v1/billing/admin/tenants/<tenantId>/grant-exception \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "ACTIVE",
    "reason": "Manual enterprise deal — invoice sent separately",
    "adminUserId": "<your-admin-user-id>"
  }'
```

Valid target statuses: `ACTIVE`, `TRIALING`, `FREE_PILOT`

This does **not** create a Stripe subscription or charge the customer. It only overrides the internal billing state.

Always follow up by either:
- Creating a proper Stripe subscription (for long-term paid customers)
- Setting a trial with `adminConvertToTrial` (for short-term exceptions)
- Documenting that the exception is intentional (e.g. enterprise contract billed manually)

---

## Escalation

| Severity | Response Time | Who |
|----------|--------------|-----|
| Tenant blocked from live trading | Immediate (P0) | On-call engineer |
| Tenant stuck in wrong billing state | 1 hour (P1) | Operations team |
| Billing portal not working | 4 hours (P2) | Support team |
| Invoice or payment question | Same day (P3) | Support team |
| Plan change request | Same day (P3) | Operations team |
