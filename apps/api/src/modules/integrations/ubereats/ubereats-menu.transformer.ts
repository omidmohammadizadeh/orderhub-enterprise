// Phase UE-3 — OrderHub menu → Uber Eats v2 menu upsert payload.
//
// Same source vocabulary as the Deliveroo transformer (SrcCategory →
// SrcProduct → SrcGroup → SrcOption, prices in pounds). Uber's shape,
// verified against the v2 example payloads reference:
//   • items[] holds BOTH sellable products AND modifier options — a
//     modifier_group references options via modifier_options[{type:"ITEM",id}].
//   • Every title/description is { translations: { en_us: "…" } }.
//   • Prices are integer minor units (pence) in price_info.price.
//   • categories reference items via entities[{type:"ITEM", id}].
//   • menus[] carries service_availability (per-day time_periods) and
//     category_ids; we publish one all-day menu — Uber gates real ordering
//     on the store's own hours, so availability here stays permissive.
//   • Unavailable products ship suspended (suspension_info.suspension.
//     suspend_until far-future) instead of being dropped, so an 86ed item
//     shows as unavailable rather than vanishing.

import type {
  SrcCategory,
  SrcGroup,
  SrcProduct,
} from "../deliveroo/deliveroo-menu.transformer";

interface Translated {
  translations: { en_us: string };
}
const T = (s: string): Translated => ({ translations: { en_us: s } });

interface UberMenuEntity {
  type: "ITEM";
  id: string;
}

export interface UberEatsMenuPayload {
  menus: Array<{
    id: string;
    title: Translated;
    service_availability: Array<{
      day_of_week: string;
      time_periods: Array<{ start_time: string; end_time: string }>;
    }>;
    category_ids: string[];
  }>;
  categories: Array<{
    id: string;
    title: Translated;
    entities: UberMenuEntity[];
  }>;
  items: Array<{
    id: string;
    title: Translated;
    description?: Translated;
    price_info: { price: number };
    tax_info?: { tax_rate: number };
    image_url?: string;
    modifier_group_ids?: { ids: string[] };
    suspension_info?: { suspension: { suspend_until: number } };
    external_data?: string;
  }>;
  modifier_groups: Array<{
    id: string;
    title: Translated;
    quantity_info: { quantity: { min_permitted: number; max_permitted: number } };
    modifier_options: UberMenuEntity[];
  }>;
}

const toPence = (pounds: number): number =>
  Math.max(0, Math.round((Number(pounds) || 0) * 100));

// Items store per-channel tax as percentage points, defaulting to 0 when the
// operator never set one — publish standard UK VAT rather than a 0% rate for
// unconfigured items (same policy as the Deliveroo publish).
const DEFAULT_TAX_RATE = 20;
const taxRate = (rate?: number | null): number =>
  rate != null && Number(rate) > 0 ? Number(rate) : DEFAULT_TAX_RATE;

// 2100-01-01T00:00:00Z — "suspended until further notice".
const SUSPEND_FOREVER = 4_102_444_800;

const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
const ALL_WEEK = DAYS.map((day_of_week) => ({
  day_of_week,
  time_periods: [{ start_time: "00:00", end_time: "23:59" }],
}));

export interface UberTransformResult {
  payload: UberEatsMenuPayload;
  stats: {
    categories: number;
    products: number;
    groups: number;
    options: number;
  };
  warnings: string[];
}

/**
 * Uber has no store-hours REST endpoint — the menu's service_availability IS
 * the store's ordering hours. Convert our canonical opening-hours (location
 * {enabled,slots} map / brand array / legacy [{day,open,close}]) into Uber's
 * per-day time_periods; empty/unset falls back to 24/7 so a menu without
 * configured hours stays orderable.
 */
export function toUberServiceAvailability(
  hours: any,
): Array<{ day_of_week: string; time_periods: Array<{ start_time: string; end_time: string }> }> {
  const byDay = new Map<string, Array<{ start_time: string; end_time: string }>>();
  const push = (day: string, from: any, to: any) => {
    if (!from || !to) return;
    const list = byDay.get(day) ?? [];
    list.push({ start_time: String(from), end_time: String(to) });
    byDay.set(day, list);
  };
  if (Array.isArray(hours)) {
    for (const h of hours) {
      const day = String(h?.day ?? "").toLowerCase();
      if (DAYS.includes(day)) push(day, h?.open ?? h?.from, h?.close ?? h?.to);
    }
  } else if (hours && typeof hours === "object") {
    for (const day of DAYS) {
      const d = (hours as any)[day];
      if (!d) continue;
      const slots = Array.isArray(d) ? d : d.enabled === false ? [] : (d.slots ?? []);
      for (const s of slots) push(day, s?.from, s?.to);
    }
  }
  if (byDay.size === 0) return ALL_WEEK;
  return DAYS.filter((d) => byDay.has(d)).map((day_of_week) => ({
    day_of_week,
    time_periods: byDay.get(day_of_week)!,
  }));
}

export function buildUberEatsMenu(input: {
  menuName: string;
  categories: SrcCategory[];
  /** Canonical opening hours (location/brand) — omitted = 24/7. */
  openingHours?: any;
}): UberTransformResult {
  const warnings: string[] = [];
  const categories: UberEatsMenuPayload["categories"] = [];
  const items: UberEatsMenuPayload["items"] = [];
  const modifierGroups: UberEatsMenuPayload["modifier_groups"] = [];

  const seenGroups = new Set<string>();
  const seenOptions = new Set<string>();
  const emittedProducts = new Set<string>();

  const emitGroup = (g: SrcGroup): void => {
    if (seenGroups.has(g.id)) return;
    seenGroups.add(g.id);
    const optionIds: string[] = [];
    for (const o of g.options) {
      optionIds.push(o.id);
      if (!seenOptions.has(o.id)) {
        seenOptions.add(o.id);
        items.push({
          id: o.id,
          title: T(o.name),
          price_info: { price: toPence(o.price) },
          tax_info: { tax_rate: taxRate(o.taxRate) },
          ...(o.plu ? { external_data: String(o.plu) } : {}),
        });
      }
    }
    // Uber requires min ≤ max and max ≥ 1 (a group with nothing selectable
    // is meaningless). VARIANT-style groups default to exactly one choice.
    const isVariant = g.selectionType !== "ADDON";
    let max = g.maxSelections ?? (isVariant ? 1 : optionIds.length || 1);
    max = Math.max(1, max);
    let min = g.minSelections ?? 0;
    min = Math.min(Math.max(0, min), max);
    modifierGroups.push({
      id: g.id,
      title: T(g.name),
      quantity_info: { quantity: { min_permitted: min, max_permitted: max } },
      modifier_options: optionIds.map((id) => ({ type: "ITEM" as const, id })),
    });
  };

  for (const cat of input.categories) {
    const productIds: string[] = [];
    for (const p of cat.products) {
      productIds.push(p.id);
      if (emittedProducts.has(p.id)) continue;
      emittedProducts.add(p.id);

      const groupIds: string[] = [];
      for (const g of p.groups) {
        if (g.options.length === 0) continue;
        groupIds.push(g.id);
        emitGroup(g);
      }

      items.push({
        id: p.id,
        title: T(p.name),
        ...(p.description ? { description: T(p.description) } : {}),
        price_info: { price: toPence(p.price) },
        tax_info: { tax_rate: taxRate(p.taxRate) },
        ...(p.imageUrl ? { image_url: p.imageUrl } : {}),
        ...(groupIds.length ? { modifier_group_ids: { ids: groupIds } } : {}),
        ...(p.plu ? { external_data: String(p.plu) } : {}),
        ...(p.available === false
          ? {
              suspension_info: {
                suspension: { suspend_until: SUSPEND_FOREVER },
              },
            }
          : {}),
      });
    }

    if (productIds.length === 0) {
      warnings.push(`Category "${cat.name}" has no items — skipped`);
      continue;
    }
    categories.push({
      id: cat.id,
      title: T(cat.name),
      entities: productIds.map((id) => ({ type: "ITEM" as const, id })),
    });
  }

  return {
    payload: {
      menus: categories.length
        ? [
            {
              id: "all-day",
              title: T(input.menuName || "Menu"),
              service_availability: toUberServiceAvailability(input.openingHours),
              category_ids: categories.map((c) => c.id),
            },
          ]
        : [],
      categories,
      items,
      modifier_groups: modifierGroups,
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
