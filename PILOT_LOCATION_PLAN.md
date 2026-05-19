# Pilot Location Plan — First Live Restaurant

> Completed: 2026-05-19
> Status: GO-LIVE APPROVED — location marked LIVE at 09:15 UTC on 2026-05-19

---

## Restaurant Details

| Field | Value |
|---|---|
| Tenant name | Spice Garden Ltd |
| Brand name | Spice Garden |
| Location name | Spice Garden — Bethnal Green |
| Location address | 47 Roman Road, Bethnal Green, London E2 0HU |
| Location timezone | `Europe/London` |
| shopCode | `SPGRD01` |

---

## Contact Person

| Field | Value |
|---|---|
| Primary contact | Arjun Mehta |
| Role | Owner |
| Phone | +44 7911 234567 |
| Email | arjun@spicegarden.co.uk |
| WhatsApp | +44 7911 234567 |
| Best time to call | Before 11:00 or after 15:00 |
| On-call during launch | Yes |

Secondary contact:

| Field | Value |
|---|---|
| Secondary contact | Priya Mehta |
| Role | Manager |
| Phone | +44 7922 345678 |
| Email | priya@spicegarden.co.uk |
| On-call during launch | Yes |

---

## Go-Live Schedule

| Field | Value |
|---|---|
| Proposed go-live date | 2026-05-19 |
| Proposed go-live time | 09:15 UTC (before 10:00 opening) |
| Operating hours | Mon–Sun 11:00–22:30 BST |
| Quiet periods for testing | Mon–Wed 11:00–13:00 |
| Peak hours to avoid | Fri–Sat 17:30–21:00 |
| Avoid go-live on | Bank holidays |
| Actual go-live time | 09:15 UTC 2026-05-19 ✓ |

---

## Providers to Connect

| Provider | Status | Notes |
|---|---|---|
| Uber Eats | ✓ Connected | clientId, clientSecret, webhookSecret all set. Webhook received 2026-05-18. Token refresh confirmed. |
| Deliveroo | ✓ Connected | clientId, clientSecret, webhookSecret set. Test webhook received 2026-05-18. |
| Just Eat | ☐ Not started | Not in scope for pilot phase. Restaurant not currently on Just Eat. |
| HubRise | ☐ Not started | Not in scope for pilot phase. May add in Phase O. |
| Manual/POS | ☐ Not started | Not in scope. |

---

## Printer Setup

| Field | Value |
|---|---|
| Printer manufacturer | Epson |
| Printer model | TM-T88VI |
| Connection type | LAN |
| IP address | 192.168.1.201 |
| Port | 9100 |
| Paper width | 80mm |
| Supports receipts | Yes |
| Supports kitchen tickets | Yes |
| Supports labels | No |
| Flutter Android tablet model | Samsung Galaxy Tab A8 |
| shopCode in Flutter app | `SPGRD01` (confirmed matches Location.shopCode) |
| Printer heartbeat | ONLINE (confirmed 2026-05-18) |
| Test print completed | Yes — 2026-05-18 16:45 UTC |

---

## Staff Users to Create

| Name | Role | Email | Created |
|---|---|---|---|
| Arjun Mehta | TENANT_OWNER | arjun@spicegarden.co.uk | ✓ 2026-05-17 |
| Priya Mehta | MANAGER | priya@spicegarden.co.uk | ✓ 2026-05-17 |
| Kitchen Staff (shared login) | STAFF | kitchen@spicegarden.co.uk | ✓ 2026-05-18 |

---

## Menu

| Field | Value |
|---|---|
| Menu imported from | Manual — entered by Arjun Mehta via dashboard |
| Number of categories | 8 (Starters, Mains, Breads, Rice, Sides, Drinks, Desserts, Specials) |
| Number of items | 47 |
| Has modifiers | Yes — spice level (Mild, Medium, Hot, Extra Hot) on main dishes |
| Currency | GBP |
| Price format | Pence (e.g. 1295 = £12.95) |
| Menu reviewed | Yes — reviewed by Arjun Mehta 2026-05-18 |
| Menu matches Uber Eats portal | Confirmed 2026-05-18 |
| Menu matches Deliveroo portal | Confirmed 2026-05-18 |

---

## Known Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Internet outage at restaurant | Medium | Restaurant has EE 4G mobile hotspot as backup |
| Printer goes offline | Medium | Staff trained to reprint; Flutter app retries; heartbeat monitor in place |
| Provider webhook delay | Low | Outbox retries, Bull queues, monitored via Bull Board |
| Staff not familiar with KDS | Low | Training session completed 2026-05-18 |
| Order not matching menu items | Low | Menu verified in test order 2026-05-18 |
| Provider credentials expire | Low | Token refresh tested for Uber Eats 2026-05-18; Deliveroo uses long-lived keys |
| Uber Eats store pause required | Medium | Provider tablet available; staff briefed to use Uber Eats partner app if OrderHub pause insufficient |
| Deliveroo store pause required | Medium | Deliveroo partner portal accessible; staff have login credentials |
| Duplicate orders during peak | Low | Idempotency keys implemented; tested with concurrent test orders |

---

## Rollback / Pause Plan

If something goes wrong during the pilot:

### Immediate pause (< 2 minutes)

1. Go-Live Wizard (`/dashboard/admin/go-live`) → location → **PAUSED**
2. Or via API (MANAGER+ role):
   ```bash
   curl -X POST "https://api.orderhub.io/api/v1/onboarding/locations/LOC_SPGRD01/transition?tenantId=TENANT_SPGRD" \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"targetStatus": "PAUSED", "reason": "Pilot issue — investigating"}'
   ```
3. Notify restaurant contact: Arjun Mehta +44 7911 234567

### Disable one provider

```bash
# Pause Uber Eats integration
curl -X POST "https://api.orderhub.io/api/v1/onboarding/locations/LOC_SPGRD01/providers/INT_UBEREATS/pause?tenantId=TENANT_SPGRD" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Uber Eats sync issue — investigating"}'

# Pause Deliveroo integration
curl -X POST "https://api.orderhub.io/api/v1/onboarding/locations/LOC_SPGRD01/providers/INT_DELIVEROO/pause?tenantId=TENANT_SPGRD" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Deliveroo sync issue — investigating"}'
```

### Disable printer (prevent duplicate prints)

```bash
curl -X POST "https://api.orderhub.io/api/v1/onboarding/locations/LOC_SPGRD01/printers/PRN_EPSON01/pause?tenantId=TENANT_SPGRD" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Printer duplicate issue — pausing until fix deployed"}'
```

### Also pause in provider portals (manual step)

- **Uber Eats**: Open Uber Eats Restaurant Manager → pause store
- **Deliveroo**: Open Deliveroo partner portal → set store to closed

### Full rollback

See `DEPLOYMENT_RUNBOOK.md § Rollback`.

---

## Pre-Go-Live Sign-Off

All of the following confirmed before the location was marked LIVE:

- [x] All sections of this plan are filled in — 2026-05-18
- [x] Release readiness score ≥ 90 — score: 95 — 2026-05-19 09:00 UTC
- [x] No critical blockers in go-live wizard — 2026-05-19 09:00 UTC
- [x] Smoke test passes (exit code 0) — 16/16 checks — 2026-05-19 08:47 UTC
- [x] Test order completed successfully — 2026-05-18 17:10 UTC
- [x] Test print completed successfully — 2026-05-18 16:45 UTC
- [x] Staff training completed (see `PILOT_STAFF_TRAINING.md`) — 2026-05-18
- [x] Restaurant contact has support number/contact — Arjun Mehta +44 7911 234567
- [x] On-call engineer confirmed available — Omid Mohammadizadeh (OrderHub engineering)
- [x] Emergency pause tested or confirmed working — tested 2026-05-18 via staging
- [x] Go-live time agreed (not during peak hours) — 09:15 UTC agreed with restaurant
- [x] Operations manager sign-off: Omid Mohammadizadeh, 2026-05-19 09:10 UTC
