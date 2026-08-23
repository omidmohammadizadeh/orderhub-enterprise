// Which payment provider takes the money, and where that is decided.
//
// It is decided by the SHOP'S COUNTRY, and nowhere else — the same rule that
// already picks currency, timezone and channels. A stored per-location
// provider setting would be a second source of truth able to disagree with the
// location's country, and every payment path would then have to decide which
// one wins. (`LocationPaymentConfig.provider` exists in the schema from an
// earlier design and is read by nothing; don't revive it for this.)
//
// ── Why two providers at all ────────────────────────────────────────────────
//
// Not preference. Stripe's own UAE Connect rules say a UAE platform may only
// use Custom accounts with destination charges or separate charges+transfers,
// and that `on_behalf_of` is unsupported. Our storefront checkout takes DIRECT
// charges on the merchant's account (payments.service.ts, "DIRECT CHARGE"), so
// there is no version of the existing integration that legally works in the
// Gulf — it needs rewriting whichever provider we pick. Tap covers the whole
// GCC and settles KNET, mada and BENEFIT, which Stripe does not.

export type PaymentProviderId = "STRIPE" | "TAP";

/**
 * Countries Tap settles in — the six Tap confirmed in writing on 2026-08-23,
 * and no more.
 *
 * Egypt and Jordan used to be in this list. They came out of Tap's own MENA
 * marketing copy and were wrong: Tap support, asked directly, said "Egypt is
 * currently not supported" (they have a Cairo office, which is what made the
 * marketing read the other way), and Jordan is absent from the supported list
 * too. A shop in either was being routed to a provider that cannot onboard it.
 *
 * A country NOT listed here falls to Stripe. That is the safe default: Stripe
 * is the live, proven path, and a shop in an unlisted country getting Stripe
 * is a shop that can at least be onboarded manually, whereas defaulting to Tap
 * would hand it a provider that cannot settle its currency.
 *
 * ⚠️ Being on this list is necessary but NOT sufficient. Tap requires the
 * retailer's country to MATCH the marketplace account's country — they cannot
 * split a payment across countries — so one Tap marketplace account serves
 * exactly one of these six. Selling into a second country means a second
 * licensed entity, a second bank account and a second Tap account there. See
 * TapService's header.
 */
const TAP_COUNTRIES = new Set([
  "AE", // United Arab Emirates
  "SA", // Saudi Arabia
  "KW", // Kuwait
  "QA", // Qatar
  "BH", // Bahrain
  "OM", // Oman
]);

export function paymentProviderForCountry(
  country: string | null | undefined,
): PaymentProviderId {
  return TAP_COUNTRIES.has(String(country ?? "GB").trim().toUpperCase())
    ? "TAP"
    : "STRIPE";
}

/** True where the money path is Tap's. Reads better at call sites than an
 *  equality check against a string literal, and greps as one thing. */
export function usesTap(country: string | null | undefined): boolean {
  return paymentProviderForCountry(country) === "TAP";
}
