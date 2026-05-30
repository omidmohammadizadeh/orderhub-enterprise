# Promo Codes

Promo codes are tenant-wide records, optionally scoped to a subset of locations. The POS validates a typed code against the cart before it is applied; redemption happens atomically when the order is created.

## Data model

```
PromoCode {
  id            cuid
  tenantId      String  (unique with code)
  code          String  (uppercase)
  description   String?
  type          PromoCodeType  (PERCENTAGE | FIXED_AMOUNT | FREE_DELIVERY)
  value         Decimal        (% for PERCENTAGE, £ for FIXED_AMOUNT, ignored for FREE_DELIVERY)
  minOrderValue Decimal?
  maxUses       Int?
  usedCount     Int (default 0)
  startAt       DateTime?
  expiresAt     DateTime?
  isActive      Boolean (default true)
  locationIds   String[] (empty = all locations)
}
```

## API

* `GET /v1/promo-codes` — list.
* `POST /v1/promo-codes` — create.
* `PATCH /v1/promo-codes/:id` — update.
* `DELETE /v1/promo-codes/:id` — remove.
* `POST /v1/promo-codes/validate` — body `{ code, locationId, subtotal }`.

All write endpoints require `MANAGER`+.

## Validation rules

The `validate` endpoint runs each check in order and returns the first failing reason:

1. Code exists (case-insensitive).
2. `isActive = true`.
3. `now ∈ [startAt, expiresAt]` when set.
4. `usedCount < maxUses` when `maxUses` is set.
5. `subtotal ≥ minOrderValue` when set.
6. `locationIds` is empty OR includes the requested `locationId`.

## Discount maths

| Type | Logic |
|---|---|
| `PERCENTAGE` | `Math.round(subtotal × value) / 100` |
| `FIXED_AMOUNT` | `min(value, subtotal)` — capped so the discount never exceeds the bill |
| `FREE_DELIVERY` | discount amount = 0; `freeDelivery: true` returned for the POS to zero out delivery fee |

## Redemption + usage tracking

* `validate` is read-only — it never increments `usedCount`. This lets a customer apply a code, change their mind, and remove it without consuming a use.
* When the order is created, `OrdersService.create` calls `PromoCodesService.incrementUsage(tenantId, code)` after the order row is persisted. This is fire-and-forget; the order succeeds even if the usage bump fails, but the bump runs against a row that definitely exists so it's effectively idempotent for retries.
* `incrementUsage` uses Prisma's `{ increment: 1 }` operator — safe under concurrency.

## Errors the POS surfaces

| Reason returned | Operator-friendly message |
|---|---|
| `Promo code not found` | "Promo code not found" |
| `Promo code is inactive` | "Promo code is inactive" |
| `Promo code is not yet active` | "Promo code is not yet active" |
| `Promo code has expired` | "Promo code has expired" |
| `Promo code usage limit reached` | "Promo code usage limit reached" |
| `Minimum spend of £X.XX required` | shown as-is |
| `Promo code not valid at this location` | shown as-is |

## Test coverage

`promo-codes.spec.ts` covers all six failure branches and the three discount types, plus case-insensitive matching with leading/trailing whitespace.
