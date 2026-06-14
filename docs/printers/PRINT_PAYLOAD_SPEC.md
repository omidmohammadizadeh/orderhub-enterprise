# Print Payload Spec

`PrintJob.payload` is **always** structured JSON. The API never
generates raw ESC/POS — that conversion lives in each client
(server-direct, web bridge, Flutter, future cloud-print). This is
the only thing that makes "one API for every client" possible.

## Common envelope

```jsonc
{
  // KITCHEN_TICKET | CUSTOMER_RECEIPT | DRIVER_SLIP | DISPATCH_TICKET | LABEL | TEST_PRINT
  "kind": "CUSTOMER_RECEIPT",
  "orderNumber": "1042",
  "customerName": "Omid",
  "fulfillmentType": "DELIVERY",   // DELIVERY | PICKUP | DINE_IN
  "receivedAt": "2026-06-14T09:31:00Z"
}
```

## CUSTOMER_RECEIPT

```jsonc
{
  "orderNumber": "1042",
  "customerName": "Omid",
  "fulfillmentType": "DELIVERY",
  "receivedAt": "2026-06-14T09:31:00Z",
  "items": [
    {
      "name": "Pepperoni Pizza 12\"",
      "quantity": 1,
      "modifiers": [
        { "name": "Extra cheese", "quantity": 1, "price": 1.50 }
      ]
    }
  ],
  "subtotal": 12.50, "tax": 0, "delivery": 2.50, "discount": 0, "total": 15.00,
  "paymentMethod": "CARD",
  "paymentStatus": "PAID"
}
```

## KITCHEN_TICKET

```jsonc
{
  "stationName": "Pizza Station",
  "orderNumber": "1042",
  "customerName": "Omid",
  "fulfillmentType": "DELIVERY",
  "receivedAt": "2026-06-14T09:31:00Z",
  "items": [
    { "name": "Pepperoni Pizza 12\"", "quantity": 1,
      "modifiers": [{ "name": "Extra cheese" }],
      "notes": "Well done please" }
  ]
}
```

## DRIVER_SLIP

```jsonc
{
  "orderNumber": "1042",
  "customerName": "Omid",
  "customerPhone": "07700 000000",
  "address": {
    "line1": "5 Sunningdale Drive",
    "line2": null,
    "city": "Washington",
    "postcode": "NE37 2LL"
  },
  "total": 15.00,
  "paymentMethod": "CARD",
  "paymentStatus": "PAID"
}
```

## TEST_PRINT

```jsonc
{
  "kind": "TEST_PRINT",
  "logoUrl": null,
  "printerName": "Kitchen Printer A",
  "locationName": "Pizza Uno Pelton",
  "locationAddress": "5 Sunningdale Drive, NE37 2LL",
  "datetime": "2026-06-14T09:31:00Z",
  "message": "Order Hub test print — if you can read this, your printer is wired correctly.",
  "qrCode": "https://orderhubsolutions.com/printers/prn_xxx",
  "openCashDrawer": true,
  "paperWidth": 80
}
```

## Rendering hints

- 80mm thermal ≈ 42 monospace cols (font A).
- 58mm thermal ≈ 32 cols.
- Right-align totals; bold + double-size for `TOTAL`.
- Cut at end (`GS V B \0`).
- Open cash drawer pin 2 (`ESC p \0 \x40 \xc8`) only when both
  `openCashDrawer` in the payload AND `Printer.supportsCashDrawer`
  are true.
