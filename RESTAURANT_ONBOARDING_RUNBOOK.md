# Restaurant Onboarding Runbook

> Last updated: Phase Z — Cloud Deployment & Production Infrastructure (2026-05-19)
>
> Step-by-step process for onboarding a new restaurant onto OrderHub in a live cloud environment.
> Run through this checklist for every new location. Do not skip steps.

---

## Prerequisites

Before starting onboarding:

- [ ] OrderHub API and Web are deployed and healthy (`GET /api/v1/health/ready` returns `ok`)
- [ ] Staging environment validated (STAGING_ENVIRONMENT.md complete)
- [ ] Restaurant owner has been briefed and has agreed to terms
- [ ] At least one platform (Uber Eats or Deliveroo) credential is available
- [ ] Printer hardware is on-site (or confirmed shipping date)
- [ ] On-call engineer available for the first 24 hours after go-live

---

## Phase 1 — Tenant and Location Creation (Admin Task)

### 1.1 Create the Tenant

Using the OrderHub admin API or dashboard:

```bash
# POST /api/v1/admin/tenants
{
  "name": "Restaurant Name Ltd",
  "slug": "restaurant-name",
  "plan": "FREE_PILOT",
  "ownerEmail": "owner@restaurant.com",
  "ownerName": "Restaurant Owner Name"
}
```

Note the returned `tenantId`.

### 1.2 Create the Brand

```bash
# POST /api/v1/admin/brands (or via dashboard)
{
  "tenantId": "<tenantId>",
  "name": "Restaurant Name",
  "currency": "GBP"
}
```

Note the returned `brandId`.

### 1.3 Create the Location

```bash
# POST /api/v1/admin/locations (or via dashboard)
{
  "brandId": "<brandId>",
  "name": "Restaurant Name — High Street",
  "address": "123 High Street, London, EC1A 1BB",
  "timezone": "Europe/London",
  "shopCode": "SHOP06"   # Must be unique across all locations
}
```

Note the returned `locationId`. The `shopCode` is used by the Flutter printer app.

### 1.4 Verify Location

```bash
# GET /api/v1/admin/go-live?locationId=<locationId>
# Status should be DRAFT
```

---

## Phase 2 — Marketplace Integration Setup

### 2.1 Uber Eats Integration

**Requirements:** Uber Eats Developer portal access with POS API credentials for this restaurant.

1. In the OrderHub dashboard, go to **Settings → Integrations → Add Integration → Uber Eats**
2. Enter the restaurant's `clientId` and `clientSecret` from Uber Eats Developer portal
3. Enter the `webhookSecret` (from Uber Eats webhook configuration)
4. Set status to `ACTIVE`
5. Register the webhook URL in Uber Eats Developer portal:
   ```
   https://api.orderhubsolutions.com/api/v1/webhooks/uber-eats
   ```

**Verify:**
- [ ] Integration shows `status: ACTIVE` in dashboard
- [ ] Token refresh completes (check `Integration.tokenExpiresAt` is populated)
- [ ] Send test webhook from Uber Eats sandbox — confirm order appears in OrderHub

### 2.2 Deliveroo Integration

**Requirements:** Deliveroo Partner portal credentials.

1. Dashboard → **Settings → Integrations → Add Integration → Deliveroo**
2. Enter `clientId`, `clientSecret`, `webhookSecret`
3. Set status to `ACTIVE`
4. Register webhook URL in Deliveroo Partner portal:
   ```
   https://api.orderhubsolutions.com/api/v1/webhooks/deliveroo
   ```

**Verify:**
- [ ] Integration `status: ACTIVE`
- [ ] Send test webhook from Deliveroo sandbox

### 2.3 Just Eat Integration

> **WARNING**: Just Eat integration code exists but has not been production-validated. Do NOT activate Just Eat for any new restaurant until P0-1 validation in PROVIDER_IMPLEMENTATION_PLAN.md is complete. Set status to `INACTIVE` until then.

### 2.4 HubRise Integration

> **WARNING**: HubRise integration has not been used in production. First HubRise restaurant requires sub-pilot treatment. See PROVIDER_IMPLEMENTATION_PLAN.md P0-2.

---

## Phase 3 — Printer Setup

### 3.1 Add Printer Record

Dashboard → **Settings → Printers → Add Printer**:

| Field | Value |
|---|---|
| Name | `Receipt Printer` / `Kitchen Printer` etc. |
| Connection Type | `LAN` (most common) or `EPSON_EPOS`, `STAR`, `BROWSER`, `CLOUD` |
| IP Address | Local network IP of the printer (e.g. `192.168.1.100`) |
| Port | `9100` (standard RAW port for LAN printers) |
| Supports Receipts | `true` for counter printer |
| Supports Kitchen | `true` for kitchen printer |
| Is Active | `true` |

### 3.2 Install Flutter Printer App (Android)

The Flutter Android app runs on a tablet/phone on the restaurant's local network.

1. Install the OrderHub Printer App APK on the Android device
2. Open the app and enter the **Shop Code** (e.g. `SHOP06`) — this is `Location.shopCode`
3. Enter the API base URL:
   ```
   https://api.orderhubsolutions.com
   ```
4. The app polls for pending print jobs:
   ```
   GET /api/v1/print-jobs/pending/:shopCode
   ```
5. Verify the printer appears as **ONLINE** in Dashboard → **Settings → Printers**

### 3.3 Test Print

Dashboard → **Settings → Printers → (printer) → Test Print**

- [ ] Test print receipt appears on printer
- [ ] Printer status shows `ONLINE` (heartbeat received within 60s)

---

## Phase 4 — Go-Live Wizard

### 4.1 Run the Go-Live Wizard

Dashboard → **Admin → Go-Live → (location)**

The wizard tracks location state through:
```
DRAFT → CONFIGURING → TESTING → READY_FOR_GO_LIVE → LIVE
```

**CONFIGURING checklist (wizard):**
- [ ] At least one active integration
- [ ] At least one printer configured
- [ ] Menu has at least one published category and item
- [ ] Timezone and address set

**TESTING checklist (wizard):**
- [ ] Run sandbox test orders (5 orders recommended)
- [ ] All orders appear in Orders page, KDS, Rush Hour
- [ ] Printer prints test order receipts
- [ ] Order lifecycle: accept → preparing → ready → dispatched → completed

**READY_FOR_GO_LIVE gate:**
- Wizard LIVE button is disabled until:
  - `plaintextCredentials: 0`
  - `outboxDead: 0`
  - `outboxStuckProcessing: 0`
  - At least one active integration
  - At least one printer ONLINE
  - All blockers resolved

### 4.2 Release Readiness Check

```bash
curl "https://api.orderhubsolutions.com/api/v1/health/release-readiness?tenantId=<tenantId>" \
  -H "Authorization: Bearer <admin-token>" | jq '.'
```

All gates must pass:
- `encryption.keySet: true`
- `credentialEncryption.plaintextCredentials: 0`
- `credentialEncryption.encryptedWithOldKey: 0`
- `outbox.dead: 0`
- `outbox.stuckProcessing: 0`
- `readyScore >= 90`

### 4.3 Go Live

1. Confirm with restaurant owner: agree go-live time (avoid peak hours — outside 11:30–14:00 and 17:00–21:00)
2. In the wizard, click **Go Live**
3. Location status transitions to `LIVE`
4. Watch logs for first webhook arriving from each active platform

---

## Phase 5 — First Hour Monitoring

For the first hour after go-live, monitor:

```bash
# Health (run every 2 minutes)
watch -n 120 'curl -s https://api.orderhubsolutions.com/api/v1/health/ready | jq .'

# Outbox health (run every 5 minutes)
curl "https://api.orderhubsolutions.com/api/v1/health/release-readiness?tenantId=<tenantId>" \
  -H "Authorization: Bearer <token>" | jq '.checks.outbox'
```

**First-hour gates:**
- [ ] First real order received and visible in dashboard
- [ ] First real order printed automatically
- [ ] First real order status synced back to platform (ACCEPTED within 30s of accept click)
- [ ] Outbox: `dead: 0` and `stuckProcessing: 0`
- [ ] No 5xx errors in API logs
- [ ] No `UnauthorizedException` in webhook logs (would indicate wrong webhook secret)
- [ ] Bull Board shows no failed jobs accumulating

---

## Phase 6 — Handover to Restaurant

### Staff Training Checklist

Conduct a 30–45 minute session with restaurant staff covering:

- [ ] **Receiving orders**: alert sound, order card, accept button, reject with reason
- [ ] **Status flow**: Accept → Preparing → Ready → Dispatched → Complete
- [ ] **Rush Hour mode**: bulk-accept, volume visibility
- [ ] **Kitchen Display Screen (KDS)**: ticket view, bump tickets
- [ ] **Cashier mode**: walk-in orders
- [ ] **Dispatch mode**: driver assignment, tracking
- [ ] **Printer troubleshooting**: what to do if no printout (check online status, test print)
- [ ] **Pausing orders**: how to pause/resume when kitchen is overwhelmed
- [ ] **Emergency contact**: support phone/email

### Support Handover

- [ ] Share support contact (WhatsApp group or email)
- [ ] Share `PAID_CUSTOMER_SUPPORT_RUNBOOK.md` with operations team
- [ ] Add restaurant owner to monitoring Slack channel or WhatsApp group
- [ ] Book 3-day check-in call

---

## Phase 7 — 3-Day Stability Check

After 3 trading days:

- [ ] 0 lost orders (every order that came in was printed and actioned)
- [ ] 0 unresolved P0/P1 issues
- [ ] Staff operating independently (no calls to support for routine operations)
- [ ] Printer heartbeat confirmed ONLINE consistently
- [ ] Release readiness score ≥ 90 at end of Day 3
- [ ] Decision recorded: **expand** / **hold** / **pause**

---

## Rollback: Pause a Location

If a critical issue occurs, you can pause the location without taking down the whole platform:

```bash
# Pause all integrations for a location
PATCH /api/v1/admin/locations/:locationId/pause
# { "reason": "Critical printer failure — investigating" }

# Or pause a specific provider only
PATCH /api/v1/admin/locations/:locationId/providers/:integrationId/pause
```

Restaurant staff should be notified immediately via phone/WhatsApp if ordering is paused.

---

## Rollback: Emergency Close Location

```bash
# Emergency close (stop accepting new orders)
POST /api/v1/store-ops/locations/:locationId/emergency-close
# { "reason": "Temporary closure — system maintenance" }
```

This sets the location status to closed in the platform. New orders will not arrive.

---

## Common Issues

### "Order not printing"

1. Check Dashboard → Printers — is printer ONLINE?
2. Check Dashboard → Print Jobs — is there a FAILED job?
3. On the Android tablet: is the app open and connected?
4. Verify `shopCode` in app matches `Location.shopCode` in database
5. Retry print from Dashboard → Order → Reprint

### "Order not syncing back to platform"

1. Check Bull Board (admin) — is there a failed `ORDER_SYNC` job?
2. Check API logs for provider error (401 = token expired, 429 = rate limit)
3. If 401: trigger token refresh manually via Integration settings
4. If 429: wait for rate limit window to clear (usually 60s), jobs will retry automatically

### "Webhook not arriving"

1. Verify webhook URL registered correctly in provider portal (no trailing slash, HTTPS)
2. Check API logs: `GET /api/v1/webhooks/*` events
3. If `UnauthorizedException`: webhook secret mismatch — re-register with correct secret
4. If 404: URL path is wrong

### "Wrong total / items on order"

1. Check order JSON in raw webhook event table (`webhookEvent`)
2. Verify provider menu IDs match OrderHub menu item IDs
3. Check if order platform currency matches `Brand.currency` setting

---

## See Also

- `RELEASE_CHECKLIST.md` — complete go-live checklist
- `PILOT_LAUNCH_RUNBOOK.md` — first-ever location (pilot)
- `PAID_CUSTOMER_SUPPORT_RUNBOOK.md` — post-go-live support
- `DEPLOYMENT_ARCHITECTURE.md` — system architecture
- `MONITORING_AND_ALERTS.md` — alert thresholds and escalation
