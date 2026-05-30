# POS Operator Guide

The POS tab is at **Dashboard → POS**. Pick a location with the location selector top-right.

## Layout

* **Left** — category tabs, product grid, search.
* **Right** — cart panel with everything else: customer, address, timing, discounts, promo, payment, totals, submit.

## Building an order

1. **Pick a category** — tap the chip to switch.
2. **Tap a product** — items with modifiers / multiple SKUs open the modifier modal. Simple items add straight to the cart.
3. **Adjust qty** in the cart with the `−`/`+` buttons. Trash icon removes a line.
4. **Fill customer details** — Name and Phone. If a caller-ID integration is wired, the Caller ID field is auto-populated; otherwise it's a free-text capture field.
5. **Order type** — Collection (default) or Delivery.

## Delivery orders

There are **three ways** to fill in a delivery address:

1. **Postcode lookup (UK Royal Mail PAF)** — type the postcode and tap **Find**. A list of every address at that postcode appears below — tap one to fill line 1 / line 2 / city / postcode in one go. The operator just adds a flat number or buzzer code on top. Requires `GETADDRESS_API_KEY` on the API.
2. **Free-text autocomplete** — the search box at the top of the address block suggests as you type (Mapbox). Requires `MAPBOX_ACCESS_TOKEN`.
3. **Manual entry** — always available. Type line 1, line 2, city, postcode directly.

The first two are wholly optional — if no API keys are configured the POS still works with manual entry, no errors surfaced.

* **Postcode fee lookup** (delivery zone) runs automatically as you type the postcode. The zone tag underneath shows the match (e.g. "Zone SW1 — £2.50 (min order £15.00)").
* **Manual fee override** lets you charge a custom delivery fee for this order only — useful for last-minute "I'm just round the corner" judgement calls.

## Timing

* **Expected time** — quick chips for ASAP, 15, 30, 45, 60 minutes, or type a custom number.
* **Schedule for later** — tick the box and pick a date + time. The order is saved at **PENDING** with `scheduledAt` set, lands in the Scheduled section of the Orders board, and does NOT print yet.

## Discounts

* **10% off** / **20% off** — applies to subtotal. Stored as `discountType=PERCENT_10` / `PERCENT_20` with the computed amount in the order's `promoDiscount`.
* **Free delivery** — sets delivery fee to £0 for this order; the original zone fee is still recorded in metadata for audit.

## Promo codes

* Type the code → hit **Apply**.
* Validated against:
  * Code exists, active, not expired, within start window
  * Usage cap not reached
  * Minimum spend met
  * Location scope (a code can be limited to a subset of locations)
* If valid, the discount is shown in green: "−£X off (CODE)" or "Free delivery applied".
* `usedCount` is only incremented when the order is **actually created** — abandoned carts don't burn a use.

## Payment

| Method | Behaviour |
|---|---|
| **Cash** | Default. `paymentStatus = PENDING` on submit. |
| **Card terminal** | Cashier confirms payment on a real terminal. `paymentStatus = PAID`. |
| **Online card** | Disabled offline. Requires a payment provider integration (Stripe / Dojo / Adyen / Worldpay). |
| **External** | Other / cheque / account / bank transfer. `paymentStatus = PENDING`. |

## Submit

The green button reads **"Place order"** for immediate orders or **"Save scheduled order"** when the schedule toggle is on.

* Immediate orders are auto-accepted on submit (`PENDING → ACCEPTED`), which fires the PrinterJob pipeline.
* Scheduled orders stay at `PENDING` and appear in the Scheduled section of the Orders page with a countdown.

## Offline mode

A yellow banner reading **"Offline mode — cart saved locally, card-online disabled"** appears at the top of the cart panel when the browser is offline. The cart + customer details are persisted to `localStorage` per location, so a refresh or short outage doesn't wipe a half-built order. **Online card payment** is disabled while offline.

For full offline order creation (cash orders queued locally and synced when the network returns), see `OFFLINE_POS_PLAN.md` — that work lands in the next phase.
