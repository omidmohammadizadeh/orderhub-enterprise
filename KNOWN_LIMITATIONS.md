# Known Limitations

> Last updated: Phase AM — POS Operational Upgrade (2026-05-30)
> This file documents provider limitations, unsupported actions, pending approvals, and areas needing future work.

---

## Phase AM Limitations (POS operational upgrade)

- **No admin UI for delivery zones yet.** Zones are configured through
  `POST /v1/delivery-zones`. The POS lookup + override are wired; the
  manager-facing zones editor lands next phase.
- **No admin UI for promo codes yet.** Create / update / delete is API-only.
  The POS validates + redeems correctly today.
- **Address autocomplete requires `MAPBOX_ACCESS_TOKEN`.** Without it the
  POS falls back to manual entry — no provider fails closed. Google Places
  is a placeholder.
- **Caller-ID integration is a free-text field.** Hardware/CTI bridge is
  not yet wired; the field structure + persistence are ready.
- **Payment providers Dojo / Adyen / Worldpay are placeholders.** The
  selector + storage + status enum are in place; only Stripe is wired
  end-to-end. See `PAYMENT_PROVIDERS_PLAN.md`.
- **Full offline order placement is deferred to Phase AN.** Cart draft
  persistence + offline banner ship in AM; queued submissions + IndexedDB
  menu cache + sync worker do not. See `OFFLINE_POS_PLAN.md`.
- **No manager UI for `LocationPaymentConfig`.** Created automatically with
  defaults on first order; no in-app editor yet.

---

## Phase AJ Limitations

- **"Add Time" button is not implemented on order cards.** Base44 lets staff
  bump prep time by 5/10/15 min from the order card. The status state
  machine and `preparationMinutes` column are in place; the UI affordance
  is deferred until the Store-Ops prep-time configuration flow ships.
- **Top-bar operational tools (Resume Orders / Busy Mode / Prep Time /
  Cash Up) are not on the Orders tab UI yet.** The underlying `store-ops`
  module exists; the Orders-tab wiring is a separate phase.
- **`Order.brandId` defaults to `NULL` on existing orders.** The FK is
  `NOT VALID`, so existing rows are not retroactively assigned. New
  orders set it via the canonical ingest when the adapter knows the
  brand. A backfill script will be needed before per-brand reporting
  goes live.
- **Print-token provisioning has no admin UI.** Operators currently set
  `Location.printToken` via direct DB write. Until a location-admin
  endpoint ships, the new `/v1/printer-jobs` endpoint runs in **grace
  mode** for locations with no token — requests are accepted and a
  warning logged. The old `/printers/jobs` endpoint remains Public and
  un-tokenised for backwards compatibility.
- **Driver-handoff UI (ASSIGNED_DRIVER / ACCEPTED_BY_DRIVER) is data-model
  only.** The statuses are in the enum, state machine, and rank table,
  but there is no dispatch screen yet. Status moves through driver states
  via API only.
- **Base44 order fields `courier_*`, `food_photo_url`, `stripe_*`,
  `hubrise_*`, `tracking_url`, `pin_code`, `pickup_code`,
  `customer_access_code`, `applied_offer_id`, `discount_code` continue to
  live in `Order.metadata` JSONB.** They are accessible but not
  indexable; promote to columns when they need to be queryable in
  reports or filters.
- **Production marketplace adapters (Uber Eats / Deliveroo / Just Eat /
  HubRise) are NOT reconnected by this phase.** Test orders flow
  end-to-end via `POST /v1/orders/test` and through the canonical
  pipeline; live platform ingest is out of scope.
- **POS / Menu / Menu Manager / KDS / Team Roles / Locations tabs are
  out of scope.** The Orders tab and Printer-Job compatibility are the
  only operational surfaces rebuilt in Phase AJ.

---

## Phase AA Staging Limitations

- **First staging deployment not yet executed**: Phase AA commits the infrastructure fixes and documentation. The actual Render deploy is pending. `STAGING_DEPLOYMENT_STATUS.md` will be updated with live URLs once the deployment completes.
- **`DIRECT_URL` now required at startup**: The Prisma schema now requires `DIRECT_URL` to be set (direct Postgres connection for migrations). If not set, `start-api.sh` will fail with `ERROR: DIRECT_URL is not set`. For local dev, `DIRECT_URL` should equal `DATABASE_URL`. For Supabase: port 5432 direct URL.
- **`shadowDatabaseUrl` removed from schema**: `prisma migrate dev` (local migration creation) will no longer use a shadow database unless `SHADOW_DATABASE_URL` is set locally. This is intentional — Supabase managed databases don't support shadow databases. Add `SHADOW_DATABASE_URL` to local `.env` if you need `migrate dev`.
- **Provider sandbox webhooks not registered**: Uber Eats and Deliveroo sandbox webhook URLs need to be registered in developer portals before sandbox testing works. See `RENDER_SETUP.md` Step 9 (Webhook URLs).
- **Stripe webhook not registered**: The Stripe webhook endpoint at `/api/v1/webhooks/stripe` exists but the endpoint URL needs to be registered in the Stripe Dashboard for webhook events to arrive.
- **Worker job deduplication not end-to-end tested on staging**: Bull queue deduplication logic is unit-tested but has not been verified against a live Upstash instance under concurrent load.

---

## Phase Z Infrastructure Limitations

- **Render starter plan sleeps on free tier**: Render free-tier services sleep after 15 minutes of inactivity. Upgrade to a paid Render account or use an uptime monitor to avoid cold starts. The `starter` plan on a paid account does not sleep.
- **Supabase free tier pauses**: Supabase free projects pause after 7 days of inactivity. Upgrade to Supabase Pro for always-on staging/production.
- **No internal Render networking for Upstash**: Upstash Redis is accessed over TLS via public internet. This adds ~5–10ms latency vs. co-located Redis. Acceptable for current load. Mitigate with co-located Redis if latency becomes a concern.
- **Single Upstash instance for all Redis uses**: Staging uses one Upstash database for both `REDIS_URL` and `QUEUE_REDIS_URL`. For production, consider separate instances to isolate queue backpressure from real-time Socket.IO adapter traffic.
- **Socket.IO multi-instance not verified in staging**: The Render Blueprint sets `numInstances: 1`. Socket.IO uses Redis adapter for multi-instance pub/sub, but this has not been load-tested with >1 API instance.
- **Docker build not triggered on `claude/**` branches in production-deploy.yml**: `production-deploy.yml` runs on `main` only (manual dispatch). `ci.yml` now includes `claude/**` for CI but Docker build validation still only runs on PRs and main/develop.
- **CI docker-build skipped on `claude/**` pushes**: The `docker-build` job has an `if` condition that skips on non-PR, non-main, non-develop pushes. Docker validation therefore does not run on `claude/**` branches — run `docker build` locally if making Dockerfile changes.
- **`noUncheckedIndexedAccess` not enabled** *(carried forward)*: See Phase X/Y section.
- **`StoreStatusPayload` too narrow** *(carried forward)*: See Phase X/Y section.

---

## Phase X / Y Limitations

- **Just Eat not production-validated**: *Carried forward from Phase Q.* `just-eat.adapter.ts` and status sync code exists and is unit-tested but has NEVER been tested against Just Eat's live or sandbox API. Do NOT activate any Just Eat integration (`Integration.status = ACTIVE`) until P0-1 validation is complete (see `PROVIDER_IMPLEMENTATION_PLAN.md`).
- **HubRise not production-validated**: *Carried forward from Phase Q.* HubRise code exists but no shop has used it in production. First HubRise shop requires sub-pilot treatment. See `PROVIDER_IMPLEMENTATION_PLAN.md` P0-2.
- **Just Eat dueDate hardcoded**: `PUT /orders/:id/accept` always sends `dueDate = now + 30min`. Should use `location.currentPrepTime`. Fix: P0-3 in `PROVIDER_IMPLEMENTATION_PLAN.md`.
- **MenuItem.brand relation missing**: `MenuItem` model in Prisma schema has `brandId String` but no `brand Brand @relation(...)`. Phase X fixed the access control queries to use a two-step lookup via `Brand.findFirst`. A future schema migration should add the relation explicitly to simplify queries and enforce FK at the ORM level.
- **StoreStatusPayload is too narrow**: `StoreStatusPayload` in `events.types.ts` requires `locationName` and `status` fields but `StoreOpsService` emits richer objects. Phase X added `as any` casts. The shared type should be updated to match the actual emitted shape in Phase Z.
- **Smoke test uses `@prisma/client` directly**: `smoke-test.ts` imports `PrismaClient` from `@prisma/client` (default path) rather than the workspace `@orderhub/database` package. This works at runtime but requires that `prisma generate` has been run in the project root. Phase Y: added `as any` casts for `outboxEvent` to handle stale type resolution.
- **TypeScript `noUncheckedIndexedAccess` not enabled**: Arrays accessed via `[0]` may return `undefined` at runtime. Phase X applied `!` non-null assertions on known-safe accesses. Consider enabling `noUncheckedIndexedAccess` in tsconfig in Phase Z.

---

## Provider Limitations

### Uber Eats
- **Courier lifecycle events**: Webhooks for courier_assigned, courier_arriving, courier_picked_up, courier_enroute are received but not extracted as actionable events. These are informational only on Uber's side — no restaurant action is required.
- **Order completed webhook**: When Uber marks an order complete on their side, no lifecycle call is expected from the restaurant.
- **Store availability API**: Requires Uber Eats POS Partner status. Not implemented.
- **Menu sync to Uber**: Not implemented. Menu changes must be made in Uber Eats directly or via HubRise.
- **Rate limit (429) Retry-After header not parsed**: ~~Resolved in Phase O/P correction — `parseRetryAfterMs()` added to all sync clients. `rateLimitAwareBackoff` registered on ORDER_SYNC Bull queue. STATUS_CHANGE jobs use `rate-limit-aware` backoff type. Retry-After header now actually drives retry delay, not just logs it.~~

### Deliveroo
- **Store open/close**: Deliveroo's availability API requires POS Partner approval. Endpoint not implemented.
- **Item pause/unpause**: Requires POS Partner approval. Not implemented.
- **Menu publish**: Not implemented via Deliveroo direct API. Use HubRise for menu sync.
- **Rate limit response parsing**: 429 responses from Deliveroo are caught as errors and retried via Bull backoff. No explicit Retry-After header parsing.

### Just Eat / Takeaway
- **Store open/close**: Not implemented.
- **Item availability**: Not implemented.
- **Due date calculation**: Accept sends dueDate = now + 30 minutes. This is not configurable per-location yet.

### HubRise
- **Menu import from HubRise**: Not implemented. Menu must be built in OrderHub directly.
- **Menu publish to HubRise**: Not implemented.
- **Item availability sync**: Not implemented.
- **Customer deduplication**: HubRise customers are mapped but not deduplicated against existing CustomerProfile records.

---

## Implementation Gaps

### Order Schema
- `paymentMethod` field referenced by the Cashier page is not stored on the Order model. The cashier payment selection updates UI state only — it is not persisted to the database.
- `isSandbox` flag used by SandboxService may not exist in the current Prisma schema. Add `isSandbox Boolean @default(false)` to the Order model before using sandbox order generation.

### Location Schema  
- `shopCode` field used by the Flutter printer polling endpoint may not exist in the current schema. Add `shopCode String?` to the Location model.

### Print Job Status
- Status `QUEUED` is used in the DB but `PRINT_JOBS` queue constant uses lowercase names (e.g. `"receipt"`). The mismatch between the DB status enum and the queue job name is intentional and correctly handled.

### Audit Log Coverage
- Marketplace sync audit events (sync.attempted, sync.succeeded, sync.failed) are logged in the worker but the worker doesn't have access to AuditLogService directly (it's in the API). Worker logs structured messages instead. Full audit trail for sync events requires publishing to the audit log via a shared event bus or direct DB write from the worker.

### Printer Heartbeat
- The `isActive` field on Printer is used to filter printers for heartbeat probing. If this field doesn't exist in the schema, the heartbeat query will fail. Add `isActive Boolean @default(true)` to the Printer model.

---

## Security Notes

- Printer job polling endpoint (`GET /v1/printerJobs`) is `@Public()` authenticated only by `shop_code`. This is intentional to support the Flutter app without requiring JWT, but it means anyone who knows a `shop_code` can enumerate print jobs for a location. Consider adding a static API key mechanism for the Flutter app in a future iteration.
- The `PATCH /v1/printerJobs/:id` endpoint is also public for the same reason.

---

## Pending Provider Approvals

| Provider | Action | Status |
|----------|--------|--------|
| Deliveroo | Store availability API access | Pending POS Partner approval |
| Deliveroo | Menu management API access | Pending POS Partner approval |
| Just Eat | Store availability API access | Not requested |
| Uber Eats | Menu management API access | Not requested |

---

## Future Work

1. **WebSocket reconnection**: The frontend does not implement automatic WebSocket reconnection with exponential backoff. Orders may go stale if the socket drops.
2. **Menu sync bidirectional**: Currently one-way (platform → OrderHub). Publishing menu changes back to platforms is not implemented.
3. **Multi-store analytics**: Cross-location reports are not scoped correctly — they aggregate all locations for the tenant regardless of user permissions.

> Items 1 and 2 from the original list (outbox pattern, credential encryption) were resolved in Phase J.
> Item 6 (test coverage) was resolved across Phases I–K — 122 tests now passing.

---

## Phase R Limitations

- **BillingGuard not globally applied**: *Resolved in Phase S* — BillingGuard registered as APP_GUARD. All critical trading endpoints have `@BillingExempt()`.
- **Grace period expiry not automated**: *Resolved in Phase S* — hourly cron moves PAST_DUE → UNPAID.
- **Usage not reported to Stripe**: *Partially resolved in Phase S* — daily cron aggregates usage into `usage_records`. Stripe metered billing reporting is still not wired (Phase W).
- **FREE_PILOT conversion not automated**: *Resolved in Phase S* — daily cron moves FREE_PILOT → TRIALING after trialEndsAt (not ACTIVE).
- **Payment method status not synced**: *Resolved in Phase U* — `customer.updated` and `customer.subscription.updated` webhooks sync `paymentMethodStatus`.
- **Stripe not configured in test/staging**: StripeService lazy-loads and `isConfigured` returns false when key absent. No startup failure. Use test keys in staging.
- **Pilot shop notice not yet sent**: Written notice must be sent to 5 pilot shops before 2026-08-01 explaining transition from FREE_PILOT to Starter tier on 2026-09-01.

## Phase W Limitations

- **`nest build` exits non-zero due to pre-existing TS errors**: `analytics.service.ts`, `branding.service.ts`, `redis-subscriber.service.ts`, and `onboarding.service.ts` have Prisma schema-lag errors that predate Phase R. Resolve by running `prisma migrate deploy && prisma generate` before building in CI/CD. The billing module is clean.
- **ESLint v9 config missing**: ESLint v9 requires `eslint.config.js` but only `.eslintrc.*` config exists (removed in ESLint v9). Billing files pass manual review. Migrate config in Phase X.
- **`usage.service.ts` isSandbox Prisma lag**: *Resolved in Phase W* — `as any` spread applied. Will resolve cleanly after `prisma generate` with full schema.

## Phase V Limitations

- **Menu publish not billing-gated for UNPAID tenants**: `MenusController` has no `BillingGuard` integration. Publishing menus for UNPAID tenants is not restricted. Phase W.
- **Integration CRUD not audited against plan limits**: Connecting a new provider isn't checked against plan feature flags in `IntegrationsController`. Phase W.
- **No email notification on payment failure**: UNPAID tenants receive Stripe's default payment failure email (if configured in Stripe dashboard) but OrderHub sends no custom notification. Staff may not know access is restricted. Phase W.
- **Stripe metered usage not reported to Stripe**: Usage is tracked internally in `usage_records` but not sent to Stripe's metered billing API. Billing is flat-rate only for now. Phase W.
- **Mass rollout controls not enforced in code**: The 2-per-day activation limit and pre-activation checks in `PAID_ROLLOUT_PLAN.md` are process controls only — not enforced in code. Phase W.
- **Just Eat not production-validated**: *Still unresolved from Phase Q.* Do not set Just Eat Integration.status = ACTIVE for any new paid customer until a production-level webhook exchange is validated.
- **HubRise not production-validated**: *Still unresolved from Phase Q.* Do not activate paid customers using HubRise as their primary provider until validated.

## Phase Q Limitations

- **Just Eat not production-validated**: The Just Eat webhook adapter exists and is unit-tested but was NOT activated in any Phase Q shop. Shops must NOT set Just Eat Integration.status = ACTIVE until a production-level webhook exchange is validated. Phase R: schedule validation with Just Eat API team before onboarding Just Eat shops.
- **Star printer character width fixed (Q-001)**: *Resolved in Phase Q* — `escpos.formatter.ts` now uses printer-type-aware character width (42 chars for Epson, 32 chars for Star). Always test a new printer model's receipt format with a real menu before go-live. Pre-go-live checklist updated.
- **Integration status has no `PENDING_APPROVAL` state**: Only `ACTIVE` and `INACTIVE` exist. Staff cannot distinguish "deliberately not connected" from "connected but failing". Phase R: add `PENDING_APPROVAL` enum value to `IntegrationStatus`.
- **WebSocket reconnection not implemented**: Orders page does not auto-reconnect on WebSocket drop. Staff must manually refresh. Print still fires correctly regardless. Phase R: implement reconnection with exponential backoff.
- **Rollout overview requires manual refresh**: Point-in-time snapshot. No push notification. During go-live monitoring, poll every few minutes manually.
- **paymentMethod not persisted**: Cashier page payment method updates UI only — not stored on Order model.
- **Multi-shop analytics cross-contamination**: Cross-location reports aggregate all tenant locations regardless of user permissions. Do not expose cross-location analytics to STAFF role until scoped correctly.
- **HubRise order flow not production-tested**: HubRise webhook adapter exists and is tested but no Phase Q shop used HubRise. First HubRise shop must be treated as a sub-pilot with close monitoring.

## Phase P Limitations

- **Just Eat not production-validated**: *Confirmed in Phase Q — still not activated.* See Phase Q Limitations.
- **Star printer (Shop 3) not yet production-tested**: *Resolved in Phase Q* — Star TSP654II deployed at Shop 3, character width fix applied Day 1 (Issue Q-001).
- **Rollout overview requires manual refresh**: *Still true in Phase Q.*
- **paymentMethod not persisted**: *Still true — Phase R work.*
- **Multi-shop analytics cross-contamination**: *Still true — Phase R work.*

## Phase O Limitations

- **Provider rate-limit does not override Bull backoff delay**: ~~`Retry-After` is parsed and logged but Bull's exponential backoff governs actual retry timing.~~ *Resolved in Phase O correction* — `rateLimitAwareBackoff` strategy registered on ORDER_SYNC queue. STATUS_CHANGE jobs use `rate-limit-aware` backoff type. Retry-After header now drives the actual retry delay. Exponential backoff is the fallback when no Retry-After is present.
- **Staff health panel requires explicit locationId query param**: Staff must know their locationId for `GET /v1/health/staff-status?locationId=X`. The dashboard frontend does not yet surface this as a one-click link. Future work: add a status badge to the Orders page header.
- **Paper jam is not electronically detectable**: When a paper jam occurs the printer goes offline (detectable) but the root cause (jam vs. cable vs. power) cannot be determined remotely. Staff must physically inspect.

## Phase N Limitations

- **Printer offline detection was reactive**: *Resolved in Phase O* — `lastHeartbeatAt` is written to `Printer.metadata` on every probe. Readiness engine and staff health panel detect stale heartbeats (> 90s). Confirmed working (Phase O Issue O-001).
- **Uber Eats 429 Retry-After not parsed**: *Resolved in Phase O* — `parseRetryAfterMs()` added to all four sync clients. Retry-After header is parsed (integer seconds or HTTP-date), logged as structured WARN, and retryAfterMs returned in `SyncResult`. See Phase O Limitations for the remaining Bull backoff caveat.
- **No automated escalation for P2 issues**: *Partially resolved* — P2 escalation protocol added to `PILOT_ISSUES.md`. No automated alerting yet.
- **Restaurant staff cannot see outbox health**: *Partially resolved in Phase O* — Staff health panel added at `GET /v1/health/staff-status`. Shows printer status, provider connection, and action required. Outbox internals remain admin-only.

---

## Phase M Limitations

- **Emergency pause is not automated**: When a critical issue is detected (e.g. dead outbox events increasing rapidly), the location is not automatically paused. An operator must take manual action via the Go-Live Wizard or API. Future work: add a scheduled job that auto-pauses LIVE locations with > N dead events.
- **Provider store open/close not implemented**: Pausing a location in OrderHub does not signal to providers (Uber Eats, Deliveroo) to pause the store on their platform. Staff must also pause the store in each provider's tablet app or dashboard. This is a known limitation for the pilot phase.
- **Menu availability sync is one-way**: Marking an item unavailable in OrderHub does not sync to providers. Staff must also remove/pause the item in each provider's portal or app.
- **No pilot-specific observability dashboard**: There is no dedicated pilot monitoring page. Operators use the Go-Live Wizard, Bull Board, and the release readiness endpoint to monitor the pilot location.

---

## Phase L Limitations

- **Smoke test requires Redis client library**: The smoke test (`apps/api/src/scripts/smoke-test.ts`) imports `createClient` from `redis`. If this package is not in the runtime environment, the Redis check will fail. Install `redis` as a dev dependency if running the smoke test outside the app container.
- **Monitoring is documentation-only**: `MONITORING_AND_ALERTS.md` defines alert thresholds and investigation steps but does not wire up alerting infrastructure (Datadog/PagerDuty/etc.). Operators must configure their own alert rules against the health endpoint.
- **Backup schedule is manual**: `BACKUP_AND_RECOVERY.md` provides the backup commands but does not add automated backup cron jobs. Use managed Postgres (RDS, Supabase, etc.) or configure cron separately.
- **`ProductionStartupService` does not check plaintext credentials**: The startup guard validates connectivity but does not query the database for unencrypted credentials. Use the smoke test or release readiness endpoint for that check.

---

## Phase K Limitations

- **Readiness score not cached**: `getLocationReadiness` is computed on every request. For a location list with many locations, individual scores are returned as `null` and computed on drill-down. A cache layer (Redis, 60s TTL) would improve the wizard's initial load.
- **Go-live wizard is admin-only**: The frontend wizard is scoped to `PLATFORM_ADMIN` role. Tenant owners can call the API directly but have no dedicated UI yet.
- **No email notifications on status change**: When a location transitions to `LIVE` or `BLOCKED`, no notification is sent to the tenant owner. Integrate with `NotificationsModule` in a future iteration.
- **No scheduled readiness polling**: The wizard shows a point-in-time readiness snapshot. There is no background job that periodically re-checks LIVE locations and auto-transitions to `BLOCKED` on degradation.
