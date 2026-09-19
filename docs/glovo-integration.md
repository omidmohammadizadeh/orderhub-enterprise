# Glovo direct integration — research, plan, onboarding

Researched 2026-09-19. Spec copies saved to `~/Downloads/glovo-restaurant-partners-api-2026-09-19.yaml`
(source: `https://api-docs.glovoapp.com/partners/definition.yaml`) and
`~/Downloads/glovo-menu-json-schema-2026-09-19.json` (source: `https://stageapi.glovoapp.com/paris/menu/schema`).

## Two Glovo APIs — we build against the RESTAURANT one

| | Restaurant **Partners API** (what we build) | Q-Commerce **Partner API** (the `openapi.json` that was attached) |
|---|---|---|
| Docs | api-docs.glovoapp.com/partners | qcommerce.developer.glovoapp.com |
| For | Restaurants (food) | Grocery / retail / dark stores |
| Hosts | `stageapi.glovoapp.com` / `api.glovoapp.com` | `sandbox.partner.deliveryhero.io` / `glovo.partner.deliveryhero.io` |
| Auth | One static shared token per environment, `Authorization: <token>` both ways | OAuth2 client credentials (JWT, 2h) |
| Order items | products + **attributes (modifiers)** + combos, prices in **cents** | SKU + barcode + weight + picker replacements, **no modifiers**, prices in major units |
| Menu | Full menu JSON **pulled by Glovo from a URL we host** | Barcoded product catalog on Glovo's global category tree |

The Q-Commerce API cannot carry a burger's toppings or a pizza's size, and its catalog requires a GTIN on every
non-weighed product. It is the wrong API for a restaurant POS. If Glovo onboarding pushes us there, ask them
explicitly for the **restaurant (food) Partners API**.

## Verified from the restaurant spec (not guesses; still to be confirmed against a real order)

- **Auth:** one shared token per environment, same token for every store. It goes in `Authorization` with **no
  `Bearer` prefix**. Glovo sends the same token in `Authorization` on every webhook — that is the only webhook auth
  (no HMAC). Glovo has no fixed IPs.
- **Menu fetch is the exception:** Glovo fetches our `menuUrl` with `Authorization: Bearer <token>`.
- **Three inbound webhooks, registered by Glovo by hand:** order *dispatched* (mandatory), *picked up*, *cancelled*.
  We give them URLs; there is no subscription API.
- **"Dispatched" is not "placed".** It is sent when Glovo decides the kitchen should start, based on the courier's
  ETA and the store's prep time.
- **Webhook contract:** reply **200 within 10 s**. On a timeout or any non-2xx they retry up to 3 times with
  backoff, and the spec asks for deduplication on `order_id`. On error, "No action is taken. We assume the Partner
  will prepare the order", so a 5xx does not stop the order. The order also appears in Glovo's own Partner Webapp.
- **Money:** order amounts are **integer cents**. Menu prices are **decimal major units**, max 2 dp. Product
  `price` is the unit price *without* attributes; `discount` covers *all units*; attribute `price` is per unit.
- **Times:** `order_time` / `estimated_pickup_time` are **local wall-clock time with no offset**
  (`yyyy-MM-dd HH:mm:ss`), with `utc_offset_minutes` as a *string*.
- **`store_id` is OUR id.** We choose each store address's external id and give it to Glovo. Unique per token.
- **Customer PII:** name only. Phone is `"N/A"` on Glovo-courier orders, and `delivery_address` is null unless the
  store delivers itself (marketplace). Full contact details need a signed DPA + NDA.
- **`pick_up_code`:** a 3-digit, non-unique code the courier quotes. It must be shown prominently on the ticket and
  board.
- **`order_code`:** the reference support and invoices use, so it becomes `displayId`.
- **`payment_method`:** how *Glovo pays the partner*, not how the customer paid. `CASH` = the courier pays at
  pickup; `DELAYED` = invoiced. Stage always sends `DELAYED`.
- **No cancel or reject endpoint.** A partner cancels only by phoning Glovo support. We only *receive*
  cancellations, and those arrive only for orders that were dispatched **and accepted**.
- **Status updates:** `PUT /webhook/stores/{storeId}/orders/{orderId}/status` with
  `ACCEPTED | READY_FOR_PICKUP | OUT_FOR_DELIVERY | PICKED_UP_BY_CUSTOMER`. The newer
  `/api/v0/integrations/orders/{id}/accept|ready_for_pickup|out_for_delivery|customer_picked_up` endpoints take the
  store id in a `Glovo-Store-Address-External-Id` header, and `accept` takes `committedPreparationTime` (UTC, at
  most +10 min). ACCEPTED on an already accepted or auto-accepted order returns an error, which is harmless.
  READY_FOR_PICKUP applies only to Glovo-courier orders, OUT_FOR_DELIVERY only to marketplace orders, and
  PICKED_UP_BY_CUSTOMER only to customer-pickup orders.
- **Menu:** `POST /webhook/stores/{id}/menu {menuUrl}` returns a `transaction_id`, which we poll with
  `GET .../menu/{tx}` (status kept 24 h). Limit **5 full uploads per day per store address** (429 /
  `LIMIT_EXCEEDED`). Structure: collections → sections (≤200 products) → products → attribute_groups →
  attributes. **Attributes are flat** (no nested groups); combos are separate. Attribute ids must be unique
  across the store. The live schema **requires `image_url` and `description` on every product** and **rejects a
  zero price**, which contradicts the prose ("images are nice-to-have"). This is a question for Glovo.
- **Sizes:** there are no portions. A size becomes a required `min 1 / max 1` attribute group whose options carry
  the size price as `price_impact` over a base price.
- **86 / availability:** `PATCH .../products/{id}` and `PATCH .../attributes/{id}` (`{available, price}`), or
  bulk `POST .../menu/updates` (≤10 000 items, async, `PARTIALLY_PROCESSED` possible). There is no timed
  auto-restore, so we must send the un-86 ourselves.
- **Store status:** only temporary closing: `PUT/GET/DELETE .../closing {until: ISO-8601 with offset}`. **Opening
  hours are NOT settable via this API** ("managed in the Glovo Partner Webapp"). Collection-level `schedule` in the
  menu JSON needs Glovo's "schedule catalog" feature enabled per store.
- **Rate limit:** 120 requests/minute, summed per store address.
- **Countries:** Glovo trades in Spain, Italy, Portugal, Poland, Romania, Croatia, Serbia, Bosnia, Montenegro,
  Moldova, Ukraine, Georgia, Kazakhstan, Kyrgyzstan, Morocco, Tunisia, Kenya, Uganda, Nigeria, Ghana and Côte
  d'Ivoire. **Not the UK, not the UAE.** Access is requested per country.
- **Onboarding contact:** `partner.integrationseu@glovoapp.com`.

## Phases

| # | Phase | Notes |
|---|---|---|
| 1 | Auth client + health probe | Static token from Render env (`GLOVO_API_TOKEN`, `GLOVO_ENV=stage\|production`); public `GET /v1/integrations/glovo/health` reports presence only |
| 2 | Webhooks + order intake | `POST /v1/integrations/glovo/orders/dispatched`, `/picked-up`, `/cancelled`. Token check, raw envelope logged + persisted, idempotent on `order_id`, 200 fast |
| 3 | Status sync + cancel | Board status → ACCEPTED / READY_FOR_PICKUP / OUT_FOR_DELIVERY / PICKED_UP_BY_CUSTOMER. Cancel = receive only; a "cancel" in OrderHub tells staff to phone Glovo |
| 4 | Menu publish + 86 | Transformer → menu JSON served from a token-protected URL; upload + transaction polling; 86 via PATCH product/attribute; 5/day guard |
| 5 | Store status | Pause/resume → temporary closing. Hours: read-only note ("set in Glovo Partner Webapp") unless Glovo enables schedule catalog |
| 6 | Dashboard connect/manage | `GlovoRow` + `glovo-manage-modal.tsx` (Store ID form, Status + Menu tabs) |
| 7 | Channel plumbing | `GLOVO` in enums (NEW migration), logos, filters, analytics, customers, simulate |
| 8 | Marketing site | Integration page + logo, status "Coming soon" |

## What we need from Glovo

1. Access to the **restaurant Partners API** (not Q-Commerce), for the countries we'll operate in.
2. **Stage** shared token (via their encrypted channel → we put it in 1Password → Render env; never email/chat).
3. Registration of our three stage webhook URLs.
4. A stage test store address mapped to an external id we choose, plus testglovo.com test-customer access.
5. Access to their Jira support desk.
6. Their certification / go-live checklist, and later the production token + webhook.

## Questions to send

1. Should a POS platform use the restaurant Partners API (api.glovoapp.com) or the Delivery Hero Partner API?
2. Which order-status endpoints are current — `/webhook/stores/{id}/orders/{id}/status` or
   `/api/v0/integrations/orders/{id}/*`? Is one being deprecated?
3. Attribute `quantity`: per product unit, or across all units of the line?
4. Can manual acceptance be enabled for our stores (auto-accept off), and what is the acceptance deadline?
5. The live menu schema requires `image_url` and `description` on every product and rejects price 0. Is that
   enforced? What should we send for a product without a photo, and for a free item?
6. Is there any API for regular opening hours, or can the "schedule catalog" feature be enabled for our stores?
7. Menu fetch auth: is the `Bearer` token Glovo sends when fetching `menuUrl` our shared token, or one we choose?
8. Can we receive a real sample dispatched-order payload from stage (incl. a combo and a marketplace order)?
9. Customer phone/address for Glovo-courier orders — what DPA/NDA is needed?
10. Is `order_id` numeric (the v0 endpoints type it `long`) or an opaque string?
11. Certification: is there a test script, and who signs off?

## What's built (2026-09-19)

All eight phases are built. Code: `apps/api/src/modules/integrations/glovo/`. UI: `GlovoRow` in
`brand-platform-grid.tsx`, `glovo-manage-modal.tsx`, `glovo.client.ts`, and a Glovo target in
`publish-menu-modal.tsx`. The target is shown only for shops in a Glovo country. Marketing:
`/integrations/glovo`, "Coming soon".

### Webhook URLs to register with Glovo (stage and production are the same host)

```
https://orderhub-api-0re6.onrender.com/api/v1/integrations/glovo/orders/dispatched   (mandatory)
https://orderhub-api-0re6.onrender.com/api/v1/integrations/glovo/orders/picked-up
https://orderhub-api-0re6.onrender.com/api/v1/integrations/glovo/orders/cancelled
```

Never rename these. `tests/glovo-store-availability.spec.ts` pins them. `picked_up` (underscore) is
also accepted.

### Render env

| Var | Value |
|---|---|
| `GLOVO_API_TOKEN` | The shared token from Glovo, via 1Password. It is also the value expected on inbound webhooks. |
| `GLOVO_ENV` | `stage` until certified, then `production` together with the production token |
| `GLOVO_WEBHOOK_TOKEN` | Only if Glovo issues a different inbound token (unset = same as the API token) |
| `GLOVO_API_BASE` | Optional host override |

Check with `GET /api/v1/integrations/glovo/health`. It is public and reports presence only.

### Before any store goes live

1. Diff the first real `dispatched` envelope (logged in full, and stored in `webhook_events.rawPayload`
   with `externalEventId = dispatched:<order_id>`) against `tests/glovo-order.fixtures.ts`. Pay
   particular attention to attribute `quantity` semantics: the intake logs a warning when line totals
   disagree with `estimated_total_price`.
2. Confirm which `Authorization` value Glovo sends when fetching the menu feed. The feed logs "Bearer" /
   "no Bearer" / "none".
3. A TND or zero-decimal currency (UGX, XOF): confirm Glovo's "cents" is still ÷100.

## Onboarding email (draft to send)

To: partner.integrationseu@glovoapp.com
Subject: POS integration request — Order Hub (restaurant Partners API)

Hello Glovo Integrations team,

Order Hub is a restaurant POS and ordering platform: an in-store POS, a kitchen display, branded online
ordering and direct marketplace integrations, all on one order board. Restaurants already run Just Eat,
Deliveroo, Uber Eats, Careem and talabat through Order Hub with direct integrations, and several of our
restaurant groups have asked us to add Glovo on the same terms.

We would like to integrate as a POS partner through your restaurant Partners API (api.glovoapp.com):
order notifications, order status updates, menu upload, product and attribute availability, and
temporary store closing. The integration is already built against your published specification and
ready for testing on stage.

To start, could you please:

1. Grant us access to the Partners API for restaurants in the markets our customers trade in (we can
   start with Spain and add countries as merchants onboard).
2. Register our stage webhook endpoints:
   - Order dispatched: https://orderhub-api-0re6.onrender.com/api/v1/integrations/glovo/orders/dispatched
   - Order picked up: https://orderhub-api-0re6.onrender.com/api/v1/integrations/glovo/orders/picked-up
   - Order cancelled: https://orderhub-api-0re6.onrender.com/api/v1/integrations/glovo/orders/cancelled
3. Share the stage shared token through your standard encrypted process (please not by plain email).
4. Set up a stage test store address mapped to our store ID, and give us access to testglovo.com and your
   Jira support desk.
5. Send your certification checklist or test script, and tell us who signs off go-live.

We also have a few questions so our implementation matches your platform exactly:

1. Order status: should we use `PUT /webhook/stores/{storeId}/orders/{orderId}/status` or the
   `/api/v0/integrations/orders/{orderId}/accept | ready_for_pickup | out_for_delivery |
   customer_picked_up` endpoints? Is either being deprecated?
2. Is an attribute's `quantity` per unit of the product, or for the whole order line?
3. Can manual acceptance be enabled for our stores (auto-accept off)? If so, how long do we have to
   accept?
4. The menu JSON schema requires `image_url` and `description` on every product and rejects a price of 0.
   Is `null` accepted for a product without a photo, and how should a free item be sent?
5. Is there any API for regular opening hours, or can the schedule-catalogue feature be enabled for our
   stores?
6. When Glovo fetches our `menuUrl`, which token is sent as `Authorization: Bearer`?
7. Is `order_id` always numeric, or should we treat it as an opaque string?
8. For currencies with three decimals (TND) or none (UGX, XOF), are order amounts still in hundredths?
9. Could you send a real sample `order dispatched` payload from stage, ideally one with a combo and one
   marketplace (store-delivered) order?
10. What agreements (DPA/NDA) are needed to receive customer contact details for Glovo-courier orders?

We're happy to arrange a call to go through the integration and plan the rollout.

Kind regards,
[Name]
Order Hub Solutions
