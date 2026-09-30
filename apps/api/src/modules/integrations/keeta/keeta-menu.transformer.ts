import { currencyDecimals } from "@orderhub/shared";

// Phase KT-4 — our menu → Keeta's OpenItemCode menu sync (/product/menu/sync).
//
// ── Why the OpenItemCode API and not the Keeta-ID one ───────────────────────
//
// Keeta offer two menu APIs. The Keeta-ID one is 25 calls in a strict order,
// storing Keeta's ids for everything. The OpenItemCode one is ONE call where
// every entity carries an id WE choose — and it is the only one that supports
// nested option groups. We send our own ids (MenuCategory / MenuItem /
// ModifierGroup / ModifierOption ids) as the openItemCodes, so orders come
// back carrying codes that resolve straight to our rows, with no mapping table.
//
// ── Keeta's model, and how ours fits it ─────────────────────────────────────
//
//   shopCategory  = our category (one level only; ours are flat already)
//   SPU           = our menu item
//   SKU           = a size. A plain item is one SKU with an empty spec; an
//                   item with productSkus is one SPU with a SKU per size —
//                   Keeta model sizes natively, so there is none of the
//                   size-group or product-per-size workaround Glovo needs.
//   ChoiceGroup   = our modifier group, attached PER SKU, so a 12" pizza can
//                   carry different topping prices from a 10".
//   ChoiceGroupSku= our modifier option; it may carry nested groups.
//
// ── Rules we enforce BEFORE sending, because Keeta enforce them after ───────
//
// menuSync is asynchronous: code 0 only means "task accepted", and failures
// arrive minutes later on webhook 1202 as a list of rejected products. Every
// rule below would otherwise surface there, one product at a time.
//
//   • A FULL REPLACE: anything not in the payload is DELETED from the store.
//   • ≤100 categories with unique names; ≤2 000 SPUs; ≤2 000 groups;
//     ≤10 000 options. Category `type` 1 means "customer MUST pick from this
//     category" — never what we mean, so every category is type 0.
//   • Group: maxNumber > 0 and ≥ minNumber, and there must be at least
//     minNumber AVAILABLE options or the group can never be satisfied.
//   • Prices are decimal STRINGS in MAJOR units (unlike orders, which are
//     minor-unit integers). SKU prices take the currency's decimals (3 for
//     KWD/BHD/OMR); option prices are documented as 2 decimals only, so a
//     3-decimal option price that isn't a whole number of 10 fils is refused.
//   • Pickup: an SPU offering "pickup" needs pickPrice on every SKU AND every
//     option in its groups. We always send pickPrice = price, so the item's
//     own collection flag is the only switch.
//   • Name auto-binding: an option whose name equals a product's name is
//     silently LINKED to it by Keeta (86 one, 86 both). Harmless for "Coke"
//     the drink and "Coke" the meal-deal choice; flagged as a warning. An
//     option WITH nested groups may not share a product's name at all.
//   • One translation per text field. Our secondLanguageName is the KITCHEN
//     language (Chinese for the wok, say), not a customer translation, so it
//     is only sent — as Arabic — when it actually is Arabic script.

export const KEETA_LIMITS = {
  categories: 100,
  spus: 2000,
  groups: 2000,
  options: 10000,
} as const;

// ── source (built by KeetaMenuPublishService from our tables) ──────────────

export interface KeetaSrcOption {
  code: string;
  name: string;
  secondLanguageName?: string | null;
  price: number;
  available: boolean;
  /** Codes of nested groups hanging off this option. */
  groupCodes?: string[];
}

export interface KeetaSrcGroup {
  code: string;
  name: string;
  secondLanguageName?: string | null;
  minSelections: number;
  maxSelections: number | null;
  allowDuplicateSelections?: boolean;
  options: KeetaSrcOption[];
}

export interface KeetaSrcSku {
  code: string;
  /** "" for a single-size item. */
  spec: string;
  price: number;
  groupCodes: string[];
}

export interface KeetaSrcItem {
  code: string;
  name: string;
  secondLanguageName?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  available: boolean;
  pickup: boolean;
  delivery: boolean;
  allergens?: string[];
  calories?: number | null;
  skus: KeetaSrcSku[];
}

export interface KeetaSrcCategory {
  code: string;
  name: string;
  secondLanguageName?: string | null;
  description?: string | null;
  itemCodes: string[];
}

export interface KeetaSrcMenu {
  shopId: string;
  currency: string;
  categories: KeetaSrcCategory[];
  items: KeetaSrcItem[];
  groups: KeetaSrcGroup[];
}

export interface KeetaMenuProblem {
  entity: "menu" | "category" | "item" | "group" | "option";
  code: string;
  name?: string;
  message: string;
}

export interface KeetaMenuBuild {
  payload: Record<string, unknown> | null;
  errors: KeetaMenuProblem[];
  warnings: KeetaMenuProblem[];
  stats: { categories: number; spus: number; skus: number; groups: number; options: number };
}

// ── helpers ─────────────────────────────────────────────────────────────────

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿ]/;

/** name + (optional) one Arabic translation, in Keeta's field names. */
function names(
  name: string,
  second: string | null | undefined,
  keys: { text: string; translation: string; source: string; target: string; type: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = { [keys.text]: name, [keys.source]: "en" };
  const t = String(second ?? "").trim();
  if (t && ARABIC.test(t) && t !== name) {
    out[keys.translation] = t;
    out[keys.target] = "ar";
    out[keys.type] = 1;
  }
  return out;
}

const NAME_KEYS = {
  text: "name",
  translation: "nameTranslation",
  source: "sourceLanguageType",
  target: "targetLanguageType",
  type: "nameTranslateType",
};

/**
 * A price as Keeta's decimal string, or null if it cannot be sent exactly.
 *
 * `maxDp` is what the field accepts; the currency's own exponent is what the
 * money actually has. 1.250 KWD in a 2-decimal field is "1.25" — the same
 * money — but 1.255 KWD is not expressible and is refused rather than rounded.
 */
export function keetaPriceString(amount: number, currency: string, maxDp: number): string | null {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return null;
  const dp = Math.min(currencyDecimals(currency), maxDp);
  const scaled = n * 10 ** dp;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return null;
  return n.toFixed(dp);
}

/** Keeta allergen vocabulary, from their Menu Integration Guide 4.4. */
const KEETA_ALLERGENS: Record<string, string> = {
  celery: "Celery",
  sulphites: "Sulfite",
  sulfites: "Sulfite",
  sulphur: "Sulfite",
  sulfite: "Sulfite",
  milk: "Milk",
  dairy: "Milk",
  lactose: "Milk",
  nuts: "Nuts",
  "tree nuts": "Nuts",
  treenuts: "Nuts",
  peanuts: "Peanuts",
  peanut: "Peanuts",
  fish: "Fish",
  gluten: "Grains",
  cereals: "Grains",
  wheat: "Grains",
  grains: "Grains",
  soy: "Soybeans",
  soya: "Soybeans",
  soybeans: "Soybeans",
  lupin: "Lupins",
  lupins: "Lupins",
  molluscs: "Molluscs",
  mollusks: "Molluscs",
  sesame: "Sesame seeds",
  "sesame seeds": "Sesame seeds",
  mustard: "Mustard",
  egg: "Eggs",
  eggs: "Eggs",
  crustaceans: "Crustaceans",
  shellfish: "Crustaceans",
};

export function keetaAllergens(ours: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const a of ours ?? []) {
    const k = KEETA_ALLERGENS[String(a).trim().toLowerCase()];
    if (k) out.add(k);
  }
  return Array.from(out);
}

// ── build ───────────────────────────────────────────────────────────────────

export function buildKeetaMenuSync(src: KeetaSrcMenu): KeetaMenuBuild {
  const errors: KeetaMenuProblem[] = [];
  const warnings: KeetaMenuProblem[] = [];
  const cur = src.currency;

  // Only categories that will actually show something, and only items that
  // sit in one of them (Keeta require every SPU to name a category).
  const itemsByCode = new Map(src.items.map((i) => [i.code, i]));
  const categories = src.categories
    .map((c) => ({ ...c, itemCodes: c.itemCodes.filter((code) => itemsByCode.has(code)) }))
    .filter((c) => c.itemCodes.length > 0);

  const catNames = new Map<string, string>();
  for (const c of categories) {
    const key = c.name.trim().toLowerCase();
    if (!c.name.trim()) {
      errors.push({ entity: "category", code: c.code, message: "has no name" });
    } else if (catNames.has(key)) {
      errors.push({
        entity: "category",
        code: c.code,
        name: c.name,
        message: `has the same name as another category ("${c.name}") — Keeta require category names to be unique per store`,
      });
    }
    catNames.set(key, c.code);
  }
  if (categories.length > KEETA_LIMITS.categories) {
    errors.push({
      entity: "menu",
      code: src.shopId,
      message: `${categories.length} categories — Keeta allow at most ${KEETA_LIMITS.categories} per store`,
    });
  }

  const categoriesOf = new Map<string, string[]>();
  for (const c of categories) {
    for (const code of c.itemCodes) categoriesOf.set(code, [...(categoriesOf.get(code) ?? []), c.code]);
  }
  const items = src.items.filter((i) => categoriesOf.has(i.code));
  if (items.length > KEETA_LIMITS.spus) {
    errors.push({
      entity: "menu",
      code: src.shopId,
      message: `${items.length} products — Keeta allow at most ${KEETA_LIMITS.spus} per store`,
    });
  }

  // Only the groups something actually uses, following nesting down.
  const groupsByCode = new Map(src.groups.map((g) => [g.code, g]));
  const used = new Set<string>();
  const frontier: string[] = items.flatMap((i) => i.skus.flatMap((s) => s.groupCodes));
  while (frontier.length) {
    const code = frontier.pop()!;
    if (used.has(code)) continue;
    const g = groupsByCode.get(code);
    if (!g) continue;
    used.add(code);
    for (const o of g.options) frontier.push(...(o.groupCodes ?? []));
  }
  const groups = src.groups.filter((g) => used.has(g.code));
  const optionCount = groups.reduce((n, g) => n + g.options.length, 0);
  if (groups.length > KEETA_LIMITS.groups) {
    errors.push({ entity: "menu", code: src.shopId, message: `${groups.length} option groups — Keeta allow ${KEETA_LIMITS.groups}` });
  }
  if (optionCount > KEETA_LIMITS.options) {
    errors.push({ entity: "menu", code: src.shopId, message: `${optionCount} options — Keeta allow ${KEETA_LIMITS.options}` });
  }

  const spuNames = new Set(items.map((i) => i.name.trim().toLowerCase()));

  // ── groups ──
  const choiceGroupList = groups.map((g) => {
    const available = g.options.filter((o) => o.available).length;
    const count = g.options.length;
    const repeatable = g.allowDuplicateSelections === true;
    const min = Math.max(0, g.minSelections || 0);
    // null max = "as many as there are" in our model. Keeta need a number > 0.
    let max = g.maxSelections == null || g.maxSelections <= 0 ? count : g.maxSelections;
    if (!repeatable) max = Math.min(max, count);
    max = Math.max(max, min, 1);

    if (count === 0) {
      errors.push({ entity: "group", code: g.code, name: g.name, message: "has no options" });
    } else if (min > available) {
      errors.push({
        entity: "group",
        code: g.code,
        name: g.name,
        message:
          `needs ${min} selection(s) but only ${available} option(s) are available — Keeta would make every ` +
          `product using it unorderable`,
      });
    }

    const choiceGroupSkuList = g.options.map((o) => {
      const price = keetaPriceString(o.price, cur, 2);
      if (price === null) {
        errors.push({
          entity: "option",
          code: o.code,
          name: o.name,
          message: `price ${o.price} ${cur} can't be sent — Keeta take option prices to 2 decimal places`,
        });
      }
      const nested = (o.groupCodes ?? []).filter((c) => used.has(c));
      const clashes = spuNames.has(o.name.trim().toLowerCase());
      if (nested.length && clashes) {
        errors.push({
          entity: "option",
          code: o.code,
          name: o.name,
          message: `has nested choices and shares its name with a product — Keeta forbid that; rename one of them`,
        });
      } else if (clashes) {
        warnings.push({
          entity: "option",
          code: o.code,
          name: o.name,
          message: `has the same name as a product, so Keeta will link their availability (86 one, both go)`,
        });
      }
      return {
        ...names(o.name, o.secondLanguageName, NAME_KEYS),
        price: price ?? "0.00",
        pickPrice: price ?? "0.00",
        currency: cur,
        status: o.available ? 1 : 0,
        openItemCode: o.code,
        ...(nested.length ? { choiceGroupOpenItemCodeList: nested } : {}),
      };
    });

    return {
      ...names(g.name, g.secondLanguageName, NAME_KEYS),
      minNumber: min,
      maxNumber: max,
      repeatable: repeatable ? 1 : 0,
      openItemCode: g.code,
      choiceGroupSkuList,
    };
  });

  // ── products ──
  let skuCount = 0;
  const spuList = items.map((it) => {
    if (!it.name.trim()) errors.push({ entity: "item", code: it.code, message: "has no name" });
    const allergens = keetaAllergens(it.allergens);
    const skuList = it.skus.map((s) => {
      skuCount++;
      const price = keetaPriceString(s.price, cur, 3);
      if (price === null) {
        errors.push({
          entity: "item",
          code: it.code,
          name: it.name,
          message: `${s.spec ? `size "${s.spec}" ` : ""}price ${s.price} ${cur} can't be sent exactly`,
        });
      }
      return {
        ...(s.spec ? { spec: s.spec, sourceLanguageType: "en" } : { spec: "" }),
        price: price ?? "0",
        pickPrice: price ?? "0",
        currency: cur,
        openItemCode: s.code,
        choiceGroupOpenItemCodeList: s.groupCodes.filter((c) => used.has(c)),
        ...(allergens.length ? { allergens } : {}),
        ...(it.calories != null && it.calories > 0
          ? { nutritionalInfo: { calories_kcal: Math.round(it.calories) } }
          : {}),
      };
    });
    const modes = [...(it.delivery ? ["delivery"] : []), ...(it.pickup ? ["pickup"] : [])];
    const image = String(it.imageUrl ?? "").trim();
    const desc = String(it.description ?? "").trim();
    return {
      ...names(it.name, it.secondLanguageName, NAME_KEYS),
      status: it.available ? 1 : 0,
      ...(desc ? { description: desc, descSourceLanguageType: "en" } : {}),
      // External URLs are accepted on ports 80/443. Keeta reject anything
      // under 600×450 on their side (reported on 1201/1202), not here.
      ...(/^https?:\/\//i.test(image) ? { pictureList: [{ url: image }] } : {}),
      skuList,
      availableTime: { code: 0 },
      isSpecialty: 0,
      openItemCode: it.code,
      shopCategoryOpenItemCodeList: categoriesOf.get(it.code) ?? [],
      // Keeta default everything to delivery; an item we don't deliver still
      // has to name a mode, so a collection-only item sends just "pickup".
      userGetModeList: modes.length ? modes : ["delivery"],
    };
  });

  const shopCategoryList = categories.map((c) => {
    const desc = String(c.description ?? "").trim();
    return {
      ...names(c.name, c.secondLanguageName, NAME_KEYS),
      // 0 = ordinary. 1 would force every customer to buy from it.
      type: 0,
      ...(desc ? { description: desc, descSourceLanguageType: "en" } : {}),
      openItemCode: c.code,
      availableTime: { code: 0 },
    };
  });

  // Our order within each category. Keeta require it to cover EVERY product
  // in EVERY category if sent at all — which, built from the categories
  // themselves, it always does.
  const spuSequenceCodeMap: Record<string, string[]> = {};
  for (const c of categories) spuSequenceCodeMap[c.code] = c.itemCodes;

  const stats = {
    categories: shopCategoryList.length,
    spus: spuList.length,
    skus: skuCount,
    groups: choiceGroupList.length,
    options: optionCount,
  };

  if (spuList.length === 0) {
    errors.push({
      entity: "menu",
      code: src.shopId,
      message: "Nothing to publish — no visible products in any visible category",
    });
  }
  if (errors.length) return { payload: null, errors, warnings, stats };

  return {
    payload: {
      shopCategoryList,
      choiceGroupList,
      spuList,
      spuSequenceCodeMap,
    },
    errors,
    warnings,
    stats,
  };
}
