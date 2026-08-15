// ── Uber Eats menu classifier ───────────────────────────────────────────────
//
// Pure function: given the raw response from
//   GET /v2/eats/stores/{store_id}/menus?menu_type=MENU_TYPE_FULFILLMENT_DELIVERY
// it returns a NormalizedMenu the writer can persist.
//
// Critical Uber quirks (from Base44 audit, sanity-tested with fixture
// payloads):
//
//   1. `items[]` mixes products and modifier options. We classify by
//      cross-referencing category.entities (products) and
//      modifier_group.modifier_options (modifiers). Products take priority
//      when an item appears on both lists (defensive — Uber occasionally
//      emits an item under both during catalog merges).
//
//   2. Prices come in pence as integers (`price_info.price`). Divide by 100.
//
//   3. PLU sits in `item.external_data` if the restaurant set one in their
//      back-office; otherwise we fall back to `item.id` (Uber's own UUID)
//      so PLU is never null at import time. The writer can hand off to
//      PluService later if the operator wants nicer codes.
//
//   4. Selection semantics live in `quantity_info.quantity`. max_permitted
//      > 1 → ADDON; otherwise VARIANT.
//
//   5. Modifier group link field name varies. Real-world Uber payloads
//      have been observed with `modifier_group_ids`, `modifier_groups`,
//      `option_list_ids`, `option_lists`, `modifier_group_refs`,
//      `option_list_refs`, and `bundled_item_ids`. The Base44 code tries
//      all of them; we do the same.
//
//   6. Multi-SKU pizzas: Uber has no size concept either, so a sized
//      product arrives as a required pick-one group whose choices carry
//      the price — the same shape Deliveroo uses, and the same shape we
//      publish. It's lifted back into `productSkus[]` (see import-sizes.ts).
//
//   7. Uber nests: an option item can carry `modifier_group_ids` of its
//      own, which is how "Make It a Meal → Choose Side" and our per-size
//      groups reach the store. Options used to be read for name and price
//      only, so every nested group was silently dropped.

import { createHash } from "crypto";
import {
  foldSizedProduct,
  isSizeGroup,
  type FoldedProduct,
  type OptionPricing,
  type RawGroup,
  type RawOption,
} from "./import-sizes";
import type {
  NormalizedCategory,
  NormalizedMenu,
  NormalizedModifier,
  NormalizedModifierGroup,
  NormalizedProduct,
} from "./normalized-menu.types";

/**
 * Bumped whenever a change alters what an Uber import WRITES. The menu-level
 * hash short-circuits the whole import when it matches, so without a bump the
 * operator re-imports an unchanged Uber menu, is told "unchanged", and the fix
 * never lands. See the fullHash comment at the bottom.
 *
 *   2 — sizes lift into productSkus, options carry their nested groups, and
 *       the per-size group copies publishing emits fold back into one group
 *       with pricesBySize. Before this an Uber import dropped all three.
 */
const CLASSIFIER_VERSION = 2;

// ── Public ──────────────────────────────────────────────────────────────────

export interface UberMenuPayload {
  menus?: Array<UberMenu>;
  categories?: Array<UberCategory>;
  items?: Array<UberItem>;
  modifier_groups?: Array<UberModifierGroup>;
  [key: string]: unknown;
}

interface UberMenu {
  id: string;
  title?: { translations?: Record<string, string> };
  category_ids?: { ids?: string[] };
}
interface UberCategory {
  id: string;
  title?: { translations?: Record<string, string> };
  external_data?: string;
  entities?: Array<{ id: string }>;
}
interface UberItem {
  id: string;
  title?: { translations?: Record<string, string> };
  description?: { translations?: Record<string, string> };
  external_data?: string;
  price_info?: { price?: number };
  image_url?: string;
  modifier_group_ids?: { ids?: string[] };
  modifier_groups?: string[];
  option_list_ids?: { ids?: string[] };
  option_lists?: string[];
  modifier_group_refs?: string[];
  option_list_refs?: string[];
  bundled_item_ids?: string[];
  suspension_info?: { suspended?: boolean };
}
/**
 * Uber's item image shape varies just like Deliveroo's (API-upserted menus
 * carry image_url; Uber-Eats-Manager-managed / GET-retrieved menus can nest
 * it as image{url}, images[], media[] or translations maps). Probe them all;
 * return null when none present. (Same fix as the Deliveroo importer.)
 */
function imageFrom(item: any): string | null {
  const single =
    item.image_url ?? item.imageUrl ?? item.image ?? item.hero_image_url;
  if (typeof single === "string") return single || null;
  if (single && typeof single === "object") {
    if (typeof single.url === "string") return single.url || null;
    // translations map: { translations: { en_us: "https://…" } }
    const tr = (single as any).translations;
    if (tr && typeof tr === "object") {
      const first = Object.values(tr).find((v) => typeof v === "string");
      if (typeof first === "string") return first || null;
    }
  }
  const arr = item.images ?? item.media ?? item.image_urls;
  if (Array.isArray(arr) && arr.length > 0) {
    const first = arr[0];
    if (typeof first === "string") return first || null;
    if (first && typeof first === "object" && typeof first.url === "string") {
      return first.url || null;
    }
  }
  return null;
}

interface UberModifierGroup {
  id: string;
  title?: { translations?: Record<string, string> };
  quantity_info?: {
    quantity?: {
      min_permitted?: number;
      max_permitted?: number;
    };
  };
  modifier_options?: Array<{ id: string }>;
  options?: Array<{ id: string }>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const enTitle = (
  x: { translations?: Record<string, string> } | undefined,
  fallback = "",
): string =>
  x?.translations?.en_us ??
  x?.translations?.en_gb ??
  x?.translations?.en ??
  Object.values(x?.translations ?? {})[0] ??
  fallback;

const penceToPounds = (p: number | undefined): number =>
  p === undefined || p === null ? 0 : Math.round((p / 100) * 100) / 100;

const sha = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 32);

/**
 * The set of modifier-group fields we accept on an Uber item. Tries each
 * in order; first one with content wins. Matches the Base44 fallback list.
 */
function extractModifierGroupIds(item: UberItem): string[] {
  if (item.modifier_group_ids?.ids?.length) return item.modifier_group_ids.ids;
  if (item.modifier_groups?.length) return item.modifier_groups;
  if (item.option_list_ids?.ids?.length) return item.option_list_ids.ids;
  if (item.option_lists?.length) return item.option_lists;
  if (item.modifier_group_refs?.length) return item.modifier_group_refs;
  if (item.option_list_refs?.length) return item.option_list_refs;
  if (item.bundled_item_ids?.length) return item.bundled_item_ids;
  return [];
}

// ── Public entry point ──────────────────────────────────────────────────────

export function classifyUberMenu(payload: UberMenuPayload): NormalizedMenu {
  const warnings: string[] = [];
  const items = payload.items ?? [];
  const categories = payload.categories ?? [];
  const modifierGroups = payload.modifier_groups ?? [];

  // Step 1: cross-index which items are products vs modifiers.
  const productIds = new Set<string>();
  for (const cat of categories) {
    for (const entity of cat.entities ?? []) {
      if (entity.id) productIds.add(entity.id);
    }
  }
  const modifierIds = new Set<string>();
  for (const mg of modifierGroups) {
    for (const opt of mg.modifier_options ?? []) modifierIds.add(opt.id);
    for (const opt of mg.options ?? []) modifierIds.add(opt.id);
  }

  // Step 1b: fold sized products back off the wire.
  //
  // A size on Uber is a required pick-one group whose choices carry the
  // price, and the choices can open groups of their own — that's how a 12
  // inch offers a different crust list than a 10 inch. All of it has to be
  // resolved BEFORE the item loop, because the fold decides which option and
  // group rows are per-size copies that must not also be written standalone,
  // and items[] interleaves products with the copies.
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const groupsById = new Map(modifierGroups.map((mg) => [mg.id, mg]));
  const payloadGroupIds = new Set(modifierGroups.map((mg) => mg.id));

  const groupOptionIds = (mg: UberModifierGroup): string[] => [
    ...(mg.modifier_options?.map((o) => o.id) ?? []),
    ...(mg.options?.map((o) => o.id) ?? []),
  ];
  const toRawGroup = (mg: UberModifierGroup): RawGroup => {
    const max = Number(mg.quantity_info?.quantity?.max_permitted ?? 1);
    return {
      externalId: mg.id,
      name: enTitle(mg.title, mg.id),
      minSelections: Number(mg.quantity_info?.quantity?.min_permitted ?? 0),
      maxSelections: max,
      allowDuplicateSelections: max > 1,
      optionExternalIds: groupOptionIds(mg),
    };
  };
  const toRawOption = (item: UberItem): RawOption => ({
    externalId: item.id,
    name: enTitle(item.title, item.id),
    price: penceToPounds(item.price_info?.price),
    plu: (item.external_data ?? item.id).toString(),
    isAvailable: !item.suspension_info?.suspended,
  });

  const sizeGroupIds = new Set(
    modifierGroups.filter((mg) => isSizeGroup(toRawGroup(mg))).map((mg) => mg.id),
  );
  // A choice only stops being a modifier if EVERY group holding it is a size
  // group. A "Large" that's also a drink upgrade elsewhere must survive, or
  // that other group loses an option.
  const sizeChoiceIds = new Set<string>();
  for (const id of sizeGroupIds) {
    const mg = groupsById.get(id);
    if (!mg) continue;
    for (const optId of groupOptionIds(mg)) {
      const inNonSizeGroup = modifierGroups.some(
        (other) =>
          !sizeGroupIds.has(other.id) && groupOptionIds(other).includes(optId),
      );
      if (!inNonSizeGroup) sizeChoiceIds.add(optId);
    }
  }

  const foldByProductId = new Map<string, FoldedProduct>();
  /** Size groups actually converted, so they aren't also written as groups. */
  const sizeGroupsUsed = new Set<string>();
  /** Per-size copies folded away — never written as rows of their own. */
  const consumedGroupIds = new Set<string>();
  const consumedOptionIds = new Set<string>();
  /** Canonical option id → per-size prices recovered from the copies. */
  const optionPricing = new Map<string, OptionPricing>();
  const rebuiltGroups = new Map<string, RawGroup>();
  const rebuiltOptions = new Map<string, RawOption>();

  for (const item of items) {
    if (!productIds.has(item.id)) continue;
    const groupIds = extractModifierGroupIds(item);
    const sizeGroupId = groupIds.find((g) => sizeGroupIds.has(g));
    if (!sizeGroupId) continue;
    const sizeGroup = groupsById.get(sizeGroupId);
    const sizeOptionIds = sizeGroup ? groupOptionIds(sizeGroup) : [];
    if (sizeOptionIds.length === 0) continue;

    const fold = foldSizedProduct({
      // Uber adds a modifier's price to the item's, so a size choice reads
      // back as the difference above the item price, not the size price.
      productPrice: penceToPounds(item.price_info?.price),
      sizes: sizeOptionIds.map((optId) => {
        const opt = itemsById.get(optId);
        return {
          externalId: optId,
          name: opt ? enTitle(opt.title, optId) : optId,
          price: penceToPounds(opt?.price_info?.price),
          plu: (opt?.external_data ?? optId).toString(),
          nestedGroupIds: opt ? extractModifierGroupIds(opt) : [],
        };
      }),
      productGroupIds: groupIds.filter((g) => g !== sizeGroupId),
      groupById: (id) => {
        const mg = groupsById.get(id);
        return mg ? toRawGroup(mg) : undefined;
      },
      optionById: (id) => {
        const it = itemsById.get(id);
        return it ? toRawOption(it) : undefined;
      },
      payloadGroupIds,
    });

    foldByProductId.set(item.id, fold);
    sizeGroupsUsed.add(sizeGroupId);
    for (const id of fold.consumedGroupIds) consumedGroupIds.add(id);
    for (const id of fold.consumedOptionIds) consumedOptionIds.add(id);
    for (const g of fold.rebuiltGroups) rebuiltGroups.set(g.externalId, g);
    for (const o of fold.rebuiltOptions) rebuiltOptions.set(o.externalId, o);
    for (const [optId, pricing] of fold.pricing) {
      const existing = optionPricing.get(optId);
      if (!existing) {
        optionPricing.set(optId, pricing);
        continue;
      }
      // Two sized products sharing a group agree on its per-size prices —
      // they came from the same option row before publishing split it.
      Object.assign(existing.pricesBySize, pricing.pricesBySize);
      Object.assign(existing.skuPlus, pricing.skuPlus);
    }
  }

  // Step 2: walk items and bucket them.
  const products: NormalizedProduct[] = [];
  const modifiers: NormalizedModifier[] = [];
  const productGroupLinks: NormalizedMenu["productModifierGroupLinks"] = [];
  const optionNestedGroupLinks: NormalizedMenu["optionNestedGroupLinks"] = [];
  /** Choices that own their own groups — "Make It a Meal" and friends. */
  const modifiersWithNestedGroups: string[] = [];
  /** Nested groups pointing at something absent from modifier_groups[]. */
  const danglingNestedGroupIds = new Set<string>();

  for (const item of items) {
    // Products take priority on conflict — see header comment.
    if (productIds.has(item.id)) {
      const imageUrl = imageFrom(item);
      const name = enTitle(item.title, item.id);
      const description = enTitle(item.description) || null;
      const price = penceToPounds(item.price_info?.price);
      const allGroupIds = extractModifierGroupIds(item);
      const plu = (item.external_data ?? item.id).toString();
      const isSuspended = !!item.suspension_info?.suspended;

      // The size group becomes productSkus rather than a group the operator
      // has to pick through before they can price anything.
      const groupIds = allGroupIds.filter((g) => !sizeGroupsUsed.has(g));
      const skus = foldByProductId.get(item.id)?.skus ?? [];
      // Every SKU price is already absolute. The tile shows the cheapest, so
      // a product whose sizes carry the whole price isn't listed at "£0.00".
      const basePrice = skus.length
        ? Math.min(...skus.map((s) => s.price))
        : price;

      products.push({
        externalId: item.id,
        name,
        description,
        price: basePrice,
        imageUrl,
        plu,
        isAvailable: !isSuspended,
        outOfStock: false,
        visibleToCustomers: true,
        hasMultipleSkus: skus.length > 0,
        productSkus: skus,
        modifierGroupExternalIds: groupIds,
        // imageUrl + description are part of the hash — otherwise a re-import
        // that only adds images is skipped as "unchanged" (items upsert by
        // externalId across the brand). Same fix as the Deliveroo classifier.
        // Sizes ride it too, so a price change on one size re-imports the item.
        syncHash: sha(
          JSON.stringify({ name, price: basePrice, plu, groupIds, skus, isSuspended, imageUrl, description }),
        ),
      });

      for (const groupExt of groupIds) {
        productGroupLinks.push({
          productExternalId: item.id,
          modifierGroupExternalId: groupExt,
        });
      }
    } else if (modifierIds.has(item.id)) {
      // Already lifted into a product's sizes — emitting it again would show
      // "12 inch" as a topping as well as a size.
      if (sizeChoiceIds.has(item.id)) continue;
      // One of the per-size copies publishing splits an option into. Its price
      // has been folded back onto the canonical option as a pricesBySize
      // entry; writing it too would list "Stuffed crust" once per size.
      if (consumedOptionIds.has(item.id)) continue;

      const name = enTitle(item.title, item.id);
      const price = penceToPounds(item.price_info?.price);
      const plu = (item.external_data ?? item.id).toString();
      const isSuspended = !!item.suspension_info?.suspended;

      // An option can carry groups of its own — "Make it a meal" opening a
      // sides and a drinks picker. Those groups and their options are already
      // in the payload, so they import as normal rows; only the option →
      // group edge was missing, which is why a meal deal used to arrive
      // looking complete and behave as if empty.
      const nested = extractModifierGroupIds(item);
      if (nested.length) {
        modifiersWithNestedGroups.push(name);
        let sortOrder = 0;
        for (const grpExt of nested) {
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

      const pricing = optionPricing.get(item.id);
      modifiers.push({
        externalId: item.id,
        name,
        plu,
        priceAdjustment: price,
        pricesBySize: pricing?.pricesBySize ?? {},
        skuPlus: pricing?.skuPlus ?? {},
        isAvailable: !isSuspended,
        visibleToCustomers: true,
        syncHash: sha(JSON.stringify({ name, price, plu, isSuspended, nested, pricing: pricing ?? null })),
      });
    }
    // Items in neither list are silently skipped — Uber occasionally
    // emits orphan items during catalog merges. Not worth surfacing.
  }

  // Options that existed ONLY as per-size copies — publishing a sized product
  // emits `Stuffed__10` and `Stuffed__12` but never a plain `Stuffed`, so the
  // canonical row has to be recreated from them.
  const emittedModifierIds = new Set(modifiers.map((m) => m.externalId));
  for (const opt of rebuiltOptions.values()) {
    if (emittedModifierIds.has(opt.externalId)) continue;
    const pricing = optionPricing.get(opt.externalId);
    modifiers.push({
      externalId: opt.externalId,
      name: opt.name,
      plu: opt.plu,
      priceAdjustment: opt.price,
      pricesBySize: pricing?.pricesBySize ?? {},
      skuPlus: pricing?.skuPlus ?? {},
      isAvailable: opt.isAvailable,
      visibleToCustomers: true,
      syncHash: sha(JSON.stringify({ name: opt.name, plu: opt.plu, price: opt.price, pricing: pricing ?? null })),
    });
  }

  // Step 3: normalize categories.
  const normalizedCategories: NormalizedCategory[] = categories.map((cat, idx) => {
    const name = enTitle(cat.title, cat.id);
    const productExternalIds = (cat.entities ?? [])
      .map((e) => e.id)
      .filter((id) => productIds.has(id));
    return {
      externalId: cat.id,
      name,
      sortOrder: idx,
      available: true,
      visibleToCustomers: true,
      syncHash: sha(JSON.stringify({ name, productExternalIds })),
      productExternalIds,
    };
  });

  // Step 4: normalize modifier groups + group-to-modifier links.
  const groupModifierLinks: NormalizedMenu["modifierGroupModifierLinks"] = [];
  const normalizedGroups: NormalizedModifierGroup[] = modifierGroups
    // Lifted into a product's sizes, or a per-size copy folded back into one
    // group whose options carry pricesBySize. Writing either would show the
    // operator a "Size" group they already have as sizes, or one "Base" group
    // per size.
    .filter((mg) => !sizeGroupsUsed.has(mg.id) && !consumedGroupIds.has(mg.id))
    .map((mg) => {
    const name = enTitle(mg.title, mg.id);
    const min = Number(mg.quantity_info?.quantity?.min_permitted ?? 0);
    const max = Number(mg.quantity_info?.quantity?.max_permitted ?? 1);
    const selectionType: "VARIANT" | "ADDON" = max > 1 ? "ADDON" : "VARIANT";
    const optionIds = [
      ...(mg.modifier_options?.map((o) => o.id) ?? []),
      ...(mg.options?.map((o) => o.id) ?? []),
    ];
    for (const optId of optionIds) {
      groupModifierLinks.push({
        modifierGroupExternalId: mg.id,
        modifierExternalId: optId,
      });
    }
    return {
      externalId: mg.id,
      name,
      plu: mg.id,
      selectionType,
      minSelections: min,
      maxSelections: max,
      allowDuplicateSelections: max > 1, // Uber doesn't expose this; assume true for addons
      modifierExternalIds: optionIds,
      syncHash: sha(JSON.stringify({ name, min, max, selectionType, optionIds })),
    };
  });

  // The canonical groups behind those copies. A sized product's groups exist
  // on the wire ONLY as per-size copies, so without this the SKUs would point
  // at ids nothing ever wrote.
  const emittedGroupIds = new Set(normalizedGroups.map((g) => g.externalId));
  for (const g of rebuiltGroups.values()) {
    if (emittedGroupIds.has(g.externalId)) continue;
    for (const optId of g.optionExternalIds) {
      groupModifierLinks.push({
        modifierGroupExternalId: g.externalId,
        modifierExternalId: optId,
      });
    }
    normalizedGroups.push({
      externalId: g.externalId,
      name: g.name,
      plu: g.externalId,
      selectionType: g.maxSelections > 1 ? "ADDON" : "VARIANT",
      minSelections: g.minSelections,
      maxSelections: g.maxSelections,
      allowDuplicateSelections: g.allowDuplicateSelections,
      modifierExternalIds: g.optionExternalIds,
      syncHash: sha(
        JSON.stringify({
          name: g.name,
          min: g.minSelections,
          max: g.maxSelections,
          optionIds: g.optionExternalIds,
        }),
      ),
    });
  }

  // Step 5: defensive warnings.
  const orphanGroupLinks = productGroupLinks.filter(
    (link) => !normalizedGroups.find((g) => g.externalId === link.modifierGroupExternalId),
  );
  if (orphanGroupLinks.length) {
    warnings.push(
      `${orphanGroupLinks.length} product → modifier-group references pointed at groups Uber did not include in the payload. ` +
        "The link will be dropped at import time.",
    );
  }

  if (sizeGroupsUsed.size) {
    const names = [...sizeGroupsUsed]
      .map((id) => enTitle(groupsById.get(id)?.title, id))
      .join(", ");
    warnings.push(
      `Imported as product sizes rather than modifier groups: ${names}. ` +
        "If any of those are really a choice of topping, edit the product and move them back.",
    );
  }

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

  // A group that became a product's sizes, or was folded into another, is no
  // longer written — a nested link into it would point at a row that never
  // existed. Drop those rather than import a picker step that opens nothing.
  const writtenGroupIds = new Set(normalizedGroups.map((g) => g.externalId));
  const liveNestedLinks = optionNestedGroupLinks.filter((l) =>
    writtenGroupIds.has(l.modifierGroupExternalId),
  );

  // Step 6: compute a top-level sync hash so a re-import can short-circuit.
  // The version rides along, so shipping a classifier fix is enough to make
  // the next re-import actually apply it — otherwise the operator re-imports
  // an unchanged Uber menu, is told "unchanged", and the fix never lands.
  const fullHash = sha(`${CLASSIFIER_VERSION}:${JSON.stringify(payload)}`);

  return {
    platformSource: "uber",
    menuPatch: {
      menuData: { menus: payload.menus ?? [] },
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
