// ── AI menu classifier ──────────────────────────────────────────────────────
//
// Turns the structured draft Claude extracts from an uploaded menu
// (PDF / JPEG / PNG) into the same `NormalizedMenu` shape every other
// importer produces, so it flows through `MenuWriterService.apply()`
// untouched — atomic writes, the modifier holding-group, product↔group
// links, category ordering, multi-SKU pricing.
//
// The draft is a friendly nested shape the dashboard shows for review:
//
//   categories[] -> items[] (each with an optional sizes[] for size pricing)
//   modifierGroups[] (shared, referenced by item.modifierGroupKeys)
//
// The classifier assigns synthetic external IDs NAMESPACED by the menu id
// so two AI imports under the same brand never collide on (platformSource,
// externalId) inside the writer's upsert.

import { createHash } from "crypto";
import { extractSizeKey, type ProductSku } from "@orderhub/shared";
import type {
  NormalizedCategory,
  NormalizedMenu,
  NormalizedModifier,
  NormalizedModifierGroup,
  NormalizedProduct,
} from "./normalized-menu.types";

// ── Draft shape (shared with the parse service + the dashboard) ──────────────

export interface AiMenuSize {
  /** "10 inch", "Small", "Large", "Regular"… */
  name: string;
  price: number;
  sku?: string | null;
}

export interface AiMenuOptionSizePrice {
  /** Must match one of the parent item's size names. */
  sizeName: string;
  price: number;
}

export interface AiMenuOption {
  name: string;
  /** Extra cost when chosen; 0 for free. */
  priceAdjustment?: number;
  /** Per-size pricing (rare). Surfaced to the operator, not auto-applied. */
  pricesBySize?: AiMenuOptionSizePrice[];
}

export interface AiMenuGroup {
  /** Stable key the model assigns (e.g. "g_sauce") so items can reference it. */
  key: string;
  name: string;
  /** VARIANT = pick one (radio), ADDON = pick many (checkbox). */
  selectionType: "VARIANT" | "ADDON";
  minSelections?: number;
  maxSelections?: number;
  options: AiMenuOption[];
}

export interface AiMenuItem {
  name: string;
  description?: string | null;
  /** Single price; ignored when sizes[] has 2+ entries. */
  price?: number;
  sku?: string | null;
  /** Different prices for different sizes. */
  sizes?: AiMenuSize[];
  /** Keys into draft.modifierGroups. */
  modifierGroupKeys?: string[];
}

export interface AiMenuCategory {
  name: string;
  description?: string | null;
  items: AiMenuItem[];
}

export interface AiMenuDraft {
  menuName?: string;
  currency?: string;
  categories: AiMenuCategory[];
  modifierGroups?: AiMenuGroup[];
  warnings?: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const sha = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 32);

/** Coerce to a non-negative money value rounded to pennies. */
const money = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : 0;
};

const clean = (s: unknown): string =>
  typeof s === "string" ? s.trim() : "";

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * @param draft  The (operator-reviewed) draft from the parse service.
 * @param ns     Namespace for synthetic external IDs — pass the menu id so
 *               external IDs are unique across imports.
 */
export function classifyAiMenu(draft: AiMenuDraft, ns: string): NormalizedMenu {
  const warnings: string[] = [...(draft.warnings ?? [])];

  const categories: NormalizedCategory[] = [];
  const products: NormalizedProduct[] = [];
  const modifierGroups: NormalizedModifierGroup[] = [];
  const modifiers: NormalizedModifier[] = [];
  const productModifierGroupLinks: NormalizedMenu["productModifierGroupLinks"] = [];
  const modifierGroupModifierLinks: NormalizedMenu["modifierGroupModifierLinks"] = [];

  // ── Modifier groups + options ──
  const groupKeyToExt = new Map<string, string>();
  let perSizeOptionSeen = false;

  (draft.modifierGroups ?? []).forEach((g, gi) => {
    const groupExt = `${ns}-grp-${gi}`;
    const key = clean(g.key);
    if (key) groupKeyToExt.set(key, groupExt);

    const optionExtIds: string[] = [];
    (g.options ?? []).forEach((o, oi) => {
      const optExt = `${groupExt}-opt-${oi}`;
      optionExtIds.push(optExt);
      const price = money(o.priceAdjustment ?? 0);

      // Per-size option pricing is a footgun (an option HIDES on sizes it
      // isn't priced for). We surface it as a warning rather than applying
      // it blindly — the operator sets it deliberately in the editor.
      if ((o.pricesBySize?.length ?? 0) > 0) perSizeOptionSeen = true;

      modifiers.push({
        externalId: optExt,
        name: clean(o.name) || "Option",
        plu: optExt,
        priceAdjustment: price,
        pricesBySize: {},
        skuPlus: {},
        isAvailable: true,
        visibleToCustomers: true,
        syncHash: sha(JSON.stringify({ n: o.name, price })),
      });
      modifierGroupModifierLinks.push({
        modifierGroupExternalId: groupExt,
        modifierExternalId: optExt,
      });
    });

    const isAddon = g.selectionType === "ADDON";
    let min = Math.floor(Number(g.minSelections));
    if (!Number.isFinite(min) || min < 0) min = isAddon ? 0 : 1;
    let max = Math.floor(Number(g.maxSelections));
    if (!Number.isFinite(max) || max < 1) max = isAddon ? optionExtIds.length || 1 : 1;
    if (max < min) max = min;

    modifierGroups.push({
      externalId: groupExt,
      name: clean(g.name) || "Options",
      plu: groupExt,
      selectionType: isAddon ? "ADDON" : "VARIANT",
      minSelections: min,
      maxSelections: max,
      allowDuplicateSelections: isAddon,
      modifierExternalIds: optionExtIds,
      syncHash: sha(JSON.stringify({ n: g.name, min, max, optionExtIds })),
    });
  });

  if (perSizeOptionSeen) {
    warnings.push(
      "Some modifiers looked like they're priced differently per size. They were imported at a single price — set per-size prices in the menu editor if needed.",
    );
  }

  // ── Categories + products ──
  let prodCounter = 0;
  (draft.categories ?? []).forEach((cat, ci) => {
    const productExternalIds: string[] = [];

    (cat.items ?? []).forEach((it) => {
      const prodExt = `${ns}-prod-${prodCounter++}`;
      productExternalIds.push(prodExt);

      const groupExts = (it.modifierGroupKeys ?? [])
        .map((k) => groupKeyToExt.get(clean(k)))
        .filter((x): x is string => !!x);

      const sizes = (it.sizes ?? []).filter((s) => s && clean(s.name));
      const hasMultipleSkus = sizes.length > 1;

      let basePrice: number;
      let productSkus: ProductSku[] = [];
      if (hasMultipleSkus) {
        productSkus = sizes.map((s, si) => ({
          name: clean(s.name),
          plu: clean(s.sku) || `${prodExt}-sku-${si}`,
          price: money(s.price),
          // Local group ids back-filled after the writer creates the rows.
          modifierGroups: [],
        }));
        basePrice = Math.min(...productSkus.map((s) => s.price));
      } else {
        basePrice = money(it.price ?? sizes[0]?.price ?? 0);
      }

      products.push({
        externalId: prodExt,
        name: clean(it.name) || "Item",
        description: clean(it.description) || null,
        price: basePrice,
        imageUrl: null,
        plu: clean(it.sku) || prodExt,
        isAvailable: true,
        outOfStock: false,
        visibleToCustomers: true,
        hasMultipleSkus,
        productSkus,
        modifierGroupExternalIds: groupExts,
        syncHash: sha(JSON.stringify({ n: it.name, basePrice, productSkus, groupExts })),
      });

      for (const gExt of groupExts) {
        productModifierGroupLinks.push({
          productExternalId: prodExt,
          modifierGroupExternalId: gExt,
        });
      }
    });

    categories.push({
      externalId: `${ns}-cat-${ci}`,
      name: clean(cat.name) || `Category ${ci + 1}`,
      sortOrder: ci,
      available: true,
      visibleToCustomers: true,
      syncHash: sha(JSON.stringify({ n: cat.name, productExternalIds })),
      productExternalIds,
    });
  });

  return {
    platformSource: "ai",
    menuPatch: {
      menuData: {},
      rawImportPayload: draft as unknown as Record<string, unknown>,
      syncHash: sha(JSON.stringify(draft)),
    },
    categories,
    products,
    modifierGroups,
    modifiers,
    productModifierGroupLinks,
    modifierGroupModifierLinks,
    // Vision parsing reads a printed menu, which has no way to express a
    // group hanging off one option. Flat by construction.
    optionNestedGroupLinks: [],
    warnings,
  };
}

// `extractSizeKey` is imported so a future revision can wire per-size
// modifier pricing through the same key logic the storefront uses.
void extractSizeKey;
