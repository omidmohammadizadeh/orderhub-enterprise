# Phase M Report — First Live Pilot Launch Preparation

> Completed: 2026-05-19

---

## Summary

Phase M prepares the platform for the first live pilot restaurant. It adds emergency control endpoints (provider disable, printer disable) with mandatory audit logging, pilot-specific documentation, an issue tracker, and staff training materials. The readiness engine from Phase K enforces that no location can go LIVE until all critical checks pass. The emergency pause controls from Phase M allow quick recovery if anything goes wrong after go-live.

No product features were added. No provider integrations were changed. The Flutter printer app contract is unchanged. All 157 tests pass; 9 new tests were added.

---

## What Was Built

### 1. Emergency Control Endpoints

Added to `OnboardingService` and `OnboardingController`:

| Endpoint | Method | Description |
|---|---|---|
| `/v1/onboarding/locations/:lid/providers/:iid/pause` | POST | Set integration status to INACTIVE (audited) |
| `/v1/onboarding/locations/:lid/providers/:iid/resume` | POST | Set integration status to ACTIVE (audited) |
| `/v1/onboarding/locations/:lid/printers/:pid/pause` | POST | Set printer isActive to false (audited) |
| `/v1/onboarding/locations/:lid/printers/:pid/resume` | POST | Set printer isActive to true (audited) |

All endpoints:
- Require `MANAGER`, `TENANT_OWNER`, or `PLATFORM_ADMIN` role
- Require a non-empty `reason` in the request body (`BadRequestException` if missing)
- Write an audit log entry for every action
- Enforce tenant isolation — users cannot affect other tenants' integrations or printers
- Log a `WARN`-level message for pause actions, `INFO` for resume

---

### 2. Tests (+9 new, 157 total)

Added to `onboarding.service.spec.ts`:
- `pauseProvider` — sets INACTIVE, writes audit log, requires reason, NotFoundException
- `resumeProvider` — sets ACTIVE, writes audit log, requires reason
- `pausePrinter` — sets isActive false, writes audit log, requires reason, NotFoundException
- `resumePrinter` — sets isActive true, writes audit log

---

### 3. Documentation Created

| File | Description |
|---|---|
| `PILOT_LOCATION_PLAN.md` | Template for pilot restaurant details, contacts, provider list, printer, known risks, rollback plan |
| `PILOT_STAFF_TRAINING.md` | Simple staff quick-reference guide covering order acceptance, KDS, cashier, dispatch, reprinting, pausing items |
| `PILOT_ISSUES.md` | Issue tracker with P0–P3 severity definitions, template, and P0 response protocol |
| `PHASE_M_REPORT.md` | This file |

Updated:
- `PILOT_LAUNCH_RUNBOOK.md` — emergency pause, monitoring, API pause commands (added in Phase L)
- `RELEASE_CHECKLIST.md` — Phase M pilot readiness section
- `KNOWN_LIMITATIONS.md` — Phase M limitations

---

## Production Dry-Run Checklist Status

To be completed before the first real go-live:

| Check | Status |
|---|---|
| Deploy to staging-production with production config | ☐ Pending |
| `prisma migrate deploy` confirms all migrations applied | ☐ Pending |
| Startup guard passes (no `STARTUP FAILED` in logs) | ☐ Pending |
| Smoke test passes (16 checks, exit code 0) | ☐ Pending |
| Release readiness score ≥ 90 | ☐ Pending |
| Pre-deploy backup completed | ☐ Pending |
| No plaintext credentials | ☐ Pending |
| No dead/stuck outbox events | ☐ Pending |
| Sandbox tools disabled | ☐ Pending |
| Provider base URLs confirmed (production endpoints) | ☐ Pending |

---

## Pilot Onboarding Checklist Status

To be completed using the go-live wizard:

| Step | Status |
|---|---|
| Tenant created | ☐ Pending |
| Location created with shopCode | ☐ Pending |
| Provider integrations connected | ☐ Pending |
| Credentials encrypted | ☐ Pending |
| Webhook URLs configured | ☐ Pending |
| Printer configured | ☐ Pending |
| Staff users created | ☐ Pending |
| Menu imported/configured | ☐ Pending |
| Test print completed | ☐ Pending |
| Test order completed | ☐ Pending |
| Go-live wizard readiness score ≥ 90 | ☐ Pending |
| All blockers cleared | ☐ Pending |
| Location marked READY_FOR_GO_LIVE | ☐ Pending |
| Final sign-off obtained | ☐ Pending |
| Location marked LIVE | ☐ Pending |

---

## Provider Validation Status

| Provider | Credentials | Webhook | Last Webhook | Accept/Reject | Token Refresh |
|---|---|---|---|---|---|
| Uber Eats | ☐ | ☐ | ☐ | ☐ | ☐ |
| Deliveroo | ☐ | ☐ | ☐ | ☐ | ☐ |
| Just Eat | ☐ | ☐ | ☐ | ☐ | ☐ |
| HubRise | ☐ | ☐ | ☐ | ☐ | ☐ |

---

## Printer Validation Status

| Check | Status |
|---|---|
| Flutter app connects to production endpoint | ☐ Pending |
| shopCode matches Location.shopCode | ☐ Pending |
| Test print succeeds | ☐ Pending |
| Customer details print correctly | ☐ Pending |
| Item modifiers print correctly | ☐ Pending |
| Totals print correctly | ☐ Pending |
| No duplicate after app restart | ☐ Pending |
| No duplicate after worker restart | ☐ Pending |
| Failed job retry works | ☐ Pending |
| Diagnostics page shows correct status | ☐ Pending |

---

## Staff Training Status

| Person | Role | Training completed |
|---|---|---|
| _(to be filled)_ | TENANT_OWNER | ☐ |
| _(to be filled)_ | MANAGER | ☐ |
| _(to be filled)_ | Kitchen staff | ☐ |

---

## Pilot Success Criteria

### Day 1 minimum
- [ ] No lost orders
- [ ] No cross-location data leak
- [ ] No plaintext credential exposure
- [ ] No repeated duplicate printing
- [ ] No dead outbox events unresolved
- [ ] Printer stable during trading
- [ ] Staff can complete full order lifecycle without developer help
- [ ] Emergency pause tested or confirmed functional
- [ ] Support process confirmed working

### 3-day minimum
- [ ] Orders consistently arriving from all connected providers
- [ ] Printer reliable — no sustained failures
- [ ] Webhook failures are low or understood
- [ ] Staff operating independently
- [ ] No P0/P1 issues open
- [ ] All known limitations documented
- [ ] Decision made: expand to second pilot location yes/no

---

## Known Provider Limitations (Pilot Phase)

| Provider | Limitation |
|---|---|
| Deliveroo | Store open/close API not yet implemented — must use Deliveroo partner portal |
| Uber Eats | Menu sync is one-way — menu changes must also be reflected in Uber Eats portal |
| Just Eat | Accept/reject webhook not available on all partner tiers |
| HubRise | POS sync may require manual configuration of item IDs in HubRise dashboard |

---

## Files Changed

| File | Status |
|---|---|
| `apps/api/src/modules/onboarding/onboarding.service.ts` | Modified — emergency control methods |
| `apps/api/src/modules/onboarding/onboarding.controller.ts` | Modified — emergency control endpoints |
| `apps/api/src/modules/onboarding/tests/onboarding.service.spec.ts` | Modified — 9 new tests |
| `PILOT_LOCATION_PLAN.md` | New |
| `PILOT_STAFF_TRAINING.md` | New |
| `PILOT_ISSUES.md` | New |
| `PHASE_M_REPORT.md` | New |
| `RELEASE_CHECKLIST.md` | Updated — Phase M section |
| `KNOWN_LIMITATIONS.md` | Updated — Phase M limitations |

---

## Decision: Ready for Live Pilot?

**Status: Ready for go-live pending restaurant selection and dry-run deployment.**

Technical readiness:
- ✓ All 157 tests passing
- ✓ Emergency pause controls implemented and tested
- ✓ Readiness engine blocks go-live until all critical checks pass
- ✓ Smoke test covers 16 production safety checks
- ✓ Encryption, outbox, provider, printer, and staff checks all in place
- ✓ Audit trail on all lifecycle transitions and emergency actions

Operational readiness:
- ☐ Pilot restaurant selected — needs `PILOT_LOCATION_PLAN.md` filled in
- ☐ Production dry-run deployment completed
- ☐ Pilot restaurant onboarded through go-live wizard
- ☐ Staff training completed
- ☐ Emergency pause tested against pilot environment

The platform is technically ready. The remaining items are operational and happen during the actual pilot onboarding process.
