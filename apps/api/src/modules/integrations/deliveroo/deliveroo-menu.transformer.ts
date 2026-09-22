// Phase BA-5 — OrderHub menu → Deliveroo Menu API upload payload.
//
// Inverse of the importer (deliveroo-menu.classifier): Deliveroo calls
// modifier *groups* "modifiers" and models modifier *options* as normal
// `items[]` entries with type "CHOICE". Products are `items[]` with type
// "ITEM", linked into categories via `category.item_ids` and to their
// modifier groups via `item.modifier_ids`. Prices are integer minor units
// (pence). Names are localised objects `{ en: "…" }`. A menu also needs at
// least one `mealtime` with a schedule + category_ids or nothing shows.
//
// Verified against the Deliveroo Menu API upload reference (PUT
// /menu/v1/brands/{brand_id}/menus/{id}). See [[project-orderhub-deliveroo]].

// ── Source shape (Prisma rows flattened by the service) ────────────────

export interface SrcOption {
  id: string;
  name: string;
  price: number; // pounds
  plu?: string | null;
  taxRate?: number | null; // percentage points, e.g. 20
  available?: boolean;
  /**
   * Groups this option opens when chosen. Deliveroo models a nested group by
   * putting `modifier_ids` on a CHOICE item — the same shape their live menus
   * use for "Make It a Meal → Choose Side", which is what we import.
   *
   * It is how a sized product keeps ONE tile while still pricing its crust
   * per size: each size option opens its own copy of the crust group.
   */
  nestedGroups?: SrcGroup[];
}
/** Deliveroo's modifier "type" enum (Menu API upload reference). */
export type DeliverooModifierType =
  | "up-sell-existing-items"
  | "remove-ingredient"
  | "add-ingredient"
  | "cooking-instruction"
  | "size-modification"
  | "product-variation"
  | "gift-wrap"
  | "bundle-item"
  | "add-separate-condiment";

export interface SrcGroup {
  id: string;
  name: string;
  /**
   * Deliveroo asks for a modifier type "for all your modifications, whenever
   * available". Set only where we KNOW it — the size group is certainly a
   * size-modification; a free-named group like "Extras" could be three
   * different things, and a wrong type is worse than none.
   */
  modifierType?: DeliverooModifierType;
  minSelections?: number | null;
  maxSelections?: number | null;
  selectionType?: "VARIANT" | "ADDON" | string;
  allowDuplicateSelections?: boolean;
  options: SrcOption[];
}
export interface SrcProduct {
  id: string;
  name: string;
  description?: string | null;
  price: number; // pounds
  plu?: string | null;
  taxRate?: number | null; // percentage points, e.g. 20
  imageUrl?: string | null;
  available?: boolean;
  groups: SrcGroup[];
}
export interface SrcCategory {
  id: string;
  name: string;
  description?: string | null;
  products: SrcProduct[];
}

/**
 * A meal deal, published as a Deliveroo BUNDLE. Each section is one pick
 * step ("Choose your burger"); each option names a product that must already
 * be on this menu — Deliveroo bundles re-use real menu items rather than
 * copies, which is how the same burger keeps its own extras inside a deal.
 */
export interface SrcBundleOption {
  productId: string;
  /** Pounds on top of the deal price when this option is picked; 0 = included. */
  extraPrice?: number | null;
}
export interface SrcBundleSection {
  name: string;
  minChoices?: number | null;
  maxChoices?: number | null;
  options: SrcBundleOption[];
}
export interface SrcBundle {
  id: string;
  name: string;
  description?: string | null;
  /** Pounds. null = the deal has no price yet, and can't be published. */
  price: number | null;
  plu?: string | null;
  taxRate?: number | null;
  imageUrl?: string | null;
  sections: SrcBundleSection[];
}

// ── Deliveroo upload shape ─────────────────────────────────────────────

interface Loc {
  en: string;
}
export interface DeliverooItem {
  id: string;
  type: "ITEM" | "CHOICE" | "BUNDLE";
  name: Loc;
  description?: Loc;
  plu: string;
  tax_rate: string;
  price_info: {
    price: number;
    /** A bundle prices each item per section: {type:MODIFIER, id: section}. */
    overrides?: Array<{ type: "MODIFIER"; id: string; price: number }>;
  };
  image?: { url: string };
  modifier_ids?: string[];
}
export interface DeliverooMenuUpload {
  name: string;
  menu: {
    mealtimes: Array<{
      id: string;
      name: Loc;
      image?: { url: string };
      category_ids: string[];
      schedule: Array<{
        day_of_week: number;
        time_periods: Array<{ start: string; end: string }>;
      }>;
    }>;
    categories: Array<{
      id: string;
      name: Loc;
      description?: Loc;
      item_ids: string[];
    }>;
    items: Array<DeliverooItem>;
    modifiers: Array<{
      id: string;
      /** Set where known: bundle sections, size groups. Omitted otherwise. */
      type?: DeliverooModifierType;
      name: Loc;
      min_selection: number;
      max_selection: number;
      repeatable: boolean;
      item_ids: string[];
    }>;
  };
  site_ids: string[];
}

const toPence = (pounds: number): number =>
  Math.max(0, Math.round((Number(pounds) || 0) * 100));

// Deliveroo requires a non-blank tax_rate string on every item. Our items
// store per-channel tax as percentage points (delivery tax), defaulting to
// 0 when the operator never set one — so we fall back to standard UK VAT
// rather than publishing a 0% rate for unconfigured items.
const DEFAULT_TAX_RATE = 20;
const formatTaxRate = (rate?: number | null): string => {
  const r = rate != null && Number(rate) > 0 ? Number(rate) : DEFAULT_TAX_RATE;
  // "20" not "20.00"; keep decimals only when meaningful (e.g. "12.5").
  return String(Number(r.toFixed(2)));
};

// Every day, all day. Deliveroo gates real ordering on the site's own
// opening hours (published separately), so an always-on mealtime just
// makes every category visible without duplicating the hours logic here.
// day_of_week is 0=Monday … 6=Sunday.
const ALL_WEEK = Array.from({ length: 7 }, (_, d) => ({
  day_of_week: d,
  time_periods: [{ start: "00:00", end: "23:59" }],
}));

export interface TransformResult {
  payload: DeliverooMenuUpload;
  stats: {
    categories: number;
    products: number;
    groups: number;
    options: number;
    bundles: number;
  };
  warnings: string[];
}

/** Category the published meal deals sit in. Fixed id: one per menu. */
export const DELIVEROO_BUNDLE_CATEGORY_ID = "meal-deals";

export function buildDeliverooMenu(input: {
  menuName: string;
  siteId: string;
  categories: SrcCategory[];
  // Deliveroo requires a cover photo on the mealtime — an absolute,
  // publicly-fetchable image URL.
  coverImageUrl?: string | null;
  /** Meal deals to publish as Deliveroo bundles, after the products. */
  bundles?: SrcBundle[];
}): TransformResult {
  const warnings: string[] = [];
  const categories: DeliverooMenuUpload["menu"]["categories"] = [];
  const items: DeliverooMenuUpload["menu"]["items"] = [];
  const modifiers: DeliverooMenuUpload["menu"]["modifiers"] = [];

  // A group/option can hang off many products — emit each exactly once.
  const seenGroups = new Set<string>();
  const seenOptions = new Set<string>();
  const emittedProducts = new Set<string>();

  /**
   * Emit the groups an option opens, and their own options, returning the
   * group ids to hang off that option. Recursive so a nested group's options
   * can themselves nest — the shape is the same at every level.
   */
  const emitNested = (groups: SrcGroup[] | undefined): string[] => {
    const ids: string[] = [];
    for (const g of groups ?? []) {
      if (g.options.length === 0) continue;
      ids.push(g.id);
      if (seenGroups.has(g.id)) continue;
      seenGroups.add(g.id);
      const optionIds: string[] = [];
      for (const o of g.options) {
        optionIds.push(o.id);
        if (seenOptions.has(o.id)) continue;
        seenOptions.add(o.id);
        const deeper = emitNested(o.nestedGroups);
        items.push({
          id: o.id,
          type: "CHOICE",
          name: { en: o.name },
          plu: String(o.plu || o.id),
          tax_rate: formatTaxRate(o.taxRate),
          price_info: { price: toPence(o.price) },
          ...(deeper.length ? { modifier_ids: deeper } : {}),
        });
      }
      const isVariant = g.selectionType !== "ADDON";
      let max = g.maxSelections ?? (isVariant ? 1 : optionIds.length || 1);
      max = Math.max(1, max);
      let min = g.minSelections ?? 0;
      min = Math.min(Math.max(0, min), max);
      modifiers.push({
        id: g.id,
        ...(g.modifierType ? { type: g.modifierType } : {}),
        name: { en: g.name },
        min_selection: min,
        max_selection: max,
        repeatable: !!g.allowDuplicateSelections,
        item_ids: optionIds,
      });
    }
    return ids;
  };

  for (const cat of input.categories) {
    const productIds: string[] = [];

    for (const p of cat.products) {
      // Same product can appear in two categories; emit the item once but
      // list its id under each category it belongs to.
      productIds.push(p.id);
      if (!emittedProducts.has(p.id)) {
        emittedProducts.add(p.id);

        const groupIds: string[] = [];
        for (const g of p.groups) {
          groupIds.push(g.id);
          if (!seenGroups.has(g.id)) {
            seenGroups.add(g.id);
            const optionIds: string[] = [];
            for (const o of g.options) {
              optionIds.push(o.id);
              if (!seenOptions.has(o.id)) {
                seenOptions.add(o.id);
                // An option that opens its own groups is emitted with
                // modifier_ids, exactly as Deliveroo's own menus do it.
                const nestedIds = emitNested(o.nestedGroups);
                items.push({
                  id: o.id,
                  type: "CHOICE",
                  name: { en: o.name },
                  plu: String(o.plu || o.id),
                  tax_rate: formatTaxRate(o.taxRate),
                  price_info: { price: toPence(o.price) },
                  ...(nestedIds.length ? { modifier_ids: nestedIds } : {}),
                });
              }
            }
            // Deliveroo requires 1 ≤ max_selection and min ≤ max.
            const isVariant = g.selectionType !== "ADDON";
            let max = g.maxSelections ?? (isVariant ? 1 : optionIds.length || 1);
            max = Math.max(1, max);
            let min = g.minSelections ?? 0;
            min = Math.min(Math.max(0, min), max);
            modifiers.push({
              id: g.id,
              ...(g.modifierType ? { type: g.modifierType } : {}),
              name: { en: g.name },
              min_selection: min,
              max_selection: max,
              repeatable: !!g.allowDuplicateSelections,
              item_ids: optionIds,
            });
          }
        }

        items.push({
          id: p.id,
          type: "ITEM",
          name: { en: p.name },
          ...(p.description ? { description: { en: p.description } } : {}),
          plu: String(p.plu || p.id),
          tax_rate: formatTaxRate(p.taxRate),
          price_info: { price: toPence(p.price) },
          ...(p.imageUrl ? { image: { url: p.imageUrl } } : {}),
          ...(groupIds.length ? { modifier_ids: groupIds } : {}),
        });
      }
    }

    // Deliveroo rejects a category with no items — skip empty ones.
    if (productIds.length === 0) {
      warnings.push(`Category "${cat.name}" has no items — skipped`);
      continue;
    }
    categories.push({
      id: cat.id,
      name: { en: cat.name },
      ...(cat.description ? { description: { en: cat.description } } : {}),
      item_ids: productIds,
    });
  }

  // Bundles last: they point at products, so every product must be emitted
  // (with its final price) before a deal can reference it.
  const bundleIds = addBundles(input.bundles ?? [], items, modifiers, warnings);
  if (bundleIds.length) {
    // First, so deals lead the menu the way operators set them up in-store.
    categories.unshift({
      id: DELIVEROO_BUNDLE_CATEGORY_ID,
      name: { en: "Meal Deals" },
      item_ids: bundleIds,
    });
  }

  const categoryIds = categories.map((c) => c.id);
  if (categoryIds.length && !input.coverImageUrl) {
    warnings.push(
      "No cover image available for the menu — Deliveroo requires one on the mealtime and will reject the upload. Set a menu banner or brand logo.",
    );
  }
  const mealtimes = categoryIds.length
    ? [
        {
          id: "all-day",
          name: { en: "All Day" },
          ...(input.coverImageUrl
            ? { image: { url: input.coverImageUrl } }
            : {}),
          category_ids: categoryIds,
          schedule: ALL_WEEK,
        },
      ]
    : [];

  return {
    payload: {
      name: input.menuName,
      menu: { mealtimes, categories, items, modifiers },
      site_ids: [input.siteId],
    },
    stats: {
      categories: categories.length,
      products: emittedProducts.size,
      groups: seenGroups.size,
      options: seenOptions.size,
      bundles: bundleIds.length,
    },
    warnings,
  };
}

/**
 * A stored MealDeal row → bundle source. `sections` is JSON written by the
 * Meal Deals editor: [{ name, minChoices, maxChoices, options: [{ menuItemId,
 * priceOverride }] }]. priceOverride is the extra charged for that pick inside
 * the deal (blank = included). A Deliveroo price override, when the operator
 * set one, wins over the deal's own price — the same rule as products.
 */
export function toSrcBundle(
  deal: {
    id: string;
    name: string;
    description?: string | null;
    imageUrl?: string | null;
    plu?: string | null;
    price?: unknown;
    deliveryTax?: unknown;
    sections?: unknown;
    platformPricingOverrides?: unknown;
  },
  absolutiseImage: (url: string | null | undefined) => string | null | undefined = (u) => u,
): SrcBundle {
  const num = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const overrides = (deal.platformPricingOverrides ?? {}) as Record<string, unknown>;
  const rawSections = Array.isArray(deal.sections) ? (deal.sections as any[]) : [];
  return {
    id: deal.id,
    name: deal.name,
    description: deal.description ?? null,
    price: num(overrides.DELIVEROO) ?? num(deal.price),
    plu: deal.plu ?? null,
    taxRate: num(deal.deliveryTax),
    imageUrl: absolutiseImage(deal.imageUrl) ?? null,
    sections: rawSections
      .filter((s) => s && typeof s === "object")
      .map((s) => ({
        name: String(s.name ?? "").trim() || "Choose",
        minChoices: num(s.minChoices),
        maxChoices: num(s.maxChoices),
        options: (Array.isArray(s.options) ? s.options : [])
          .filter((o: any) => o && o.menuItemId)
          .map((o: any) => ({
            productId: String(o.menuItemId),
            extraPrice: num(o.priceOverride) ?? 0,
          })),
      })),
  };
}

// ── Bundles ─────────────────────────────────────────────────────────────
//
// Deliveroo's bundle rules (Menu API guidelines, "Bundles"):
//   • a bundle is an item of type BUNDLE whose modifiers are all of type
//     "bundle-item", and whose sections contain only real ITEMs;
//   • the in-bundle price lives on the ITEM, as a MODIFIER override keyed by
//     the section — the same item keeps its normal price everywhere else;
//   • at most 3 layers of nested modifiers, counting the section itself;
//   • the customer must pick the MAXIMUM of a section's range, and base-price
//     validation reads the minimum, so min and max are published equal;
//   • at least one way to build the bundle with no extra cost;
//   • never dearer than the same items bought separately;
//   • a premium no more than the item's price over the section's cheapest;
//   • an item with modifiers must not be pickable more than once.
// A deal that breaks a rule is left out with a warning naming the rule, so
// the rest of the menu still publishes and the operator knows what to fix.

const MAX_OVERRIDES_PER_ITEM = 100;
const MAX_BUNDLE_LAYERS = 3;
const gbp = (pence: number) => `£${(pence / 100).toFixed(2)}`;

/** How many layers of modifiers hang beneath an item (0 = none). */
function modifierLayers(
  item: DeliverooItem,
  itemsById: Map<string, DeliverooItem>,
  modsById: Map<string, { item_ids: string[] }>,
  guard = 0,
): number {
  if (!item.modifier_ids?.length || guard > 10) return 0;
  let deepest = 0;
  for (const mid of item.modifier_ids) {
    for (const cid of modsById.get(mid)?.item_ids ?? []) {
      const child = itemsById.get(cid);
      if (child) {
        deepest = Math.max(deepest, modifierLayers(child, itemsById, modsById, guard + 1));
      }
    }
  }
  return 1 + deepest;
}

/**
 * Validate each deal against Deliveroo's rules and emit the valid ones.
 * Mutates `items` (bundle items + per-section price overrides on the products
 * they use) and `modifiers` (one bundle-item section each). Returns the
 * emitted bundle ids, for the Meal Deals category.
 */
export function addBundles(
  bundles: SrcBundle[],
  items: DeliverooItem[],
  modifiers: DeliverooMenuUpload["menu"]["modifiers"],
  warnings: string[],
): string[] {
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const modsById = new Map(modifiers.map((m) => [m.id, m]));
  const emitted: string[] = [];

  for (const b of bundles) {
    const problems: string[] = [];
    const notes: string[] = [];
    const sections: Array<{
      id: string;
      name: string;
      count: number;
      options: Array<{ item: DeliverooItem; extra: number }>;
    }> = [];
    // Individual price of the cheapest no-extra way to build the deal.
    let separatePrice = 0;

    b.sections.forEach((s, i) => {
      const count = Math.max(1, Math.round(Number(s.maxChoices ?? s.minChoices ?? 1) || 1));
      const options: Array<{ item: DeliverooItem; extra: number }> = [];
      const seen = new Set<string>();
      for (const o of s.options) {
        if (seen.has(o.productId)) continue;
        seen.add(o.productId);
        const item = itemsById.get(o.productId);
        if (!item || item.type !== "ITEM") {
          notes.push(`an option in "${s.name}" isn't on this menu, so it was left out`);
          continue;
        }
        if (1 + modifierLayers(item, itemsById, modsById) > MAX_BUNDLE_LAYERS) {
          notes.push(
            `"${item.name.en}" has too many layers of extras to go inside a deal (Deliveroo allows 2), so it was left out of "${s.name}"`,
          );
          continue;
        }
        options.push({ item, extra: toPence(Number(o.extraPrice ?? 0)) });
      }

      if (options.length === 0) {
        problems.push(`section "${s.name}" has no products that are on this menu`);
        return;
      }
      const included = options
        .filter((o) => o.extra === 0)
        .map((o) => o.item.price_info.price)
        .sort((a, z) => a - z);
      if (included.length < count) {
        problems.push(
          `section "${s.name}" asks for ${count} pick${count === 1 ? "" : "s"} but only ${included.length} option${included.length === 1 ? " is" : "s are"} included at no extra cost`,
        );
      } else {
        separatePrice += included.slice(0, count).reduce((n, p) => n + p, 0);
      }
      const cheapest = Math.min(...options.map((o) => o.item.price_info.price));
      for (const o of options) {
        const headroom = o.item.price_info.price - cheapest;
        if (o.extra > headroom) {
          problems.push(
            `"${o.item.name.en}" costs ${gbp(o.extra)} extra in "${s.name}", but Deliveroo allows at most ${gbp(headroom)} (its price over the section's cheapest item)`,
          );
        }
      }
      sections.push({ id: `${b.id}__sec${i}`, name: s.name, count, options });
    });

    if (b.sections.length === 0) problems.push("it has no sections");
    const price = b.price == null ? null : toPence(b.price);
    if (price == null) {
      problems.push("it has no price");
    } else if (!problems.length && price > separatePrice) {
      problems.push(
        `its price ${gbp(price)} is more than ${gbp(separatePrice)}, the same items bought separately`,
      );
    }
    for (const sec of sections) {
      for (const o of sec.options) {
        if ((o.item.price_info.overrides?.length ?? 0) >= MAX_OVERRIDES_PER_ITEM) {
          problems.push(
            `"${o.item.name.en}" is already in ${MAX_OVERRIDES_PER_ITEM} deal sections, Deliveroo's limit`,
          );
        }
      }
    }

    if (problems.length) {
      warnings.push(`Meal deal "${b.name}" was not published to Deliveroo: ${problems.join("; ")}.`);
      continue;
    }
    for (const n of notes) warnings.push(`Meal deal "${b.name}": ${n}.`);

    for (const sec of sections) {
      modifiers.push({
        id: sec.id,
        type: "bundle-item",
        name: { en: sec.name },
        min_selection: sec.count,
        max_selection: sec.count,
        // An item with extras must not be pickable twice — and a deal section
        // is "pick N different things" in every deal we model.
        repeatable: false,
        item_ids: sec.options.map((o) => o.item.id),
      });
      for (const o of sec.options) {
        (o.item.price_info.overrides ??= []).push({
          type: "MODIFIER",
          id: sec.id,
          price: o.extra,
        });
      }
    }
    items.push({
      id: b.id,
      type: "BUNDLE",
      name: { en: b.name },
      ...(b.description ? { description: { en: b.description } } : {}),
      plu: String(b.plu || b.id),
      tax_rate: formatTaxRate(b.taxRate),
      price_info: { price: price! },
      ...(b.imageUrl ? { image: { url: b.imageUrl } } : {}),
      modifier_ids: sections.map((s) => s.id),
    });
    emitted.push(b.id);
  }
  return emitted;
}

/**
 * Name-length rules Deliveroo enforces on upload, each verified from a real
 * 400 on our own publishes:
 *   categories  `{"categories":{"2":{"name":{"en":"should not exceed 120"}}}}`
 *   items       `{"items":{"181":{"name":{"en":"the length must be between 2 and 160"}}}}`
 * "items" covers products AND modifier options (Deliveroo models options as
 * CHOICE items). Its errors name things only by their position in the upload,
 * which means nothing to an operator, so we check first and name them.
 */
export const DELIVEROO_CATEGORY_NAME_MAX = 120;
export const DELIVEROO_ITEM_NAME_MIN = 2;
export const DELIVEROO_ITEM_NAME_MAX = 160;

export function overlongCategoryNames(
  payload: DeliverooMenuUpload,
): Array<{ name: string; length: number }> {
  return payload.menu.categories
    .map((c) => c.name.en)
    .filter((n) => n.length > DELIVEROO_CATEGORY_NAME_MAX)
    .map((name) => ({ name, length: name.length }));
}

/** Every name Deliveroo will reject, described so an operator can find it. */
export function menuNameProblems(payload: DeliverooMenuUpload): string[] {
  const clip = (n: string) => (n.length > 60 ? `${n.slice(0, 60)}…` : n);
  const problems = overlongCategoryNames(payload).map(
    (c) => `Category "${clip(c.name)}" is ${c.length} characters (max ${DELIVEROO_CATEGORY_NAME_MAX})`,
  );

  // Options have no category, so say which group(s) they sit in instead.
  const groupsOfOption = new Map<string, string[]>();
  for (const m of payload.menu.modifiers) {
    for (const id of m.item_ids) {
      const list = groupsOfOption.get(id) ?? [];
      list.push(m.name.en);
      groupsOfOption.set(id, list);
    }
  }

  for (const it of payload.menu.items) {
    const name = it.name.en ?? "";
    const len = name.length;
    if (len >= DELIVEROO_ITEM_NAME_MIN && len <= DELIVEROO_ITEM_NAME_MAX) continue;
    const rule =
      len < DELIVEROO_ITEM_NAME_MIN
        ? `is too short (${len} character${len === 1 ? "" : "s"}, min ${DELIVEROO_ITEM_NAME_MIN})`
        : `is ${len} characters (max ${DELIVEROO_ITEM_NAME_MAX})`;
    if (it.type === "CHOICE") {
      const groups = groupsOfOption.get(it.id) ?? [];
      const where = groups.length ? ` in group "${[...new Set(groups)].join('", "')}"` : "";
      problems.push(`Option "${clip(name)}"${where} ${rule}`);
    } else {
      problems.push(`${it.type === "BUNDLE" ? "Meal deal" : "Product"} "${clip(name)}" ${rule}`);
    }
  }
  return problems;
}
