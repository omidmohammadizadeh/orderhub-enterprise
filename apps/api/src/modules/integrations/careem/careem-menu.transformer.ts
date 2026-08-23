// Phase CA-3 — our menu → Careem's catalog payload.
//
// ── Their catalog is FLAT, not nested ───────────────────────────────────────
//
// categories[], sub_categories[], items[], groups[] and options[] are five
// top-level arrays that reference each other by arrays of string ids. So the
// transformer's job is mostly to walk our tree once, collect every entity into
// the right bucket, and emit the id lists — not to build a nested document.
//
// The ids are OURS. Careem's catalog takes ids "provided by vendor or
// restaurant", so we publish MenuItem.id, ModifierGroup.id and
// ModifierOption.id verbatim. That is what makes an inbound order — which
// carries ids and no names at all — resolvable against our own menu without a
// mapping table.
//
// ── Careem supports nested modifiers, and we normally flatten them ──────────
//
// An option can carry `groups`, so "choose a sauce for the side you chose" is
// expressible here. Our HubRise publish flattens that away; Careem takes it as
// it really is. The one catch is their own rule: a group with multi_select
// true may NOT contain nested groups.
//
// ── The one thing that is not verified ──────────────────────────────────────
//
// `price` is documented as an integer and the unit is not stated anywhere.
// Their example shows `"price": 20` for pancakes, which reads as whole
// dirhams; but an integer in whole dirhams cannot express 11.50, which is what
// a real menu is full of. Rather than guess and silently put every price out
// by a factor of a hundred, the transformer REFUSES to emit a price it would
// have to round, and names the items. Flip CAREEM_PRICE_UNIT once Careem
// confirms it.

export type CareemPriceUnit = "major" | "minor";

export interface CareemLocalized {
  en: string;
  ar: string;
}

export interface CareemCatalogPayload {
  diff: boolean;
  catalog: {
    id: string;
    name: string;
    include_tax: boolean;
    tax: number;
    currency_id: number;
    category_ids: string[];
  };
  categories: unknown[];
  items: unknown[];
  groups: unknown[];
  options: unknown[];
}

// ── Our side, normalised ────────────────────────────────────────────────────

export interface SourceOption {
  id: string;
  name: string;
  secondLanguageName?: string | null;
  priceAdjustment: number;
  isAvailable: boolean;
  sortOrder: number;
  /** Nested groups hanging off this option — Careem takes these natively. */
  groupIds?: string[];
}

export interface SourceGroup {
  id: string;
  name: string;
  secondLanguageName?: string | null;
  description?: string | null;
  minSelections: number;
  maxSelections: number | null;
  isRequired: boolean;
  sortOrder: number;
  /** ADDON groups let a customer take several; VARIANT is pick-one. */
  selectionType: "VARIANT" | "ADDON";
  options: SourceOption[];
}

export interface SourceItem {
  id: string;
  name: string;
  secondLanguageName?: string | null;
  description?: string | null;
  basePrice: number;
  isAvailable: boolean;
  imageUrl?: string | null;
  calories?: number | null;
  allergens?: string[];
  sortOrder: number;
  groupIds: string[];
}

export interface SourceCategory {
  id: string;
  name: string;
  secondLanguageName?: string | null;
  description?: string | null;
  sortOrder: number;
  itemIds: string[];
}

/**
 * Careem identify a currency by an integer of their own, not by ISO code.
 * Their table, verbatim — the five we can't serve are kept so a country we
 * add later doesn't silently fall through to Dirhams.
 */
const CAREEM_CURRENCY_ID: Record<string, number> = {
  AED: 1,
  SAR: 2,
  EGP: 3,
  QAR: 4,
  LBP: 5,
  KWD: 6,
  JOD: 7,
  BHD: 8,
  SGD: 9,
  IRR: 10,
  OMR: 11,
  PKR: 12,
  AUD: 13,
  IQD: 14,
};

/** The API runs in UAE, Jordan and KSA only — nothing else can be published,
 *  whatever currency the shop is set to. */
const CAREEM_COUNTRIES = new Set(["AE", "JO", "SA"]);

export interface SourceMenu {
  id: string;
  name: string;
  /** ISO 4217 for the shop's country. Careem want their own integer for it. */
  currency: string;
  /** Where the shop trades. Careem serve three countries and no others. */
  country: string;
  /** Careem prices are tax-INCLUSIVE. This is the rate they contain. */
  taxPercentage: number;
  categories: SourceCategory[];
  items: SourceItem[];
  groups: SourceGroup[];
}

export interface CareemMenuProblem {
  entity: string;
  id: string;
  message: string;
}

export interface CareemMenuResult {
  payload: CareemCatalogPayload | null;
  /** Anything here means we do NOT push. Careem would reject most of it, and
   *  the rest would be silently wrong on the SuperApp. */
  errors: CareemMenuProblem[];
}

/** Careem's hard ceiling on one sync. */
export const CAREEM_MAX_ITEMS = 8500;

const localized = (en: string, ar?: string | null): CareemLocalized => ({
  en,
  // Their docs: Arabic and English only. An empty string is accepted and is
  // what their own examples send when there's no translation.
  ar: (ar ?? "").trim(),
});

/**
 * A price in whatever unit Careem wants, or null if converting would lose
 * money.
 *
 * The whole point: their schema says `integer`, and if that means whole
 * dirhams then 11.50 is not expressible. Rounding it silently is how every
 * price on a menu ends up wrong by an amount nobody notices until a customer
 * complains. Returning null makes the transformer refuse and name the item.
 */
export function careemPrice(
  amount: number,
  unit: CareemPriceUnit,
): number | null {
  const n = Number(amount) || 0;
  if (unit === "minor") {
    // Fils. Any two-decimal price converts exactly.
    const minor = Math.round(n * 100);
    return Math.abs(n * 100 - minor) < 1e-6 ? minor : null;
  }
  // Whole units. Only an already-whole price survives.
  return Number.isInteger(n) ? n : null;
}

/**
 * Careem's own group validation rules, from their FAQ.
 *
 * Implemented here so a bad group is caught before a 5-minute async round trip
 * comes back FAILED with a message about "customization group max". Their
 * wording, their thresholds.
 */
export function validateCareemGroup(group: SourceGroup): string[] {
  const problems: string[] = [];
  const count = group.options.length;
  const multiSelect = group.selectionType === "ADDON";
  const min = group.minSelections;
  const max = group.maxSelections ?? (multiSelect ? min : count);

  if (!group.name?.trim()) problems.push("name cannot be blank");
  if (count === 0) {
    // Stop here. Every min/max rule is stated in terms of the option count, so
    // with none they all "fail" and bury the one problem that matters under
    // arithmetic about zero.
    problems.push("has no options");
    return problems;
  }

  if (multiSelect) {
    // Theirs, verbatim: min must be > 1 and max must EQUAL min.
    if (min <= 1) {
      problems.push(
        `multi-select group needs min > 1 (has ${min}) — Careem rejects pick-many groups that allow one or none`,
      );
    }
    if (max !== min) {
      problems.push(`multi-select group needs max = min (has min ${min}, max ${max})`);
    }
    if (group.options.some((o) => (o.groupIds ?? []).length > 0)) {
      problems.push("multi-select group cannot contain nested groups");
    }
  } else {
    if (min < 0 || min > count) {
      problems.push(`min must be between 0 and ${count} (has ${min})`);
    }
    if (max < min || max > count) {
      problems.push(`max must be between min and ${count} (has ${max})`);
    }
  }
  return problems;
}

/**
 * Build the catalog payload, or refuse with reasons.
 *
 * `diff: false` — a full replace. Careem deletes anything absent from the
 * payload, which is what we want from a publish: our menu is the truth.
 */
export function transformCareemMenu(
  menu: SourceMenu,
  opts: { unit: CareemPriceUnit; branchId: string },
): CareemMenuResult {
  const errors: CareemMenuProblem[] = [];
  const groupsById = new Map(menu.groups.map((g) => [g.id, g]));

  // Careem serve UAE, Jordan and KSA. A shop anywhere else has no outlet to
  // map to, so refusing here beats a rejection five minutes after upload.
  if (!CAREEM_COUNTRIES.has((menu.country ?? "").toUpperCase())) {
    errors.push({
      entity: "catalog",
      id: menu.id,
      message:
        `Careem's POS API covers UAE, Jordan and KSA only — this shop is in ` +
        `${menu.country || "an unset country"}.`,
    });
  }

  if (!CAREEM_CURRENCY_ID[menu.currency]) {
    errors.push({
      entity: "catalog",
      id: menu.id,
      message: `Careem have no currency id for ${menu.currency || "an unset currency"}.`,
    });
  }

  if (menu.items.length > CAREEM_MAX_ITEMS) {
    errors.push({
      entity: "catalog",
      id: menu.id,
      message: `${menu.items.length} items exceeds Careem's limit of ${CAREEM_MAX_ITEMS} per sync`,
    });
  }

  // ── Items ────────────────────────────────────────────────────────────────
  const items = menu.items.map((item) => {
    if (!item.name?.trim()) {
      errors.push({ entity: "item", id: item.id, message: "name cannot be blank" });
    }
    const price = careemPrice(item.basePrice, opts.unit);
    if (price === null) {
      errors.push({
        entity: "item",
        id: item.id,
        message:
          `price ${item.basePrice} cannot be sent as a whole number in "${opts.unit}" units. ` +
          `Careem's schema says integer without stating the unit — confirm with them, ` +
          `then set CAREEM_PRICE_UNIT.`,
      });
    }
    return {
      id: item.id,
      deleted: false,
      name: item.name,
      name_localized: localized(item.name, item.secondLanguageName),
      ...(item.description
        ? {
            description: item.description,
            description_localized: localized(item.description, null),
          }
        : {}),
      active: item.isAvailable,
      price: price ?? 0,
      ...(item.calories != null ? { calorie_counts: String(item.calories) } : {}),
      ...(item.allergens?.length
        ? { allergic_information: item.allergens.join(", ") }
        : {}),
      ...(item.imageUrl ? { media: item.imageUrl } : {}),
      priority: item.sortOrder,
      groups: item.groupIds,
    };
  });

  // ── Groups + options ─────────────────────────────────────────────────────
  const groups = menu.groups.map((group) => {
    for (const problem of validateCareemGroup(group)) {
      errors.push({ entity: "group", id: group.id, message: problem });
    }
    const multiSelect = group.selectionType === "ADDON";
    return {
      id: group.id,
      deleted: false,
      name: group.name,
      name_localized: localized(group.name, group.secondLanguageName),
      ...(group.description
        ? {
            description: group.description,
            description_localized: localized(group.description, null),
          }
        : {}),
      multi_select: multiSelect,
      min: group.minSelections,
      max: group.maxSelections ?? (multiSelect ? group.minSelections : group.options.length),
      priority: group.sortOrder,
      options: group.options.map((o) => o.id),
    };
  });

  const options = menu.groups.flatMap((group) =>
    group.options.map((option) => {
      if (!option.name?.trim()) {
        errors.push({ entity: "option", id: option.id, message: "name cannot be blank" });
      }
      const price = careemPrice(option.priceAdjustment, opts.unit);
      if (price === null) {
        errors.push({
          entity: "option",
          id: option.id,
          message: `price ${option.priceAdjustment} cannot be sent as a whole number in "${opts.unit}" units`,
        });
      }
      // A nested group that isn't in the payload would dangle, and Careem
      // would take the option's reference to nothing.
      for (const gid of option.groupIds ?? []) {
        if (!groupsById.has(gid)) {
          errors.push({
            entity: "option",
            id: option.id,
            message: `references nested group ${gid}, which is not in this menu`,
          });
        }
      }
      return {
        id: option.id,
        deleted: false,
        name: option.name,
        name_localized: localized(option.name, option.secondLanguageName),
        active: option.isAvailable,
        price: price ?? 0,
        priority: option.sortOrder,
        ...(option.groupIds?.length ? { groups: option.groupIds } : {}),
      };
    }),
  );

  // ── Categories ───────────────────────────────────────────────────────────
  const itemIds = new Set(menu.items.map((i) => i.id));
  const categories = menu.categories.map((category) => {
    if (!category.name?.trim()) {
      errors.push({ entity: "category", id: category.id, message: "name cannot be blank" });
    }
    const missing = category.itemIds.filter((id) => !itemIds.has(id));
    if (missing.length) {
      errors.push({
        entity: "category",
        id: category.id,
        message: `references ${missing.length} item(s) not in this menu`,
      });
    }
    return {
      id: category.id,
      deleted: false,
      name: category.name,
      name_localized: localized(category.name, category.secondLanguageName),
      ...(category.description
        ? {
            description: category.description,
            description_localized: localized(category.description, null),
          }
        : {}),
      priority: category.sortOrder,
      items: category.itemIds.filter((id) => itemIds.has(id)),
    };
  });

  if (errors.length) return { payload: null, errors };

  return {
    errors: [],
    payload: {
      // A full replace: Careem deletes whatever is absent, and our menu is the
      // truth. Partial updates are what the 86 endpoint is for.
      diff: false,
      catalog: {
        // One catalog per branch, named by the branch, so a support
        // conversation about "which catalog" has an obvious answer.
        id: opts.branchId,
        name: menu.name,
        // Their prices INCLUDE tax — this is the rate baked in, not a rate to
        // add. UAE 5%, KSA 15%.
        include_tax: true,
        tax: menu.taxPercentage,
        // Required by their schema. We never sent it, and a catalog without it
        // is rejected outright.
        currency_id: CAREEM_CURRENCY_ID[menu.currency]!,
        category_ids: categories.map((c) => c.id),
      },
      categories,
      items,
      groups,
      options,
    },
  };
}
