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

/** A named price list on a menu — one brand×channel leaf. `ref` is the
 *  stable key used everywhere overrides are stored, and the ref sent to
 *  HubRise. In a shared catalog, brand is encoded into the variant (name +
 *  `brandId`) so HubRise can tell brands apart and products can be scoped
 *  to their brand via `restrictions.variant_refs`. */
export interface PricingVariant {
  /** Stable unique key. Brand×channel leaves use `${brandId}__${channelKey}`;
   *  custom variants get a generated ref (e.g. "var_ab12cd"). */
  ref: string;
  /** Display name published to HubRise, e.g. "Monster Burgerz — Uber Eats". */
  name: string;
  /** Delivery channel for this leaf (UBER_EATS/DELIVEROO/JUST_EAT). Absent
   *  for fully custom variants. */
  channelKey?: string;
  /** The OrderHub brand this variant belongs to. Products are restricted to
   *  the variants whose brandId matches the product's brand, so a brand's
   *  connector only sees that brand's products. Absent = global variant. */
  brandId?: string;
  /** Cached brand display name (for the variant label + UI grouping). */
  brandName?: string;
}

/** Build the stable ref for a brand×channel leaf. */
export function brandChannelRef(brandId: string, channelKey: string): string {
  return `${brandId}__${channelKey}`;
}

/** Turn a free-text channel name into a stable UPPER_SNAKE key, for custom
 *  channels beyond the built-in presets (e.g. "Careem", "Talabat", "WhatsApp",
 *  "Online ordering" -> "ONLINE_ORDERING"). Empty when the name has no
 *  alphanumeric characters — callers should reject that case. */
export function slugifyChannelKey(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Built-in channel presets an operator can one-click add as variants.
 *  Refs deliberately equal the keys already used in
 *  MenuItem.platformPricingOverrides so existing per-channel prices map
 *  straight onto the matching preset variant with no data migration. */
export interface ChannelPreset {
  channelKey: string;
  name: string;
}

export const CHANNEL_VARIANT_PRESETS: ReadonlyArray<ChannelPreset> = [
  { channelKey: "UBER_EATS", name: "Uber Eats" },
  { channelKey: "DELIVEROO", name: "Deliveroo" },
  { channelKey: "JUST_EAT", name: "Just Eat" },
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
    const brandId = (raw as any).brandId;
    const brandName = (raw as any).brandName;
    out.push({
      ref,
      name,
      ...(typeof channelKey === "string" && channelKey ? { channelKey } : {}),
      ...(typeof brandId === "string" && brandId ? { brandId } : {}),
      ...(typeof brandName === "string" && brandName ? { brandName } : {}),
    });
  }
  return out;
}

/**
 * The variant refs that apply to a product given the brand(s) it belongs
 * to. Used to set HubRise `restrictions.variant_refs` so a product only
 * appears under its own brand's connectors. Returns [] when no brand-tagged
 * variant matches (caller should then leave the product unrestricted).
 */
export function variantRefsForBrands(
  variants: ReadonlyArray<PricingVariant>,
  brandIds: ReadonlyArray<string | null | undefined>,
): string[] {
  const set = new Set(brandIds.filter((b): b is string => !!b));
  if (set.size === 0) return [];
  return variants.filter((v) => v.brandId && set.has(v.brandId)).map((v) => v.ref);
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
