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
}
export interface SrcGroup {
  id: string;
  name: string;
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

// ── Deliveroo upload shape ─────────────────────────────────────────────

interface Loc {
  en: string;
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
    items: Array<{
      id: string;
      type: "ITEM" | "CHOICE";
      name: Loc;
      description?: Loc;
      plu: string;
      tax_rate: string;
      price_info: { price: number };
      image?: { url: string };
      modifier_ids?: string[];
    }>;
    modifiers: Array<{
      id: string;
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
  stats: { categories: number; products: number; groups: number; options: number };
  warnings: string[];
}

export function buildDeliverooMenu(input: {
  menuName: string;
  siteId: string;
  categories: SrcCategory[];
  // Deliveroo requires a cover photo on the mealtime — an absolute,
  // publicly-fetchable image URL.
  coverImageUrl?: string | null;
}): TransformResult {
  const warnings: string[] = [];
  const categories: DeliverooMenuUpload["menu"]["categories"] = [];
  const items: DeliverooMenuUpload["menu"]["items"] = [];
  const modifiers: DeliverooMenuUpload["menu"]["modifiers"] = [];

  // A group/option can hang off many products — emit each exactly once.
  const seenGroups = new Set<string>();
  const seenOptions = new Set<string>();
  const emittedProducts = new Set<string>();

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
                items.push({
                  id: o.id,
                  type: "CHOICE",
                  name: { en: o.name },
                  plu: String(o.plu || o.id),
                  tax_rate: formatTaxRate(o.taxRate),
                  price_info: { price: toPence(o.price) },
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
    },
    warnings,
  };
}
