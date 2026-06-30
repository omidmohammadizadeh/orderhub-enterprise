// ── Pricing variants ────────────────────────────────────────────────────────
//
// A "pricing variant" is a named price list on a menu — e.g. "Uber Eats",
// "Deliveroo", or a custom "Kiosk" / "Brand A". One menu defines its
// variants; every item SKU and modifier option can carry a per-variant
// price override. On publish to HubRise these become catalog `variants[]`
// plus `price_overrides[]` on each SKU/option, so a single menu drives a
// different price per channel/brand without duplicating the menu.
//
// HubRise variant model (verified against
// https://www.hubrise.com/developers/api/catalogs#variants):
//   data.variants:                [{ ref, name }]
//   sku.price_overrides / option: [{ variant_refs: [ref], price: "9.99 GBP" }]
// The variant a given order/channel uses is chosen in the HubRise
// connection, not the catalog.

/** A named price list on a menu. `ref` is the stable key used everywhere
 *  overrides are stored, and the ref sent to HubRise. */
export interface PricingVariant {
  /** Stable unique key. Channel presets reuse the channel key (e.g.
   *  "UBER_EATS"); custom variants get a generated ref (e.g. "var_ab12cd"). */
  ref: string;
  /** Display name shown to the operator and published to HubRise. */
  name: string;
  /** Set for the built-in channel presets so the UI can badge them and
   *  the publisher knows the delivery channel. Absent for custom variants. */
  channelKey?: string;
}

/** Built-in channel presets an operator can one-click add as variants.
 *  Refs deliberately equal the keys already used in
 *  MenuItem.platformPricingOverrides so existing per-channel prices map
 *  straight onto the matching preset variant with no data migration. */
export const CHANNEL_VARIANT_PRESETS: ReadonlyArray<Required<PricingVariant>> = [
  { ref: "UBER_EATS", name: "Uber Eats", channelKey: "UBER_EATS" },
  { ref: "DELIVEROO", name: "Deliveroo", channelKey: "DELIVEROO" },
  { ref: "JUST_EAT", name: "Just Eat", channelKey: "JUST_EAT" },
];

/** Coerce a stored JSON value into a clean PricingVariant[]. Tolerates
 *  legacy/garbage shapes (returns []). */
export function normalizePricingVariants(value: unknown): PricingVariant[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: PricingVariant[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const ref = String((raw as any).ref ?? "").trim();
    const name = String((raw as any).name ?? "").trim();
    if (!ref || !name || seen.has(ref)) continue;
    seen.add(ref);
    const channelKey = (raw as any).channelKey;
    out.push({
      ref,
      name,
      ...(typeof channelKey === "string" && channelKey
        ? { channelKey }
        : {}),
    });
  }
  return out;
}

/** One HubRise price-override rule. */
export interface HubRisePriceOverride {
  variant_refs: string[];
  price: string; // "9.99 GBP"
}

/**
 * Build HubRise `price_overrides[]` from a {variantRef -> amount} map,
 * restricted to the variants actually defined on the menu. A variant whose
 * override equals the default price is skipped (no-op rule).
 *
 * @param overrides   e.g. { UBER_EATS: 11.99, var_kiosk: 9.5 }
 * @param variantRefs the set of refs defined on the menu (others ignored)
 * @param defaultPrice the SKU/option base price (rules equal to it are dropped)
 * @param formatPrice  money formatter, e.g. (n) => `${n.toFixed(2)} GBP`
 */
export function buildHubRisePriceOverrides(
  overrides: Record<string, number> | null | undefined,
  variantRefs: ReadonlySet<string>,
  defaultPrice: number,
  formatPrice: (amount: number) => string,
): HubRisePriceOverride[] {
  if (!overrides || typeof overrides !== "object") return [];
  const rules: HubRisePriceOverride[] = [];
  for (const [ref, amount] of Object.entries(overrides)) {
    const n = Number(amount);
    if (!variantRefs.has(ref)) continue;
    if (!Number.isFinite(n) || n < 0) continue;
    if (n === defaultPrice) continue;
    rules.push({ variant_refs: [ref], price: formatPrice(n) });
  }
  return rules;
}
