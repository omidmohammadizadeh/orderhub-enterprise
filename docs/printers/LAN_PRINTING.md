# LAN Printing (SERVER_DIRECT)

For LAN printers without a bound Print Agent, the API itself acts as
the agent. **Zero client install** — operator plugs in an Epson
TM-m30, wires it to the receipt printer slot, prints.

## How it works

```
Order accepted
  → PrintJobsService.createFromOrder(ORDER_ACCEPTED)
    → resolveForOrder() returns PrintTarget[]
      → autoPrintRules filter
        → PrintJob row created (status=QUEUED, printerId, payload)

ServerDirectPrintCron (every 2s)
  → SELECT * FROM print_jobs
    WHERE status='QUEUED' AND printerId IN (lan printers w/ agentId=NULL)
  → claim row (UPDATE WHERE status='QUEUED' — atomic vs agent races)
  → render JSON → ESC/POS bytes (escpos-renderer.ts)
  → TCP connect(host, port=9100) → write(buf) → close
  → status=PRINTED
```

## Printer config example

```
Printer:
  name: "Receipt Printer"
  connectionType: LAN
  ipAddress: 192.168.1.50
  port: 9100              (omit → defaults to 9100)
  paperWidth: 80
  supportsLan: true
  supportsEscPos: true
  supportsCashDrawer: true
  agentId: NULL           ← key: tells the cron to drive it
```

## Failure handling

- TCP connect refused / timeout → `failureReason=printer_offline`,
  printer marked `isOnline=false`, job goes `RETRYING` with
  `nextRetryAt = now + backoff`.
- Backoff: 1s → 4s → 9s → 16s → … capped at 60s.
- After 3 attempts (configurable per job via `maxRetries`) →
  `FAILED` + `deadLetteredAt`.

## When to use a Print Agent instead

- **Bluetooth / USB printers** — API has no path to those transports.
- **Mixed kitchens** that mix LAN with BT/USB — easier to run a
  single agent than split modes per printer.
- **Restaurants with no static LAN address** — the agent dials out
  to the API so the API doesn't need to reach the till PC.

The contract is the same; the agent just owns the same print-job
rows by being the one whose `agentId` is on the printer.

## Tested with

- Epson TM-m30 (LAN). Single-tape ESC/POS over port 9100.
- Generic 80mm thermal printers exposing `RAW 9100`.

Star StarPRNT, EPSON ePOS-Print HTTP, and other proprietary
protocols are NOT covered by this path — they'd plug in via an
agent or a per-vendor server-side adapter later.
