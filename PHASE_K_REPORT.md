# Phase K Report — Live Client Onboarding & Go-Live Wizard

> Completed: 2026-05-19

---

## Summary

Phase K delivers the live client onboarding workflow and go-live lifecycle management needed to safely launch pilot restaurants. It builds on Phase J's production hardening by adding structured per-location readiness checks, a lifecycle state machine, an internal admin wizard, and a full test suite.

No existing provider integrations, printer app contracts, or webhook flows were modified.

---

## What Was Built

### 1. Location Go-Live Lifecycle (`LocationGoLiveStatus`)

A new enum tracks each location's onboarding progress:

```
DRAFT → CONFIGURING → TESTING → READY_FOR_GO_LIVE → LIVE
                                                     ↓
                                               PAUSED / BLOCKED
```

Transitions are enforced by `VALID_TRANSITIONS` in `OnboardingService`. Illegal transitions (e.g. DRAFT → LIVE) throw `BadRequestException`.

**Schema changes** — `packages/database/prisma/schema.prisma`:
- `LocationGoLiveStatus` enum added
- `Location.goLiveStatus` — default `DRAFT`
- `Location.lastTestOrderAt` — timestamp, optional
- `Location.lastTestPrintAt` — timestamp, optional

**Migration** — `packages/database/prisma/migrations/20260519000000_phase_k/migration.sql`

---

### 2. Readiness Engine (`OnboardingService`)

`apps/api/src/modules/onboarding/onboarding.service.ts`

`getLocationReadiness(locationId, tenantId)` runs 13 checks across:

| Category | Checks | Critical | Admin-Overridable |
|---|---|---|---|
| Security | `encryption.key_set`, `encryption.no_plaintext_credentials` | Yes | **No** |
| Tenant | `tenant.active` | Yes | **No** |
| Location | `location.active`, `location.shop_code` | active: Yes | active: Yes |
| Outbox | `outbox.no_dead_events` | Yes | Yes |
| Provider | `provider.at_least_one_connected` | No | Yes |
| Printer | `printer.configured`, `printer.test_print_passed` | No | Yes |
| Menu | `menu.items_exist` | No | Yes |
| Staff | `staff.user_exists` | Yes | Yes |
| Orders | `orders.test_order_completed` | No | Yes |

**Score formula:** `max(0, 100 - blockers × 15 - warnings × 5)`

**Non-overridable checks** (cannot be bypassed by any admin):
- `encryption.key_set` — encryption key must be configured
- `tenant.active` — tenant must be in ACTIVE status

---

### 3. Go-Live Guard

`transitionGoLiveStatus()` calls `validateGoLive()` when `targetStatus === "LIVE"`. If any critical blocker exists, the transition is rejected with a descriptive error listing every failing check.

`adminOverride()`:
- Requires a non-empty reason string (logged to audit trail)
- Refuses non-overridable checks even for `PLATFORM_ADMIN`
- Writes a permanent audit log entry with `adminOverride: true`

---

### 4. REST API (`OnboardingController`)

`apps/api/src/modules/onboarding/onboarding.controller.ts`

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/v1/onboarding/locations` | MANAGER+ | List all locations with go-live status |
| GET | `/v1/onboarding/locations/:id/readiness` | MANAGER+ | Full readiness check |
| POST | `/v1/onboarding/locations/:id/transition` | MANAGER+ | Transition lifecycle status |
| POST | `/v1/onboarding/locations/:id/admin-override` | PLATFORM_ADMIN | Force status with reason |
| POST | `/v1/onboarding/locations/:id/record-test-order` | MANAGER+ | Stamp test order timestamp |
| POST | `/v1/onboarding/locations/:id/record-test-print` | MANAGER+ | Stamp test print timestamp |

`PLATFORM_ADMIN` can pass `?tenantId=` query param to scope requests to any tenant. Other roles are scoped to their own tenant automatically.

---

### 5. Go-Live Wizard Frontend

`apps/web/src/app/(dashboard)/dashboard/admin/go-live/page.tsx`

Features:
- Location list with go-live status badges and optional tenant filter
- Per-location readiness score ring (0–100)
- Blocker panel (red) — lists all critical failures
- Warning panel (yellow) — lists all non-critical issues
- Provider cards (Uber Eats, Deliveroo, etc.) — connection and encryption status
- Printer cards — online status, failed job count
- Full check table with critical/non-overridable labels
- Transition action buttons — LIVE button disabled until all blockers clear
- Admin override panel (reason required, logged)

---

### 6. Tests

`apps/api/src/modules/onboarding/tests/onboarding.service.spec.ts` — **27 tests**

Coverage:
- Readiness calculation (score, checks, provider/printer detail)
- NotFoundException for unknown location or tenant
- Per-check failure paths (encryption missing, tenant suspended, dead outbox events)
- Test order/print fallback to database query
- Valid and invalid status transitions
- Go-live blocked by critical checks
- Audit log written on every transition/override
- Admin override requires reason
- Non-overridable checks refuse LIVE override (encryption key, tenant status)
- Tenant isolation (per-tenant location scoping)

---

### 7. Module Wiring

- `apps/api/src/modules/onboarding/onboarding.module.ts` — imports `AuthModule` (for `AuditLogService`) and `IntegrationsModule` (for `CredentialEncryptionService`)
- `apps/api/src/app.module.ts` — `OnboardingModule` added

---

## Test Results

```
Test Suites: 10 passed, 10 total
Tests:       122 passed, 122 total  (+27 from Phase K)
```

---

## Files Changed

| File | Status |
|---|---|
| `packages/database/prisma/schema.prisma` | Modified — LocationGoLiveStatus enum + 3 fields on Location |
| `packages/database/prisma/migrations/20260519000000_phase_k/migration.sql` | New |
| `apps/api/src/modules/onboarding/onboarding.service.ts` | New |
| `apps/api/src/modules/onboarding/onboarding.controller.ts` | New |
| `apps/api/src/modules/onboarding/onboarding.module.ts` | New |
| `apps/api/src/modules/onboarding/tests/onboarding.service.spec.ts` | New |
| `apps/api/src/app.module.ts` | Modified — OnboardingModule added |
| `apps/web/src/app/(dashboard)/dashboard/admin/go-live/page.tsx` | New |
| `PHASE_K_REPORT.md` | New |
| `PILOT_LAUNCH_RUNBOOK.md` | New |
| `RELEASE_CHECKLIST.md` | Updated — Phase K onboarding steps |

---

## What Was Deliberately Not Built

Per Phase K constraints:
- No billing or subscription changes
- No mobile/driver app changes
- No provider integration changes (Uber Eats, Deliveroo, Just Eat, HubRise untouched)
- No printer app contract changes (Flutter polling unchanged)
- No sandbox tool changes

---

## Known Limitations

See `KNOWN_LIMITATIONS.md`.

The go-live wizard frontend requires `PLATFORM_ADMIN` credentials and a running API. The readiness score is computed on demand (not cached), which means the location list page shows `score: null` — click through to a location to see the live score.
