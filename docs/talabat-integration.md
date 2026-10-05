# Talabat — direct integration (Delivery Hero POS Middleware)

Module: `apps/api/src/modules/integrations/talabat/` · Dashboard: `/dashboard/integrations/talabat`

## Which API this is

Talabat restaurants integrate through **Delivery Hero's POS Middleware**, documented at
<https://integration.talabat.com/en/documentation/>:

| Spec | Who calls whom | Where |
|---|---|---|
| POS Middleware API | **we** call Delivery Hero | `integration-middleware.stg.restaurant-partners.com/apidocs/pos-middleware-api` |
| POS Plugin API | Delivery Hero calls **us** | `…/apidocs/pos-plugin-api` |

**Not** `developer.talabat.com`. That is the Quick-Commerce "Local Shops" Partner API (SKUs, barcodes,
picking). Its own intro page says "Restaurants – you're in the wrong place". It is only relevant to a future
grocery channel. Local copies of every YAML are in `~/Downloads/talabat-restaurant-pos/`.

## Environment

| Variable | What |
|---|---|
| `TALABAT_USERNAME`, `TALABAT_PASSWORD` | The integration credential. Talabat email it PGP-encrypted to our public key once our contact approves the credential request. |
| `TALABAT_PLUGIN_SECRET` | The secret the middleware signs its JWTs with. It is issued with the credential and differs between staging and production. |
| `TALABAT_ENV` | `staging` (the default) or `production`. |
| `TALABAT_API_BASE` | **Required in production.** The spec only names the staging host, so we never guess the Middle-East production host. |
| `TALABAT_SANDBOX=true` | Our own fake middleware (see below). It is refused when `TALABAT_ENV=production`. |

## What Talabat need from us at activation

The Talabat page has a button, **"Show activation details"**, that fills this in from our connections. Talabat ask for:

- **Integration name/code:** "OrderHub UAE" / `orderhub-ae`.
- **Flow:** Direct, which is tabletless.
- **Plugin base URL:** `https://<api>/api/v1/talabat-plugin`.
- **Per vendor:** the chain code (Talabat assign it), the vendor code, and **our remote ID**. The remote ID is generated per brand and location, or typed in.
- **IP allowlist** of Talabat's callers:
  - Middle East: `63.32.225.161`, `18.202.96.85`, `52.208.41.152`.
  - Staging: `34.246.34.27`, `18.202.142.208`, `54.72.10.41`.

## The flows

| Certification item | How it's done |
|---|---|
| **Menu API** | `PUT /v2/chains/{chain}/catalog`, a full replace. Sources: the publish-menu modal, the Talabat page, or Talabat's own `GET /menuimport` trigger. Progress arrives on our catalog callback. |
| **Item availability (item + choice)** | `PUT …/catalog/items/availability`. `ITEM` covers MenuItem 86s, including same-brand twins. `TOPPING` covers modifier-option on/off from the menu editor. Timed snoozes use `AT_TIMESTAMP`. |
| **DH Order API** | `POST /talabat-plugin/order/{remoteId}`. It acks with `remoteResponse.remoteOrderId` = our order id. Retries dedupe on the middleware token. |
| **Branch availability** | GET then PUT `…/remoteVendors/{id}/availability`. Pausing the brand in OrderHub mirrors to Talabat (`CLOSED_UNTIL` + minutes). Talabat-side closures arrive on `PUT /talabat-plugin/remoteId/{id}/availability`. |
| **Food is ready** | Board → READY → `orderPreparedUrl`. Only rider orders carry this URL. |
| **Item-level discounts (sponsor + ratio)** | Every order stores `metadata.talabat.promotions`, split by platform / vendor / third-party funding. The roll-up is at `GET /integrations/talabat/promotions` (Talabat page → "who paid"). |
| **AWT prep-time adjustment** | Order drawer → "Move rider pickup". The request is validated against the min/max window the order arrived with. |
| Golden: callback URLs, async dispatch | Every status goes to the order's own `callbackUrls`. Acceptance is asynchronous: ack first, accept from the board. |
| Golden: AWT order status + warning | `COURIER_ARRIVED_AT_VENDOR` → RIDER_ARRIVED. `SHOW/HIDE_RIDER_WAITING_WARNING` → a banner on the order. |

Other handling:

- **Rejections** use Talabat's enum only. A cancel after acceptance is sent only with an "after acceptance" reason; otherwise staff are told to phone Talabat.
- **Out-of-stock lines** go through product modification. The result returns as `PRODUCT_ORDER_MODIFICATION_SUCCESSFUL/FAILED`.
- **Test orders** (`test: true`) land on the board as sandbox orders labelled "DO NOT PREPARE". A reject sends `TEST_ORDER`.
- **Missed-order reconciliation** compares the order report (`/orders/ids` + `/orders/{id}`) with the board, which gives our order-ingestion success rate (OI SR). It can pull missed orders in.

**Promotions:** the restaurant API has **no endpoint to create a promotion**. Restaurants create them in Talabat's
portal. The grocery Partner API's `PUT /promotion` is for Local Shops only.

## Menu rules we enforce (refuse rather than guess)

- **Two topping levels at most.** The first level must be pick-exactly-one (min 1 / max 1) if it opens a second.
  - Sizes become that first level: "Size" with one option per size, each priced as the difference from the cheapest.
  - Each size carries its own second-level groups, so per-size modifier prices are exact.
- **Too-deep groups:**
  - A required group that would sit too deep blocks the publish, and the problem is named.
  - An optional one is left off with a warning.
- **Option products** go in a hidden "Add-ons" category that no menu lists. Every product must belong to a category.
- **Prices** are decimal strings. A standalone item with no price is refused.
- **Images** must be https, otherwise the item publishes without a photo and a warning.
- **Age restriction:** `minAge ≥ 16` sets `tags.ageRestrictedItem: ["ID_CHECK_18"]`.
- **Schedule** comes from location hours (falling back to brand hours). It is split at midnight.

## Sandbox (`TALABAT_SANDBOX=true`)

- **What it is:** `/api/v1/talabat-sandbox/middleware/*` plays Delivery Hero. Our client logs in to it, publishes to it, and accepts orders against it.
- **Rules it enforces:**
  - acceptanceTime must be at least 2 minutes ahead;
  - the reject enum, including the before/after-acceptance split;
  - prepared is only for rider orders, picked up only for vendor delivery and pickup;
  - the prep-time window;
  - one product modification at a time;
  - the catalog validation rules;
  - the availability body rules.
- **Driving it:** the Talabat page's sandbox buttons place orders built from our published catalog onto our **real** plugin endpoints, signed with a JWT. They can also cancel an order, send the rider, show the rider-waiting warning, close the vendor, and ask for the menu.

## Open questions for Talabat

1. **Choice availability type:** we send modifier options as `type: TOPPING` with the option's product ids. Confirm that is the right type for a choice. The spec only says "TOPPING | ITEM".
2. **Production host:** the Middle-East production middleware host (`TALABAT_API_BASE`).
3. **Sizes as a pick-one first topping level** (their coffee example) rather than product `variants`: confirm that is preferred on Talabat.
4. **Expiry:** the auto-cancel window for unaccepted orders in the UAE. The spec says "check with your local team".
5. **Order report filter:** whether `/orders/ids?vendorId=` takes the platform vendor code or our remote ID.
