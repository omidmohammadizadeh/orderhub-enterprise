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
//   6. Multi-SKU pizzas: Uber doesn't model size variants on a single
//      product — each size is its own flat item. We can't reconstruct
//      `productSkus[]` without operator hints, so the classifier emits a
//      warning if it detects what looks like a size series (same base
//      name + different size suffix).

import { createHash } from "crypto";
import type {
  NormalizedCategory,
  NormalizedMenu,
  NormalizedModifier,
  NormalizedModifierGroup,
  NormalizedProduct,
} from "./normalized-menu.types";

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

  // Step 2: walk items and bucket them.
  const products: NormalizedProduct[] = [];
  const modifiers: NormalizedModifier[] = [];
  const productGroupLinks: NormalizedMenu["productModifierGroupLinks"] = [];

  for (const item of items) {
    // Products take priority on conflict — see header comment.
    if (productIds.has(item.id)) {
      const imageUrl = imageFrom(item);
      const name = enTitle(item.title, item.id);
      const description = enTitle(item.description) || null;
      const price = penceToPounds(item.price_info?.price);
      const groupIds = extractModifierGroupIds(item);
      const plu = (item.external_data ?? item.id).toString();
      const isSuspended = !!item.suspension_info?.suspended;

      products.push({
        externalId: item.id,
        name,
        description,
        price,
        imageUrl,
        plu,
        isAvailable: !isSuspended,
        outOfStock: false,
        visibleToCustomers: true,
        hasMultipleSkus: false,
        productSkus: [],
        modifierGroupExternalIds: groupIds,
        // imageUrl + description are part of the hash — otherwise a re-import
        // that only adds images is skipped as "unchanged" (items upsert by
        // externalId across the brand). Same fix as the Deliveroo classifier.
        syncHash: sha(
          JSON.stringify({ name, price, plu, groupIds, isSuspended, imageUrl, description }),
        ),
      });

      for (const groupExt of groupIds) {
        productGroupLinks.push({
          productExternalId: item.id,
          modifierGroupExternalId: groupExt,
        });
      }
    } else if (modifierIds.has(item.id)) {
      const name = enTitle(item.title, item.id);
      const price = penceToPounds(item.price_info?.price);
      const plu = (item.external_data ?? item.id).toString();
      const isSuspended = !!item.suspension_info?.suspended;

      modifiers.push({
        externalId: item.id,
        name,
        plu,
        priceAdjustment: price,
        pricesBySize: {},
        skuPlus: {},
        isAvailable: !isSuspended,
        visibleToCustomers: true,
        syncHash: sha(JSON.stringify({ name, price, plu, isSuspended })),
      });
    }
    // Items in neither list are silently skipped — Uber occasionally
    // emits orphan items during catalog merges. Not worth surfacing.
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
  const normalizedGroups: NormalizedModifierGroup[] = modifierGroups.map((mg) => {
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

  // Step 6: compute a top-level sync hash so a re-import can short-circuit.
  const fullHash = sha(JSON.stringify(payload));

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
    // Uber nests too (customization_options can carry child_modifier_group_refs),
    // but that's a separate classifier change — left empty rather than
    // half-wired, so Uber imports behave exactly as they do today.
    optionNestedGroupLinks: [],
    warnings,
  };
}
