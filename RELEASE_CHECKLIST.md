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

## 10d. Production Environment Check (Phase L)

- [ ] All variables in `PRODUCTION_ENVIRONMENT.md` reviewed and set
- [ ] `CREDENTIAL_ENCRYPTION_KEY` stored in secrets manager (not committed to git)
- [ ] `JWT_SECRET` and `JWT_REFRESH_SECRET` randomly generated, ≥ 32 chars, no insecure defaults
- [ ] `APP_URL` is production URL (not localhost)
- [ ] `SOCKET_CORS_ORIGIN` is production frontend domain (not `*`)
- [ ] Provider base URLs confirmed to point to production endpoints
- [ ] Production startup validation passes (no `STARTUP FAILED` in logs)
- [ ] Smoke test passes (exit code 0): `npx ts-node apps/api/src/scripts/smoke-test.ts`
- [ ] Smoke test: `no_plaintext_credentials` passes
- [ ] Smoke test: `no_dead_outbox_events` passes
- [ ] Smoke test: `phase_k_migration_applied` passes
- [ ] Smoke test: `release_readiness_score` ≥ 80

---

## 10e. Monitoring Setup (Phase L)

- [ ] Log aggregation configured (Datadog / CloudWatch / equivalent)
- [ ] Uptime monitor on `GET /api/v1/health` configured
- [ ] Alert on `outbox.dead > 0`
- [ ] Alert on `outbox.stuckProcessing > 0` for > 300s
- [ ] Alert on webhook failures increasing
- [ ] On-call runbook link shared with team (`MONITORING_AND_ALERTS.md`)

---

## 10f. Backup Verified (Phase L)

- [ ] Pre-deploy database backup taken
- [ ] Backup file verified non-empty
- [ ] Backup uploaded to S3 or equivalent
- [ ] `CREDENTIAL_ENCRYPTION_KEY` confirmed available for backup restore
- [ ] Restore procedure reviewed (`BACKUP_AND_RECOVERY.md`)

---

## 10g. Pilot Location Readiness (Phase M)

- [ ] `PILOT_LOCATION_PLAN.md` fully completed and reviewed
- [ ] Restaurant contact confirmed and has support number
- [ ] All provider integrations connected and encrypted
- [ ] Printer online and test print confirmed
- [ ] Staff training completed — `PILOT_STAFF_TRAINING.md` reviewed with staff
- [ ] Emergency pause tested — `/v1/onboarding/locations/:id/transition` to PAUSED works
- [ ] Provider pause tested — `/v1/onboarding/locations/:id/providers/:id/pause` works
- [ ] Printer pause tested — `/v1/onboarding/locations/:id/printers/:id/pause` works
- [ ] All audit log entries verified for lifecycle transitions
- [ ] `PILOT_ISSUES.md` open and assigned to on-call engineer
- [ ] Go-live time agreed — not during peak hours
- [ ] Rollback plan confirmed in `PILOT_LAUNCH_RUNBOOK.md`

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

## 10i. 3-Day Pilot Stability (Phase O)

- [ ] 3-day monitoring log completed in `PHASE_O_REPORT.md`
- [ ] 0 lost orders over 3 days
- [ ] 0 unresolved P0 or P1 issues at end of Day 3
- [ ] Staff operating independently from Day 2
- [ ] Printer stale-heartbeat detection confirmed working (Phase O improvement)
- [ ] Provider rate-limit events logged with Retry-After detail (Phase O improvement)
- [ ] Staff health panel accessible and used by restaurant staff
- [ ] 3-day success criteria decision recorded: expand / hold / pause

---

## 10h. First Live Trading Validation (Phase N)

- [ ] Smoke test re-run immediately before go-live (exit code 0, all 16 checks)
- [ ] Release readiness score ≥ 90 confirmed on day of go-live
- [ ] On-call engineer monitoring logs for first 2 hours of trading
- [ ] First real order received and confirmed printed
- [ ] First real order status synced back to provider
- [ ] Bull Board checked — no failed jobs accumulating
- [ ] `outboxDead: 0` confirmed after first order
- [ ] Printer heartbeat ONLINE confirmed during peak
- [ ] No 5xx errors in structured logs during first trading hour
- [ ] P2 issues logged in `PILOT_ISSUES.md` with root cause
- [ ] 3-day review date agreed before handing off monitoring

---

## 12. Post Go-Live (First 30 minutes)

- [ ] Monitor /api/v1/health/ready — stays green
- [ ] Monitor Bull Board for queue failures
- [ ] Confirm first real order received and printed
- [ ] Confirm first real order status synced back to platform
- [ ] No errors in structured logs
- [ ] On-call engineer available
