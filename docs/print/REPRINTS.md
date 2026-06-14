# Reprints

## How

Every order row on the Orders board has a printer-icon dropdown:

- Kitchen ticket
- Customer receipt
- Driver slip (delivery only)
- Reprint everything (all of the above that apply)

Each click POSTs to `/v1/print-jobs/reprint`:

```
POST /v1/print-jobs/reprint
{
  "orderId": "cmorder...",
  "types": ["KITCHEN_TICKET", "CUSTOMER_RECEIPT"]
}
```

The endpoint runs the **same routing engine** the original print used —
so reprints land on the same printers even if rules or station
defaults haven't changed. Each requested type produces ONE new
`PrintJob` row with `type=REPRINT` and `payload.reprintOf` set to the
original type, so the audit trail is clear.

## Roles

`MANAGE_PRINT_ROLES` + `STAFF` can reprint. Lower-tier roles
(`DRIVER`) cannot.

## Audit

Reprints never mutate the original PrintJob row. They always create
new rows. Search `print_jobs WHERE type='REPRINT' AND orderId=…` to
get the full reprint history for an order.

## Offline reprint

The Print Bridge also keeps the last 200 successfully printed payloads
in `printed_history` (SQLite) so it can reprint locally if the API is
unreachable. This is not exposed via UI in AS-4 — operator triggers a
reprint via the dashboard, which queues a new PrintJob; the bridge
hands it to the printer either via fresh API claim or directly off the
local cache. See `apps/print-bridge/src/queue/outbox.ts`.
