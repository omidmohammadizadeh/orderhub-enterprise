# Yango Delivery — courier dispatch (UAE) · Phase BK

**Status:** built and unit-tested (111 tests), **not yet run against Yango**.
Everything below the API surface is spec-derived. Yango has **no sandbox**, so the
first real call has to happen on a production account, and a location starts in
**estimate-only** mode. See [First live test](#first-live-test).

Yango Delivery is the same product shape as Stuart, Uber Direct and JET Go: the
order is ours, so is the customer, and Yango supplies the courier. It plugs into the same
dispatch chooser, the same wallet fee and the same order statuses.

Code: `apps/api/src/modules/integrations/yango/` · Dashboard:
`yango-connection-section.tsx`, `yango-dispatch-card.tsx`, `lib/api/yango.client.ts`
· Schema: `YangoConfig` + migration `20260927140000_yango_dispatch`.

---

## What the API is

There is **no Yango-branded API**. Yango Delivery is the international brand of
Yandex Delivery. Its B2B "express claims" API is Yandex's, and it runs on one host for
every country, the UAE included:

| | |
|---|---|
| Host | `https://b2b.taxi.yandex.net` + `/b2b/cargo/integration/v2/…` (override: `YANGO_API_BASE`) |
| Auth | `Authorization: Bearer <token>`. It is a **static** token from the business cabinet → **Integration → Get token**. There is no OAuth exchange and no refresh. The token never expires on its own, but **changing the cabinet password kills it**. |
| Headers | `Accept-Language: en` (required on most methods) |
| Sandbox | **None** for express claims. Accepting a claim sends a real courier and bills the account. |
| Docs | `yandex.com/support/delivery-profile/en/api/express/…` (append `.md` for raw). The only public Yango client, `github.com/A1-x-Tech/mcp-yango-delivery`, is built from the same docs and calls the same host. |

`b2b.yango.com`, `b2b-platform.yango.com` and `b2b.taxi.yango.com` do not resolve.
The region comes from the account and the coordinates, not from the host.

### Endpoints used

| Endpoint | Used for |
|---|---|
| `POST check-price` | Quote. It is **free and creates no claim**, which is why estimate-only mode can use it. |
| `POST tariffs` | "Check with Yango" in settings. It proves the token works and that the shop sits in a zone, and lists the classes. |
| `POST claims/create?request_id=` | Create the claim (status `new`). `request_id` is the idempotency key. |
| `POST claims/info?claim_id=` | Read one claim: used during dispatch, by the callback, and by refresh. |
| `POST claims/bulk_info` | The poller reads up to 1000 claims per call. |
| `POST claims/accept?claim_id=` `{version}` | **Books the courier. This is the call that costs money.** |
| `POST claims/cancel-info` → `claims/cancel` `{version, cancel_state}` | Cancel. |
| `GET claims/performer-position` | The courier's live position. |
| `GET claims/tracking-links` | Customer-safe `sharing_link` on the destination point. |
| `POST driver-voiceforwarding` `{claim_id, point_id}` | The courier's masked phone number and extension. |

---

## What it can and can't do

**Can:** give a price and ETA before booking, book on-demand couriers
(`courier` = bike or foot up to 10 kg, `express` = car up to 20 kg), report status,
report the courier's live position, give a customer tracking link and the
courier's masked phone, cancel for free until the courier reaches the shop, and
make claim creation idempotent.

**Can't, or not confirmed:**
- **No sandbox.**
- **Webhooks are deprecated, unsigned and state-less.** A callback carries only `claim_id` and `updated_ts`.
- **Cash on delivery** in the UAE is unconfirmed. The docs contradict themselves ("cash — not yet available") and it is gated per account.
- **No published rate limits.** Yango only returns 429s.
- **`auto_accept`** needs a Yango manager to enable it, so we accept explicitly.
- **Scheduled pickup (`due`)** exists, but we dispatch ASAP only. See the warning below.

## How it maps onto our dispatch model

| OrderHub | Yango |
|---|---|
| Quote in the dispatch modal | `check-price` |
| Dispatch | fresh `check-price` → wallet debit → `claims/create` → wait for `ready_for_approval` → `claims/accept` |
| `Order.courierProvider` / `courierJobId` | `"YANGO"` / `claim.id` |
| `Order.courierStatus` | Yango's status, uppercased verbatim |
| Status updates | the poller (`bulk_info`, every 15 s) + the callback as a nudge |
| Courier name / phone / pin / tracking | `performer_info`, `driver-voiceforwarding`, `performer-position`, `tracking-links` |
| Pickup / delivery ETA | `route_points[].visited_at.expected`, which comes free with every claim read |
| Cancel dispatch | `cancel-info` → `cancel`, with a confirmation step for a paid cancel |
| Wallet fee / refunds | same as JET Go (below) |

### Status mapping

| Yango | Order | Notes |
|---|---|---|
| `new`, `estimating`, `ready_for_approval`, `accepted`, `performer_lookup`, `performer_draft` | — | Still searching. Not "rider on the way". |
| `performer_found`, `pickup_arrived`, `ready_for_pickup_confirmation` | `ASSIGNED_DRIVER` | |
| `pickuped`, `delivery_arrived`, `ready_for_delivery_confirmation`, `pay_waiting` | `OUT_FOR_DELIVERY` | |
| `delivered`, `delivered_finish` | `COMPLETED` | Single drop-off, so `delivered` is the handover. |
| `returning` … `returned_finish` | — | Warned once in the activity log. The refund is a person's decision. |
| `performer_not_found`, `cancelled_by_taxi`, `failed`, `estimating_failed` | → `READY` | Yango gave up. Courier cleared, **fee refunded**. |
| `cancelled`, `cancelled_with_payment` (outside OrderHub) | → `READY` | Cancelled in the shop's cabinet. Cleared, **no refund** (otherwise it becomes a free loop). |
| `cancelled_with_items_on_hands` | — | The courier kept the food. Cleared, loud warning, order not moved. |

`pay_waiting` is documented but missing from Yango's enum, so an unknown status is
recorded and moves nothing.

---

## Traps, and what we do about them (each has a test)

1. **Coordinates are `[longitude, latitude]`.** The docs say "exactly in that
   order". Reversed, a Dubai drop-off lands in the sea. The client flips our
   `{lat, lng}` in one place (`toYangoCoords`). `performer-position` answers with
   *named* `lat`/`lon` fields, which we read by name.
2. **Two body shapes for one route.** `check-price` wants route points as
   `id` with flat `coordinates`/`fullname`, and items with `dropoff_point`. `claims/create`
   wants `point_id` with an `address` object, and items with **`droppof_point`** (sic, that
   is Yango's spelling).
3. **Our point ids ≠ Yango's.** We send `point_id: 1/2`. Yango answers with its own
   server ids, and `driver-voiceforwarding` needs *those*. The courier phone
   lookup reads the source point's server id back from the claim.
4. **`claim_id` in the query**, except `driver-voiceforwarding` and
   `confirmation_code`, which take it in the body. `performer-position` and
   `tracking-links` are **GET**.
5. **Create is asynchronous, and the offer expires in ~10 minutes.** Accepting an
   expired offer returns **200** and the claim then goes `failed`. We check
   `valid_until` before accepting.
6. **Accept needs the current `version`** (`409 old_version` otherwise). We
   re-read and retry once. An accept that 5xx'd is **never blindly retried**,
   because it books a courier. The next poll re-reads and retries only if the claim
   is still waiting.
7. **Estimation errors can arrive inside a 200** as `error_messages`. They surface
   in the refund message.
8. **`skip_confirmation` defaults to false**, which means an SMS code at every
   handover. A restaurant counter has no code to read, so we set it true at
   both points.
9. **Email is mandatory on the pickup contact.** It is a required setting, and
   activation is blocked without it.
10. **Phones must be `+…`.** UAE numbers arrive as `050…`, `971…`, `00971…`;
    `toYangoPhone` normalises all of them.
11. **The callback URL is concatenated, not merged.** Yango appends
    `updated_ts=…&claim_id=…` to the URL string, so ours ends in `?`.
12. **`external_order_id` is only allowed on the destination point.**
13. **Money is a decimal *string*** in the currency's precision (`"86.50"` AED).

---

## Money

These rules are the same as for Stuart, Uber Direct and JET Go:
- A flat OrderHub fee (`DISPATCH_FEE_MINOR`) is debited from the location wallet **before** the claim is created.
- The fee is refunded if the courier is never booked.
- `PLATFORM_ADMIN` bypasses the fee.
- Yango bills the shop's own Yango account for the courier.

Yango-specific rules:
- **Price guard.** The accept is checked against a `check-price` quote taken at
  dispatch time. An offer more than `YANGO_MAX_PRICE_DRIFT` (default 25%) above
  the quote is **not accepted**: the claim is cancelled (free, since it was never
  accepted) and the fee is refunded.
- **Refunded:** Yango failed (`performer_not_found`, `cancelled_by_taxi`,
  `failed`, `estimating_failed`), or we refused the offer.
- **Not refunded:** the operator's own cancel, or a cancel from the shop's Yango
  cabinet. Refunding those would let cancel-and-redispatch run for free.
- **Paid cancel.** Once the courier reaches the shop, Yango charges to cancel.
  The first cancel call only returns the fee. The operator must confirm before
  `confirmPaid` is sent. The background code never pays to cancel.
- **Tips.** `Order.tipAmount` is never sent. It is the restaurant's gratuity.
- **Cash.** We never send `payment_on_delivery`. A cash order shows a warning
  *before* the dispatch button.

## Estimate-only mode (the default)

Yango has no test environment, so every location starts with
`mode = "estimate_only"`:
- Quotes work and show Yango's real price and ETA.
- Dispatch refuses **before** any claim is created or any fee is taken.
- Switching to `live` needs `acknowledgeLiveCouriers: true` in the request. The
  settings screen asks for it with a checkbox; a changed dropdown alone is not enough.
- If a location goes back to estimate-only while a claim is still waiting to be
  accepted, that claim is cancelled free and refunded rather than accepted.

## Tracking: poll first, callback second

Yango marks `callback_url` **deprecated**. It is unsigned, carries no state, and
gives up after a few undocumented retries. So:
- **`YangoPollCron`** reads `claims/bulk_info` every 15 s. Scope:
  - in-flight Yango orders from the last 24 h
  - one call per location
  - it leaves a claim created in the last 20 s to the dispatch call, rather than
    racing it to the accept
  - `YANGO_POLL_ENABLED=false` stops it.
- **Callback** `POST /api/v1/webhooks/yango/:token?claim_id=…`: nothing in the request is
  trusted. It only names a claim, which we re-read from Yango with the location's own
  token. A forged callback can cause one extra read, and nothing else. It always returns 200.
- The courier's position is refreshed on every poll while a courier is attached. The
  tracking link and masked phone are fetched once.

We don't use `claims/journal` (the account-wide cursor feed). `bulk_info` over
known orders needs no cursor state, and its load is bounded by our own
in-flight count. If volume ever makes this expensive, switch to the journal.

## UAE only

`YANGO_COUNTRIES = ["AE"]`, enforced on the server:
- saving a config for a non-UAE location is refused
- dispatch and quote refuse a non-UAE location
- the dashboard section and dispatch card render nothing for a non-UAE shop, unless one was
  already configured, so it can still be switched off.

Yango's site lists other markets (Azerbaijan, Côte d'Ivoire, Ghana, Senegal, Zambia,
Bolivia, Peru, Colombia, Pakistan). Add a country only once Yango confirms it for us.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `YANGO_API_BASE` | `https://b2b.taxi.yandex.net` | Only for a future regional host. |
| `YANGO_MAX_PRICE_DRIFT` | `0.25` | The maximum fraction by which the offer may exceed the quote. |
| `YANGO_POLL_ENABLED` | on | `false` stops the poller. |
| `YANGO_USER_AGENT` | `OrderHub/1.0 (+https://orderhub.solutions)` | |

The token is stored per location, encrypted with `CREDENTIAL_ENCRYPTION_KEY`.

---

## First live test

There is no sandbox, so the first test runs on production. A claim that is cancelled
**before** `pickup_arrived` is free.

1. Paste the token, set the email, check the pickup pin, and click **Check with Yango**. This is free.
2. While still in estimate-only mode, open the dispatch modal on a real UAE delivery
   order. The Yango card should show an AED price and an ETA. This is free.
3. Switch to live, dispatch one order to an address near the shop, then **immediately**
   cancel from the order drawer. The cancel should say free.
4. In the Logs page (channel *Yango Delivery*), you should see the dispatch, the accept and the cancel. Then compare:
   - `metadata.yango.quotedPrice` against the offer price
   - the pickup and drop-off pins in the Yango cabinet against ours.

Things to confirm on that first real claim:
- that `check-price` `price` and `offer.price` are both exclusive of VAT (we compare those two)
- which classes `tariffs` reports for Dubai
- the real shape of the `tariffs` response
- the order of `points-eta.performer_position` (we don't use it, because the docs example looks like `[lat, lon]`).

## Open questions for Yango

1. Is there any test account or test mode for express claims in the UAE?
2. Is cash on delivery (`payment_on_delivery`) available for a UAE account?
3. Which `taxi_class` values run in Dubai, Abu Dhabi and Sharjah? Is a `thermobag` option available?
4. Callback retry policy, and whether a signed callback is planned.
5. Rate limits for `bulk_info` and `performer-position`.
6. Does `check-price` quote the same basis (ex-VAT) as `pricing.offer.price`?
