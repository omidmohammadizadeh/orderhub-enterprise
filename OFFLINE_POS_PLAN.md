# Offline POS Plan

Phase AM lays the foundation for offline operation. Full offline order placement + sync ships in **Phase AN**.

## What works offline today (Phase AM)

* **Cart draft persists per location** to `localStorage` with a 24-hour TTL. A browser refresh or short outage restores the in-progress cart + customer details + selected discount + payment method.
* **Online/offline detection** via `navigator.onLine` + the `'online'`/`'offline'` window events. A banner reading *"Offline mode — cart saved locally, card-online disabled"* shows at the top of the cart panel.
* **`ONLINE_CARD` is disabled** while offline. Cash, card-terminal and external are always available.

## What still requires a network today

* Submitting the order — needs `POST /v1/orders`.
* Postcode → fee lookup — needs `GET /v1/delivery-zones/lookup`.
* Address autocomplete — needs `GET /v1/address-lookup/search`.
* Promo validation — needs `POST /v1/promo-codes/validate`.
* Menu fetch — needs `GET /v1/menus/:id`.

## Phase AN scope (full offline)

### 1. Local menu cache

* On menu load, mirror the active menu + active modifier-group catalog to **IndexedDB** keyed by `(locationId, menuId, version)`.
* On reconnect or on a new POS session, re-fetch and bump the local version.

### 2. Local order queue

* When a cash order is submitted offline, write it to IndexedDB with:
  * A locally generated temporary id (`local:cuid()`).
  * The full canonical payload.
  * A `queuedAt` timestamp.
* Print a local receipt via the Flutter app's printer bridge or `window.print()`.

### 3. Sync on reconnect

* A background sync worker watches `'online'`.
* For each queued order, POST it to `/v1/orders` with the `idempotencyKey` set to the local id.
* On success, swap the local row to the server id.
* On conflict (409), mark the local row as `synced-as=server-id` and move on.

### 4. Conflict handling

* Server is the source of truth — once an order is synced, the local copy becomes a read-only reference.
* If the server rejects the payload (4xx other than 409), the local row is flagged for operator review on an "Offline queue" page; the kitchen receipt is preserved.

### 5. UI surface

* **Offline queue page** under the POS — list of pending-sync orders with retry / discard actions.
* **Banner** counts of "X orders waiting to sync" when present.

## Out of scope for the foreseeable future

* Offline online-card payments (impossible without provider connectivity).
* Offline integration syncs (Deliveroo/Uber/JustEat — needs their cloud).
* Offline reports (data isn't fresh).

## Code organisation hints (for whoever picks up AN)

* `apps/web/src/lib/pos/cart-storage.ts` — current localStorage layer. Add an `idb-storage.ts` sibling for IndexedDB; keep cart draft on localStorage (small, synchronous) and bulk data on IndexedDB.
* `apps/web/src/lib/pos/use-online-status.ts` — extend to expose a `useSyncQueue()` companion.
* `apps/web/src/lib/pos/sync-worker.ts` — new module, picks up queued orders and drains them.
