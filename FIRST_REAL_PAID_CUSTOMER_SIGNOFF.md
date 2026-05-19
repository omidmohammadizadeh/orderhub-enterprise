# First Real Paid Customer Sign-Off

> Complete this document before and after the first live Stripe activation.
> Both the operator and the customer agreement must be on record before any real payment is taken.

---

## Customer Details

| Field | Value |
|-------|-------|
| Tenant name | _(e.g. "Burger Palace — Oxford Street")_ |
| Tenant ID (UUID) | _(UUID from database)_ |
| Location name | _(e.g. "Main Location")_ |
| Tenant owner name | _(full name)_ |
| Billing email | _(confirmed email address)_ |
| Phone / WhatsApp | _(support contact)_ |
| Selected plan | _(STARTER / PROFESSIONAL / ENTERPRISE)_ |
| Plan ID (UUID) | _(UUID from `subscription_plans` table)_ |
| Monthly price | _(£49 / £149 / custom)_ |
| Currency | GBP |
| Trial period | _(e.g. "none" / "14 days free")_ |
| First charge date | _(date, or "immediately after checkout")_ |
| FREE_PILOT end date | _(if converting from pilot — must have explicit agreement)_ |
| Current billing status | _(FREE_PILOT / TRIALING / none)_ |

---

## Commercial Agreement

> The following must be confirmed **before** the checkout session is created.

- [ ] Customer has been informed of the monthly price in writing (email/contract)
- [ ] Customer understands when the first charge will occur
- [ ] Customer understands trial period terms (if applicable)
- [ ] Customer understands auto-renewal unless cancelled
- [ ] Customer has confirmed billing email
- [ ] Customer has been given cancellation instructions
- [ ] Written agreement on record (email thread, contract, or signed proposal)

| Field | Value |
|-------|-------|
| Agreement type | _(email / contract / signed proposal)_ |
| Date of agreement | _(YYYY-MM-DD)_ |
| Agreement reference | _(email subject / contract number / URL)_ |
| Approved by (PLATFORM_ADMIN) | _(name)_ |
| Approval date | _(YYYY-MM-DD)_ |

---

## Pre-Activation Checklist

Complete STRIPE_PRODUCTION_CHECKLIST.md in full. Key items:

- [ ] Stripe test-mode activation completed and passed (all 4 webhook events received)
- [ ] STRIPE_SECRET_KEY set to live key in production environment
- [ ] STRIPE_WEBHOOK_SECRET set to live endpoint secret
- [ ] Webhook endpoint registered in Stripe dashboard: `POST https://<prod-domain>/api/v1/webhooks/stripe`
- [ ] All 8 webhook events enabled in Stripe dashboard
- [ ] Billing plan exists with correct live Stripe price ID
- [ ] 5 FREE_PILOT shops confirmed unaffected (status still FREE_PILOT)
- [ ] API health check passes: GET /api/v1/health/ready → ok

---

## Activation Record

| Step | Time (UTC) | Result | Notes |
|------|-----------|--------|-------|
| Admin assigns plan | | | |
| Checkout session created | | | |
| Customer completes checkout | | | |
| checkout.session.completed received | | | |
| customer.subscription.created received | | | |
| invoice.finalized received | | | |
| invoice.paid received | | | |
| Tenant status → ACTIVE | | | |
| paymentMethodStatus → attached | | | |
| lastInvoiceStatus → PAID | | | |
| POST /billing/portal confirmed | | | |
| Audit log entries confirmed | | | |

---

## Post-Activation Smoke Test

Run all checks from PHASE_V_REPORT.md Section 4 immediately after activation.

| Endpoint | Result |
|----------|--------|
| GET /orders | ⬜ |
| POST /orders | ⬜ |
| GET /kds/screens | ⬜ |
| GET /printers/jobs (Flutter) | ⬜ |
| PATCH /printers/jobs/:id (Flutter) | ⬜ |
| POST /webhooks/:platform/:locationId | ⬜ |
| GET /health/staff-status | ⬜ |
| GET /health/ready | ⬜ |
| POST /onboarding/.../providers/:id/pause | ⬜ |
| POST /billing/portal | ⬜ |
| GET /billing/warnings | ⬜ |
| GET /billing/status (no Stripe IDs) | ⬜ |

---

## FREE_PILOT Protection Verification

After activation, verify all pilot shops are unaffected:

| Shop | status still FREE_PILOT | No stripeCustomerId | Orders working |
|------|------------------------|---------------------|----------------|
| Shop 1 | ⬜ | ⬜ | ⬜ |
| Shop 2 | ⬜ | ⬜ | ⬜ |
| Shop 3 | ⬜ | ⬜ | ⬜ |
| Shop 4 | ⬜ | ⬜ | ⬜ |
| Shop 5 | ⬜ | ⬜ | ⬜ |

---

## Sign-Off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| PLATFORM_ADMIN | | | |
| Operations Manager | | | |
| Customer Confirmation | | | |

---

## Rollback Plan

If anything goes wrong after live activation:

1. **Cancel subscription in Stripe dashboard** — prevents further charges
2. **Run adminGrantException** with reason "Rollback after activation issue" — restores tenant access
3. **Inform customer immediately** — explain the issue and resolution timeline
4. **Check stripe_webhook_events table** for error messages
5. **Replay webhooks** from Stripe dashboard → Webhooks → Event details → Resend
6. **Do not delete** the Stripe customer or subscription — cancel only; re-activate from same customer later

---

## Support Contact for This Customer

| Field | Value |
|-------|-------|
| Primary contact (OrderHub side) | _(name + phone/email)_ |
| Escalation contact | _(name + phone)_ |
| Response SLA | _(e.g. 2h during business hours, 4h otherwise)_ |
