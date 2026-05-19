# Pilot Location Plan — First Live Restaurant

> Complete this plan before onboarding the pilot restaurant.
> Every section must be filled in and reviewed before go-live.

---

## Restaurant Details

| Field | Value |
|---|---|
| Tenant name | _(to be confirmed)_ |
| Brand name | _(to be confirmed)_ |
| Location name | _(to be confirmed)_ |
| Location address | _(to be confirmed)_ |
| Location timezone | `Europe/London` _(to be confirmed)_ |
| shopCode | _(to be assigned, e.g. `PILOT01`)_ |

---

## Contact Person

| Field | Value |
|---|---|
| Primary contact | _(name)_ |
| Role | Owner / Manager |
| Phone | _(number)_ |
| Email | _(email)_ |
| WhatsApp | _(optional)_ |
| Best time to call | _(e.g. before 11:00 or after 15:00)_ |
| On-call during launch | Yes / No |

---

## Go-Live Schedule

| Field | Value |
|---|---|
| Proposed go-live date | _(YYYY-MM-DD)_ |
| Proposed go-live time | _(e.g. 09:00 before opening)_ |
| Operating hours | _(e.g. Mon–Sat 11:00–22:00)_ |
| Quiet periods for testing | _(e.g. Mon–Wed before 12:00)_ |
| Peak hours to avoid | _(e.g. Fri–Sat 18:00–21:00)_ |
| Avoid go-live on | _(e.g. bank holidays, events)_ |

---

## Providers to Connect

| Provider | Status | Notes |
|---|---|---|
| Uber Eats | ☐ Not started / ☐ In progress / ☐ Connected | |
| Deliveroo | ☐ Not started / ☐ In progress / ☐ Connected | |
| Just Eat | ☐ Not started / ☐ In progress / ☐ Connected | |
| HubRise | ☐ Not started / ☐ In progress / ☐ Connected | |
| Manual/POS | ☐ Not started / ☐ In progress / ☐ Connected | |

---

## Printer Setup

| Field | Value |
|---|---|
| Printer manufacturer | _(e.g. Epson, Star)_ |
| Printer model | _(e.g. TM-T88VI, TSP654II)_ |
| Connection type | LAN / ePOS / USB / Cloud |
| IP address | _(e.g. 192.168.1.100)_ |
| Port | _(e.g. 9100)_ |
| Paper width | 58mm / 80mm |
| Supports receipts | Yes / No |
| Supports kitchen tickets | Yes / No |
| Supports labels | Yes / No |
| Flutter Android tablet model | _(e.g. Samsung Tab A8)_ |
| shopCode in Flutter app | _(to be confirmed, must match Location.shopCode)_ |

---

## Staff Users to Create

| Name | Role | Email |
|---|---|---|
| _(owner name)_ | TENANT_OWNER | _(email)_ |
| _(manager name)_ | MANAGER | _(optional)_ |
| _(staff name)_ | STAFF | _(optional)_ |

---

## Menu

| Field | Value |
|---|---|
| Menu imported from | _(provider / manual / CSV)_ |
| Number of categories | _(approx)_ |
| Number of items | _(approx)_ |
| Has modifiers | Yes / No |
| Currency | GBP / EUR / _(other)_ |
| Price format | Pence / Cents / Decimal |
| Menu reviewed | Yes / No |

---

## Known Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Internet outage at restaurant | Medium | Restaurant has mobile hotspot backup |
| Printer goes offline | Medium | Staff trained to reprint manually |
| Provider webhook delay | Low | Outbox retries, monitored |
| Staff not familiar with KDS | Medium | Training session before go-live |
| Order not matching menu items | Low | Menu verified in test order |
| Provider credentials expire | Low | Token refresh tested before go-live |
| _(add restaurant-specific risks here)_ | | |

---

## Rollback / Pause Plan

If something goes wrong during the pilot:

### Immediate pause (< 2 minutes)

1. Go-Live Wizard (`/dashboard/admin/go-live`) → location → **PAUSED**
2. Or via API (MANAGER+ role):
   ```bash
   curl -X POST "https://api.orderhub.io/api/v1/onboarding/locations/<id>/transition?tenantId=<tid>" \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"targetStatus": "PAUSED", "reason": "Pilot issue — investigating"}'
   ```
3. Notify restaurant contact: _(name and phone number here)_

### Disable one provider

```bash
curl -X POST "https://api.orderhub.io/api/v1/onboarding/locations/<loc>/providers/<int>/pause?tenantId=<tid>" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Uber Eats sync issue"}'
```

### Disable printer (prevent duplicate prints)

```bash
curl -X POST "https://api.orderhub.io/api/v1/onboarding/locations/<loc>/printers/<pid>/pause?tenantId=<tid>" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Printer duplicate issue — pausing until fix deployed"}'
```

### Full rollback

See `DEPLOYMENT_RUNBOOK.md § Rollback`.

---

## Pre-Go-Live Sign-Off

All of the following must be confirmed before the location is marked LIVE:

- [ ] All sections of this plan are filled in
- [ ] Release readiness score ≥ 90
- [ ] No critical blockers in go-live wizard
- [ ] Smoke test passes (exit code 0)
- [ ] Test order completed successfully
- [ ] Test print completed successfully
- [ ] Staff training completed (see `PILOT_STAFF_TRAINING.md`)
- [ ] Restaurant contact has support number/contact
- [ ] On-call engineer confirmed available
- [ ] Emergency pause tested or confirmed working
- [ ] Go-live time agreed (not during peak hours)
- [ ] Operations manager sign-off: _(name, date)_
