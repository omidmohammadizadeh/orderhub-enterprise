# Stripe Setup — Phase R

> Run this guide once before going live with billing.
> Stripe test mode should be used for staging; live mode for production.

---

## 1. Create Stripe Account

1. Go to [stripe.com](https://stripe.com) and create an account
2. Complete business verification (required for payouts — not needed for test mode)
3. In the Stripe Dashboard: confirm you are using **UK** as the account country

---

## 2. Create Products and Prices

In Stripe Dashboard → Products → **+ Add product**:

### Starter Plan

- Name: `OrderHub Starter`
- Description: `1 location, up to 2 providers, 500 orders/month`
- Pricing: Recurring / Monthly / £49.00 GBP
- Copy the **Price ID** (e.g. `price_1AbcXXXXXXXXX`) → set as `STRIPE_PRICE_STARTER`

### Professional Plan

- Name: `OrderHub Professional`
- Description: `1–3 locations, unlimited providers, 2,000 orders/month`
- Pricing: Recurring / Monthly / £149.00 GBP
- Copy the **Price ID** → set as `STRIPE_PRICE_PROFESSIONAL`

### Enterprise Plan

- Name: `OrderHub Enterprise`
- Description: `4+ locations, all features, custom limits — contact sales`
- Pricing: Custom (create when needed)
- Copy the **Price ID** → set as `STRIPE_PRICE_ENTERPRISE` (optional)

---

## 3. Get API Keys

Stripe Dashboard → Developers → API keys:

- **Publishable key** (`pk_live_...` or `pk_test_...`) → `STRIPE_PUBLISHABLE_KEY`
- **Secret key** (`sk_live_...` or `sk_test_...`) → `STRIPE_SECRET_KEY`

Never commit secret key to git. Store in your secrets manager.

---

## 4. Configure Webhook

Stripe Dashboard → Developers → Webhooks → **+ Add endpoint**:

- Endpoint URL: `https://api.orderhub.io/api/v1/webhooks/stripe`
- Events to listen:
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.finalized`
  - `invoice.paid`
  - `invoice.payment_failed`
  - `customer.updated`

After creating, click **Reveal signing secret** → copy `whsec_...` → `STRIPE_WEBHOOK_SECRET`

---

## 5. Set Environment Variables

```bash
# .env.production (never commit to git)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PUBLISHABLE_KEY=pk_live_...

STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_PROFESSIONAL=price_...
STRIPE_PRICE_ENTERPRISE=price_...     # optional
```

---

## 6. Seed Billing Plans

Run the plan seed script:

```bash
STRIPE_PRICE_STARTER=price_... \
STRIPE_PRICE_PROFESSIONAL=price_... \
DATABASE_URL=<prod_url> \
  npx ts-node -P apps/api/tsconfig.json \
  apps/api/src/scripts/seed-billing-plans.ts
```

Verify plans are visible at `GET /api/v1/billing/plans`.

---

## 7. Run Pilot Shop Migration

Mark the 5 Phase Q shops as FREE_PILOT:

```bash
# Dry run first
DRY_RUN=true DATABASE_URL=<prod_url> \
  npx ts-node -P apps/api/tsconfig.json \
  apps/api/src/scripts/migrate-pilot-shops.ts

# Apply
DATABASE_URL=<prod_url> \
  npx ts-node -P apps/api/tsconfig.json \
  apps/api/src/scripts/migrate-pilot-shops.ts
```

---

## 8. Configure Stripe Billing Portal

Stripe Dashboard → Settings → Billing → Customer portal:

- Allow customers to: cancel subscriptions, update payment methods
- Return URL: `https://app.orderhub.io/dashboard/billing`

---

## 9. Test Checkout Flow (Staging)

Using Stripe test cards (`4242 4242 4242 4242`):

1. `POST /api/v1/billing/checkout` with a planId and test successUrl/cancelUrl
2. Open the returned `url` in a browser
3. Complete checkout with test card
4. Verify Stripe sends `checkout.session.completed` to your webhook endpoint
5. Verify `TenantSubscription.status = TRIALING` in the database
6. Check `StripeWebhookEvent` table for the processed event record

---

## 10. Verify Webhook Security

```bash
# Stripe CLI (for local testing)
stripe listen --forward-to http://localhost:4000/api/v1/webhooks/stripe

# Trigger a test event
stripe trigger invoice.payment_failed
```

Confirm: webhook received, signature verified, `StripeWebhookEvent` created with `processedAt` set.

---

## 11. Release Checklist Items

Add these to your pre-launch checklist:

- [ ] `STRIPE_SECRET_KEY` set (live, not test)
- [ ] `STRIPE_WEBHOOK_SECRET` set
- [ ] Webhook endpoint active in Stripe Dashboard (shows "Enabled")
- [ ] Billing plans seeded (3 plans in `subscription_plans` table)
- [ ] Pilot shops migrated to `FREE_PILOT`
- [ ] Test checkout flow works end-to-end
- [ ] `StripeWebhookEvent` table exists (migration applied)
- [ ] `UsageRecord` table exists
- [ ] `gracePeriodEndsAt` column exists on `tenant_subscriptions`
