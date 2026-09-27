# Keeta integration (Phase KT)

Direct integration with **Keeta** (Meituan's food-delivery app), trading in
UAE, KSA, Kuwait, Qatar, Bahrain and Oman. Code: `apps/api/src/modules/integrations/keeta/`.

Built 2026-09-27 from Keeta's **official OpenAPI bundles** (api-docs.mykeeta.com).
Keeta publish per-field examples but no whole order payload, so the order
transformer is spec-derived: every order keeps `metadata.keetaRaw` for diffing
against the first real test-store order. The request signature IS verified —
the tests reproduce the worked example in Keeta's Authorization Guide.

## Which Keeta API

Keeta's docs site documents three API families on one host. This is the
**Standard Keeta API** (`https://open.mykeeta.com/api/open`) — the one with
AED/SAR/KWD/QAR/BHD/OMR and en/ar. The site's default "Open Delivery" pages are
the **Brazilian** standard (Portuguese, BRL, HMAC in `X-App-Signature`) and do
not apply. Inferred from currencies/languages/examples; confirm with Keeta.

## Onboarding (Keeta's process)

1. Developer signup at developers.mykeeta.com → review within 5 business days.
2. NDA.
3. Keeta send a **Developer Account** (Dev Portal login) and a **Test Store**.
   Fill in company logo, contact phone/email and merchant-operations email.
4. Development. Complete Keeta's **SOW** (Dev Portal → Integration Document
   Management) and self-test against their **SIT test cases** (Dev Portal).
5. Joint SIT with Keeta → they issue a **production** appId/secret.
6. Brand registration with Keeta's onboarding team.
7. **UAT per brand** in production with a real restaurant. Brands that fail
   UAT cannot launch.

## Server setup

```
KEETA_APP_ID=            # Dev Portal → Application Management
KEETA_APP_SECRET=
KEETA_ENV=test           # production after SIT (selects "Formal Store" webhooks)
KEETA_WEBHOOK_SIG_MODE=observe
# optional overrides:
# KEETA_OAUTH_REDIRECT_URI=https://<api>/api/v1/integrations/keeta/oauth/callback
# KEETA_WEBHOOK_URL=https://<api>/api/v1/integrations/keeta/webhook
```

Then, in the Keeta Dev Portal → Edit application:

- **Push Oauth2 authorization code**: `https://<api>/api/v1/integrations/keeta/oauth/callback`
  (must equal `KEETA_OAUTH_REDIRECT_URI`).
- Every other event → `https://<api>/api/v1/integrations/keeta/webhook`.
  `POST /api/v1/integrations/keeta/register-webhooks` (PLATFORM_ADMIN) does
  this by API for events 1, 1001–1007, 1101, 1102, 1201, 1202, 1301–1303.

Probe: `GET /api/v1/integrations/keeta/health`. Diagnostics (recent webhooks,
which signature recipe matched): `GET /api/v1/integrations/keeta/diagnostics`.

## Connecting a shop

Locations → Brands → **Keeta** → *Authorize with Keeta*. The merchant signs in
to Keeta, ticks their stores and returns. Keeta authorize by **brand**: one
token covers every store ticked. If exactly one store came back it is connected
to that location immediately; otherwise pick the Keeta store from the list.
Then publish the menu (Menus → Publish → Keeta) and push opening hours
(Manage → Push opening hours).

## What it does

| Area | How |
|---|---|
| Orders in | webhook 1001 → board, pinned to the connection's brand. Accept within **5 min** or Keeta cancel (and may close the store). |
| Status out | ACCEPTED→`/order/confirm`, READY→`/order/prepare`, CANCELLED/REJECTED→`/order/cancel`; self-delivery OUT_FOR_DELIVERY→`/order/dispatched`, COMPLETED→`/order/delivered`; pickup COMPLETED→`/order/collect`. Each sent once. |
| Status in | 1002 accepted, 1003 completed, 1004 cancelled (late CS cancels of completed orders are recorded, not applied), 1006 rider (assigned / arrived / collected / delivered). |
| Refunds | 1005/1007 recorded on the order + activity log (Keeta auto-approve after **15 min**). API: `POST orders/:orderId/refund/agree|reject`. |
| Menu | `/product/menu/sync` — full replace, async (result on 1202; photos on 1201). Our ids are the openItemCodes. Sizes = SKUs; groups per SKU; nested groups supported. **Locks Keeta's portal menu editor.** |
| 86 | `/product/spustatus/batchupdatebycode`, restore swept when a timed snooze ends. |
| Pause | Stop taking orders / Manage → `/scm/shop/status/rest|open` (delivery + pickup together, no end time). |
| Hours | `/scm/shop/business/hour/effective/update`, seconds-of-day, overnight slots split. |
| Tokens | 90-day access+refresh, refresh token single-use; daily cron refreshes 5 days early. Stored once per brand in `keeta_authorizations`, encrypted. |

## Traps (from the docs)

- Signature = lowercase hex **SHA-256** of `URL + "?" + sorted k=v&… + secret` —
  not HMAC, not Base64. Empty/null values included; nested objects signed as their JSON.
- Four common body fields (`appId`, `accessToken`, `timestamp` seconds, `sig`) are
  missing from every endpoint schema.
- Webhook `message` is a **JSON string**. Heartbeats are empty POSTs. Reply HTTP
  200 `{"code":0}`; non-zero makes Keeta retry (we do that only for a failed new order).
- Ids are int64 — parsed with a big-int-safe parser (`keeta-json.ts`).
- Order money is **minor units**; menu prices are **major-unit strings**
  (option prices 2 dp only). Rider tip is inside `payTotal` and is **not** the shop's.
- Customer PII arrives `ENC_…`; decryptable only for self-delivery orders.
- `feeDtl.merchantFee` may be missing on first delivery — never relied on.
- Category `type: 1` forces customers to buy from it — we always send 0.
- An option named like a product is auto-linked by Keeta (shared 86).

## Open questions for Keeta

1. Confirm the Gulf uses the Standard API (not Open Delivery).
2. **Webhook signature recipe** — undocumented. We try candidates and log which
   matches (`diagnostics`). Switch `KEETA_WEBHOOK_SIG_MODE=enforce` once seen.
3. Is event 1 (auth code) a GET or a POST? Both are handled.
4. KWD/BHD/OMR order amounts: ×1000? (We assume the ISO exponent.)
5. Business-hours timezone (we send store-local) and cross-midnight format (we split).
6. `orderProductId` for merchant partial refunds — not in the order payload.
7. Status 20 vs 30 on accept (docs contradict).
8. Rate limits for order/store endpoints; pickup auto-complete timeout.
9. Full `payType` enum; who collects COD on self-delivery.
10. The SIT case list and SOW template (Dev Portal only).
