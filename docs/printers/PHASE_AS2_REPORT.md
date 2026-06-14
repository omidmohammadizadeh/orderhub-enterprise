# Phase AS-2 — Print Lifecycle Integration

Status: shipped 2026-06-14 on branch `claude/xenodochial-brahmagupta-5521f8`.

## What landed

1. **Order lifecycle integration.** `OrdersService.updateStatus` now
   calls `PrintJobsService.createFromOrder({ trigger })` on every
   non-terminal status transition:
   - `PENDING → ACCEPTED` → `ORDER_ACCEPTED`
   - `ACCEPTED → PREPARING` → `ORDER_PREPARING`
   - anything → `READY` → `ORDER_READY`
   The pre-existing legacy `printQueue.enqueueForNewOrder` path stays
   on for the Bull-backed POS receipt pipeline; both layers coexist
   until AS-3 retires the legacy queue.
2. **Scheduled-order guard.** `createFromOrder` short-circuits when
   the trigger is `ORDER_RECEIVED` and `scheduledFor / scheduledAt`
   is more than 5 minutes in the future. A separate cron (Phase AS-3)
   will wake those up at the scheduled time.
3. **Auto-print rule evaluator.** Per-printer `autoPrintRules` JSON
   `[{ trigger, copies }]` decides whether to emit a job. Receipts
   and driver slips bypass the filter because their printer is
   already opted in via `Location.receiptPrinterId / dispatchPrinterId`.
4. **Server-direct LAN printing.** `ServerDirectPrintCron` ticks
   every 2 seconds and drains QUEUED jobs targeting printers with
   `agentId IS NULL AND supportsLan = true`. Renders the JSON
   payload via the new `escpos-renderer.ts`, writes to TCP port
   9100. No client install required.
5. **Retry + dead-letter.** `PrintJob` gained `nextRetryAt`,
   `failureReason`, `lastError`, `deadLetteredAt`. Exponential
   backoff (1s → 4s → 9s → … cap 60s). `RETRYING` rows promote
   back to `QUEUED` via the housekeeping cron when their
   `nextRetryAt` elapses. Jobs that exhaust `maxRetries` (default 3)
   land in `FAILED` with `deadLetteredAt` set — never auto-retry,
   always available for manual reprint via the operator UI.
6. **Agent telemetry.** `PrintAgent` gained `osType`, `hostname`,
   `printerCount`. `detectOfflineAgents()` flips agents stale at the
   90s threshold and emits `printer:agent:offline`.
7. **Printer capabilities columns.** `Printer` gained
   `supportsBluetooth`, `supportsUsb`, `supportsLan`,
   `supportsEscPos`, `supportsQrCode`, `supportsImages` — typed
   columns the Flutter client can read without parsing JSON.
8. **WebSocket events.**
   - `printer:job:created` — on every new PrintJob row
   - `printer:job:updated` — on every lifecycle transition
   - `printer:agent:online` — when an agent that had been offline
     phones home with a heartbeat
   - `printer:agent:offline` — when the 90s threshold trips
9. **ESC/POS renderer.** `escpos-renderer.ts` is one transport
   adapter; Flutter, macOS bridge, future cloud-print each
   implement the same JSON → bytes contract.

## Notes for future phases

- The Flutter app will not need to reimplement routing logic —
  `PrintRoutingService.resolveForOrder` does that server-side and
  Flutter only ever consumes the rendered `PrintJob` rows via the
  agent claim API.
- The legacy `PrintQueueService` Bull pipeline is still wired but
  unused for new printers. AS-3 will drain it and remove.
- ESC/POS renderer covers Epson TM-m30 / Star TSP100/143 / Sunmi /
  generic 80mm thermal. Star StarPRNT and other proprietary
  protocols will plug in later when needed.

## Tests run

API typecheck clean. Prisma schema validates. Migration applied
locally.

## Files

```
packages/database/prisma/migrations/20260614100000_phase_as2_print_lifecycle/
apps/api/src/modules/printers/escpos-renderer.ts
apps/api/src/modules/printers/server-direct.cron.ts
apps/api/src/modules/printers/print-jobs.service.ts     (extended)
apps/api/src/modules/printers/print-agents.service.ts   (extended)
apps/api/src/modules/printers/printer-heartbeat.cron.ts (extended)
apps/api/src/modules/orders/orders.service.ts           (trigger fan-out)
docs/printers/{PHASE_AS2_REPORT,PRINT_AGENT_PROTOCOL,PRINT_PAYLOAD_SPEC,LAN_PRINTING,PRINTER_HEARTBEAT,OFFLINE_PRINTING_PLAN}.md
```
