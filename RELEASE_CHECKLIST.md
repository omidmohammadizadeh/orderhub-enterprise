# Release Checklist — Onboarding a Live Client

> Use this checklist before going live with any new restaurant location.
> Run the Release Readiness page at /dashboard/admin/release-readiness after each section.

---

## 1. Environment

- [ ] `NODE_ENV=production` set in API and worker
- [ ] Sandbox tools confirmed disabled (`SandboxService.guardNonProd()` active)
- [ ] No provider test credentials hardcoded in env files
- [ ] `.env.production` does not contain `localhost` or test keys
- [ ] CORS `SOCKET_CORS_ORIGIN` set to production frontend domain
- [ ] `JWT_SECRET` is at least 32 chars, randomly generated, not default
- [ ] `CREDENTIAL_ENCRYPTION_KEY` set (64 hex chars) — `openssl rand -hex 32`

---

## 2. Database

- [ ] All Prisma migrations applied (`prisma migrate deploy` — includes Phase I migration `20260518210000_phase_i`)
- [ ] `prisma generate` run with production DATABASE_URL
- [ ] Database connection tested via `/api/v1/health/ready`
- [ ] Redis connection tested via `/api/v1/health/ready`
- [ ] `outbox_events` table exists and accessible (confirm in DB)

---

## 2a. Credential Encryption Backfill

- [ ] Run backfill script against production DB:
  ```bash
  DRY_RUN=true CREDENTIAL_ENCRYPTION_KEY=<key> DATABASE_URL=<url> \
    npx ts-node -P apps/api/tsconfig.json \
    apps/api/src/scripts/backfill-credential-encryption.ts
  ```
- [ ] Review dry-run output — confirm integration count is correct
- [ ] Run without `DRY_RUN=true` to apply encryption
- [ ] Confirm `plaintextCredentials: 0` in release readiness check
- [ ] Confirm all provider integrations still work after backfill (test webhook receipt)

---

## 2b. Outbox Health Check

- [ ] Confirm `outboxPending: 0` after initial startup
- [ ] Confirm `outboxDead: 0` before go-live
- [ ] Confirm outbox dispatcher is running (check API logs for "Outbox: claimed" messages)
- [ ] Send a test order and confirm `outboxPending` drops to 0 within 10 seconds

---

## 3. Tenant Setup

- [ ] Tenant record created in database
- [ ] Tenant owner user created and invited
- [ ] Tenant name and slug confirmed
- [ ] Billing plan assigned

---

## 4. Location Setup

- [ ] Location record created under tenant's brand
- [ ] Location name, address, timezone set
- [ ] `shopCode` set on location (used by Flutter printer app)
- [ ] Location visible in dashboard location switcher

---

## 5. Marketplace Credentials

For each enabled platform:

### Uber Eats
- [ ] `clientId`, `clientSecret` set in Integration credentials
- [ ] `webhookSecret` set
- [ ] Integration status = ACTIVE
- [ ] Test webhook received successfully (check webhookEvent table)
- [ ] Token refresh tested (Integration.tokenExpiresAt populated)

### Deliveroo
- [ ] `clientId`, `clientSecret` set
- [ ] `webhookSecret` set
- [ ] Integration status = ACTIVE
- [ ] Test order webhook received

### Just Eat
- [ ] `clientId`, `clientSecret`, `applicationId` set
- [ ] `webhookSecret` set
- [ ] Integration status = ACTIVE

### HubRise
- [ ] `accessToken`, `refreshToken`, `accountId`, `locationId` set
- [ ] Integration status = ACTIVE
- [ ] Test order from HubRise received

---

## 6. Printer Setup

- [ ] At least one printer configured for the location
- [ ] Printer connectionType set (LAN/EPSON_EPOS/STAR/BROWSER/CLOUD)
- [ ] IP address and port set for LAN/ePOS printers
- [ ] `supportsReceipts`, `supportsKitchen`, `supportsLabels` flags set correctly
- [ ] `isActive = true`
- [ ] Heartbeat showing printer ONLINE (check diagnostics page)
- [ ] Test print sent successfully from diagnostics page
- [ ] Flutter Android app configured with correct `shop_code`
- [ ] Flutter app polling confirmed (check printJob records updating to PRINTED)

---

## 7. Menu Setup

- [ ] Menu created with at least one category and item
- [ ] Menu published to active platforms
- [ ] Item prices in correct currency (pence for GBP)
- [ ] Modifiers and options configured

---

## 8. Test Order Flow

- [ ] Sandbox order generator run (5 test orders, any platform)
- [ ] Orders appear in main Orders page
- [ ] Orders appear in Rush Hour page
- [ ] Orders appear in Kitchen Display
- [ ] Accept order → status moves to ACCEPTED
- [ ] Preparing → status moves to PREPARING
- [ ] Ready → status moves to READY
- [ ] Dispatch → status moves to DISPATCHED
- [ ] Complete → status moves to COMPLETED
- [ ] Printer job created for new order
- [ ] Printer job marked PRINTED by Flutter app (or heartbeat retry)
- [ ] KDS ticket bumped on READY

---

## 9. Real Webhook Test

- [ ] Send a real test webhook from Uber Eats sandbox (if available)
- [ ] Confirm order appears with correct items and total
- [ ] Confirm signature verification passed (no UnauthorizedException in logs)
- [ ] Confirm no duplicate orders created
- [ ] Confirm status sync sent back to platform on accept

---

## 10. Staff Training

- [ ] Owner/manager trained on dashboard
- [ ] Staff trained on KDS (kitchen screen)
- [ ] Staff trained on Rush Hour mode
- [ ] Staff trained on Cashier mode
- [ ] Staff trained on Dispatch mode
- [ ] Printer troubleshooting steps provided

---

## 10a. Smoke Test (Phase J)

- [ ] Run smoke test script: `SMOKE_BASE_URL=<url> SMOKE_TENANT_ID=<id> ... pnpm smoke-test`
- [ ] All 9 checks pass (exit code 0)
- [ ] Encryption roundtrip check passes
- [ ] `outbox_events` table exists (confirms migration applied)
- [ ] Webhook endpoint reachable (returns 400 for unknown platform, not 404/502)

---

## 10b. Key Rotation Check (Phase J)

- [ ] `CREDENTIAL_ENCRYPTION_KEY_ID` set (e.g. `v1`)
- [ ] `credentialEncryption.encryptedWithOldKey === 0` in release readiness (or rotation is explicitly in progress)
- [ ] If rotation in progress: `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` still set until rotation completes
- [ ] Rotation script dry run completed successfully before final launch

---

## 10c. Onboarding Lifecycle Check (Phase K)

- [ ] Run `prisma migrate deploy` — confirms `20260519000000_phase_k` migration applied
- [ ] `Location.goLiveStatus` column exists in database (default: `DRAFT`)
- [ ] Go-Live Wizard accessible at `/dashboard/admin/go-live`
- [ ] Each pilot location has been advanced through CONFIGURING → TESTING → READY_FOR_GO_LIVE
- [ ] `goLiveStatus = READY_FOR_GO_LIVE` before clicking LIVE in wizard
- [ ] All readiness blockers resolved (LIVE button enabled only when zero blockers)
- [ ] Audit log entries confirmed for all status transitions

---

## 11. Go-Live Approval

- [ ] All webhook test suites pass (0 failures)
- [ ] `outbox.stuckProcessing === 0`
- [ ] `outbox.dead === 0`
- [ ] `credentialEncryption.plaintextCredentials === 0`
- [ ] `credentialEncryption.encryptedWithOldKey === 0` (pre-launch target — acceptable during rotation window)
- [ ] Release Readiness score ≥ 90
- [ ] No CRITICAL warnings in release readiness check
- [ ] All printers online
- [ ] At least one active integration
- [ ] Test order lifecycle completed end-to-end
- [ ] Operations manager sign-off obtained
- [ ] Go-live time agreed (avoid peak hours)

---

## 12. Post Go-Live (First 30 minutes)

- [ ] Monitor /api/v1/health/ready — stays green
- [ ] Monitor Bull Board for queue failures
- [ ] Confirm first real order received and printed
- [ ] Confirm first real order status synced back to platform
- [ ] No errors in structured logs
- [ ] On-call engineer available
