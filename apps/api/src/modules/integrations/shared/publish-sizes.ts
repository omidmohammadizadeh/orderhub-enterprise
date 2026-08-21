// ── How a multi-SKU product reaches a marketplace ───────────────────────────
//
// Neither Deliveroo nor Uber Eats has a size concept. A size is a required
// pick-one modifier group — which is exactly how a sized product arrives when
// we IMPORT one, and what the importer converts into productSkus.
//
// Publishing it back has two possible shapes, and the right one depends on the
// product:
//
//   A. ONE item + a required "Size" group
//      Margherita  £8.99
//        Size (pick one):  9 inch +£0.00 | 12 inch +£3.00 | 14 inch +£5.00
//        Toppings:         Extra cheese +£1.00
//
//      One tile on the marketplace, matching how the menu was authored and
//      how it looked before we imported it. A Deliveroo → OrderHub →
//      Deliveroo round trip returns the same shape it started as.
//
//   B. ONE item PER SIZE
//      Margherita - 9 inch   £8.99   Toppings: Extra cheese +£0.75
//      Margherita - 12 inch  £11.99  Toppings: Extra cheese +£1.00
//      Margherita - 14 inch  £13.99  Toppings: Extra cheese +£1.25
//
//      Three tiles. Clutters the category and splits the item's ranking and
//      stats — but it is the ONLY correct shape when a modifier's price or
//      availability depends on the size, because no marketplace can express
//      "this modifier costs more when that other modifier is selected".
//
// So the choice isn't a preference, it's a constraint: use A whenever the menu
// can be represented faithfully, and B only when the data forces it.

import type {
  SrcGroup,
  SrcOption,
} from "../deliveroo/deliveroo-menu.transformer";

/** Minimal shape of one productSkus[] row. */
export interface PublishSku {
  name: string;
  plu?: string | null;
  price: number | string;
  modifierGroups?: string[] | null;
}

/** The group name customers see above the size choices. */
export const SIZE_GROUP_NAME = "Size";

/**
 * Does this product HAVE to be published as one item per size?
 *
 * Two things force it, and both are cases a single size group cannot express:
 *
 *   1. A modifier priced or restricted per size (`pricesBySize`). A 14"
 *      extra cheese costing more than a 9" one cannot be stated once — and
 *      an option keyed to sizes it isn't sold at is hidden on the others,
 *      which a single group can't do either.
 *
 *   2. Sizes that offer DIFFERENT modifier groups. Marketplaces have no
 *      conditional groups, so "stuffed crust only on 12 inch and up" can
 *      only be said by splitting the item.
 */
export function needsPerSizeExpansion(
  skus: PublishSku[],
  groupsById: Map<string, { options?: Array<{ pricesBySize?: unknown }> | null }>,
): boolean {
  if (skus.length === 0) return false;

  // (2) — every size must offer the same set of groups.
  const signature = (s: PublishSku) =>
    [...new Set(s.modifierGroups ?? [])].sort().join("|");
  const first = signature(skus[0]!);
  if (skus.some((s) => signature(s) !== first)) return true;

  // (1) — any per-size price or per-size availability anywhere in those groups.
  for (const gid of skus[0]!.modifierGroups ?? []) {
    const g = groupsById.get(gid);
    for (const o of g?.options ?? []) {
      const by = o?.pricesBySize as Record<string, unknown> | null | undefined;
      if (by && typeof by === "object" && Object.keys(by).length > 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The item price for a sized product published as ONE item: its cheapest size.
 *
 * Marketplaces add a modifier's price to the item's, so the base has to be the
 * cheapest size and each size then carries the difference. Pricing off any
 * other size would make the cheaper ones negative.
 */
export function sizeBasePrice(skus: PublishSku[]): number {
  return Math.min(...skus.map((s) => Number(s.price) || 0));
}

/**
 * The required pick-one group holding the sizes.
 *
 * Each option's price is its difference from the cheapest size, so the
 * customer sees "12 inch +£3.00" and the total comes out right. The PLU is the
 * SKU's own, which is what lets an incoming order line be reconciled back to
 * the size that was ordered.
 */
export function buildSizeGroup(
  itemId: string,
  skus: PublishSku[],
  opts?: { taxRate?: number | null },
): SrcGroup {
  const base = sizeBasePrice(skus);
  const options: SrcOption[] = skus.map((sku, i) => ({
    id: `${itemId}__size${i}`,
    name: sku.name,
    price: Math.round(((Number(sku.price) || 0) - base) * 100) / 100,
    plu: sku.plu ?? null,
    taxRate: opts?.taxRate ?? null,
    available: true,
  }));

  return {
    // Deterministic, so republishing doesn't churn the marketplace's ids.
    id: `${itemId}__sizes`,
    name: SIZE_GROUP_NAME,
    minSelections: 1,
    maxSelections: 1,
    selectionType: "VARIANT",
    allowDuplicateSelections: false,
    options,
  };
}

/**
 * Sizes priced BELOW the product's own base price.
 *
 * A marketplace item is published at its cheapest size, with each size priced
 * as the difference from it — so one size mistyped as a supplement rather than
 * a total silently becomes the item's advertised price. THE GRILL STOP's
 * Quarter Chicken went out on Deliveroo at £3.99 because a "Make it meal"
 * size was set to £3.99 instead of £10.48, and nothing said so: the publish
 * succeeded, the maths was self-consistent, and the wrong price sat on a live
 * marketplace.
 *
 * Under the supplement model a well-formed sized product always has one size
 * AT the base price and the rest above it, so anything below is a data error
 * worth naming. Returns the offending size names; empty when all is well.
 *
 * Reporting only — deliberately does NOT alter what is published. Re-anchoring
 * on the base price would push the mistyped size to a negative option price,
 * which marketplaces reject, taking the whole menu down over one bad field.
 */
export function sizesUnderBase(
  skus: PublishSku[],
  basePrice: number | null | undefined,
): string[] {
  const base = Number(basePrice) || 0;
  if (base <= 0) return []; // no base set — the cheapest size is the only truth
  return skus
    .filter((s) => (Number(s.price) || 0) < base - 0.005)
    .map((s) => s.name);
}
