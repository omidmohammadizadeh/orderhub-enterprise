// Auto-composed HubRise master menu.
//
// WHY THIS EXISTS
// ---------------
// HubRise allows exactly ONE catalog per location and charges per location,
// so every brand trading out of one kitchen has to share a single catalog.
// Until now the operator satisfied that by hand-building a "Master Menu"
// (menus.service.createMasterMenu) that deep-copies every brand's products
// into one row, then publishing THAT. It works, but it has to be rebuilt or
// re-edited every time a brand changes a price.
//
// This module removes the hand-built step: an operator edits each brand's own
// menu and presses publish on it, and we compose the master menu in memory at
// publish time out of every brand's menu at that location.
//
// THE ONE RULE THAT MATTERS
// -------------------------
// The published payload must ALWAYS contain EVERY member brand, no matter
// which brand's publish button was pressed. A HubRise catalog PUT replaces the
// catalog wholesale: sending only the clicked brand would produce a catalog
// with a single brand's items and NO variants, which wipes every other brand's
// items AND every operator's variant selection in their HubRise connection.
// Everything below — the membership set, the "member contributed nothing"
// guard, the "you published a non-member" guard — exists to hold that line.
//
// VARIANTS ARE THE PER-BRAND SELECTOR
// -----------------------------------
// HubRise variants filter items, not just prices: a brand's connection selects
// one variant and its storefront then shows only the products restricted to
// that variant. So the composed catalog carries one variant per (brand ×
// channel), and every product is restricted to its own brand's variants
// (transformMenuToCatalog does that via variantRefsForBrands).
//
// Variant refs MUST stay brandChannelRef(brandId, channelKey) —
// `${brandId}__${channelKey}` — because that is what each operator already
// selected inside HubRise. Change the ref and every operator has to go back
// into HubRise and re-select their variant. We only ever pass existing refs
// through untouched, or mint new ones with the same helper.
//
// MEMBERSHIP IS EXPLICIT
// ----------------------
// A menu joins the composed catalog by carrying `metadata.hubriseAutoMaster
// === true`. Nothing is inferred from "menus at this location", deliberately:
// Clifton alone has SIX menus with three spellings of the same name all
// pointing at one catalog, and auto-including them would republish the same
// products six times over. Explicit membership also makes the feature
// STRICTLY ADDITIVE — no menu carries the flag today, so with zero members
// every publish behaves exactly as it does now, including the hand-built
// master menu path.

import {
  CHANNEL_VARIANT_PRESETS,
  brandChannelRef,
  normalizePricingVariants,
  type PricingVariant,
} from "@orderhub/shared";

/** Menu.metadata key that opts a menu into the location's composed catalog. */
export const HUBRISE_AUTO_MASTER_FLAG = "hubriseAutoMaster";

/** True when this menu is part of its location's auto-composed HubRise catalog. */
export function isAutoMasterMember(menu: unknown): boolean {
  const metadata = (menu as { metadata?: unknown } | null | undefined)?.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  return (metadata as Record<string, unknown>)[HUBRISE_AUTO_MASTER_FLAG] === true;
}

/** Merge the flag into an existing Menu.metadata blob without dropping keys. */
export function withAutoMasterFlag(
  metadata: unknown,
  member: boolean,
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object"
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  if (member) base[HUBRISE_AUTO_MASTER_FLAG] = true;
  else delete base[HUBRISE_AUTO_MASTER_FLAG];
  return base;
}

/**
 * One member menu, loaded with the same `include` publishMenu uses for a
 * single menu (categories → items → item → modifierGroupLinks → group →
 * options) plus the owning brand's name for variant labels.
 */
export interface AutoMasterMember {
  id: string;
  name: string;
  brandId: string;
  brand?: { id?: string; name?: string } | null;
  pricingVariants?: unknown;
  categories?: any[];
}

export interface ComposedAutoMaster {
  /**
   * A synthetic menu shaped exactly like the row publishMenu would have
   * loaded, so `transformMenuToCatalog` consumes it unchanged.
   */
  menu: {
    name: string;
    pricingVariants: PricingVariant[];
    categories: any[];
  };
  /** Member menu ids, in composition order. All of them get markPublished. */
  memberIds: string[];
  /** Member id → menu name, for operator-facing guard messages. */
  memberNames: Map<string, string>;
  /** Member id → number of products it contributed. 0 means the payload would
   *  ship without that brand, which is the failure the guards refuse. */
  productCounts: Map<string, number>;
  /** Brands we had to mint preset variants for (they had none of their own). */
  seededBrandIds: string[];
  /** MenuItem rows linked from more than one member menu, folded into one
   *  product tagged with both brands. */
  sharedItemCount: number;
}

/** Deterministic member order: brand name, then menu name, then id. Composition
 *  order decides category-name suffixing and which member "owns" a shared item,
 *  so it must not depend on which brand pressed publish or on row ordering. */
function compareMembers(a: AutoMasterMember, b: AutoMasterMember): number {
  const an = (a.brand?.name ?? a.brandId ?? "").toLowerCase();
  const bn = (b.brand?.name ?? b.brandId ?? "").toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  const am = (a.name ?? "").toLowerCase();
  const bm = (b.name ?? "").toLowerCase();
  if (am !== bm) return am < bm ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Every brand a product should be visible to inside the composed catalog. */
function brandsForItem(item: any, memberBrandId: string): string[] {
  const out: string[] = [];
  const add = (b: unknown) => {
    if (typeof b === "string" && b && !out.includes(b)) out.push(b);
  };
  add(item?.brandId);
  for (const b of Array.isArray(item?.brandIds) ? item.brandIds : []) add(b);
  // The member menu's own brand always counts. A product sitting in Brand A's
  // menu must appear in Brand A's storefront even if someone mis-tagged it to
  // Brand B — otherwise composing would silently delete it from the shop that
  // sells it. Widening is safe (restrictions only ever ADD a variant); losing
  // the item is not.
  add(memberBrandId);
  return out;
}

/**
 * Build one catalog-ready menu out of every member menu at a location.
 *
 * Pure — no Prisma, no IO — so the composition rules are unit-testable
 * against plain objects.
 */
export function composeAutoMaster(
  members: ReadonlyArray<AutoMasterMember>,
  opts: { name: string },
): ComposedAutoMaster {
  const ordered = [...members].sort(compareMembers);

  // ── Variants ────────────────────────────────────────────────────────
  // Union of every member's own variants, first-write-wins on ref so a
  // duplicated leaf can't emit twice. Refs pass through untouched: they are
  // what operators already selected inside HubRise.
  const variants: PricingVariant[] = [];
  const takenRefs = new Set<string>();
  for (const member of ordered) {
    for (const variant of normalizePricingVariants(member.pricingVariants)) {
      if (takenRefs.has(variant.ref)) continue;
      takenRefs.add(variant.ref);
      variants.push(variant);
    }
  }

  // A member whose menu defines no variant for its own brand would publish
  // its products unrestricted — visible in EVERY brand's storefront. Seed the
  // same brand×channel leaves createMasterMenu seeds, using the same helper so
  // the refs match what the hand-built path produced.
  const brandsWithVariants = new Set(
    variants.filter((v) => v.brandId).map((v) => v.brandId as string),
  );
  const seededBrandIds: string[] = [];
  for (const member of ordered) {
    if (!member.brandId || brandsWithVariants.has(member.brandId)) continue;
    brandsWithVariants.add(member.brandId);
    seededBrandIds.push(member.brandId);
    const brandName = member.brand?.name ?? member.name;
    for (const preset of CHANNEL_VARIANT_PRESETS) {
      const ref = brandChannelRef(member.brandId, preset.channelKey);
      if (takenRefs.has(ref)) continue;
      takenRefs.add(ref);
      variants.push({
        ref,
        name: `${brandName} — ${preset.name}`,
        channelKey: preset.channelKey,
        brandId: member.brandId,
        brandName,
      });
    }
  }

  // ── Categories + products ───────────────────────────────────────────
  const categories: any[] = [];
  const productCounts = new Map<string, number>();
  // Same category NAME used by two different brands gets the brand suffixed,
  // exactly as createMasterMenu does — one brand keeps the plain name, later
  // brands are disambiguated. Two categories of the SAME brand keep their name.
  const nameOwner = new Map<string, string>();
  // A MenuItem row linked from two member menus (brands that still share an
  // item set) must become ONE product carrying both brands, not two products
  // with the same ref.
  const composedItemById = new Map<string, any>();
  let sharedItemCount = 0;

  for (const member of ordered) {
    let contributed = 0;
    const brandName = member.brand?.name ?? member.name;
    for (const category of member.categories ?? []) {
      const collides =
        nameOwner.has(category.name) &&
        nameOwner.get(category.name) !== member.brandId;
      if (!nameOwner.has(category.name)) {
        nameOwner.set(category.name, member.brandId);
      }

      const links: any[] = [];
      for (const link of category.items ?? []) {
        const item = link?.item;
        if (!item?.id) continue;
        contributed += 1;

        const existing = composedItemById.get(item.id);
        if (existing) {
          // Already placed by an earlier member — widen its brand tags so the
          // single product shows in this brand's storefront too.
          sharedItemCount += 1;
          for (const b of brandsForItem(item, member.brandId)) {
            if (!existing.brandIds.includes(b)) existing.brandIds.push(b);
          }
          continue;
        }

        const composedItem = {
          ...item,
          brandIds: brandsForItem(item, member.brandId),
        };
        composedItemById.set(item.id, composedItem);
        links.push({ ...link, item: composedItem });
      }

      categories.push({
        ...category,
        name: collides ? `${category.name} (${brandName})` : category.name,
        items: links,
      });
    }
    productCounts.set(member.id, contributed);
  }

  return {
    menu: { name: opts.name, pricingVariants: variants, categories },
    memberIds: ordered.map((m) => m.id),
    memberNames: new Map(ordered.map((m) => [m.id, m.name])),
    productCounts,
    seededBrandIds,
    sharedItemCount,
  };
}

/**
 * Every ref HubRise keys on must be unique inside one catalog. Composing
 * independent per-brand menus can collide where the hand-built master menu
 * could not: createMasterMenu deep-copies with FRESH PLUs, whereas two brands'
 * own menus may each carry PLU "B1", or two menus imported from the same
 * HubRise catalog may carry identical externalIds.
 *
 * Publishing a duplicate ref silently merges or drops a product, so we refuse
 * instead and tell the operator exactly which two rows to fix. Composed path
 * only — the single-menu path is left exactly as it was.
 */
export function findDuplicateRefs(data: {
  categories: Array<{ ref?: string | null; name: string }>;
  products: Array<{
    ref?: string | null;
    name: string;
    skus?: Array<{ ref?: string | null; name?: string | null }>;
  }>;
  optionLists: Array<{ ref?: string | null; name: string }>;
}): string[] {
  const problems: string[] = [];
  const check = (
    kind: string,
    entries: Array<{ ref?: string | null; label: string }>,
  ) => {
    const firstSeen = new Map<string, string>();
    for (const entry of entries) {
      const ref = entry.ref;
      if (!ref) continue;
      const prior = firstSeen.get(ref);
      if (prior === undefined) {
        firstSeen.set(ref, entry.label);
        continue;
      }
      problems.push(`${kind} ref "${ref}" used by both "${prior}" and "${entry.label}"`);
    }
  };

  check(
    "category",
    data.categories.map((c) => ({ ref: c.ref, label: c.name })),
  );
  check(
    "product",
    data.products.map((p) => ({ ref: p.ref, label: p.name })),
  );
  check(
    "product size",
    data.products.flatMap((p) =>
      (p.skus ?? []).map((s) => ({
        ref: s.ref,
        label: s.name ? `${p.name} — ${s.name}` : p.name,
      })),
    ),
  );
  check(
    "option list",
    data.optionLists.map((l) => ({ ref: l.ref, label: l.name })),
  );

  return problems;
}
