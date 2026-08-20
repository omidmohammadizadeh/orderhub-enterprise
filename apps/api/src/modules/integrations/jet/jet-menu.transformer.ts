// Phase JE-3 — OrderHub menu graph → JET Connect `POST /menus` payload.
//
// Pure: no Nest, no Prisma, no I/O. The publish service loads the graph and
// decides what to do with the result; this decides only what the result IS.
//
// SHAPE (from the spec's schemas, not guessed):
//   { restaurants: string[], menus: BaselineMenu[], callback_url?: string }
//   BaselineMenu requires  name, reference, type (COLLECTION|DELIVERY), categories
//   Category     requires  name, description
//   Item         requires  name, plu           (price is integer MINOR units)
//   Modifier     requires  name, description, pick
//   pick         is        { pick_same_option } + { exactly } | { range: {min,max} }
//
// TWO DELIBERATE MODELLING CHOICES
//
// 1. SIZES BECOME `portions`, NOT SEPARATE ITEMS. Deliveroo has no size
//    concept, so our publish there flattens a multi-SKU product into one item
//    per size ("Margherita - 12 inch"). JET has `portions`, which maps 1:1 onto
//    ProductSku — name, description, plu, price, modifiers — so the customer
//    sees one product with a size selector, and the PLU that comes back on the
//    order is the size's own. Inventing flattened names here would also make
//    the 86 board's item references disagree with the published menu.
//
// 2. CATEGORIES STAY FLAT. JET supports nested subcategories, but the spec
//    says using them requires contacting your Technical Project Manager first.
//    Our menu graph is flat anyway, so emitting `type: root` with no nesting
//    is both correct and the option that cannot be rejected for lack of a
//    conversation we have not had.

export interface JetSrcOption {
  id: string;
  name: string;
  description?: string | null;
  /** Major units (pounds). Converted to minor units here. */
  price: number;
  plu?: string | null;
}

export interface JetSrcGroup {
  id: string;
  name: string;
  description?: string | null;
  minSelection: number;
  maxSelection: number;
  /** Can the same option be chosen more than once? */
  repeatable?: boolean;
  options: JetSrcOption[];
}

export interface JetSrcPortion {
  id: string;
  name: string;
  description?: string | null;
  price: number;
  plu?: string | null;
  groups: JetSrcGroup[];
}

export interface JetSrcProduct {
  id: string;
  name: string;
  description?: string | null;
  price: number;
  plu?: string | null;
  imageUrl?: string | null;
  groups: JetSrcGroup[];
  /** Multi-SKU sizes. When present, `price` is the base/first size. */
  portions?: JetSrcPortion[];
  dietaryRestrictions?: string[];
  outOfStock?: boolean;
}

export interface JetSrcCategory {
  id: string;
  name: string;
  description?: string | null;
  products: JetSrcProduct[];
}

/** Day-keyed availability, values like "08:00 - 23:59". */
export type JetAvailability = Record<string, string[]>;

export const JET_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

/** JET's two menu types. A restaurant serving both needs one menu of each. */
export type JetMenuType = "DELIVERY" | "COLLECTION";

export interface JetMenuBuildResult {
  menus: any[];
  stats: {
    menus: number;
    categories: number;
    items: number;
    portions: number;
    groups: number;
    options: number;
  };
  warnings: string[];
}

/** Major units (pounds) → integer minor units (pence), which is what JET wants. */
function minorUnits(price: unknown): number {
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

/**
 * A non-blank PLU for every item, option and portion.
 *
 * JET requires `plu` on every item — including modifier options, which are
 * Items in their schema too. Our rows do not always carry one (a cloned menu
 * has its PLUs stripped), so the row id is the fallback: it is stable, unique,
 * and it is the SAME value the item-availability push sends as an
 * itemReference, so an 86 lands on the thing that was published.
 */
function pluFor(entity: { id: string; plu?: string | null }): string {
  const p = (entity.plu ?? "").trim();
  return p || entity.id;
}

/**
 * Build the `pick` object for a modifier group.
 *
 * JET expresses selection limits as EITHER `exactly: n` OR `range: {min, max}`,
 * never both, always alongside `pick_same_option`. A group with min === max is
 * the "exactly" case; anything else is a range. Bounds are clamped because a
 * max of 0 (which our editor allows as "unlimited") would publish a group the
 * customer can never choose from.
 */
function buildPick(group: JetSrcGroup, warnings: string[]): Record<string, unknown> {
  const min = Math.max(0, Math.floor(group.minSelection ?? 0));
  let max = Math.floor(group.maxSelection ?? 0);
  if (max <= 0) {
    // 0 means "no limit" in our editor. JET has no unlimited, so fall back to
    // the option count — every option selectable, which is the same thing.
    max = Math.max(min, group.options.length || 1);
  }
  if (max < min) {
    warnings.push(
      `modifier group "${group.name}" had max (${group.maxSelection}) below min (${min}) — clamped`,
    );
    max = min;
  }
  const pickSameOption = !!group.repeatable;
  return min === max
    ? { pick_same_option: pickSameOption, exactly: min }
    : { pick_same_option: pickSameOption, range: { min, max } };
}

function buildModifier(group: JetSrcGroup, warnings: string[]): any {
  return {
    name: group.name,
    // Required by the schema. Blank is valid; missing is not.
    description: group.description ?? "",
    pick: buildPick(group, warnings),
    options: group.options.map((option) => ({
      name: option.name,
      description: option.description ?? "",
      plu: pluFor(option),
      price: minorUnits(option.price),
    })),
  };
}

function buildItem(product: JetSrcProduct, warnings: string[]): any {
  const item: Record<string, unknown> = {
    name: product.name,
    description: product.description ?? "",
    plu: pluFor(product),
    price: minorUnits(product.price),
  };

  if (product.groups.length) {
    item.modifiers = product.groups.map((g) => buildModifier(g, warnings));
  }

  // Sizes → portions. See the file header for why not flattened items.
  if (product.portions?.length) {
    item.portions = product.portions.map((portion) => ({
      name: portion.name,
      description: portion.description ?? "",
      plu: pluFor(portion),
      price: minorUnits(portion.price),
      // Required by the portion schema even when the size adds nothing.
      modifiers: portion.groups.map((g) => buildModifier(g, warnings)),
    }));
  }

  // Images must be absolute and publicly fetchable — JET's servers pull them,
  // not a browser. The publish service resolves that before we get here, so a
  // relative or data: URL arriving means it could not be resolved and is
  // dropped rather than published as a broken link.
  if (product.imageUrl && /^https?:\/\//i.test(product.imageUrl)) {
    item.gallery = [{ url: product.imageUrl }];
  }

  if (product.dietaryRestrictions?.length) {
    item.dietary_restrictions = product.dietaryRestrictions;
  }
  // Only sent when true: the 86 board is the live source of availability and
  // publishing `out_of_stock: false` over a live suspension would un-86 an
  // item nobody asked to bring back.
  if (product.outOfStock) item.out_of_stock = true;

  return item;
}

/**
 * Normalise our stored opening hours into JET's availability map.
 *
 * All seven days are REQUIRED by the schema — a missing key is a validation
 * failure, not a closed day — so every day is emitted, with a closed day as an
 * empty array. Accepts the same three hour shapes the Deliveroo normaliser
 * does (day-keyed slots, day-keyed {enabled, slots}, and the legacy
 * [{day, open, close}] array) because that is what the location and brand rows
 * actually hold.
 */
export function toJetAvailability(hours: unknown): JetAvailability {
  const out: JetAvailability = {};
  for (const day of JET_DAYS) out[day] = [];

  const push = (day: string, from: unknown, to: unknown) => {
    const f = String(from ?? "").trim();
    const t = String(to ?? "").trim();
    if (f && t) out[day]!.push(`${f} - ${t}`);
  };

  if (Array.isArray(hours)) {
    for (const row of hours as any[]) {
      const day = String(row?.day ?? "").toLowerCase();
      if ((JET_DAYS as readonly string[]).includes(day)) {
        push(day, row?.open, row?.close);
      }
    }
    return out;
  }

  if (hours && typeof hours === "object") {
    for (const day of JET_DAYS) {
      const value = (hours as any)[day];
      if (!value) continue;
      if (Array.isArray(value)) {
        for (const slot of value) push(day, slot?.from, slot?.to);
      } else if (value.enabled === false) {
        continue;
      } else if (Array.isArray(value.slots)) {
        for (const slot of value.slots) push(day, slot?.from, slot?.to);
      }
    }
  }
  return out;
}

/** An all-day, every-day availability — the fallback when we hold no hours. */
export function allDayAvailability(): JetAvailability {
  const out: JetAvailability = {};
  for (const day of JET_DAYS) out[day] = ["00:00 - 23:59"];
  return out;
}

/**
 * Build the `menus[]` array for a JET menu ingest.
 *
 * One menu per requested service type. JET's menu `type` is COLLECTION or
 * DELIVERY and a restaurant offering both needs one of each, so the default is
 * to emit both from the same source: the food does not change because the
 * customer walked in. References are suffixed per type because `reference` is
 * how JET identifies a menu for replacement — one reference for two menus
 * would have the second overwrite the first.
 */
export function buildJetMenus(args: {
  menuName: string;
  /** Stable per-menu reference — our Menu.id, so a republish replaces. */
  menuReference: string;
  categories: JetSrcCategory[];
  availability?: JetAvailability;
  serviceTypes?: JetMenuType[];
  defaultLanguage?: string;
  description?: string | null;
}): JetMenuBuildResult {
  const warnings: string[] = [];
  const serviceTypes = args.serviceTypes?.length
    ? args.serviceTypes
    : (["DELIVERY", "COLLECTION"] as JetMenuType[]);

  // An empty category publishes as an empty section on the customer's page.
  const nonEmpty = args.categories.filter((c) => {
    if (c.products.length === 0) {
      warnings.push(`category "${c.name}" has no items — skipped`);
      return false;
    }
    return true;
  });

  const categories = nonEmpty.map((category) => ({
    name: category.name,
    // Required by the schema; blank is acceptable, absent is not.
    description: category.description ?? "",
    type: "root",
    items: category.products.map((p) => buildItem(p, warnings)),
  }));

  const availability = args.availability ?? allDayAvailability();
  const openDays = JET_DAYS.filter((d) => (availability[d] ?? []).length > 0);
  if (openDays.length === 0) {
    warnings.push(
      "availability is empty for every day — the menu would never be orderable; " +
        "publishing all-day instead",
    );
  }
  const finalAvailability = openDays.length ? availability : allDayAvailability();

  const menus = serviceTypes.map((type) => ({
    name: args.menuName,
    ...(args.description ? { description: args.description } : {}),
    ...(args.defaultLanguage ? { default_language: args.defaultLanguage } : {}),
    // Suffixed so two service types cannot overwrite each other.
    reference: `${args.menuReference}-${type.toLowerCase()}`,
    type,
    availability: finalAvailability,
    categories,
  }));

  // Counted once, not once per service type — the two menus are the same food.
  const items = categories.reduce((n, c) => n + c.items.length, 0);
  const portions = categories.reduce(
    (n, c) => n + c.items.reduce((m: number, i: any) => m + (i.portions?.length ?? 0), 0),
    0,
  );
  const groups = categories.reduce(
    (n, c) => n + c.items.reduce((m: number, i: any) => m + (i.modifiers?.length ?? 0), 0),
    0,
  );
  const options = categories.reduce(
    (n, c) =>
      n +
      c.items.reduce(
        (m: number, i: any) =>
          m +
          (i.modifiers ?? []).reduce(
            (k: number, g: any) => k + (g.options?.length ?? 0),
            0,
          ),
        0,
      ),
    0,
  );

  return {
    menus,
    stats: { menus: menus.length, categories: categories.length, items, portions, groups, options },
    warnings,
  };
}
