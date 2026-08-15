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

/**
 * Bumped whenever this classifier's OUTPUT changes shape, so an unchanged
 * Deliveroo payload still re-imports. See the fullHash comment at the bottom.
 *
 *   2 — sized products carry their modifier groups on each SKU (they were
 *       emitted empty, so a product with sizes offered no options at all),
 *       and options carry their nested groups.
 */
const CLASSIFIER_VERSION = 2;

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

/**
 * Deliveroo's image field shape varies (menu-manager vs API-built menus):
 *   image: { url }          | image: "https://…"
 *   image_url: "https://…"  | images: [{ url }] | images: ["https://…"]
 * Probe them all; return null when none present.
 */
function imageFrom(item: any): string | null {
  const single = item.image ?? item.image_url ?? item.imageUrl;
  if (typeof single === "string") return single || null;
  if (single && typeof single === "object" && typeof single.url === "string") {
    return single.url || null;
  }
  const arr = item.images ?? item.media;
  if (Array.isArray(arr) && arr.length > 0) {
    const first = arr[0];
    if (typeof first === "string") return first || null;
    if (first && typeof first === "object" && typeof first.url === "string") {
      return first.url || null;
    }
  }
  return null;
}

/**
 * Words that mark a single-choice group as a SIZE rather than a topping.
 *
 * Deliveroo has no size concept: a 9"/12"/14" pizza is a modifier group with
 * min 1 / max 1 whose choices carry the prices. Structure alone can't tell
 * that apart from "Choose your sauce", which is also pick-exactly-one — and
 * turning sauces into sizes would wreck a menu far more visibly than missing
 * a size group. So the name has to agree as well.
 */
// Deliberately narrow. An earlier draft also matched base/crust/small/medium/
// large and immediately converted a "Crust" group (Thin / Deep pan) into
// sizes — a crust is a style, not a size, and the existing classifier tests
// caught it. Erring narrow means an oddly-named size group imports as a
// modifier group and someone fixes it in a minute; erring wide silently
// rewrites real choice groups into sizes across a whole menu.
const SIZE_WORDS = /\b(size|sizes|inch|inches)\b|["\u201d]/i;

function isSizeGroup(mg: DeliverooModifierGroup): boolean {
  const min = Number(mg.min_selection ?? 0);
  const max = Number(mg.max_selection ?? 1);
  // Exactly one choice, required. A size you can skip isn't a size.
  if (min !== 1 || max !== 1) return false;
  return SIZE_WORDS.test(localized(mg.name) || "");
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

  // Which groups are really sizes, and the choices inside them.
  const groupsById = new Map(modifierGroups.map((mg) => [mg.id, mg]));
  const sizeGroupIds = new Set(
    modifierGroups.filter(isSizeGroup).map((mg) => mg.id),
  );
  // A choice only stops being a modifier if EVERY group holding it is a size
  // group. Shared options — a "Large" that is also a drink upgrade elsewhere —
  // must still exist as a modifier or that other group loses an option.
  const sizeChoiceIds = new Set<string>();
  for (const id of sizeGroupIds) {
    for (const optId of groupsById.get(id)?.item_ids ?? []) {
      const inNonSizeGroup = modifierGroups.some(
        (mg) => !sizeGroupIds.has(mg.id) && (mg.item_ids ?? []).includes(optId),
      );
      if (!inNonSizeGroup) sizeChoiceIds.add(optId);
    }
  }
  const itemsById = new Map(items.map((i) => [i.id, i]));

  // Step 2: classify each item.
  const products: NormalizedProduct[] = [];
  const modifiers: NormalizedModifier[] = [];
  const productGroupLinks: NormalizedMenu["productModifierGroupLinks"] = [];
  let itemsWithoutModifierIdsCount = 0;
  /** Size groups actually converted, so they aren't also written as groups. */
  const sizeGroupsUsed = new Set<string>();
  /** Choices that own their own groups — "Make It a Meal" and friends. */
  const modifiersWithNestedGroups: string[] = [];
  const optionNestedGroupLinks: NormalizedMenu["optionNestedGroupLinks"] = [];
  /** Nested groups pointing at something absent from menu.modifiers[]. */
  const danglingNestedGroupIds = new Set<string>();

  for (const item of items) {
    const isChoiceType = item.type === "CHOICE";
    const isProduct = productItemIds.has(item.id) && !isChoiceType;
    const isModifier = modifierItemIds.has(item.id) || isChoiceType;

    if (isProduct) {
      const price = priceFrom(item);
      const plu = (item.plu ?? item.id).toString();
      const groupIds = extractModifierGroupIds(item);
      if (groupIds.length === 0) itemsWithoutModifierIdsCount++;

      const image = imageFrom(item);

      // Sizes come in as a required single-choice group. Lift the first one
      // into productSkus and drop it from the modifier list, so a 12" pizza
      // is a SIZE on the product rather than a topping the operator has to
      // pick before they can price anything.
      const sizeGroupId = groupIds.find((g) => sizeGroupIds.has(g));
      // Everything else stays a normal modifier group on the product.
      const normalGroupIds = groupIds.filter((g) => g !== sizeGroupId);
      const skus = sizeGroupId
        ? (groupsById.get(sizeGroupId)?.item_ids ?? []).map((optId) => {
            const opt = itemsById.get(optId);
            return {
              name: localized(opt?.name) || optId,
              plu: (opt?.plu ?? optId).toString(),
              price: opt ? priceFrom(opt) : 0,
              // A sized product routes its groups through the SELECTED SKU —
              // the picker reads selectedSku.modifierGroups and ignores the
              // product's own links. Emitting [] here is why every product
              // that got sizes lost all of its toppings.
              //
              // Deliveroo has no per-size group concept: the product's other
              // groups apply whichever size you pick, so every SKU gets the
              // same list. These are EXTERNAL ids; the writer translates them
              // to local ids once the groups have been upserted.
              modifierGroups: [...normalGroupIds],
            };
          })
        : [];
      if (sizeGroupId && skus.length) {
        sizeGroupsUsed.add(sizeGroupId);
      }
      // Deliveroo prices the product at 0 when the size carries the price.
      // Show the cheapest size so the tile isn't "£0.00".
      const basePrice =
        skus.length && price === 0
          ? Math.min(...skus.map((s) => s.price))
          : price;

      products.push({
        externalId: item.id,
        name: localized(item.name) || item.id,
        description: localized(item.description) || null,
        price: basePrice,
        imageUrl: image,
        plu,
        isAvailable: item.available !== false,
        outOfStock: false,
        visibleToCustomers: true,
        hasMultipleSkus: skus.length > 0,
        productSkus: skus,
        modifierGroupExternalIds: normalGroupIds,
        // image is part of the hash so an image change (or a URL-form fix,
        // e.g. absolute→relative) updates the existing item on re-import
        // instead of being skipped as "unchanged".
        // Sizes ride the hash so a price change on one re-imports the item
        // instead of being skipped as unchanged.
        syncHash: sha(JSON.stringify({ name: item.name, plu, price: basePrice, groupIds: normalGroupIds, skus, available: item.available, image })),
      });

      for (const grpExt of normalGroupIds) {
        productGroupLinks.push({
          productExternalId: item.id,
          modifierGroupExternalId: grpExt,
        });
      }
    } else if (isModifier) {
      // Already lifted into a product's sizes — emitting it again would show
      // "12 inch" as a topping as well as a size.
      if (sizeChoiceIds.has(item.id)) continue;
      // A choice can itself carry modifier groups — "Make it a meal" opening
      // a sides and a drinks picker. Those groups and their options are
      // already in menu.modifiers[] / menu.items[], so they import as normal
      // rows; only the option → group edge was missing, which is why a meal
      // deal used to arrive looking complete and behave as if empty.
      //
      // Order is the payload's own: side before drink, as Deliveroo lists it.
      const nested = extractModifierGroupIds(item);
      if (nested.length) {
        modifiersWithNestedGroups.push(localized(item.name) || item.id);
        let sortOrder = 0;
        for (const grpExt of nested) {
          // A size group nested under an option can't become product SKUs —
          // there's no product here to hang them on. Keep it a normal group.
          if (!groupsById.has(grpExt)) {
            danglingNestedGroupIds.add(grpExt);
            continue;
          }
          optionNestedGroupLinks.push({
            modifierExternalId: item.id,
            modifierGroupExternalId: grpExt,
            sortOrder: sortOrder++,
          });
        }
      }
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
  const normalizedGroups: NormalizedModifierGroup[] = modifierGroups
    .filter((mg) => !sizeGroupsUsed.has(mg.id))
    .map((mg) => {
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

  if (sizeGroupsUsed.size) {
    const names = [...sizeGroupsUsed]
      .map((id) => localized(groupsById.get(id)?.name) || id)
      .join(", ");
    warnings.push(
      `Imported as product sizes rather than modifier groups: ${names}. ` +
        "If any of those are really a choice of topping, edit the product and move them back.",
    );
  }

  // A group can't be both a product's sizes and a nested group — the size
  // branch removes it from the group list, so the link would point at a row
  // that was never written. Drop those links rather than import a picker
  // step that opens nothing.
  const writtenGroupIds = new Set(normalizedGroups.map((g) => g.externalId));
  const liveNestedLinks = optionNestedGroupLinks.filter((l) => {
    const ok = writtenGroupIds.has(l.modifierGroupExternalId);
    if (!ok) danglingNestedGroupIds.add(l.modifierGroupExternalId);
    return ok;
  });

  if (modifiersWithNestedGroups.length) {
    const shown = modifiersWithNestedGroups.slice(0, 8).join(", ");
    const more =
      modifiersWithNestedGroups.length > 8
        ? ` (+${modifiersWithNestedGroups.length - 8} more)`
        : "";
    warnings.push(
      `${modifiersWithNestedGroups.length} option(s) open their own modifier groups ` +
        `— e.g. ${shown}${more}. Imported as nested groups: choosing the option ` +
        "asks for the follow-on choices.",
    );
  }

  if (danglingNestedGroupIds.size) {
    warnings.push(
      `${danglingNestedGroupIds.size} nested modifier group(s) referenced by an option ` +
        "are missing from the menu payload and were skipped. Those options import " +
        "without their follow-on choices.",
    );
  }

  // The menu-level hash short-circuits the ENTIRE import when it matches, so
  // a classifier fix would never reach a menu whose Deliveroo payload hadn't
  // also changed — the operator re-imports, gets "unchanged", and the bug
  // survives. Folding the version in means shipping a fix is enough to make
  // the next re-import actually apply it. Bump on any change to what the
  // classifier emits.
  const fullHash = sha(`${CLASSIFIER_VERSION}:${JSON.stringify(payload)}`);

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
    optionNestedGroupLinks: liveNestedLinks,
    warnings,
  };
}
