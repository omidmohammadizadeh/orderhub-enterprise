# Controlled Rollout Plan — Shops 2–5

> Created: 2026-05-22
> Status: Ready to begin — Spice Garden (Shop 1) is stable after 3-day pilot

---

## Overview

This plan governs expanding from 1 pilot restaurant to 3–5 restaurants. Each shop must meet the selection criteria and complete the full go-live checklist before going live. No more than 1 new shop per day. Do not onboard any shop during peak trading hours.

The goal is controlled, safe expansion — not speed.

---

## Selection Criteria for Next 3–5 Shops

A shop is eligible for the controlled rollout if it meets ALL of the following:

### Must Have

- [ ] Single location (multi-location brands deferred until 5+ shops are stable)
- [ ] Friendly owner or manager who will actively participate in training and setup
- [ ] Stable internet (broadband or fibre preferred; mobile hotspot backup available)
- [ ] Simple, proven printer setup (LAN Epson or Star preferred — same as pilot)
- [ ] Existing Uber Eats or Deliveroo account already active and configured
- [ ] Clean menu (all items have prices; modifiers defined; currency confirmed GBP)
- [ ] Staff available for 1-hour training session before go-live
- [ ] Owner or manager reachable during first 2 hours of trading after go-live

### Preferred (not required but weighted in selection)

- Restaurant recommended by existing pilot customer (Arjun Mehta referral list)
- Kitchen volume ≤ 50 orders/day initially (avoid very high-volume shops until 5-shop stability confirmed)
- Timezone: Europe/London (expansion to other timezones deferred)
- Fewer than 3 active providers initially (add more providers post-onboarding)
- No major events (festivals, bank holidays) in first week of trading

### Exclusion Criteria

- Multi-location chains (deferred to Phase P)
- Restaurants requiring HubRise or custom POS integration (deferred)
- Restaurants already in dispute with Uber Eats or Deliveroo
- Restaurants with unstable internet (staff on mobile only, no fixed broadband)
- Restaurants going live on a Friday or Saturday in first month

---

## Recommended Rollout Order

| Shop # | Name | Type | Notes |
|---|---|---|---|
| 1 | Spice Garden — Bethnal Green | Indian | ✓ LIVE (pilot) |
| 2 | TBD — Arjun referral 1 | TBD | Schedule week of 2026-05-25 |
| 3 | TBD — Arjun referral 2 | TBD | Schedule week of 2026-06-01 |
| 4 | TBD — inbound enquiry | TBD | After shops 2+3 stable |
| 5 | TBD | TBD | After shops 2+3+4 stable (≥ 1 week each) |

**Rule:** Do not onboard shop N+1 until shop N has traded for at least 5 working days with 0 P0/P1 issues.

---

## Maximum Onboarding Rate

| Rule | Value |
|---|---|
| Max new shops per day | 1 |
| Max new shops per week | 2 |
| Required stability window before next shop | 5 working days trading, 0 P0/P1 |
| Go-live window | 08:00–10:00 BST (before peak hours) |
| Do not go-live during | Fri/Sat 17:00–22:00, Bank holidays |

---

## Pre-Onboarding Checklist (per shop)

Complete at least 3 days before go-live:

### Restaurant Selection

- [ ] Selection criteria met (see above)
- [ ] Owner/manager briefed on pilot programme
- [ ] Support expectations set: first 2 weeks intensive; then self-serve via dashboard
- [ ] `PILOT_LOCATION_PLAN.md` template filled in for this shop

### Technical Pre-checks

- [ ] Printer model confirmed (Epson/Star LAN or EPSON_EPOS)
- [ ] Printer IP address known and reachable from restaurant network
- [ ] Uber Eats / Deliveroo credentials obtained from owner
- [ ] Webhook URLs confirmed for each provider
- [ ] `shopCode` assigned (e.g. `SHOP02`, `SHOP03`)
- [ ] Flutter Android tablet model confirmed
- [ ] Internet provider confirmed; backup confirmed if needed

### Menu Pre-checks

- [ ] Menu exported from provider portal (CSV or manual entry)
- [ ] All items have prices in pence
- [ ] Modifiers reviewed for accuracy
- [ ] Owner has signed off on menu content

---

## Provider Checklist (per shop, per provider)

For each enabled provider:

- [ ] `clientId`, `clientSecret`, `webhookSecret` obtained
- [ ] Integration created in OrderHub dashboard
- [ ] Credentials encrypted (`plaintextCredentials: 0`)
- [ ] Test webhook received and signature verified
- [ ] Token refresh tested (if OAuth provider)
- [ ] Integration status = ACTIVE

---

## Printer Checklist (per shop)

- [ ] Printer configured in OrderHub (correct model, IP, port)
- [ ] `supportsReceipts`, `supportsKitchen`, `supportsLabels` set correctly
- [ ] `isActive: true`
- [ ] Physical cable check done (Ethernet fully seated)
- [ ] Printer heartbeat ONLINE (confirmed via diagnostics or health endpoint)
- [ ] Test print sent and confirmed
- [ ] Paper loaded (80mm roll confirmed)
- [ ] Flutter app installed and `shopCode` set correctly
- [ ] Flutter app polling confirmed (print job updated to PRINTED)

---

## Staff Training Checklist (per shop)

Complete 1–2 days before go-live:

- [ ] 1-hour training session completed with owner/manager
- [ ] Kitchen staff trained on KDS (bump, colour coding)
- [ ] Staff trained on accepting/rejecting orders
- [ ] Staff trained on Cashier/Dispatch screens
- [ ] Staff trained on reprinting
- [ ] Staff trained on **printer pre-shift check** (see below)
- [ ] `PILOT_STAFF_TRAINING.md` printed and posted near tablet
- [ ] Staff health panel shown to manager: `GET /v1/health/staff-status?locationId=X`
- [ ] Emergency contact list printed and posted
- [ ] Support number confirmed with owner

### Printer Pre-Shift Check (must be completed every trading day before opening)

Every day before opening, staff should:

1. Check printer power light is green
2. Check Ethernet cable is firmly connected at both ends
3. Check paper is loaded and not near end
4. Go to OrderHub diagnostics page → confirm printer status is ONLINE
5. Send a test print → confirm it prints
6. If test print fails → follow the printer troubleshooting checklist in `PILOT_STAFF_TRAINING.md`

---

## Monitoring Checklist (per shop, first 2 weeks)

### First trading day: developer on-call for first 2 hours

- [ ] Monitor logs for 5xx errors
- [ ] Confirm first real order received and printed
- [ ] Confirm first order status synced to provider
- [ ] Confirm Bull Board has no accumulating failures
- [ ] `outboxDead: 0` confirmed after first order

### Days 2–5: check daily (15 minutes each)

- [ ] Review `GET /api/v1/health/release-readiness?tenantId=X` — score ≥ 85
- [ ] Check `outboxDead`, `outboxStuck` are 0
- [ ] Review `PILOT_ISSUES.md` for any P2s
- [ ] Confirm printer heartbeat ONLINE in diagnostics

### Days 6–14: handoff to restaurant

- [ ] Restaurant manager can check health panel themselves
- [ ] On-call engineer reduced to weekly check-in
- [ ] Any P2 issues logged and assigned

---

## Rollback / Pause Procedure (per shop)

Identical to Phase N procedure for Spice Garden. See `PILOT_LAUNCH_RUNBOOK.md` for full commands.

Quick reference:

```bash
# Pause location (stop all orders)
curl -X POST "https://api.orderhub.io/api/v1/onboarding/locations/<lid>/transition?tenantId=<tid>" \
  -H "Authorization: Bearer <token>" \
  -d '{"targetStatus": "PAUSED", "reason": "<reason>"}'

# Pause one provider
curl -X POST "https://api.orderhub.io/api/v1/onboarding/locations/<lid>/providers/<iid>/pause?tenantId=<tid>" \
  -H "Authorization: Bearer <token>" \
  -d '{"reason": "<reason>"}'

# Pause printer
curl -X POST "https://api.orderhub.io/api/v1/onboarding/locations/<lid>/printers/<pid>/pause?tenantId=<tid>" \
  -H "Authorization: Bearer <token>" \
  -d '{"reason": "<reason>"}'
```

---

## Support Coverage During Rollout

| Period | Coverage |
|---|---|
| Go-live day | On-call engineer monitoring for 2 hours |
| Days 2–5 | On-call engineer daily check-in (15 min) |
| Days 6–14 | Weekly check-in; restaurant manager self-serves health panel |
| Day 15+ | Standard support SLA; escalation via email |

Ensure on-call engineer is NOT going on holiday within 2 weeks of a new shop going live.

---

## Go/No-Go Decision Before Each New Shop

Before marking any shop LIVE, confirm:

- [ ] All previous shops in the rollout have 0 unresolved P0/P1 issues
- [ ] Current shop: release readiness score ≥ 90
- [ ] Current shop: 0 blockers in go-live wizard
- [ ] Current shop: smoke test passes (16/16 checks)
- [ ] Current shop: test order and test print completed
- [ ] Current shop: staff training completed
- [ ] Current shop: on-call engineer available
- [ ] Go-live time: 08:00–10:00 BST, not Friday/Saturday, not bank holiday

---

## Phase P Trigger Criteria

Move to Phase P (wider rollout, 6–20 shops) when:

- [ ] At least 3 shops have traded successfully for ≥ 2 weeks with 0 P0/P1 issues
- [ ] Staff from all pilot shops operating independently
- [ ] No unresolved systemic issues (outbox reliability, printer, provider rate limits)
- [ ] Support load is manageable (< 1 support call per shop per week)
- [ ] Decision confirmed by operations manager
