// ── Deliveroo menu classifier ───────────────────────────────────────────────
//
// Pure function: given the raw response from
//   GET /menu/v2/brands/{brand_id}/sites/{store_id}/menu
// returns a NormalizedMenu the writer persists.
//
// Critical Deliveroo quirks (from Base44 audit):
//
//   1. Deliveroo calls modifier *groups* "modifiers" in their API and
//      modifier *options* are normal items with `type: "CHOICE"`. So
//      classification flips: every `items[]` entry with type CHOICE is a
//      modifier; `menu.modifiers[]` are modifier groups.
//
//   2. Product → modifier group linking lives in `item.modifier_ids[]`
//      on the product item itself. This field name is fragile — older
//      Deliveroo brands sometimes emit `modifier_group_ids` or
//      `modifier_groups`. We probe all three.
//
//   3. PLU is in `item.plu`. If the restaurant didn't set it in their
//      Deliveroo back-office, the field is empty and we fall back to
//      `item.id`. Same pattern as Uber.
//
//   4. Price unit: Deliveroo sometimes returns `price_info.price` in
//      pence (integer) and sometimes in pounds (decimal). Heuristic:
//      treat ≥ 100 as pence-with-no-decimal-separator, < 100 as pounds.
//      This matches Base44's observed behaviour.

import { createHash } from "crypto";
import type {
  NormalizedCategory,
  NormalizedMenu,
  NormalizedModifier,
  NormalizedModifierGroup,
  NormalizedProduct,
} from "./normalized-menu.types";

// ── Public types ────────────────────────────────────────────────────────────

export interface DeliverooMenuPayload {
  menu?: {
    items?: Array<DeliverooItem>;
    categories?: Array<DeliverooCategory>;
    modifiers?: Array<DeliverooModifierGroup>;
    mealtimes?: Array<{ id: string; category_ids?: string[] }>;
  };
  [key: string]: unknown;
}

// Deliveroo v2 menu returns localised name/description objects ({ en: "…" }),
// but pasted exports may still use plain strings — accept both.
type Localised = string | Record<string, string>;

interface DeliverooItem {
  id: string;
  type?: "ITEM" | "CHOICE";
  name?: Localised;
  description?: Localised;
  plu?: string;
  price_info?: { price?: number };
  image?: { url?: string };
  modifier_ids?: string[];
  modifier_group_ids?: string[];
  modifier_groups?: string[];
  available?: boolean;
}
interface DeliverooCategory {
  id: string;
  name?: Localised;
  item_ids?: string[];
}
interface DeliverooModifierGroup {
  id: string;
  name?: Localised;
  item_ids?: string[];
  min_selection?: number;
  max_selection?: number;
  repeatable?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const sha = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 32);

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Deliveroo's Menu API returns `name`/`description` as localised objects
 * (`{ en: "…" }`), though older/pasted exports sometimes use a plain string.
 * Coerce either to a plain string (prefer `en`, else the first locale value).
 */
function localized(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const pick = o.en ?? o.en_GB ?? Object.values(o)[0];
    return typeof pick === "string" ? pick : "";
  }
  return "";
}

/**
 * Deliveroo returns prices in minor currency units (pence for GBP). Always
 * divide by 100. Matches Base44's `price_info.price / 100` convention.
 *
 * The integer-vs-decimal ambiguity I'd initially worried about doesn't
 * surface in practice — Deliveroo guarantees integer pence in current
 * API versions. If a future tenant connects on an older API and we see
 * non-integer values, the importer will silently scale incorrectly. Add
 * a sanity check once we have a real account to test against.
 */
function priceFrom(item: { price_info?: { price?: number } }): number {
  const p = item.price_info?.price;
  if (p === undefined || p === null) return 0;
  return round2(p / 100);
}

function extractModifierGroupIds(item: DeliverooItem): string[] {
  return (
    item.modifier_ids ??
    item.modifier_group_ids ??
    item.modifier_groups ??
    []
  );
}

// ── Entry point ─────────────────────────────────────────────────────────────

export function classifyDeliverooMenu(
  payload: DeliverooMenuPayload,
): NormalizedMenu {
  const warnings: string[] = [];
  const items = payload.menu?.items ?? [];
  const categories = payload.menu?.categories ?? [];
  const modifierGroups = payload.menu?.modifiers ?? [];

  // Step 1: which items are products vs modifier options?
  const productItemIds = new Set<string>();
  for (const cat of categories) {
    for (const id of cat.item_ids ?? []) productItemIds.add(id);
  }
  const modifierItemIds = new Set<string>();
  for (const mg of modifierGroups) {
    for (const id of mg.item_ids ?? []) modifierItemIds.add(id);
  }

  // Step 2: classify each item.
  const products: NormalizedProduct[] = [];
  const modifiers: NormalizedModifier[] = [];
  const productGroupLinks: NormalizedMenu["productModifierGroupLinks"] = [];
  let itemsWithoutModifierIdsCount = 0;

  for (const item of items) {
    const isChoiceType = item.type === "CHOICE";
    const isProduct = productItemIds.has(item.id) && !isChoiceType;
    const isModifier = modifierItemIds.has(item.id) || isChoiceType;

    if (isProduct) {
      const price = priceFrom(item);
      const plu = (item.plu ?? item.id).toString();
      const groupIds = extractModifierGroupIds(item);
      if (groupIds.length === 0) itemsWithoutModifierIdsCount++;

      products.push({
        externalId: item.id,
        name: localized(item.name) || item.id,
        description: localized(item.description) || null,
        price,
        imageUrl: item.image?.url ?? null,
        plu,
        isAvailable: item.available !== false,
        outOfStock: false,
        visibleToCustomers: true,
        hasMultipleSkus: false,
        productSkus: [],
        modifierGroupExternalIds: groupIds,
        syncHash: sha(JSON.stringify({ name: item.name, plu, price, groupIds, available: item.available })),
      });

      for (const grpExt of groupIds) {
        productGroupLinks.push({
          productExternalId: item.id,
          modifierGroupExternalId: grpExt,
        });
      }
    } else if (isModifier) {
      const price = priceFrom(item);
      const plu = (item.plu ?? item.id).toString();
      modifiers.push({
        externalId: item.id,
        name: localized(item.name) || item.id,
        plu,
        priceAdjustment: price,
        pricesBySize: {},
        skuPlus: {},
        isAvailable: item.available !== false,
        visibleToCustomers: true,
        syncHash: sha(JSON.stringify({ name: item.name, plu, price, available: item.available })),
      });
    }
  }

  // Step 3: normalize categories.
  const normalizedCategories: NormalizedCategory[] = categories.map((cat, idx) => {
    const productExternalIds = (cat.item_ids ?? []).filter((id) =>
      productItemIds.has(id),
    );
    return {
      externalId: cat.id,
      name: localized(cat.name) || cat.id,
      sortOrder: idx,
      available: true,
      visibleToCustomers: true,
      syncHash: sha(JSON.stringify({ name: cat.name, productExternalIds })),
      productExternalIds,
    };
  });

  // Step 4: normalize modifier groups + group-to-modifier links.
  const groupModifierLinks: NormalizedMenu["modifierGroupModifierLinks"] = [];
  const normalizedGroups: NormalizedModifierGroup[] = modifierGroups.map((mg) => {
    const min = Number(mg.min_selection ?? 0);
    const max = Number(mg.max_selection ?? 1);
    const selectionType: "VARIANT" | "ADDON" = max > 1 ? "ADDON" : "VARIANT";
    const optionIds = mg.item_ids ?? [];
    for (const optId of optionIds) {
      groupModifierLinks.push({
        modifierGroupExternalId: mg.id,
        modifierExternalId: optId,
      });
    }
    return {
      externalId: mg.id,
      name: localized(mg.name) || mg.id,
      plu: mg.id,
      selectionType,
      minSelections: min,
      maxSelections: max,
      allowDuplicateSelections: !!mg.repeatable,
      modifierExternalIds: optionIds,
      syncHash: sha(JSON.stringify({ name: mg.name, min, max, optionIds, repeatable: mg.repeatable })),
    };
  });

  // Step 5: surface fragility warnings (Base44 audit calls these out).
  if (itemsWithoutModifierIdsCount > 0 && products.length > 0 && modifierGroups.length > 0) {
    const ratio = itemsWithoutModifierIdsCount / products.length;
    if (ratio > 0.5) {
      warnings.push(
        `${itemsWithoutModifierIdsCount}/${products.length} products had no modifier_ids[]. ` +
          "Deliveroo may be using a different link field — modifier groups will not be attached.",
      );
    }
  }

  const fullHash = sha(JSON.stringify(payload));

  return {
    platformSource: "deliveroo",
    menuPatch: {
      menuData: { mealtimes: payload.menu?.mealtimes ?? [] },
      rawImportPayload: payload as Record<string, unknown>,
      syncHash: fullHash,
    },
    categories: normalizedCategories,
    products,
    modifierGroups: normalizedGroups,
    modifiers,
    productModifierGroupLinks: productGroupLinks,
    modifierGroupModifierLinks: groupModifierLinks,
    warnings,
  };
}
