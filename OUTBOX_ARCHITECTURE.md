# Transactional Outbox Architecture

> Phase I — Production Safety

## Why the Outbox Pattern?

Before Phase I, `OrdersService` wrote the order to the database and then immediately called `orderQueue.add(...)` to enqueue a Bull job. If the process died between the DB write and the `queue.add`, the order was created but no downstream processing (print jobs, KDS tickets, platform sync) ever happened.

The transactional outbox pattern eliminates this window by writing the "intent to process" into the database **in the same transaction as the order itself**. A separate dispatcher then reliably moves the event to the queue.

---

## Table Schema

```prisma
model OutboxEvent {
  id             String            @id @default(cuid())
  tenantId       String
  locationId     String
  aggregateType  String            // "order"
  aggregateId    String            // orderId
  eventType      String            // see Event Types below
  payload        Json              // data needed by the dispatcher
  status         OutboxEventStatus @default(PENDING)
  attempts       Int               @default(0)
  maxAttempts    Int               @default(10)
  nextAttemptAt  DateTime?         // null = ready immediately
  processedAt    DateTime?
  lastError      String?
  idempotencyKey String            @unique
  createdAt      DateTime          @default(now())
  updatedAt      DateTime          @updatedAt
}

enum OutboxEventStatus {
  PENDING     // waiting to be dispatched
  PROCESSING  // claimed by dispatcher, being dispatched now
  PROCESSED   // successfully enqueued to Bull
  FAILED      // dispatch failed, will retry
  DEAD        // maxAttempts reached, no more retries
}
```

---

## Event Types

| eventType | Trigger | Payload fields | Dispatches to |
|-----------|---------|---------------|---------------|
| `order.received` | New order created via any path | orderId, tenantId, locationId | ORDER_PROCESSING queue, INGEST job |
| `order.status_changed` | Order status transition | orderId, tenantId, locationId, fromStatus, toStatus, cancelReason? | ORDER_PROCESSING queue, STATUS_CHANGE job |

---

## Processing Flow

```
API creates order
    │
    ├─ prisma.$transaction([
    │     order.create(...),
    │     outboxEvent.create({ eventType: 'order.received', ... })
    │  ])
    │
    └─ Socket emit (best-effort, immediate — UI update only)

Every 5 seconds: OutboxDispatcherCron.dispatch()
    │
    ├─ SELECT ... FOR UPDATE SKIP LOCKED LIMIT 50
    │  (atomically claims pending events)
    │
    ├─ For each claimed event:
    │     ├─ Dispatch to Bull queue with deterministic jobId
    │     ├─ On success: update status = PROCESSED
    │     └─ On failure: update status = FAILED, increment attempts,
    │                    set nextAttemptAt with exponential backoff
    │
    └─ Events with attempts >= maxAttempts → status = DEAD
```

---

## Idempotency Rules

### Order received
- Key: `recv-{platform}-{externalId}`
- Matches the order's own `(externalId, platform)` uniqueness constraint
- If the order creation fails (P2002), no outbox event is created (transaction rolls back)
- If both succeed but the HTTP response is lost and the webhook is replayed: the second transaction fails on P2002, and the existing outbox event is not duplicated

### Status changed
- Key: `status-{orderId}-{toStatus}`
- The state machine guarantees each target status is reached at most once per order
- Optimistic concurrency in `updateStatus` prevents two concurrent requests from creating duplicate status-change events

### Bull job IDs
- INGEST job: `ingest-{orderId}` — Bull deduplicates by jobId
- STATUS_CHANGE job: `status-{orderId}-{toStatus}` — same deduplication

---

## Retry Strategy

| Attempt | Delay |
|---------|-------|
| 1 | 30 seconds |
| 2 | 2 minutes |
| 3 | 8 minutes |
| 4 | 32 minutes |
| 5+ | capped at 1 hour |

Formula: `Math.min(30 * 4^attempt, 3600)` seconds.

After `maxAttempts` (default 10) the event moves to `DEAD` and requires manual intervention.

---

## Failure Handling

**FAILED events**: Will be retried automatically on the next dispatcher tick after `nextAttemptAt`.

**DEAD events**: Will not be retried. Alert on these. To reprocess a dead event:
1. Identify the dead outbox event ID
2. Reset: `UPDATE outbox_events SET status = 'PENDING', attempts = 0, next_attempt_at = NULL WHERE id = '...'`
3. The dispatcher will pick it up on the next tick

**PROCESSING events that are stuck**: These indicate a dispatcher crash mid-flight. After a reasonable timeout (e.g. 10 minutes), reset these to PENDING for retry:
```sql
UPDATE outbox_events SET status = 'PENDING'
WHERE status = 'PROCESSING'
  AND updated_at < NOW() - INTERVAL '10 minutes';
```

---

## Concurrency Safety

The dispatcher uses `SELECT ... FOR UPDATE SKIP LOCKED` in PostgreSQL to safely claim events across multiple API instances without double-dispatching.

Bull's deterministic job IDs (`jobId: 'ingest-...'`) provide a second layer — even if two dispatcher instances somehow claim the same event, only one Bull job is created.

---

## Monitoring

The dispatcher exposes `getStats()` which is surfaced in `/v1/health/release-readiness`:

- `outboxPending` — events waiting to be dispatched
- `outboxProcessing` — events currently being dispatched
- `outboxFailed` — events that failed at least once (will retry)
- `outboxDead` — events that exhausted all retries (needs manual attention)
- `outboxOldestPendingAgeMs` — age of the oldest pending event (alert if > 5 minutes)

Warnings are added to the release readiness response when:
- `dead > 0`
- `failed > 5`
- `oldestPendingAgeMs > 5 minutes`
