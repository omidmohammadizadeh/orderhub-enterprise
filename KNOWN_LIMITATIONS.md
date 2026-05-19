# Known Limitations

> Phase H — Production Validation
> This file documents provider limitations, unsupported actions, pending approvals, and areas needing future work.

---

## Provider Limitations

### Uber Eats
- **Courier lifecycle events**: Webhooks for courier_assigned, courier_arriving, courier_picked_up, courier_enroute are received but not extracted as actionable events. These are informational only on Uber's side — no restaurant action is required.
- **Order completed webhook**: When Uber marks an order complete on their side, no lifecycle call is expected from the restaurant.
- **Store availability API**: Requires Uber Eats POS Partner status. Not implemented.
- **Menu sync to Uber**: Not implemented. Menu changes must be made in Uber Eats directly or via HubRise.
- **Rate limit (429) Retry-After header not parsed**: ~~Resolved in Phase O — `parseRetryAfterMs()` added to all sync clients. 429 responses are now detected and `Retry-After` is parsed and logged. Bull's exponential backoff remains the actual retry mechanism but the delay is now visible in logs.~~

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

## Phase O Limitations

- **Provider rate-limit does not override Bull backoff delay**: `Retry-After` is parsed and logged but Bull's exponential backoff governs actual retry timing. If `Retry-After: 1s` is returned but Bull's minimum backoff is 2s, the retry will be slightly delayed. This is safe and conservative. True `Retry-After`-driven delay scheduling requires BullMQ (Bull v4 does not support `job.moveToDelayed()`).
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
