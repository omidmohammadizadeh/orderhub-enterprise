# Stripe Application Fees

Two distinct cost models. The General tab of the Location editor lets a tenant owner pick one of four `applicationFeeMode` values; the math helpers in `locations.service` are the single source of truth.

## Modes

| Mode | When to use |
|---|---|
| `none` | Free hosting / pilot tier |
| `fixed_only` | Convenience fee passed to the customer (e.g. £0.50 / order) |
| `percentage_only` | Revenue-share — the platform takes a cut of every basket |
| `fixed_and_percentage` | Hybrid |

## Math

`locations.service` exports three pure helpers:

```ts
customerTotalWithFee(basket, cfg): number  // what the customer pays
applicationFeeAmount(basket, cfg):  number  // PaymentIntent.application_fee_amount
merchantPayout(basket, cfg):        number  // what hits the merchant's Stripe payout
```

| Scenario | basket | mode | customer pays | app fee | merchant payout |
|---|---|---|---|---|---|
| Fixed only | £10 | `fixed_only` (0.50) | £10.50 | £0.50 | £10.00 |
| Percent only | £10 | `percentage_only` (5%) | £10.00 | £0.50 | £9.50 |
| Both | £10 | `fixed_and_percentage` (0.50 + 5%) | £10.50 | £1.00 | £9.50 |
| None | £10 | `none` | £10.00 | £0.00 | £10.00 |

### Why fixed adds to the customer and percentage doesn't

Stripe Connect takes `application_fee_amount` out of the destination charge. If we only used `application_fee_amount`, both fixed and percentage would erode the merchant's payout. The Phase AN rule treats fixed as a **service fee**: it's added to the basket the customer authorises, then the same fixed amount is split off to the platform via `application_fee_amount`. The merchant payout = basket. The customer pays basket + fixed.

Percentage stays implicit — the merchant authorised that revenue-share, and Stripe just deducts it from their payout. The customer pays basket only.

## What ships in Phase AN

- DB columns + UI inputs to capture the four modes and both amounts
- Pure math helpers covered by unit tests
- Helper text in the General tab explaining each mode

## What's next

- Wiring the helpers into the actual Stripe PaymentIntent build path (Phase AO Payments).
- Surfacing a "what the customer will see" preview on the General tab using the live cart subtotal.
- Per-platform fee overrides (e.g. different fee for Uber Eats vs online ordering).
