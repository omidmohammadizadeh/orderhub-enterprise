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

1. **Transactional Outbox**: Order creation + queue enqueue are not atomic. A server crash between DB create and queue.add could result in an order with no downstream processing. Implement the outbox pattern.
2. **Credential encryption**: Integration credentials are stored as plaintext JSON in the database. Encrypt at-rest using field-level encryption before production.
3. **WebSocket reconnection**: The frontend does not implement automatic WebSocket reconnection with exponential backoff. Orders may go stale if the socket drops.
4. **Menu sync bidirectional**: Currently one-way (platform → OrderHub). Publishing menu changes back to platforms is not implemented.
5. **Multi-store analytics**: Cross-location reports are not scoped correctly — they aggregate all locations for the tenant regardless of user permissions.
6. **Jest test coverage**: Current test coverage is limited to auth module. Order lifecycle, webhook deduplication, and printer job tests exist as specs but may need updating.
