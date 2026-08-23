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
 * Countries Tap settles in. Tap's own footprint is the GCC plus Egypt and
 * Jordan, which is also roughly talabat's — the marketplaces these shops
 * already trade on.
 *
 * A country NOT listed here falls to Stripe. That is the safe default: Stripe
 * is the live, proven path, and a shop in an unlisted country getting Stripe
 * is a shop that can at least be onboarded manually, whereas defaulting to Tap
 * would hand it a provider that cannot settle its currency.
 */
const TAP_COUNTRIES = new Set([
  "AE", // United Arab Emirates
  "SA", // Saudi Arabia
  "KW", // Kuwait
  "QA", // Qatar
  "BH", // Bahrain
  "OM", // Oman
  "EG", // Egypt
  "JO", // Jordan
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
