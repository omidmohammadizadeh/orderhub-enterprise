// Reading the storefront payload: which items a customer may see, which
// modifier groups apply to an item (and to each of its sizes), and which
// illustration stands in for a missing photo.

import { displayPrice } from "@shared/display-price";
import type { MenuCategory, MenuItem, ModifierGroup, ProductSku, Storefront } from "@/api/types";
import { toNumber } from "./money";

export type Fulfillment = "DELIVERY" | "PICKUP";

export function isOrderable(item: MenuItem): boolean {
  return item.isAvailable !== false && item.outOfStock !== true;
}

export function isVisible(item: MenuItem, mode: Fulfillment): boolean {
  if (item.visibleToCustomers === false) return false;
  if (mode === "DELIVERY" && item.availableDelivery === false) return false;
  if (mode === "PICKUP" && item.availableCollection === false) return false;
  return true;
}

export type MenuSection = { id: string; title: string; items: MenuItem[] };

/** Categories with at least one visible item, items in menu order. A category
 *  price override replaces the item's base price, as on the storefront. */
export function menuSections(store: Storefront, mode: Fulfillment): MenuSection[] {
  return (store.menu?.categories ?? [])
    .map((c: MenuCategory) => ({
      id: c.id,
      title: c.name,
      items: c.items
        .map((row) =>
          row.priceOverride != null ? { ...row.item, basePrice: toNumber(row.priceOverride) } : row.item,
        )
        .filter((it) => isVisible(it, mode)),
    }))
    .filter((s) => s.items.length > 0);
}

/** "£8.50" or "From £8.50" — the same rule the web storefront uses. */
export function priceLabel(item: MenuItem): string {
  const { amount, from } = displayPrice(item as any);
  return `${from ? "From " : ""}£${amount.toFixed(2)}`;
}

/** Does tapping this item need the options sheet, or can it go straight in? */
export function needsOptions(item: MenuItem): boolean {
  return (item.productSkus?.length ?? 0) > 1 || (item.modifierGroupLinks?.length ?? 0) > 0 ||
    (item.productSkus?.[0]?.modifierGroups.length ?? 0) > 0;
}

/**
 * Groups that apply to an item. A multi-size product takes its groups from the
 * chosen SIZE (those are bare ids in productSkus[], resolved against the
 * brand catalogue); a flat product from its own links. A link whose group
 * can't be found is dropped, never shown empty — an empty required group
 * would let a pizza through with no size.
 */
export function activeGroups(
  item: MenuItem,
  sku: ProductSku | null,
  catalogue: ModifierGroup[],
): ModifierGroup[] {
  const byId = new Map(catalogue.map((g) => [g.id, g]));
  const visible = (g: ModifierGroup | undefined): g is ModifierGroup => !!g && g.visibleToCustomers !== false;
  if (sku) return (sku.modifierGroups ?? []).map((id) => byId.get(id)).filter(visible);
  return (item.modifierGroupLinks ?? []).map((l) => l.group ?? byId.get(l.groupId)).filter(visible);
}

// ── Illustrations for missing photos (drawn in components/FoodArt) ─────────

export type FoodKind = "pizza" | "burger" | "kebab" | "dessert" | "curry" | "chicken" | "fries" | "drink" | "chinese";

const KIND_WORDS: Array<[FoodKind, RegExp]> = [
  ["pizza", /pizza|garlic bread|calzone|feast/i],
  ["burger", /burger|smash/i],
  ["kebab", /kebab|donner|doner|shawarma|grill|wrap|gyro/i],
  ["curry", /curry|indian|tikka|masala|biryani|korma|balti/i],
  ["chicken", /chicken|wing|nugget|fried/i],
  ["dessert", /dessert|cake|ice|sweet|waffle|donut|shake/i],
  ["drink", /drink|cola|coke|pepsi|fanta|sprite|water|juice|pop|irn|dr pepper/i],
  ["fries", /chips|fries|wedges|sundr|side|rings/i],
  ["chinese", /chinese|noodle|dragon|wok|rice/i],
];

export function foodKind(...hints: Array<string | null | undefined>): FoodKind {
  const text = hints.filter(Boolean).join(" ");
  for (const [kind, re] of KIND_WORDS) if (re.test(text)) return kind;
  return "pizza";
}
