# Payment Providers Plan

The POS records a payment method + status + provider on every order. The provider integrations themselves are wired separately so the POS keeps working with cash/card-terminal even before a card network is enabled.

## Current state (Phase AM)

| Method | Provider | Status |
|---|---|---|
| Cash | n/a | Persisted, `paymentStatus = PENDING` (cashier marks paid when collected) |
| Card terminal | n/a | Persisted, `paymentStatus = PAID` on submit (cashier confirms on the terminal before pressing the button) |
| Online card | Stripe | Wired via existing `payments` module if `STRIPE_*` env vars are set |
| Online card | Dojo / Adyen / Worldpay | **Placeholders** — fields and selector exist; integration deferred |
| External | n/a | Persisted, `paymentStatus = PENDING` |

## Storage

* `Order.paymentMethod` — `CASH | CARD_TERMINAL | ONLINE_CARD | EXTERNAL`.
* `Order.paymentProvider` — `MANUAL | STRIPE | DOJO | ADYEN | WORLDPAY`.
* `Order.paymentStatus` — `PENDING | PAID | FAILED | REFUNDED`.
* `LocationPaymentConfig` — per-location selection + enabled-methods + non-secret config blob. **Secrets continue to live in `integrations.credentials` (encrypted at rest)** so payment provider keys aren't duplicated.

## Abstraction (next phase)

The minimal interface a provider must implement:

```ts
interface PaymentProvider {
  readonly id: "stripe" | "dojo" | "adyen" | "worldpay"
  createIntent(opts: { tenantId, locationId, orderId, amount, currency }): Promise<{ providerRef: string; clientSecret?: string }>
  capture(intentId: string): Promise<{ status: PaymentStatus }>
  refund(intentId: string, amount?: number): Promise<{ status: RefundStatus }>
  handleWebhook(signature: string, payload: unknown): Promise<{ orderId: string; status: PaymentStatus }>
}
```

A `PaymentsService` will pick the provider for a location from `LocationPaymentConfig.provider` and dispatch. The POS calls a single `POST /v1/payments/:orderId/charge` regardless of provider — the controller resolves the right implementation.

## Security

* Card numbers + CVVs are **never** sent to or stored by our API. The POS opens the provider's hosted page / SDK for the actual card capture.
* Provider secrets live in `integrations.credentials`, encrypted at rest via the existing key derived from `ENCRYPTION_KEY`.
* PCI scope stays at SAQ-A for hosted-card flows.

## Frontend

* The payment method selector on the POS cart panel disables `ONLINE_CARD` while the browser is offline.
* When a provider is wired, the same selector will disable methods not enabled in `LocationPaymentConfig` (e.g. a tenant on Dojo can't accidentally pick Stripe).

## Open questions

* Refund + partial refund flow on the Orders board — out of scope for AM.
* Tip handling — needs a wider conversation about gratuity policy.
* SCA / 3DS messaging during a busy POS rush — provider-specific UX detail.
