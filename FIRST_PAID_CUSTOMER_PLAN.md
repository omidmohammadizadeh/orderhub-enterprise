# First Paid Customer Activation Plan

## Activation Plan

| Field | Value |
|-------|-------|
| **Activation mode** | Stripe test mode first; production only after test mode passes |
| **Stripe test key** | `sk_test_...` (set in `.env.local` or deployment env) |
| **Stripe webhook endpoint** | `https://<api-domain>/api/v1/webhooks/stripe` |

---

## Selected Tenant for First Test Activation

> **Instructions for operator:** Fill in this table before activating.

| Field | Value |
|-------|-------|
| Tenant name | _(e.g. "OrderHub Test Merchant")_ |
| Tenant ID | _(UUID from database)_ |
| Location name | _(e.g. "Main Location")_ |
| Billing email | _(email of TENANT_OWNER user)_ |
| Selected plan | _(STARTER / PROFESSIONAL / ENTERPRISE)_ |
| Plan ID | _(UUID from `subscription_plans` table)_ |
| Current billing status | _(FREE_PILOT / TRIALING / none)_ |
| FREE_PILOT end date | _(if applicable — must not auto-charge)_ |
| Approved by | _(PLATFORM_ADMIN name and date)_ |

---

## Pre-Activation Checklist

- [ ] `STRIPE_SECRET_KEY` is set to test key (`sk_test_...`)
- [ ] `STRIPE_WEBHOOK_SECRET` is set (Stripe CLI or dashboard endpoint secret)
- [ ] Stripe webhook endpoint registered in dashboard: `POST /api/v1/webhooks/stripe`
- [ ] Webhook events enabled: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `customer.updated`
- [ ] Billing plan exists in DB with correct `stripePriceId` (run `seed-billing-plans.ts`)
- [ ] Tenant exists in DB with `TENANT_OWNER` user with email
- [ ] 5 FREE_PILOT shops confirmed unaffected (status still FREE_PILOT, no Stripe customer IDs created accidentally)
- [ ] API is accessible and Stripe webhook can reach it (ngrok or staging URL)

---

## Activation Steps

### Step 1 — Admin assigns plan

```bash
curl -X PATCH https://<api>/api/v1/billing/admin/tenants/<tenantId>/plan \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{ "planId": "<plan-uuid>", "reason": "First paid customer test activation" }'
```

Expected: `200 OK`

### Step 2 — Create checkout session

```bash
curl -X POST https://<api>/api/v1/billing/checkout \
  -H "Authorization: Bearer <tenant-owner-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "planId": "<plan-uuid>",
    "successUrl": "https://<dashboard>/billing?success=1",
    "cancelUrl": "https://<dashboard>/billing?cancel=1"
  }'
```

Expected: `{ "url": "https://checkout.stripe.com/...", "sessionId": "cs_test_..." }`

### Step 3 — Complete checkout

Open the `url` in a browser. Use Stripe test card:

| Card | Outcome |
|------|---------|
| `4242 4242 4242 4242` | Successful payment |
| `4000 0000 0000 9995` | Card declined |
| `4000 0000 0000 0341` | Attaches but next charge fails |

Expiry: any future date. CVC: any 3 digits.

### Step 4 — Verify webhooks received

Check Stripe dashboard → Webhooks → Recent deliveries. All 4 events should show `200`:
- `checkout.session.completed`
- `customer.subscription.created`
- `invoice.finalized`
- `invoice.paid`

### Step 5 — Verify tenant status

```bash
curl https://<api>/api/v1/billing/status \
  -H "Authorization: Bearer <tenant-owner-token>"
```

Expected:
```json
{
  "status": "ACTIVE",
  "paymentMethodStatus": "attached",
  "plan": { "name": "STARTER" },
  "recentInvoices": [{ "status": "PAID" }]
}
```

### Step 6 — Run operational smoke test

```bash
# Orders page still works
curl https://<api>/api/v1/orders -H "Authorization: Bearer <token>"

# KDS still works
curl https://<api>/api/v1/kds/screens?locationId=<id> -H "Authorization: Bearer <token>"

# Flutter printer polling still works (no auth)
curl https://<api>/api/v1/printers/jobs?shop_code=<code>

# Staff health still works
curl "https://<api>/api/v1/health/staff-status?locationId=<id>" -H "Authorization: Bearer <token>"

# Billing portal accessible
curl -X POST https://<api>/api/v1/billing/portal \
  -H "Authorization: Bearer <tenant-owner-token>" \
  -d '{ "returnUrl": "https://<dashboard>/billing" }'
```

---

## Rollback Plan

If anything goes wrong during test activation:

1. **Status stuck in wrong state** → `POST /billing/admin/tenants/<id>/grant-exception` with reason
2. **Stripe customer created incorrectly** → Update `stripeCustomerId` in DB manually, re-run checkout
3. **Subscription created on wrong price** → Cancel in Stripe dashboard, re-run checkout with correct plan
4. **Webhooks not received** → Check `stripe_webhook_events` table; replay from Stripe dashboard
5. **FREE_PILOT shop accidentally touched** → Run `migrate-pilot-shops.ts` script to re-apply FREE_PILOT

No automatic charges are made to existing FREE_PILOT shops under any circumstances.

---

## Production Activation (After Test Mode Passes)

1. Swap `STRIPE_SECRET_KEY` to live key (`sk_live_...`) — **staging only, never local**
2. Update `STRIPE_WEBHOOK_SECRET` to live endpoint secret
3. Confirm customer agreement in writing (email/contract)
4. Re-run activation steps with real card in production
5. Document result in `PHASE_U_REPORT.md`
