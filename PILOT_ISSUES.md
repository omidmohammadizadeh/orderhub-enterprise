# Pilot Issue Tracker

> Log every issue found during the pilot. Do not delete resolved issues — they form the incident history.

## Severity Levels

| Level | Description |
|---|---|
| P0 | Lost order / duplicate charge / cross-tenant data leak / security incident |
| P1 | Order received but not printed / provider sync failure / location unreachable |
| P2 | UI delay / staff workflow issue / non-critical sync failure |
| P3 | Cosmetic, low-risk, or deferred improvement |

## Issue Log

| ID | Time (UTC) | Location | Provider | Severity | Description | Status |
|---|---|---|---|---|---|---|
| N-001 | 2026-05-19 11:15 | Spice Garden — Bethnal Green | PRINTER | P2 | Printer went offline — loose Ethernet cable | Resolved |
| N-002 | 2026-05-19 12:47 | Spice Garden — Bethnal Green | UBER_EATS | P2 | 429 rate limit during concurrent status syncs | Resolved |

---

### Issue N-001

- **Time:** 2026-05-19 11:15 UTC
- **Location:** Spice Garden — Bethnal Green
- **Provider:** PRINTER
- **Severity:** P2
- **Reported by:** Priya Mehta (manager, via WhatsApp)
- **Description:** Printer went offline during first trading hour. Two orders were queued but not printed. The printer heartbeat monitor reported OFFLINE. The Flutter app stopped receiving jobs.
- **Impact:** 2 orders not printed immediately. Both were held in print queue. No orders were lost. Staff noticed within 1 minute and contacted support.
- **Root cause:** Physical Ethernet cable was slightly loose at the restaurant's network switch. Not a software issue.
- **Fix applied:** Arjun Mehta (owner) reseated the Ethernet cable. Printer came back ONLINE within 4 minutes (11:19 UTC). Print queue drained automatically — both queued jobs printed correctly without duplicates.
- **Status:** Resolved
- **Follow-up required:** No — physical cable issue. Staff briefed to check cable first if printer goes offline.
- **Resolved by:** Arjun Mehta (physical fix), 2026-05-19 11:19 UTC

---

### Issue N-002

- **Time:** 2026-05-19 12:47 UTC
- **Location:** Spice Garden — Bethnal Green
- **Provider:** UBER_EATS
- **Severity:** P2
- **Reported by:** System (structured logs — HTTP 429 detected)
- **Description:** Uber Eats returned HTTP 429 (Too Many Requests) when OrderHub attempted to sync status for 3 orders accepted within 45 seconds during the lunch peak. The accept call succeeded for all 3 orders; the 429 occurred on the subsequent status-sync call.
- **Impact:** Status sync for 3 orders was delayed by approximately 30 seconds. No orders were lost. The customer-facing status on Uber Eats was delayed but not permanently incorrect.
- **Root cause:** Uber Eats rate limits status sync calls. Three concurrent syncs within 45 seconds triggered the limit. This is a known provider limitation — see `KNOWN_LIMITATIONS.md`.
- **Fix applied:** No code change needed. The Bull queue backoff retried the status sync calls. All 3 syncs succeeded within 30 seconds of the 429. The existing Bull retry logic handled this correctly.
- **Status:** Resolved — no action required beyond monitoring
- **Follow-up required:** Yes (future, non-blocking) — add explicit `Retry-After` header parsing for Uber Eats 429 responses to make retries more efficient. Logged in `KNOWN_LIMITATIONS.md` as future work.
- **Resolved by:** System (automatic Bull retry), 2026-05-19 12:47 UTC

---

## Issue Template

Copy this section for each new issue:

```
### Issue N-XXX

- **Time:** YYYY-MM-DD HH:MM UTC
- **Location:** <location name>
- **Provider:** <UBER_EATS / DELIVEROO / PRINTER / SYSTEM / etc.>
- **Severity:** P0 / P1 / P2 / P3
- **Reported by:** <name>
- **Description:** What happened?
- **Impact:** How many orders affected? Customers notified?
- **Root cause:** What caused this?
- **Fix applied:** What was done to resolve it?
- **Status:** Open / Investigating / Resolved / Deferred
- **Follow-up required:** Yes / No — (what needs to happen)
- **Resolved by:** <name, date>
```

---

## P0 Response Protocol

A P0 incident requires immediate action:

1. **Pause the location immediately** (Go-Live Wizard → PAUSED, or see PILOT_LAUNCH_RUNBOOK.md)
2. **Notify** operations manager and on-call engineer
3. **Do not mark resolved** until root cause is confirmed
4. **Write a post-mortem** before re-enabling the location
5. **Update this file** with full timeline and root cause

---

## Closed Issues

| ID | Resolved | Summary |
|---|---|---|
| N-001 | 2026-05-19 11:19 UTC | Printer offline — loose Ethernet cable. Physical fix; no code change. |
| N-002 | 2026-05-19 12:47 UTC | Uber Eats 429 during lunch peak. Bull retry handled automatically. |
