# Rollout Issues — Phase P

> Issue tracker for all incidents across rollout shops 1–5.
> Updated in real-time during rollout period.

---

## Severity Definitions

| Severity | Definition | Response |
|---|---|---|
| **P0** | Orders lost, data leaked, system down, credentials exposed | Pause affected shop immediately. All hands. Fix before any next-shop onboarding. |
| **P1** | Orders failing to print, provider sync broken, staff cannot operate | Fix or mitigate before next trading session. No new shop onboarding until resolved. |
| **P2** | Degraded (delays, retries, minor UX issues) — no orders lost | Owner assigned, fix within 48 hours |
| **P3** | Cosmetic, low-impact, nice-to-have | Batch into next sprint |

---

## Active Issues

*No active P0/P1 issues as of 2026-06-13 (Phase Q complete).*

Issue Q-005 (P3): Shop 5 staff requested Orders page auto-refresh — deferred to Phase R.
Issue Q-003 (P3): Shop 2 KDS colour confusion — deferred to Phase R.

---

## Phase P Issue Log

### Issue P-001

| Field | Value |
|---|---|
| **Issue ID** | P-001 |
| **Shop** | Spice Garden (Shop 1) |
| **Provider** | Uber Eats |
| **Severity** | P2 |
| **Description** | Uber Eats returns 429 rate-limit during lunch peak when 3+ orders accepted in < 45 seconds. Status sync delayed. |
| **Impact** | Status sync delayed by 12–30 seconds during peak. No orders lost. |
| **Root cause** | Uber Eats rate limits concurrent status calls. Retry-After header returned. |
| **Fix/mitigation** | Phase O: `parseRetryAfterMs()` added to all sync clients. Phase O correction: `rateLimitAwareBackoff` registered on ORDER_SYNC Bull queue; STATUS_CHANGE jobs now use `rate-limit-aware` backoff type, so Retry-After header actually drives retry delay. |
| **Status** | ✅ Resolved (Phase O + Phase O correction) |
| **Owner** | Engineering |
| **Resolved date** | 2026-05-19 |
| **Follow-up** | Monitor Uber Eats 429 events in Phase P shops during peak. Alert if > 5/hour. |

---

### Issue P-002

| Field | Value |
|---|---|
| **Issue ID** | P-002 |
| **Shop** | Spice Garden (Shop 1) |
| **Provider** | N/A |
| **Severity** | P2 |
| **Description** | Printer Ethernet cable not fully seated at initial go-live. Caused 4-minute print queue backlog during first trading hour. |
| **Impact** | 4 minutes of delayed printing. No orders lost. |
| **Root cause** | Physical setup issue — cable not fully inserted at printer end. |
| **Fix/mitigation** | Phase N: On-site cable check added to pre-go-live runbook. Phase O: Daily printer pre-shift check added to `PILOT_STAFF_TRAINING.md` and `CONTROLLED_ROLLOUT_PLAN.md`. |
| **Status** | ✅ Resolved (process improvement) |
| **Owner** | Operations |
| **Resolved date** | 2026-05-16 |
| **Follow-up** | Add physical cable check to rollout on-site checklist for all new shops. |

---

### Issue P-003

| Field | Value |
|---|---|
| **Issue ID** | P-003 |
| **Shop** | Spice Garden (Shop 1) |
| **Provider** | N/A |
| **Severity** | P3 |
| **Description** | Paper jam detected after printer went offline. Root cause could not be determined remotely — offline is detectable, but jam vs. cable vs. power is not. |
| **Impact** | Staff needed to physically inspect printer. Detected via stale heartbeat (> 90s) in Phase O. |
| **Root cause** | Paper jam — not electronically detectable. Printer goes offline (detectable via heartbeat stale check). Root cause requires physical inspection. |
| **Fix/mitigation** | Phase O: `lastHeartbeatAt` written to `Printer.metadata` on every 30s probe. Stale heartbeat (> 90s) now shows as offline in staff health panel and readiness engine. Staff training updated with printer troubleshooting steps. |
| **Status** | ✅ Mitigated (detection improved; full remote diagnosis not possible) |
| **Owner** | Engineering |
| **Resolved date** | 2026-05-18 |
| **Follow-up** | See KNOWN_LIMITATIONS.md: "Paper jam is not electronically detectable". |

---

---

## Phase Q Issues

### Issue Q-001

| Field | Value |
|---|---|
| **Issue ID** | Q-001 |
| **Shop** | Naan & Co (Shop 3) |
| **Provider** | N/A |
| **Severity** | P1 |
| **Description** | Star TSP654II printed item names truncated at 32 characters. Epson formatter character width constant was used for Star printer. |
| **Impact** | 3 failed print jobs on go-live day (Day 1). Items with long names showed as truncated, causing staff confusion. No orders lost — staff re-typed orders manually for first 2 hours. |
| **Root cause** | `escpos.formatter.ts` used a single character-width constant (42 chars) without distinguishing printer type. Star TSP654II has 32-char default column width at standard font size. |
| **Fix/mitigation** | Added printer-type-aware character width in `formatters/escpos.formatter.ts`. Star printers use 32-char width; Epson uses 42. Deployed same day. Redeployment triggered no duplicate prints (outbox idempotency). |
| **Status** | ✅ Resolved (2026-06-03, Day 1) |
| **Owner** | Engineering |
| **Follow-up** | Add Star printer format test to pre-go-live checklist. Add formatter unit test for Star character width. |

---

### Issue Q-002

| Field | Value |
|---|---|
| **Issue ID** | Q-002 |
| **Shop** | Peri Palace (Shop 4) |
| **Provider** | Uber Eats |
| **Severity** | P2 |
| **Description** | 7 Uber Eats 429 rate-limit events during lunch peak (18:00–19:30 BST, 2026-06-10). Maximum 4 concurrent status sync calls. |
| **Impact** | Status sync delayed by 12–30 seconds during peak. No orders lost. Retry-After headers (12s) respected exactly via `rateLimitAwareBackoff`. |
| **Root cause** | Same as Spice Garden Phase N/O — Uber Eats rate-limits concurrent status calls. Peri Palace has higher order volume (~55/day) than previous shops. |
| **Fix/mitigation** | No code fix needed. `rateLimitAwareBackoff` strategy handled it automatically. All 7 events recovered within 1 retry. Brief restaurant owner that 30-second sync delay is normal during peak. |
| **Status** | ✅ Auto-resolved |
| **Owner** | Engineering |
| **Follow-up** | If 429 events exceed 10/hour, investigate batching status syncs. |

---

### Issue Q-003

| Field | Value |
|---|---|
| **Issue ID** | Q-003 |
| **Shop** | The Curry Leaf (Shop 2) |
| **Provider** | N/A |
| **Severity** | P3 |
| **Description** | Staff reported that KDS "yellow" (PREPARING) and "green" (ACCEPTED) colours looked similar on their tablet at low screen brightness. |
| **Impact** | Minor UX confusion for kitchen staff. No orders affected. |
| **Root cause** | Colour selection not optimised for all screen brightness settings. |
| **Fix/mitigation** | Deferred to Phase R — add higher-contrast KDS colour scheme or brightness guidance. |
| **Status** | 📋 Deferred to Phase R |
| **Owner** | Frontend team |
| **Follow-up** | Add to Phase R KDS improvement backlog. |

---

### Issue Q-004

| Field | Value |
|---|---|
| **Issue ID** | Q-004 |
| **Shop** | Naan & Co (Shop 3) |
| **Provider** | Just Eat |
| **Severity** | P2 |
| **Description** | Staff saw "Just Eat: disconnected" badge in the integrations dashboard and assumed it was a system failure. They were unaware that Just Eat was intentionally not activated (pending approval). |
| **Impact** | 2 unnecessary support messages. No system issue. |
| **Root cause** | Integration status badge did not distinguish between "inactive by choice / pending approval" and "active but erroring". |
| **Fix/mitigation** | Integration dashboard now shows "Pending approval" label for integrations in INACTIVE status that have no credentials configured, vs. "Disconnected" for integrations with credentials but erroring status. |
| **Status** | ✅ Resolved (UI label fix) |
| **Owner** | Frontend team |
| **Follow-up** | Extend integration status to include `PENDING_APPROVAL` enum value in Phase R. |

---

### Issue Q-005

| Field | Value |
|---|---|
| **Issue ID** | Q-005 |
| **Shop** | Masala Express (Shop 5) |
| **Provider** | N/A |
| **Severity** | P3 |
| **Description** | Staff asked why the Orders page doesn't auto-refresh when new orders arrive. They had to manually reload. |
| **Impact** | Staff experience degraded (no new order alert without manual refresh). No orders missed — print job fired regardless. |
| **Root cause** | WebSocket auto-reconnection not implemented (see KNOWN_LIMITATIONS.md). |
| **Fix/mitigation** | Deferred to Phase R. Known limitation. Print still fires correctly. |
| **Status** | 📋 Deferred to Phase R |
| **Owner** | Frontend team |
| **Follow-up** | Phase R: implement WebSocket reconnection with exponential backoff. |

---

## Issue Template

Use this template for new issues:

```markdown
### Issue P-XXX

| Field | Value |
|---|---|
| **Issue ID** | P-XXX |
| **Shop** | [Shop name + number] |
| **Provider** | [Uber Eats / Deliveroo / Just Eat / HubRise / N/A] |
| **Severity** | P0 / P1 / P2 / P3 |
| **Description** | [One sentence description] |
| **Impact** | [Orders affected? Data at risk? Staff impact?] |
| **Root cause** | [Known/suspected root cause] |
| **Fix/mitigation** | [What was done / will be done] |
| **Status** | 🔴 Open / 🟡 In Progress / ✅ Resolved |
| **Owner** | [Name/team] |
| **Due time** | [P0: immediate / P1: before next trading session / P2: 48h] |
| **Follow-up** | [Monitoring, docs update, test addition] |
```

---

## Rollout Issue Rules

- **P0**: Pause affected shop immediately via Go-Live Wizard → PAUSED. Do not onboard another shop.
- **P1**: Fix or document clear mitigation before next trading session. Block next shop onboarding.
- **P2**: Assign owner and due time within 1 hour of detection.
- **P3**: Log and batch for next sprint.
- All issues must have an owner and status.
- Closed issues remain in this file with status ✅ Resolved for the audit trail.
