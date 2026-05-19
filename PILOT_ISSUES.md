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

| ID | Time (UTC) | Location | Provider | Severity | Description | Impact | Root Cause | Fix | Status | Follow-up |
|---|---|---|---|---|---|---|---|---|---|---|
| _(none yet)_ | | | | | | | | | | |

---

## Issue Template

Copy this section for each new issue:

```
### Issue M-001

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

_(move resolved issues here)_
