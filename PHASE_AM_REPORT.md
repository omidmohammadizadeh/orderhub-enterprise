# Phase AM — POS Operational Upgrade

## Scope

Lift the POS from a "create-an-accepted-order" demo into a real takeaway/restaurant tool:

1. Rich customer + caller-ID + notes capture
2. Delivery address + postcode autocomplete + per-location fee lookup
3. Per-zone delivery fee setup (postcode prefix → fee + minOrderValue)
4. Expected prep time chips + custom + scheduled-for-later
5. Scheduled orders that **do not** trigger PrinterJob at create-time
6. Quick discounts (10% / 20% / Free delivery)
7. Promo codes with full validation (active, dates, usage limit, location, min spend)
8. Payment provider abstraction (Cash / Card terminal / Online card / External) — Stripe / Dojo / Adyen / Worldpay placeholders
9. Offline-ready cart persistence (localStorage) + online/offline banner
10. Orders board: dedicated **Scheduled Orders** strip + "Start preparing now"

## Schema changes

Migration `20260530000000_phase_am_pos_operational` (idempotent):

* `orders` — add `addressLine1`, `addressLine2`, `city`, `postcode`, `callerId`, `discountType`, `paymentProvider`, `scheduledAt`. Indexes on postcode, callerId, scheduledAt.
* `delivery_zones` — new table: `(locationId, postcodePrefix, fee, minOrderValue, isActive)` with unique `(locationId, postcodePrefix)`.
* `location_payment_configs` — new table: `(locationId UNIQUE, provider, cashEnabled, cardTerminalEnabled, onlinePaymentEnabled, config JSONB)`.
* `PromoCode` already existed (type / value / minOrderValue / maxUses / usedCount / startAt / expiresAt / isActive / locationIds[]).

## API surface

### New modules

| Module | Endpoints |
|---|---|
| `DeliveryZones` | `GET /v1/delivery-zones?locationId`, `GET /v1/delivery-zones/lookup?locationId&postcode`, `POST /v1/delivery-zones`, `PATCH /v1/delivery-zones/:id`, `DELETE /v1/delivery-zones/:id` |
| `PromoCodes` | `GET /v1/promo-codes`, `POST /v1/promo-codes`, `PATCH /v1/promo-codes/:id`, `DELETE /v1/promo-codes/:id`, `POST /v1/promo-codes/validate` |
| `AddressLookup` | `GET /v1/address-lookup/status`, `GET /v1/address-lookup/search?q&country&limit` (typeahead via Mapbox), `GET /v1/address-lookup/postcode?postcode` (UK Royal Mail PAF via getaddress.io — list every address at a postcode) |

### Orders module extensions

* `CreateOrderDto` gains: `callerId`, `preparationMinutes`, `discountType`, `promoCode`, `paymentMethod`, `paymentProvider`, `paymentStatus`, `isScheduled`. (All optional, all whitelisted on the global `ValidationPipe`.)
* `OrdersService.create` persists POS structured fields (`addressLine1/2`, `city`, `postcode`, `callerId`, `discountType`, `paymentProvider`, `scheduledAt`, `paymentMethod`, `paymentStatus`, `preparationMinutes`, `promoDiscount`). Calculates `estimatedReadyAt` when `preparationMinutes > 0` and not scheduled. Increments `PromoCode.usedCount` after the order writes.
* `OrdersService.updateStatus` now fires `PrintQueueService.enqueueForNewOrder(orderId)` on `ACCEPTED` and `enqueueCancel(orderId)` on `CANCELLED`. (Previously the print pipeline was wired in `print-queue.service.ts` but never called.)
* New `OrdersService.findScheduledOrders` (returns `PENDING` orders with `scheduledAt` in the near-future range).
* New `OrdersService.startPreparingScheduled` — clears `scheduledAt`, transitions PENDING → ACCEPTED.
* `OrdersController` — added `GET /v1/orders/scheduled` and `POST /v1/orders/:id/start-preparing`.

## Web

* `pos-cart-panel.tsx` — full operational right-hand sidebar (customer, caller ID, fulfilment toggle, address + autocomplete, postcode → fee lookup, expected-time chips + custom, schedule date/time, 10%/20%/Free-delivery buttons, promo input, payment method selector).
* `cart-storage.ts` + `use-online-status.ts` — localStorage cart draft per location + `navigator.onLine` hook with banner.
* `pos.client.ts` — typed clients for delivery-zones / promo-codes / address-lookup.
* `scheduled-orders-strip.tsx` — Scheduled section on the Orders board with live countdown + "Start now" mutation.

## Payment provider abstraction

* `paymentMethod` enum: `CASH`, `CARD_TERMINAL`, `ONLINE_CARD`, `EXTERNAL`.
* `paymentProvider` enum: `MANUAL`, `STRIPE`, `DOJO`, `ADYEN`, `WORLDPAY`.
* `paymentStatus`: `PENDING`, `PAID`, `FAILED`, `REFUNDED`.

For this phase:
* Cash / card terminal: persisted but no provider integration. Card-terminal defaults to `PAID` on submit (cashier-confirmed).
* Online card: disabled while offline. Stripe remains the wired flow if the consumer enables it. `Dojo`, `Adyen`, `Worldpay` placeholders documented in `PAYMENT_PROVIDERS_PLAN.md`.
* `LocationPaymentConfig` row records selection per location; secrets/credentials live in the existing encrypted `integrations` table when wired.

## Offline-ready

* Cart + customer/address/timing/discount draft persists to `localStorage` per location, scoped to a 24-hour TTL.
* Browser refresh → cart restored automatically (per location).
* Offline detection via `navigator.onLine` + `'online'`/`'offline'` events shows a banner and disables `ONLINE_CARD` payment.
* Full offline order queue + sync deferred to Phase AN — see `OFFLINE_POS_PLAN.md`.

## Tests

* `delivery-zones.spec.ts` — 9 cases: normalisation, longest-prefix match, inactive filtering, minOrderValue, no-match.
* `promo-codes.spec.ts` — 9 cases: unknown / inactive / usage-limit / min-spend / expired / location-scope rejections; PERCENTAGE / FIXED_AMOUNT / FREE_DELIVERY discount math; case-insensitive matching.
* `scheduled-orders.spec.ts` — 3 cases: ACCEPTED transition triggers print pipeline; `startPreparingScheduled` clears `scheduledAt` and fires the print pipeline; `isFutureScheduled` cut-off honoured.

Pre-existing tests updated: `orders.service.spec.ts` and `outbox.spec.ts` now stub `PrintQueueService` + `PromoCodesService` (the two new OrdersService deps).

## Acceptance vs. brief

| Acceptance criterion | Status |
|---|---|
| POS supports customer name + phone | ✅ |
| POS supports delivery/collection | ✅ |
| Delivery address + postcode fields | ✅ |
| Delivery fee calculation | ✅ (zone lookup + manual override) |
| Expected time / prep time | ✅ (ASAP/15/30/45/60/custom) |
| Scheduled order creation | ✅ |
| Scheduled orders shown separately | ✅ (Scheduled strip on Orders page) |
| Discounts (10/20/Free delivery) | ✅ |
| Promo code validation | ✅ (active / dates / usage / location / min-spend) |
| Payment method/status saved | ✅ |
| Immediate POS order → PrinterJob | ✅ (wired via OrdersService.updateStatus on ACCEPTED) |
| Scheduled POS order does not print until started | ✅ |
| Orders page shows scheduled orders | ✅ |
| Existing Orders / Menu / Product flow not broken | ✅ (full Jest suite for these passes) |

## Known follow-ups (next phase)

* AL-2 Supabase Storage signed upload URLs (carried forward).
* AL-11 POS — verify catalog-linked menu flow end-to-end (carried forward).
* Full offline order queue + sync (AN).
* Real Dojo / Adyen / Worldpay payment integrations.
* Delivery-zone admin UI (today configured via API only).
* Promo-code admin UI (today configured via API only).
* Caller-ID hardware integration (CTI protocol).
