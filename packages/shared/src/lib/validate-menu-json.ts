// Validation for a hand-authored / scraped menu JSON file before it is
// committed.
//
// The import endpoint is the same one the AI flow uses, and that flow's draft
// has already been through a review screen. A JSON file has not been through
// anything, so the checking happens here: a typo in a modifier-group key or a
// price written as "6.49" instead of 6.49 would otherwise commit quietly and
// surface later as a menu with missing options or £0 items.
//
// Errors block the import. Warnings do not — they are things worth seeing but
// legitimately intentional (a free item, a category with one item).

// Structural, not imported: this package sits below both apps, and the shape
// is the import contract itself — spelling it out here is the point.
interface DraftSize { name?: unknown; price?: unknown; modifierGroupKeys?: string[] }
interface DraftOption { name?: unknown; priceAdjustment?: unknown }
interface DraftGroup {
  key?: unknown; name?: unknown; selectionType?: unknown;
  minSelections?: unknown; maxSelections?: unknown; options?: DraftOption[];
}
interface DraftItem {
  name?: unknown; price?: unknown; sizes?: DraftSize[]; modifierGroupKeys?: string[];
}
interface DraftCategory { name?: unknown; items?: DraftItem[] }
export interface MenuJsonDraft {
  menuName?: unknown;
  categories?: DraftCategory[];
  modifierGroups?: DraftGroup[];
}

export interface MenuJsonReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Populated when ok — what the operator is about to create. */
  summary: {
    menuName: string | null;
    categories: number;
    items: number;
    modifierGroups: number;
    options: number;
    sizedItems: number;
  } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Money must be a real number. "6.49" as a string silently becomes 0. */
function checkPrice(
  value: unknown,
  where: string,
  errors: string[],
  { required }: { required: boolean },
): number | null {
  if (value === undefined || value === null) {
    if (required) errors.push(`${where}: missing a price`);
    return null;
  }
  if (typeof value !== "number") {
    errors.push(
      `${where}: price must be a number, not ${typeof value} (${JSON.stringify(value)}) — write 6.49, not "6.49"`,
    );
    return null;
  }
  if (!Number.isFinite(value) || value < 0) {
    errors.push(`${where}: price must be zero or more, got ${value}`);
    return null;
  }
  return value;
}

export function validateMenuJson(raw: unknown): MenuJsonReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isObj(raw)) {
    return {
      ok: false,
      errors: ["The file must contain a JSON object, not an array or a value."],
      warnings,
      summary: null,
    };
  }

  const draft = raw as MenuJsonDraft;

  if (!Array.isArray(draft.categories) || draft.categories.length === 0) {
    errors.push('Missing "categories" — expected a non-empty array.');
    return { ok: false, errors, warnings, summary: null };
  }

  // Modifier groups are referenced by key, so collect them first.
  const groups = Array.isArray(draft.modifierGroups) ? draft.modifierGroups : [];
  const groupKeys = new Set<string>();
  const duplicateKeys = new Set<string>();
  let options = 0;

  groups.forEach((g, gi) => {
    const where = `modifierGroups[${gi}]${g?.name ? ` "${g.name}"` : ""}`;
    if (!isObj(g)) {
      errors.push(`${where}: not an object`);
      return;
    }
    const key = typeof g.key === "string" ? g.key.trim() : "";
    if (!key) errors.push(`${where}: missing "key" — items reference groups by key`);
    else if (groupKeys.has(key)) duplicateKeys.add(key);
    else groupKeys.add(key);

    if (!String(g.name ?? "").trim()) errors.push(`${where}: missing "name"`);
    if (g.selectionType !== "VARIANT" && g.selectionType !== "ADDON") {
      errors.push(
        `${where}: selectionType must be "VARIANT" (pick one) or "ADDON" (pick many), got ${JSON.stringify(g.selectionType)}`,
      );
    }
    if (!Array.isArray(g.options) || g.options.length === 0) {
      errors.push(`${where}: has no options`);
      return;
    }
    options += g.options.length;
    g.options.forEach((o, oi) => {
      const ow = `${where} option[${oi}]${o?.name ? ` "${o.name}"` : ""}`;
      if (!String(o?.name ?? "").trim()) errors.push(`${ow}: missing "name"`);
      // priceAdjustment is optional and 0 is normal — only type-check it.
      if (o?.priceAdjustment !== undefined) {
        checkPrice(o.priceAdjustment, ow, errors, { required: false });
      }
    });

    // A pick-one group the customer cannot escape from.
    const min = Number(g.minSelections ?? 0);
    const max = Number(g.maxSelections ?? 0);
    if (max > 0 && min > max) {
      errors.push(`${where}: minSelections (${min}) is greater than maxSelections (${max})`);
    }
  });

  for (const k of duplicateKeys) {
    errors.push(
      `modifierGroups: "${k}" is used as a key more than once — items referencing it would get whichever came last`,
    );
  }

  let items = 0;
  let sizedItems = 0;
  const usedKeys = new Set<string>();

  draft.categories.forEach((c, ci) => {
    const cw = `categories[${ci}]${c?.name ? ` "${c.name}"` : ""}`;
    if (!isObj(c)) {
      errors.push(`${cw}: not an object`);
      return;
    }
    if (!String(c.name ?? "").trim()) errors.push(`${cw}: missing "name"`);
    if (!Array.isArray(c.items) || c.items.length === 0) {
      warnings.push(`${cw}: has no items`);
      return;
    }

    c.items.forEach((it, ii) => {
      const iw = `${cw} item[${ii}]${it?.name ? ` "${it.name}"` : ""}`;
      if (!isObj(it)) {
        errors.push(`${iw}: not an object`);
        return;
      }
      items += 1;
      if (!String(it.name ?? "").trim()) errors.push(`${iw}: missing "name"`);

      const sizes = Array.isArray(it.sizes) ? it.sizes : [];
      if (sizes.length > 0) {
        sizedItems += 1;
        sizes.forEach((s, si) => {
          const sw = `${iw} size[${si}]${s?.name ? ` "${s.name}"` : ""}`;
          if (!String(s?.name ?? "").trim()) errors.push(`${sw}: missing "name"`);
          checkPrice(s?.price, sw, errors, { required: true });
          // A size may carry its own groups (a 10" pizza's base is not a
          // 16"'s). Same key check as the item level — a typo here loses
          // every option on that one size only, which is harder to spot.
          for (const k of Array.isArray(s?.modifierGroupKeys) ? s.modifierGroupKeys : []) {
            usedKeys.add(k);
            if (!groupKeys.has(k)) {
              errors.push(
                `${sw}: references modifier group "${k}", which is not defined in modifierGroups`,
              );
            }
          }
        });
        // A single size is a flat item wearing a costume — it makes the POS
        // ask the operator to pick from a list of one.
        if (sizes.length === 1) {
          warnings.push(`${iw}: has only one size — it may be simpler as a plain price`);
        }
      } else {
        const p = checkPrice(it.price, iw, errors, { required: true });
        if (p === 0) warnings.push(`${iw}: priced at £0`);
      }

      const keys = Array.isArray(it.modifierGroupKeys) ? it.modifierGroupKeys : [];
      keys.forEach((k) => {
        usedKeys.add(k);
        if (!groupKeys.has(k)) {
          errors.push(
            `${iw}: references modifier group "${k}", which is not defined in modifierGroups`,
          );
        }
      });
    });
  });

  for (const k of groupKeys) {
    if (!usedKeys.has(k)) {
      warnings.push(`modifierGroups "${k}" is defined but no item uses it`);
    }
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    warnings,
    summary: ok
      ? {
          menuName: String(draft.menuName ?? "").trim() || null,
          categories: draft.categories.length,
          items,
          modifierGroups: groups.length,
          options,
          sizedItems,
        }
      : null,
  };
}
