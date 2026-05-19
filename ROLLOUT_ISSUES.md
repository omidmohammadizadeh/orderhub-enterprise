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

*No active P0/P1 issues as of 2026-05-19.*

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
