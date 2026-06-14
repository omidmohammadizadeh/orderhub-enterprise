# Offline Printing Plan

This is the contract every client (web bridge, Flutter mobile,
Flutter desktop) implements. The POS itself is already offline-aware
for orders (Phase AM-POS-9); this document covers the **print** side.

## Two queues, not one

| Layer | Outbox | Where |
|---|---|---|
| **Client** | Local SQLite (Flutter) / IndexedDB (web bridge) | The till / device |
| **Server** | `print_jobs` table | The API |

The client queue holds operations the agent **owes the server**:
"I printed job X at 09:31, here's the receipt." The server queue
holds operations the server **owes the agents**: "here's a new job
to print." They sync in opposite directions.

## Client outbox shape

```
pending_operations:
  id              UUID
  method          'POST' | 'PATCH' | 'PUT'
  url             '/v1/print-jobs/:id/complete' …
  body            JSON
  idempotency_key UUID (becomes request header)
  attempts        INT
  last_error      TEXT
  created_at      TS
  next_try_at     TS
```

## Drain loop

```
every 2s while online:
  next = pending_operations.first(next_try_at <= now)
  if !next: return

  res = POST(next.url, next.body,
             headers={ 'Idempotency-Key': next.idempotency_key,
                       'X-Agent-Id': self.agent_id,
                       'X-Agent-Token': self.token })

  if res.ok or res.status in [409, 410]:    # duplicate / gone — both OK
    delete next
  else if res.status >= 500 or network err:
    next.attempts += 1
    next.next_try_at = now + backoff(next.attempts)
    next.last_error = res.body
  else if res.status in [400, 401, 403]:
    next.attempts += 1
    next.last_error = res.body
    if next.attempts >= 5:
      next.status = 'permanent_failed'         # surface in UI
```

## Offline reprint

Even with no network, the operator can reprint locally. The flow:

1. Agent caches the last N PrintJob payloads it printed (e.g. 100
   most recent) in `printed_history`.
2. Reprint button reads from `printed_history`, renders bytes, sends
   to the printer immediately.
3. Once online, agent calls `POST /v1/print-jobs/reprint` to register
   the reprint server-side for audit. Idempotency key
   `reprint:<historical_job_id>:<timestamp>` dedupes if the call
   replays.

## Offline order capture (the POS side)

Phase AM-POS-9 already persists carts to localStorage. To extend
into proper offline orders:

1. POS submits to `pending_orders` table (local).
2. Each row carries `idempotency_key`.
3. Drain loop above sends to `POST /v1/ordering/store/:slug/checkout`
   with the key as the `Idempotency-Key` header.
4. Server's unique constraint on `orders.idempotencyKey` dedupes.
5. PrintJobs fire from the **server** as normal once the order
   lands.

## Edge cases

- **Printer offline + API offline simultaneously.**
  Order captured locally; reprint history doesn't have it yet.
  Operator can still write the order down by hand. Once network
  returns, both queues drain and the kitchen ticket prints
  retroactively.
- **Same order accepted twice while offline** (operator panic-taps).
  Idempotency key on the order create call collapses it — second
  attempt 200s with the existing order id.
- **Bridge crashes mid-print.**
  Server reaper un-claims the job after 60s; another agent (or the
  same one after restart) re-claims and reprints.
