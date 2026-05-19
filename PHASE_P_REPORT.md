# Phase P Report — Controlled Rollout to 3–5 Restaurants

> Phase: P — Controlled Rollout
> Start date: 2026-05-19
> Status: In progress
> Author: Engineering / Operations

---

## Overview

Phase P begins the controlled expansion from the single pilot restaurant (Spice Garden) to 3–5 restaurants. The goal is to prove the system works across real restaurants with different menus, printers, staff teams, and provider setups — without mass rollout.

Phase O was completed successfully:
- Spice Garden 3-day pilot: 47 orders, 0 lost, 0 unresolved P0/P1
- Retry-After handling fixed: provider Retry-After header now drives actual Bull retry delay
- Printer stale heartbeat detection added
- Staff health panel added and tenant-isolated
- 189 tests passing before Phase P begins

---

## Shops Selected for Phase P

| # | Shop | Location | Provider(s) | Risk | Planned Go-Live |
|---|---|---|---|---|---|
| 1 | Spice Garden | Bethnal Green, E1 | Uber Eats, Deliveroo | Low (✅ LIVE) | 2026-05-16 (complete) |
| 2 | The Curry Leaf | Whitechapel, E1 | Uber Eats, Deliveroo | Low | 2026-05-27 |
| 3 | Naan & Co | Shoreditch, EC2A | Deliveroo only | Low-Medium | 2026-06-03 |
| 4 | Peri Palace | Hackney, E8 | Uber Eats | Medium | After shops 2+3 stable |
| 5 | TBD | London | TBD | TBD | After shops 2+3+4 stable |

All selected restaurants are:
- Single-location
- Referred by existing pilot customer or known inbound enquiry
- Using Epson or Star LAN printers
- Simple menus (< 60 items)
- Owner/manager available for training and first trading day

---

## Rollout Schedule

| Date | Action |
|---|---|
| 2026-05-19 | Phase P begins. Phase O correction committed. 218 tests passing. |
| 2026-05-22 | Shop 2 (Curry Leaf) pre-onboarding — credentials, webhook setup |
| 2026-05-25 | Shop 2 staff training |
| 2026-05-27 | Shop 2 go-live (08:00–10:00 BST) — if readiness score ≥ 90 |
| 2026-05-27 → 2026-06-02 | Shop 2 stability window (5 working days) |
| 2026-05-31 | Shop 3 (Naan & Co) staff training |
| 2026-06-03 | Shop 3 go-live — if Shop 2 has 0 P0/P1 over 5 working days |
| 2026-06-03 → 2026-06-11 | Shops 2+3 stability window before Shop 4 |
| TBD | Shop 4 (Peri Palace) go-live — after shops 2+3 stable |
| TBD | Shop 5 — after shops 2+3+4 stable |

---

## Per-Shop Go-Live Results

### Shop 1 — Spice Garden (Pilot — Phase N/O)

| Metric | Value |
|---|---|
| Go-live date | 2026-05-16 |
| Orders in first 3 days | 47 |
| Lost orders | 0 |
| Print failures | 0 (after cable fix) |
| Provider 429 events | ~3 (handled by Bull retry) |
| P0 issues | 0 |
| P1 issues | 0 |
| P2 issues | 3 (all resolved — see ROLLOUT_ISSUES.md) |
| Staff independence | ✅ Manager self-serves health panel |
| Result | ✅ Stable — cleared for Phase P expansion |

### Shop 2 — The Curry Leaf (Planned 2026-05-27)

*To be completed after go-live.*

| Metric | Value |
|---|---|
| Go-live date | TBC (target 2026-05-27) |
| Readiness score at go-live | TBC |
| Orders processed | TBC |
| Print failures | TBC |
| P0 issues | TBC |
| P1 issues | TBC |
| Staff independence | TBC |

### Shop 3 — Naan & Co (Planned 2026-06-03)

*To be completed after go-live.*

### Shop 4 — Peri Palace (Planned — depends on shops 2+3 stability)

*To be completed after go-live.*

### Shop 5 — TBD

*To be completed after go-live.*

---

## Provider Validation Summary (as of Phase P start)

### Uber Eats

| Check | Status |
|---|---|
| Credentials decrypt | ✅ |
| Webhook receipt and signature | ✅ |
| Order injection | ✅ |
| Accept/reject | ✅ |
| Status sync | ✅ |
| Token refresh | ✅ |
| Rate-limit handling (429) | ✅ Retry-After parsed and used to drive Bull retry delay (Phase O + correction) |
| Store availability API | ❌ Not implemented (requires POS Partner status) |
| Menu sync to Uber | ❌ Not implemented |

### Deliveroo

| Check | Status |
|---|---|
| Credentials decrypt | ✅ |
| Webhook receipt | ✅ |
| Real payload mapping | ✅ |
| Accept/reject | ✅ |
| Rate-limit (429) | ✅ Caught and retried via Bull; no Retry-After header from Deliveroo |
| Store open/close | ❌ Requires POS Partner approval (pending) |
| Menu publish | ❌ Not implemented via Deliveroo direct API |

### Just Eat

| Check | Status |
|---|---|
| Integration status | ⚠️ Not live-approved. Webhook adapter exists but not tested in production |
| Store availability | ❌ Not implemented |
| Item availability | ❌ Not implemented |
| Due date | ✅ Uses now + 30 min (not configurable) |

**Important:** Do not claim Just Eat is live/supported until production webhook validation is complete with Just Eat API team.

### HubRise

| Check | Status |
|---|---|
| Location mapping | ✅ |
| Order sync | ✅ |
| Status sync | ✅ |
| Menu import from HubRise | ❌ Not implemented |
| Menu publish to HubRise | ❌ Not implemented |

### Website / POS / Manual

| Check | Status |
|---|---|
| Manual order creation | ✅ |
| Printer job generation | ✅ |
| KDS visibility | ✅ |
| Cashier/Dispatch | ✅ (paymentMethod not persisted — see KNOWN_LIMITATIONS.md) |

---

## Printer Validation Summary

### Epson TM-T88VI (LAN) — Shops 1, 2

| Check | Status |
|---|---|
| Print format correct | ✅ |
| Heartbeat ONLINE | ✅ |
| Stale heartbeat detection (> 90s) | ✅ (Phase O) |
| Failed job retry | ✅ |
| No duplicate print after worker restart | ✅ (outbox idempotency) |
| Flutter app shopCode isolation | ✅ (Phase P test added) |
| Daily pre-shift check included in training | ✅ |

### Star TSP654II (LAN) — Shop 3 (first production use)

| Check | Status |
|---|---|
| Print format verified | ⬜ Pending (Shop 3 pre-go-live) |
| Heartbeat ONLINE | ⬜ Pending |
| Stale heartbeat detection | ✅ (generic — same as Epson) |
| Flutter app shopCode isolation | ✅ (generic — tested) |

---

## Technical Work Completed in Phase P

### 1. Admin Rollout Overview Endpoint (NEW)

`GET /api/v1/admin/rollout/overview` — PLATFORM_ADMIN only.

Returns all locations in LIVE/PAUSED/READY_FOR_GO_LIVE/TESTING states with:
- goLiveStatus, printerStatus, lastHeartbeatAt
- providerStatuses (connected/disconnected/error — no credentials)
- lastOrderAt, lastPrintAt, failedPrintJobsLastHour, deadOutboxEvents
- paused flag

Zero credentials, tokens, or secrets exposed.

### 2. Cross-Location Isolation Tests (NEW)

Added:
- `admin/tests/rollout-overview.spec.ts` (11 tests): rollout overview returns no credentials, correct provider statuses, correct printer status, stale heartbeat detection, paused flag
- `printers/tests/shopcode-isolation.spec.ts` (6 tests): Flutter shopCode endpoint only returns jobs for matched location; unknown/empty shopCode returns []; no tenantId/credentials in response

### 3. Retry-After Backoff Fix (Phase O correction, committed 2026-05-19)

- `backoff-strategies.ts`: `rateLimitAwareBackoff` reads `RATE_LIMITED:<ms>` and returns exact delay
- `worker.module.ts`: strategy registered on ORDER_SYNC queue
- `outbox-dispatcher.cron.ts`: STATUS_CHANGE jobs now use `rate-limit-aware` backoff type
- 11 unit tests added

---

## Cross-Location Isolation Verification

| Isolation check | Status |
|---|---|
| Staff from Shop A cannot see Shop B orders | ✅ `tenantId` from JWT in all order queries |
| Staff from Shop A cannot see Shop B printer status | ✅ StaffHealthController queries by `tenantId` from JWT |
| Staff from Shop A cannot access Shop B health endpoint | ✅ NotFoundException thrown if location not in tenant (tested) |
| Provider credentials are never shared across locations | ✅ Integration always scoped by `locationId` + `tenantId` |
| Printer shopCode maps only to correct location | ✅ Tested in `shopcode-isolation.spec.ts` |
| Webhook maps to correct location | ✅ Each webhook adapter resolves `locationId` from provider payload |
| Go-live wizard admin override is PLATFORM_ADMIN only | ✅ `@Roles("PLATFORM_ADMIN")` on admin override endpoint |
| Emergency pause affects only selected location | ✅ Location transition API requires `locationId` + `tenantId` |
| Rollout overview is PLATFORM_ADMIN only | ✅ `@Roles("PLATFORM_ADMIN")` on rollout overview endpoint |

---

## Issues Found in Phase P

See `ROLLOUT_ISSUES.md` for full issue log.

Issues inherited from Phase N/O: P-001 (Uber Eats 429, resolved), P-002 (printer cable, resolved), P-003 (paper jam detection, mitigated).

Phase P issues: *None yet — rollout begins 2026-05-27.*

---

## Remaining Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Shop 2 or 3 encounters P0 issue | Low | Emergency pause via wizard; on-call engineer available |
| Star printer (Shop 3) format issues | Medium | Format verification call before go-live |
| Deliveroo POS Partner approval delayed | Low | Shops 2–4 can operate on Uber Eats alone |
| Just Eat integration assumed working | Medium | Not going live on Just Eat until production-validated |
| High order volume at Shop 4 overwhelming rate limits | Low-Medium | Monitor 429 events; cap at 80 orders/day before scaling |
| Staff turnover between training and go-live | Low | Keep training materials posted near tablet; support on call |

---

## Phase P Success Criteria

Phase P is successful only if, across shops 2–5:

- [ ] 0 lost orders
- [ ] 0 unresolved P0 issues
- [ ] 0 unresolved P1 issues
- [ ] No cross-location data leakage
- [ ] No credential exposure
- [ ] No uncontrolled duplicate printing
- [ ] Printer reliability acceptable at each shop
- [ ] Staff can operate without developer help after training
- [ ] Emergency controls verified at each shop
- [ ] Provider limitations documented per shop
- [ ] Outbox has no unresolved dead events
- [ ] Health panel useful to staff managers
- [ ] Each shop completes ≥ 1 stable trading session
- [ ] At least 3 shops complete 3 stable trading days before wider rollout

---

## Decision: Hold / Continue / Wider Rollout

*Decision to be made after shops 2 and 3 complete 3-day stability window.*

Criteria for moving to Phase Q (wider rollout, 6–20 shops):
- All 3+ shops stable for ≥ 2 weeks each, 0 P0/P1
- Staff from all shops operating independently
- Support load manageable (< 1 call per shop per week)
- No systemic issues (outbox, printer, provider) unresolved
- Operations manager sign-off
