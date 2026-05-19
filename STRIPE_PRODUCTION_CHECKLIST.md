# Stripe Production Activation Checklist

Complete all items before switching to live Stripe mode.

---

## Environment Configuration

- [ ] `STRIPE_SECRET_KEY` set to **live key** (`sk_live_...`) in production only
- [ ] `STRIPE_WEBHOOK_SECRET` set to **live endpoint secret** from Stripe dashboard
- [ ] Test keys (`sk_test_...`) confirmed absent from production environment
- [ ] Live keys confirmed absent from local/development environments
- [ ] Neither key is committed to source control (check `.env*` gitignore)
- [ ] Neither key appears in any log output (search logs for `sk_live`)
- [ ] Neither key appears in any API response (grep codebase for any accidental leaks)

## Stripe Dashboard Setup

- [ ] Live mode webhook endpoint registered: `POST https://<prod-domain>/api/v1/webhooks/stripe`
- [ ] Webhook signing secret (whsec) copied to `STRIPE_WEBHOOK_SECRET`
- [ ] Required webhook events enabled:
  - [ ] `checkout.session.completed`
  - [ ] `customer.subscription.created`
  - [ ] `customer.subscription.updated`
  - [ ] `customer.subscription.deleted`
  - [ ] `invoice.finalized`
  - [ ] `invoice.paid`
  - [ ] `invoice.payment_failed`
  - [ ] `customer.updated`
- [ ] Billing portal configured (Customer Portal settings in Stripe dashboard)
- [ ] Products created in live mode with correct names (Starter, Professional, Enterprise)
- [ ] Prices created with correct amounts in GBP:
  - [ ] Starter: £49/month recurring
  - [ ] Professional: £149/month recurring
  - [ ] Enterprise: manual/custom
- [ ] `stripePriceId` fields in `subscription_plans` table updated to live price IDs
  - Run: `STRIPE_MODE=live node scripts/seed-billing-plans.ts`

## Tax and Invoicing

- [ ] VAT/tax treatment documented and configured if required
- [ ] Invoice email from address configured in Stripe dashboard
- [ ] Invoice footer text configured (company address, VAT number if applicable)
- [ ] Invoice PDF branding configured (logo, colours)
- [ ] Decide: Stripe handles invoice emails, or OrderHub sends custom emails

## Pre-Production Test Run

- [ ] Full test mode activation completed (see `FIRST_PAID_CUSTOMER_PLAN.md`)
- [ ] All 4 Stripe webhook events received with 200 responses in test mode
- [ ] Tenant moved to ACTIVE status in test mode
- [ ] Payment failure simulation passed in test mode
- [ ] Payment recovery (PAST_DUE → ACTIVE) tested in test mode
- [ ] Billing portal works in test mode
- [ ] No test-mode charges are billed in production (keys are separate)

## Application Readiness

- [ ] `StripeService.isConfigured` returns `true` in production
- [ ] `/api/v1/health/ready` returns `ok` (Redis + DB both up)
- [ ] `/api/v1/health/release-readiness` shows `encryption.keySet: true`
- [ ] `CREDENTIAL_ENCRYPTION_KEY_CURRENT` set (credentials encrypted at rest)
- [ ] Webhook endpoint is reachable from Stripe's IP ranges
- [ ] Raw body parsing configured for `/api/v1/webhooks/stripe` (required for signature verification)

## Security

- [ ] No card data stored in any database table
- [ ] `stripeCustomerId` and `stripeSubId` only accessible to PLATFORM_ADMIN via API
- [ ] Tenant billing status endpoint does not expose Stripe IDs
- [ ] Webhook signature verified before processing (rejects invalid signatures with 400)
- [ ] Duplicate events are idempotent (`stripe_webhook_events` deduplication table)

## First Real Customer

- [ ] Customer agreement confirmed (email/contract in writing)
- [ ] Billing email confirmed with customer
- [ ] Plan and price confirmed
- [ ] Trial period (if any) confirmed
- [ ] Customer notified of payment amount and date
- [ ] Rollback plan ready (see `FIRST_PAID_CUSTOMER_PLAN.md`)

## Go / No-Go Decision

| Check | Result |
|-------|--------|
| Test mode activation passed | ⬜ |
| All webhook events verified | ⬜ |
| No secrets in logs/responses | ⬜ |
| 5 FREE_PILOT shops unaffected | ⬜ |
| Orders/printers/KDS work during/after activation | ⬜ |
| First customer agreement confirmed | ⬜ |
| PLATFORM_ADMIN signed off | ⬜ |

**Status:** ⬜ Not ready | ⬜ Ready for first live customer

---

## Emergency Contacts

If something goes wrong during live activation:
1. Cancel subscription immediately in Stripe dashboard
2. Run `adminGrantException` to restore tenant to usable status
3. Check `stripe_webhook_events` table for error messages
4. Replay failed webhooks from Stripe dashboard → Webhooks → Event details → Resend
