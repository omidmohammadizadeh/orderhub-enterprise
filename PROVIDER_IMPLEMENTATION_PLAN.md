# Provider Implementation Plan

> Phase Y — 2026-05-19  
> Prioritized list of missing provider features.  
>
> **Rule**: Do NOT implement any item below until:
> 1. Base44 export is received and reviewed (see `BASE44_INTEGRATION_EXPORT_REQUEST.md`)
> 2. Provider API docs are confirmed for the target endpoint
> 3. Production approval requirements are understood
>
> This document is a planning artefact — not a build order.

---

## Priority Definitions

| Level | Meaning |
|-------|---------|
| **P0** | Blocks production rollout to new customer type |
| **P1** | High business value, provider approval required |
| **P2** | Operational improvement, safe to build when ready |
| **P3** | Nice-to-have, low urgency |

---

## P0 — Production Validation (Unblock New Provider Types)

### P0-1: Just Eat Production Validation

**What**: End-to-end test of the existing Just Eat webhook + accept/reject/ready flow against Just Eat's test environment.

**Not new code** — the adapter exists. This is a test/validation exercise.

| Item | Detail |
|------|--------|
| Provider | Just Eat |
| Type | Validation, not new code |
| Effort | 1–2 days (with Just Eat test credentials) |
| Blocker | Just Eat test environment access |
| Required credentials | `JUST_EAT_CLIENT_ID`, `JUST_EAT_CLIENT_SECRET`, `JUST_EAT_APPLICATION_ID`, webhook secret |
| Tests needed | Webhook signature verification, order normalize, accept API call, reject API call, dueDate correctness |
| Production approval required | YES — no Just Eat shops can go live until this passes |
| Outcome | Update `PROVIDER_PARITY_MATRIX.md` status; create Just Eat validation sign-off |

**Steps**:
1. Obtain Just Eat sandbox credentials from Just Eat API team
2. Register test webhook URL using ngrok or similar tunnel
3. Send test webhook payloads, verify signature check passes
4. Verify order normalize produces correct CanonicalOrder
5. Call accept/reject/ready endpoints against test restaurant
6. Fix any issues found
7. Run existing webhook adapter tests to confirm nothing regressed
8. Document any payload format differences from current adapter assumptions

---

### P0-2: HubRise Production Validation

**What**: End-to-end test of the HubRise webhook + status sync flow.

| Item | Detail |
|------|--------|
| Provider | HubRise |
| Type | Validation, not new code |
| Effort | 1–2 days |
| Blocker | HubRise sandbox account + test restaurant |
| Required credentials | `HUBRISE_CLIENT_ID`, `HUBRISE_CLIENT_SECRET`, plus OAuth2 authorization code |
| Tests needed | Webhook signature, order normalize, all status sync calls |
| Production approval required | YES — first HubRise shop must be manually monitored |

**Steps**:
1. Create HubRise developer sandbox account
2. Run OAuth2 authorization_code flow to obtain tokens
3. Register webhook via HubRise API
4. Send test orders, verify normalization
5. Walk through full order lifecycle (accept → preparing → ready → dispatched → completed)
6. Verify token refresh works
7. Test with a simulated "Uber Eats via HubRise" order (channel detection)

---

### P0-3: Just Eat Configurable dueDate

**What**: `PUT /orders/:id/accept` currently sends `dueDate = now + 30 minutes` hardcoded. This should be configurable per-location using the location's `currentPrepTime`.

| Item | Detail |
|------|--------|
| Provider | Just Eat |
| Type | Small code fix (not new feature) |
| Effort | 2–3 hours |
| Blocker | Confirm dueDate format with Just Eat API docs |
| Implementation | Read `integration.settings.prepTimeMinutes` or `location.currentPrepTime`, default 30 |
| Tests needed | Unit test for dueDate calculation at 15, 30, 45, 60 min |
| Production approval required | No — but include in Just Eat validation |

---

## P1 — Store Availability (Requires Provider Approval)

### P1-1: Deliveroo Store Open/Close/Pause

**What**: Call Deliveroo's store availability API to open/close the store when staff toggle it in OrderHub.

| Item | Detail |
|------|--------|
| Provider | Deliveroo |
| Type | New feature |
| Effort | 2–3 days (after API access granted) |
| Blocker | **Deliveroo POS Partner approval required** — must apply first |
| API | `PUT /order-management/v1/restaurant/{restaurant_id}/availability` (unconfirmed endpoint) |
| Credentials/scopes | POS Partner API key |
| Request payload | `{ "isOpen": true/false, "offlineReason": "..." }` (confirm with Deliveroo docs) |
| Response handling | 200 success, 403 not approved, 404 restaurant not found |
| Retry/idempotency | Idempotent — safe to retry |
| Integration point | Call from `StoreOpsService.updateStatus()` when isOpen changes for Deliveroo-integrated locations |
| Tests needed | Unit test for API call + error handling, mock Deliveroo response |
| Files to modify | Add `deliveroo-store.service.ts` (new file) + wire into StoreOpsService |

**Do not build until**: Deliveroo POS Partner application is approved.

---

### P1-2: Uber Eats Store Open/Close/Pause

| Item | Detail |
|------|--------|
| Provider | Uber Eats |
| Type | New feature |
| Effort | 2–3 days (after API access granted) |
| Blocker | **Uber Eats POS Partner status required** |
| API | `PUT /eats/v1/eaters/restaurant-store/status` (unconfirmed) |
| Do not build until | POS Partner approval received |

---

### P1-3: Deliveroo Item Pause/Unpause

| Item | Detail |
|------|--------|
| Provider | Deliveroo |
| Type | New feature |
| Effort | 2 days (after API access) |
| Blocker | Deliveroo POS Partner approval |
| API | Item availability endpoint (requires docs from Deliveroo) |
| Integration point | Triggered when `MenuService.bulkToggleAvailability()` is called for Deliveroo-integrated locations |
| Tests needed | Unit test for API call |

---

## P2 — Rate Limit Compliance

### P2-1: Retry-After Header Parsing (All Providers)

**What**: When a provider returns HTTP 429 with a `Retry-After` header, use that value to delay the next attempt instead of using Bull's default exponential backoff.

| Item | Detail |
|------|--------|
| Providers | All (Uber Eats, Deliveroo, Just Eat, HubRise) |
| Type | Enhancement to existing sync clients |
| Effort | 1 day |
| Required | Review existing sync client code in `apps/worker/` for Bull job retry logic |
| Implementation | Parse `Retry-After` header (integer seconds or HTTP-date), compute delay, pass to Bull job options |
| Tests needed | Unit test for Retry-After parsing; mock 429 response |
| Production approval required | No |

---

## P2 — Menu Sync

### P2-2: HubRise Menu Import

**What**: Pull the menu from HubRise and create categories/items in OrderHub.

| Item | Detail |
|------|--------|
| Provider | HubRise |
| Type | New feature |
| Effort | 3–5 days |
| API | `GET /catalog/v1/catalogs/{catalog_id}/categories` + items |
| Blocker | Base44 export showing HubRise menu structure, plus HubRise sandbox access |
| Integration point | New `MenuSyncService` with `importFromHubrise(locationId)` method |
| Menu mapping | HubRise SKU → MenuItem, modifier groups → ModifierGroup |
| Idempotency | Upsert by external ID, preserve OrderHub changes |
| Tests needed | Unit test for HubRise catalog → CanonicalMenu mapping |
| Production approval required | No (pull-only) |

---

### P2-3: HubRise Item Availability Sync

**What**: When an item is toggled unavailable in OrderHub, push the change to HubRise.

| Item | Detail |
|------|--------|
| Provider | HubRise |
| Type | New feature |
| Effort | 1–2 days (after import is working) |
| API | `PATCH /catalog/v1/sku/{sku_id}` with `{ "ref": "...", "restrictions": { "available_amount": 0 } }` (unconfirmed) |
| Integration point | Hook into `MenuService.bulkToggleAvailability()` |

---

## P3 — Courier Lifecycle Events (Uber Eats)

### P3-1: Display Courier Status in Dispatch View

**What**: When Uber Eats sends `courier_assigned`, `courier_arriving`, `courier_picked_up` webhooks, extract and display the courier status in the dispatch view.

| Item | Detail |
|------|--------|
| Provider | Uber Eats |
| Type | New feature |
| Effort | 1–2 days |
| Current state | Webhooks arrive but are ignored (event_type != orders.notification) |
| Implementation | Extend `UberEatsAdapter.normalize()` to return a CanonicalCourierEvent (new type) |
| Socket event | Emit `dispatch:courier:updated` to location room |
| Tests needed | Unit test for courier event extraction |
| Production approval required | No — display only, no action taken |

---

## Implementation Constraints

Before building any P1 or P2 items:

1. **Receive Base44 export** (see `BASE44_INTEGRATION_EXPORT_REQUEST.md`)
2. **Confirm provider API version** against current docs — endpoints change
3. **Sandbox test first** — never test against production provider APIs
4. **Write tests before wiring** — each new provider action needs a unit test
5. **Do not change working flows** — existing Uber Eats + Deliveroo order flows must not regress
6. **One provider at a time** — fix Just Eat, validate, then move to HubRise

## Decision Gate

Before any P1 item is started, the following must be confirmed in writing:

```
[ ] Provider approval received (if required)
[ ] Base44 export reviewed and differences documented
[ ] Provider API docs reviewed (current version)
[ ] Sandbox credentials available
[ ] Test plan written
[ ] Code review plan agreed
[ ] Rollback plan documented
```
