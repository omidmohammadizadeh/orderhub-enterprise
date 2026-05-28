# Phase AJ — Order Foundation (Base44 Parity)

Phase AJ rebuilds the operational order foundation on the enterprise stack
(NestJS / Prisma / Redis / WebSockets / Next.js) so the Orders tab,
location filtering, status lifecycle, and Flutter printer-app compatibility
all work properly before we reconnect Uber / Deliveroo / Just Eat / HubRise
production flows.

> **Scope reminder:** this phase intentionally does **not** rewire
> marketplace integrations or rebuild POS / Menu / KDS / Menu Manager.
> Those are separate follow-on phases.

## What shipped

Five focused commits, deployed via Render auto-deploy from
`claude/xenodochial-brahmagupta-5521f8`:

| # | Commit | What |
|---|--------|------|
| 1 | `411ad87` | Granular status enum + Base44-parity fields |
| 2 | `4e82152` | Manual test-order endpoint `POST /v1/orders/test` |
| 3 | `cd4e0a7` | Flutter compat `GET/PATCH /v1/printer-jobs` + `X-Print-Token` |
| 4 | `18b9af4` | Orders board: per-status buttons + location filter + test order UI |
| 5 | _(this commit)_ | Tests + report + KNOWN_LIMITATIONS update |

## Schema changes

### `OrderStatus` enum — 4 new values
- `ASSIGNED_DRIVER` — driver picked, not yet acknowledged
- `ACCEPTED_BY_DRIVER` — driver accepted the assignment
- `OUT_FOR_DELIVERY` — granular replacement for `DISPATCHED`
- `FAILED` — distinct from `CANCELLED` / `REJECTED`

`DISPATCHED` is retained as a **legacy alias** for `OUT_FOR_DELIVERY`. Older
outbox events, integration adapters, and webhook payloads keep working;
new code emits the granular values.

### `Order` model — 4 new columns
- `brandId` — optional FK to `brands` (one location can serve multiple
  virtual brands à la Greek Gyros + crunchy chikin)
- `collectionCode` — customer-facing pickup code
- `preparationMinutes` — per-order prep time override
- `failureReason` — populated on `FAILED` transitions (distinct from
  `cancelReason`)

All other Base44 fields (`courier_*`, `food_photo_url`, `stripe_*`,
`hubrise_*`, etc.) continue to live in the existing `metadata` JSONB until
they need to be indexable.

### `Location` model — 1 new column
- `printToken` — bearer token presented by the Flutter printer agent as
  `X-Print-Token` when polling `/v1/printer-jobs`. Nullable, partial unique
  index. When set, requests must match; when null, the endpoint accepts
  requests but logs a warning so operators are reminded to provision one
  (grace mode — no live customer breaks the moment we ship).

### Indexes added
- `orders_brandId_idx`
- `orders_tenantId_brandId_idx`
- `orders_brandId_status_idx`
- `locations_printToken_key` (partial unique)

### Migrations
- `20260520200000_phase_aj_order_foundation` — status enum + Order columns + FK
- `20260520210000_phase_aj_print_token` — `Location.printToken` + partial unique

Both use `ADD VALUE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` and the FK
is `NOT VALID` (skips the scan — all existing rows have `brandId = NULL`)
so they are idempotent and fast on production-sized data.

## Shared package — status-rank guard

New module `packages/shared/src/types/order-status-rank.ts`:

- `STATUS_RANK` — frozen record mapping every `OrderStatus` to a numeric
  rank ordered along the happy path.
- `TERMINAL_STATUSES`, `CANCELLABLE_STATUSES` — read-only lists.
- `getRank()`, `isTerminal()`, `isCancellation()`, `isMonotonicForward()`.
- `assertMonotonicOrCancel(from, to)` — defensive backstop the
  `OrdersService` uses **in addition to** the per-status whitelist. Throws
  on rank downgrade, throws on transitions out of terminal states, returns
  silently for cancellations (which are always permitted).

This satisfies the Base44 monotonic-protection requirement while preserving
the more precise whitelist as the primary enforcement.

## State machine

`apps/api/src/modules/orders/order-state-machine.ts`:

- `VALID_TRANSITIONS` expanded for the new driver-handoff and FAILED states.
- Cancellation / rejection / failure permitted from any non-terminal state.
- `assertTransition` runs the shared rank guard before the whitelist — belt
  + braces.
- `getTimestampField` maps `OUT_FOR_DELIVERY` and the legacy `DISPATCHED`
  to the same `outForDeliveryAt` column.

## Service-layer status guard + audit log

`OrdersService.updateStatus` (unchanged in this phase, verified during
audit):

- Uses `assertTransition` — now rank-backed.
- Optimistic concurrency on `updatedAt`.
- Status, timestamp, cancelReason all written in one transaction with the
  `OrderStatusHistory` row.
- Outbox event written in the same transaction (atomic with the order
  update) — the dispatcher cron picks it up if the queue enqueue fails.
- Audit log via `AuditLogService.log(...)`.
- WebSocket emit (`order:updated` / `order:cancelled`) — best-effort,
  immediate.

## Manual test-order endpoint

```
POST /api/v1/orders/test
body: { locationId, customerName?, fulfillmentType? }
roles: MANAGER, TENANT_OWNER, PLATFORM_ADMIN
```

- Validates location belongs to user's tenant.
- Builds a small canonical with 3 sample items, routes through the
  existing `ingestCanonical` pipeline so the order appears on the live
  board immediately and triggers the standard outbox → worker print-job
  creation on the subsequent `ACCEPTED` transition.
- Sets `isSandbox = true` (excluded from analytics / reports later).
- Writes audit log (`order.test.created`).
- Available in production — operators need it for go-live verification.

## Printer-job legacy compat — `/v1/printer-jobs`

New `PrinterJobsLegacyController` at the path / shape Base44 documented:

```
GET   /api/v1/printer-jobs?shop_code={code}&limit=20
PATCH /api/v1/printer-jobs/{id}    body: { status, error? }
header X-Print-Token: <token>
```

- Status vocabulary: `pending | printing | printed | failed` ↔ Prisma
  `QUEUED | PRINTING | PRINTED | FAILED`. Internal `RETRYING` is hidden.
- Payload rebuilt from canonical `Order` on each fetch (not trusting
  `PrintJob.payload`) so worker schema drift can't break the agent.
- Token check: when `Location.printToken` is set, requests **must** match;
  when null, request accepted and a warning logged.
- The old `/api/v1/printers/jobs` endpoint stays mounted (Public, no
  token) so no existing print agents break.

### Print payload shape returned (Base44 verbatim)

```json
{
  "order_number": "...",
  "created_at": "...",
  "order_type": "DELIVERY",
  "order_source": "POS",
  "channel": "DIRECT",
  "collection_code": null,
  "scheduled_time": null,
  "customer": { "name": "...", "phone": "...", "address": "..." },
  "items": [{ "name": "...", "qty": 1, "price": 9.5, "notes": null, "modifiers": [] }],
  "notes": "...",
  "totals": {
    "subtotal": 15, "discount": 0, "discount_codes": [],
    "delivery_fee": 2.5, "total": 17.5
  },
  "payment": { "type": null, "status": "PENDING" },
  "promo_banner": null
}
```

### Print-job auto-creation on `ACCEPTED`

Verified during the audit — already wired:
`apps/worker/src/processors/order-processing.processor.ts` `handleStatusChange`
matches `toStatus === "ACCEPTED"` and calls `triggerAcceptedPrints` which
creates a `KITCHEN_TICKET` `PrintJob`. No change needed in this phase.

## Web — Orders board UI

Existing `OrderBoard` + `OrderCard` + `StatusColumn` + `OrderDetailDrawer`
verified and extended:

- **Per-status action buttons** (new `order-actions.tsx`): the next-step
  button + Cancel rendered on every card, derived from the same per-status
  whitelist the API enforces. Cancel-style buttons `window.prompt` for a
  reason; cancelling the prompt aborts the action so staff back out
  cleanly. Buttons use the existing `useUpdateOrderStatus` mutation with
  optimistic update + rollback already wired in `orders.store.ts`.
- **Location selector** (`LocationSelector` + `selected-location.store.ts`
  + `locations.client.ts`): Zustand store persisted to localStorage
  (replaces Base44's `selected_locations` key + `selectedLocationsChanged`
  window event). `PLATFORM_ADMIN` sees an "All locations" option; other
  roles see only their assigned locations.
- **"Create test order" affordance**: page-level button that calls
  `POST /v1/orders/test` for the selected location. Disabled when "All
  locations" is selected. Surfaces success/error feedback inline.
- **WebSocket subscription**: existing `useLiveOrders` hook joins the
  location room and listens to `order:new`, `order:updated`,
  `order:cancelled` — verified during audit, no change needed.
- **Terminal-state filtering** updated to include `FAILED` alongside
  `COMPLETED / CANCELLED / REJECTED`.

## Tests

All passing (`pnpm -F @orderhub/api test`):

- **`order-state-machine.spec.ts`** — extended with Phase AJ tests:
  driver-handoff lifecycle, `FAILED` from any non-terminal state, blocked
  transitions out of `FAILED`, driver-state regression blocked by rank
  guard.
- **`order-status-rank.spec.ts`** (new) — 19 tests covering:
  - Monotonic ordering of the happy path.
  - `DISPATCHED` ≡ `OUT_FOR_DELIVERY` rank parity.
  - Terminal exception states rank at/above happy-path peak.
  - `getRank`, `isTerminal`, `isCancellation` semantics.
  - `isMonotonicForward` — true for forward, false for same/backwards/cancel.
  - `assertMonotonicOrCancel` — cancellation overrides, forward permitted,
    downgrade rejected, terminal transitions blocked.
- Existing `shopcode-isolation.spec.ts` (printers) untouched — still passes,
  still covers the cross-location isolation guarantee for the older
  `/printers/jobs` endpoint.

**Test result:** 33 passed in 0.45s.

## Behaviour parity matrix — Base44 → Enterprise

| Base44 behaviour | Enterprise equivalent | Status |
|---|---|---|
| 13-state lifecycle | OrderStatus enum (12 values + DISPATCHED alias) | ✅ |
| Monotonic STATUS_RANK guard | `assertMonotonicOrCancel` + whitelist | ✅ |
| Cancellation overrides | Allowed from any non-terminal in both layers | ✅ |
| Order audit log | `OrderStatusHistory` + `AuditLog` | ✅ |
| `status_timeline` JSONB | `OrderStatusHistory` table (richer) | ✅ |
| `status_changed_at` | Per-status timestamp columns + Prisma `updatedAt` | ✅ |
| `selected_locations` localStorage | `useSelectedLocationStore` (zustand persist) | ✅ |
| `selectedLocationsChanged` event | Zustand subscriptions | ✅ |
| Per-status action buttons | `OrderActions` component | ✅ |
| Multi-brand per location | `Order.brandId` FK | ✅ |
| `collection_code` | `Order.collectionCode` column | ✅ |
| `preparation_minutes` | `Order.preparationMinutes` column | ✅ |
| `failure_reason` | `Order.failureReason` column | ✅ |
| Flutter agent contract | `/v1/printer-jobs` + Base44 payload + `X-Print-Token` | ✅ |
| Print job on `ACCEPTED` | Worker `triggerAcceptedPrints` | ✅ |
| Manual test orders | `POST /v1/orders/test` (production-safe) | ✅ |
| WebSocket live board updates | `useLiveOrders` + `order:new/updated/cancelled` | ✅ |
| Tenant + location scoping | `tenantId` filter on every query, location FK | ✅ |

## What's intentionally **not** in Phase AJ

These are valid Base44 features deferred to subsequent phases:

- **"Add Time" button** on cards — needs prep-time configuration flow.
- **"Resume Orders" / "Enable Busy Mode" / "Prep Time" / "Cash Up"** top-bar
  buttons — these are operational tools that belong with the upcoming
  Store-Ops phase. `store-ops` module already exists in the API but the
  Orders-tab UI hooks are out of scope here.
- **Driver dispatch UI** for `ASSIGNED_DRIVER` / `ACCEPTED_BY_DRIVER` —
  the data model + statuses are wired; the dispatch screen is a separate
  phase.
- **Print-token provisioning UI** — operators set tokens via direct DB or
  a future locations admin endpoint until then.
- **`courier_*`, `food_photo_url`, `stripe_*`, `hubrise_*` order columns**
  — still in `metadata` JSONB. Promote to columns when they need to be
  queryable.
- **Production Uber / Deliveroo / Just Eat / HubRise wiring** — explicit
  out-of-scope per the phase brief.
- **Full POS / Menu / KDS / Menu Manager / Locations tabs rebuild** —
  separate phases.

## How to verify in production

1. Log into `https://orderhub-web.onrender.com/dashboard/orders`.
2. Pick a location from the dropdown in the top-right.
3. Click **Create test order** → an order should appear in the **New**
   column within ~1s (WebSocket) or ~30s (fallback poll).
4. Click **Accept** on the card → it moves to **Accepted**, the API
   stamps `acceptedAt`, the worker creates a `KITCHEN_TICKET` PrintJob,
   and an audit-log row is written.
5. Click **Mark preparing** → **Mark ready** → **Out for delivery** →
   **Mark delivered**. The card disappears from the live board after
   `COMPLETED`.
6. From any state click **Cancel** / **Deny** → `window.prompt` asks for
   reason; submission updates status and disappears from the board.

The legacy Flutter print agent should keep polling at
`/api/v1/printers/jobs?shop_code=` exactly as before. New deployments
can migrate to `/api/v1/printer-jobs?shop_code=&limit=20` with
`X-Print-Token` once a token is provisioned on the location row.

## Deliverables vs spec

| Spec item | Status |
|---|---|
| Orders data model audit + alignment | ✅ Done |
| Location scoping | ✅ Done |
| Orders UI functionality | ✅ Done |
| Status lifecycle (monotonic + cancel) | ✅ Done |
| PrinterJob Flutter compat | ✅ Done |
| Manual test order creation | ✅ Done |
| Realtime order board updates | ✅ Verified, no change needed |
| Working Orders page | ✅ Done |
| Working Location switch/filter | ✅ Done |
| Working status transitions (buttons) | ✅ Done |
| Working demo order creation | ✅ Done |
| Working PrinterJob compatibility endpoint | ✅ Done |
| WebSocket updates for order create/update | ✅ Verified |
| Prisma migration if fields missing | ✅ Done (2 migrations) |
| `PHASE_AJ_REPORT.md` | ✅ This document |
| `KNOWN_LIMITATIONS.md` update | ✅ See appended Phase AJ section |
