# Pilot Launch Runbook

> Use this for the first 1–3 pilot restaurant locations going live on OrderHub.
> Work through every section in order. Do not skip sections.

---

## Before You Start

- Complete `RELEASE_CHECKLIST.md` sections 1–10b first
- Release readiness score ≥ 90 at `/api/v1/health/release-readiness`
- Open the Go-Live Wizard at `/dashboard/admin/go-live`
- Have on-call engineer available for 30 minutes after go-live

---

## Step 1 — Create the Tenant

```bash
# Via API or admin dashboard
POST /api/v1/tenants
{
  "name": "Restaurant Name",
  "slug": "restaurant-slug",
  "plan": "STARTER"
}
```

Confirm:
- [ ] Tenant record created, `status: ACTIVE`
- [ ] Tenant appears in admin tenant list

---

## Step 2 — Create the Brand and Location

```bash
POST /api/v1/brands        # create brand under tenant
POST /api/v1/locations     # create location under brand
```

Required location fields:
- `name` — display name
- `address` — full address
- `timezone` — e.g. `Europe/London`
- `shopCode` — short code used by Flutter printer app polling (e.g. `LON01`)

Confirm:
- [ ] Location visible at `/dashboard/locations`
- [ ] `shopCode` set — required for printer app
- [ ] Location switcher shows the new location

---

## Step 3 — Advance to CONFIGURING

In the Go-Live Wizard (`/dashboard/admin/go-live`):

1. Select the new location
2. Check: `goLiveStatus` is `DRAFT`
3. Click **CONFIGURING**

Expected: status badge → `CONFIGURING`

---

## Step 4 — Configure Marketplace Integrations

For each enabled platform (Uber Eats, Deliveroo, Just Eat, HubRise):

1. Go to `/dashboard/integrations`
2. Add integration for this location
3. Enter credentials (clientId, clientSecret, webhookSecret)
4. Set status to `ACTIVE`
5. Run credential encryption backfill if credentials were entered plaintext:
   ```bash
   DRY_RUN=true CREDENTIAL_ENCRYPTION_KEY=<key> DATABASE_URL=<url> \
     npx ts-node apps/api/src/scripts/backfill-credential-encryption.ts
   # Review output, then run without DRY_RUN=true
   ```

Confirm in Go-Live Wizard:
- [ ] `encryption.no_plaintext_credentials` → pass
- [ ] Provider cards show `ACTIVE` status

---

## Step 5 — Configure Printers

1. Go to `/dashboard/printers`
2. Add printer record for this location
3. Set `connectionType`, IP, port as appropriate
4. Set `supportsReceipts`, `supportsKitchen`, `supportsLabels`
5. Set `isActive: true`
6. Confirm Flutter Android app is configured with correct `shop_code`

Confirm:
- [ ] Printer heartbeat ONLINE in diagnostics
- [ ] Test print sent successfully
- [ ] Click **Record Test Print** in Go-Live Wizard → `printer.test_print_passed` → pass

---

## Step 6 — Build the Menu

1. Go to `/dashboard/menu`
2. Create at least one category and item
3. Set prices in pence (GBP) or cents as required
4. Publish to active platforms

Confirm:
- [ ] `menu.items_exist` → pass in Go-Live Wizard

---

## Step 7 — Invite Staff

1. Go to `/dashboard/settings/users`
2. Invite owner/manager
3. Invite kitchen staff if using KDS

Confirm:
- [ ] `staff.user_exists` → pass
- [ ] Users accept invitations and can log in

---

## Step 8 — Run Test Orders

In the sandbox order generator (`/dashboard/sandbox`):

1. Generate 5 test orders (mixed platforms if possible)
2. Confirm each order appears in:
   - [ ] Main Orders page
   - [ ] Rush Hour view
   - [ ] Kitchen Display (KDS)
3. Run through full lifecycle: Accept → Preparing → Ready → Dispatch → Complete
4. Confirm printer job created and marked `PRINTED`
5. Click **Record Test Order** in Go-Live Wizard → `orders.test_order_completed` → pass

---

## Step 9 — Advance to TESTING

In Go-Live Wizard:
- [ ] All blockers resolved (score ≥ 75 recommended)
- [ ] Click **TESTING**

---

## Step 10 — Advance to READY_FOR_GO_LIVE

In Go-Live Wizard:
- [ ] Score ≥ 90
- [ ] Zero blockers
- [ ] All provider integrations active
- [ ] At least one printer online
- [ ] Test order completed
- [ ] Test print completed
- [ ] Click **READY_FOR_GO_LIVE**

---

## Step 11 — Final Go-Live Sign-Off

Before clicking LIVE:

- [ ] Operations manager sign-off obtained
- [ ] Go-live time agreed (avoid peak hours — typical peak 12:00–14:00 and 18:00–21:00)
- [ ] On-call engineer confirmed available
- [ ] Release readiness score ≥ 90 at `/api/v1/health/release-readiness`
- [ ] `outbox.dead === 0`
- [ ] `credentialEncryption.plaintextCredentials === 0`

---

## Step 12 — Go Live

In Go-Live Wizard:
- All critical blockers must be resolved (green)
- Click **LIVE** button (only enabled when no blockers)

Expected:
- Status → `LIVE`
- Audit log entry written automatically

---

## Step 13 — Post Go-Live (First 30 Minutes)

- [ ] Monitor `/api/v1/health/ready` — stays green
- [ ] Monitor Bull Board for queue failures
- [ ] Confirm first real order received and printed
- [ ] Confirm order status synced back to platform
- [ ] No errors in structured logs
- [ ] Check printer job records — status moves to `PRINTED`

If issues arise:
- Use Go-Live Wizard to set status to `PAUSED` immediately
- Investigate before re-enabling
- See `MONITORING_AND_ALERTS.md` for investigation steps per alert type

---

## Emergency Pause

**If the location needs to stop taking orders immediately:**

1. Go-Live Wizard → select location → click **PAUSED**
2. Or via API (no UI needed):
   ```bash
   curl -X POST "https://api.orderhub.io/api/v1/onboarding/locations/<id>/transition?tenantId=<tid>" \
     -H "Authorization: Bearer <admin-token>" \
     -H "Content-Type: application/json" \
     -d '{"targetStatus": "PAUSED", "reason": "Emergency pause — investigating issue"}'
   ```
3. Disable the affected provider integration(s) at `/dashboard/integrations` if needed
4. Notify the restaurant contact
5. Document the incident in audit log (all transitions are logged automatically)

**If only one provider needs to stop:**
- Set that Integration's `status` to `INACTIVE` via `/dashboard/integrations`
- Other providers continue operating

**If all providers need to stop:**
- Pause the location AND set all Integrations to INACTIVE

---

## Monitoring During Pilot

Check these every 15 minutes for the first hour, then hourly:

```bash
# Health check
curl https://api.orderhub.io/api/v1/health/ready | jq '.status'

# Release readiness (replace tenantId)
curl -H "Authorization: Bearer <token>" \
  "https://api.orderhub.io/api/v1/health/release-readiness?tenantId=<id>" \
  | jq '{score: .readyScore, dead: .checks.outbox.dead, stuck: .checks.outbox.stuckProcessing}'
```

Expected during normal operation:
- `status: "ok"` from health/ready
- `readyScore >= 85`
- `dead: 0`
- `stuckProcessing: 0`

If any of the above deviates, see `MONITORING_AND_ALERTS.md` for investigation steps.

---

## Rollback

If go-live needs to be reversed:

1. In Go-Live Wizard, click **PAUSED**
2. Or `PLATFORM_ADMIN` admin override to `BLOCKED` with reason
3. Disable integrations at `/dashboard/integrations` (set status to INACTIVE)
4. Notify the restaurant contact
5. Investigate, fix, and re-run from Step 8

---

## Contacts

Fill in for each pilot:

| Role | Name | Contact |
|---|---|---|
| Operations manager | | |
| On-call engineer | | |
| Restaurant contact | | |
| Provider account manager | | |
