# Delivery Fees

Delivery fees are configured per **location** as a list of **delivery zones**. Each zone maps a postcode prefix to a fee and (optionally) a minimum order value.

## Data model

```
DeliveryZone {
  id              cuid
  tenantId        ─┐
  locationId      ─┴── unique together with postcodePrefix
  postcodePrefix  String  (normalised: uppercase, no whitespace)
  fee             Decimal
  minOrderValue   Decimal?  (null = no minimum)
  isActive        Boolean (default true)
}
```

## API

* `GET /v1/delivery-zones?locationId=...` — list zones for a location.
* `GET /v1/delivery-zones/lookup?locationId=...&postcode=...` — POS uses this on every postcode keystroke.
* `POST /v1/delivery-zones` — body `{ locationId, postcodePrefix, fee, minOrderValue?, isActive? }`.
* `PATCH /v1/delivery-zones/:id` — partial update.
* `DELETE /v1/delivery-zones/:id`.

All endpoints are gated to `MANAGER`+ except lookup, which any authenticated user with location access can call.

## Lookup logic

1. Normalise the postcode: uppercase, strip whitespace. (`"sw1 0aa"` → `"SW10AA"`.)
2. Fetch all `isActive=true` zones for the location.
3. Pick the **longest** `postcodePrefix` that the normalised postcode starts with.

So a merchant can configure broad zones (`SW1`) and narrower exceptions (`SW1A` for a premium pocket) and the narrower one wins.

If no zone matches, lookup returns `{ matched: false, fee: 0 }`. The POS surfaces a "no delivery zone matches" hint so the operator can either set a manual fee for this order or add a zone in admin.

## Free delivery

* The **Free delivery** quick-button on the POS sets the effective fee to £0 but the order still records the original zone fee in `metadata` for audit.
* A promo code with `type=FREE_DELIVERY` has the same effect via the promo path.

## Manual override

The POS cart shows a small "Manual fee override" input next to the lookup hint. When set, it wins over the zone lookup for this order only and is persisted in the saved `deliveryFee` column. Use this for goodwill discounts or compensating a delayed previous order.

## Test coverage

`delivery-zones.spec.ts` covers normalisation, longest-prefix match, inactive zones, `minOrderValue` propagation, and no-match return.
