import type { WeekHours } from "../../../common/opening-hours.util";

// Phase TB-4 — our menu → Delivery Hero's Catalog Import JSON.
//
// Read off catalog-schema.yaml, the Catalog Import tag's "Validation rules",
// "Requirements" and "Talabat topping requirements" sections, and the
// complexCatalog example. The shape is FLAT: one `items` map keyed by id, each
// entry a Menu, Category, Product, Topping, Image or ScheduleEntry, linked to
// each other by `{ id, type }` references.
//
// ── Rules we enforce before sending (theirs, verbatim where it matters) ─────
//
//  1. "A catalog must contain at least one Category."
//  2. "Both products and variants belong to the category. If even one product
//     does not belong to a category, the validation will fail." — that
//     includes products used only as topping options. Those go in a hidden
//     "add-ons" category that no Menu lists, which is exactly how their pizza
//     example hides its extras ("If a category contains no products that are
//     added to menu under products, the category will be not presented").
//  3. "The id of a Product has to be the same as the remoteId that needs to be
//     sent for that product to the POS." — so ids are OUR ids (MenuItem,
//     ModifierOption), and an order's remoteCode leads straight back.
//  4. "Ids have to be unique across the catalog and need to be consistent over
//     time." — deterministic, never random.
//  5. TALABAT TOPPINGS: "up to 2 topping level structure. For 2 topping level
//     structure the 1st level is always a mutually-exclusive topping and must
//     be provided, even if there is only one single option." Mutually
//     exclusive = pick exactly one. So:
//       • sizes are a first-level pick-one topping (their coffee example), and
//         each size option carries its own second-level toppings — which is
//         also how per-size modifier prices are expressed exactly;
//       • an option may open nested groups only inside a pick-exactly-one
//         group, and those nested groups may not nest again.
//     Anything that can't be said in two levels is REFUSED (if a customer
//     would lose a required choice) or DROPPED with a warning (if optional).
//     We never silently flatten a structure into something else.
//  6. Prices are decimal strings in major units ("12.50"). Images must be
//     https and immutable.
//  7. Age-restricted items carry tags.ageRestrictedItem: ["ID_CHECK_18"] —
//     their docs say products restricted at 16 should be marked the same way.
//  8. Schedules may not cross midnight (stated for Pandora platforms; applied
//     everywhere because it is never wrong to split).

export interface TbSrcOption {
  id: string;
  name: string;
  secondLanguageName?: string | null;
  price: number;
  available: boolean;
  /** Groups choosing this option opens (nested modifiers). */
  groupIds?: string[];
}

export interface TbSrcGroup {
  id: string;
  name: string;
  secondLanguageName?: string | null;
  min: number;
  max: number | null;
  options: TbSrcOption[];
}

export interface TbSrcSize {
  /** Stable id for the size option product. */
  id: string;
  name: string;
  price: number;
  /** Group codes valid for THIS size (may be size-specific copies). */
  groupIds: string[];
}

export interface TbSrcItem {
  id: string;
  name: string;
  secondLanguageName?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  available: boolean;
  price: number;
  minAge?: number | null;
  calories?: number | null;
  /** Item-level groups (single-size items). */
  groupIds: string[];
  /** Sizes, when the item has them. Each carries its own groups. */
  sizes?: TbSrcSize[];
}

export interface TbSrcCategory {
  id: string;
  name: string;
  secondLanguageName?: string | null;
  description?: string | null;
  itemIds: string[];
}

export interface TbSrcMenu {
  menuId: string;
  menuName: string;
  categories: TbSrcCategory[];
  items: TbSrcItem[];
  groups: Map<string, TbSrcGroup>;
  /** Day → slots, our shape. Empty/undefined = open all week. */
  hours?: WeekHours | null;
}

export interface TbProblem {
  level: "error" | "warning";
  message: string;
  itemId?: string;
}

type Ref<T extends string> = { id: string; type: T; order?: number };

export interface TbCatalog {
  items: Record<string, Record<string, unknown>>;
}

export interface TbBuild {
  catalog: TbCatalog | null;
  problems: TbProblem[];
  stats: {
    categories: number;
    products: number;
    toppings: number;
    options: number;
    images: number;
    scheduleEntries: number;
  };
}

export const ADDONS_CATEGORY_ID = "oh-addons";
export const SIZE_TOPPING_SUFFIX = "__size";
/** Suffix for second-level copies of a group (and of options that would nest). */
export const L2 = "__l2";

const ARABIC = /[؀-ۿ]/;

/** Their localized string: default + Arabic when we actually have Arabic. */
export function localized(name: string, second?: string | null): Record<string, string> {
  const out: Record<string, string> = { default: name };
  if (second && ARABIC.test(second)) out.ar = second.trim();
  return out;
}

/** "12.5" → "12.50". Refuses (returns null) for negative or non-finite. */
export function tbPrice(n: number): string | null {
  if (!Number.isFinite(n) || n < 0) return null;
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** Only https URLs survive — their importer fetches and validates every image. */
export function usableImage(url?: string | null): string | null {
  const u = String(url ?? "").trim();
  return /^https:\/\//i.test(u) ? u : null;
}

const DAY_NAMES = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
const OUR_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

function hhmm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}
const clock = (mins: number) =>
  mins >= 1440 ? "23:59:59" : `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00`;

/**
 * Our week → ScheduleEntry items, one per distinct (start, end) with the days
 * that share it. Overnight slots are split at midnight.
 */
export function tbSchedule(hours?: WeekHours | null): Array<{ id: string; startTime: string; endTime: string; weekDays: string[] }> {
  const perDay: Array<Array<[number, number]>> = DAY_NAMES.map(() => []);
  let any = false;
  OUR_DAYS.forEach((day, i) => {
    for (const s of hours?.[day] ?? []) {
      const from = hhmm(s.from);
      let to = hhmm(s.to);
      if (from == null || to == null) continue;
      if (to === 0) to = 1440;
      any = true;
      if (to > from) perDay[i]!.push([from, to]);
      else if (to < from) {
        perDay[i]!.push([from, 1440]);
        perDay[(i + 1) % 7]!.push([0, to]);
      }
    }
  });
  if (!any) {
    return [{ id: "oh-schedule-all-week", startTime: "00:00:00", endTime: "23:59:59", weekDays: [...DAY_NAMES] }];
  }
  const byWindow = new Map<string, Set<string>>();
  perDay.forEach((slots, i) => {
    const merged: Array<[number, number]> = [];
    for (const [a, b] of slots.sort((x, y) => x[0] - y[0])) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    for (const [a, b] of merged) {
      const key = `${clock(a)}-${clock(b)}`;
      (byWindow.get(key) ?? byWindow.set(key, new Set()).get(key)!).add(DAY_NAMES[i]!);
    }
  });
  return [...byWindow.entries()].map(([key, days]) => {
    const [startTime, endTime] = key.split("-") as [string, string];
    return {
      id: `oh-schedule-${startTime.slice(0, 5).replace(":", "")}-${endTime.slice(0, 5).replace(":", "")}`,
      startTime,
      endTime,
      weekDays: DAY_NAMES.filter((d) => days.has(d)),
    };
  });
}

const isPickOne = (g: TbSrcGroup) => g.min === 1 && g.max === 1;

export function buildTalabatCatalog(src: TbSrcMenu): TbBuild {
  const items: Record<string, Record<string, unknown>> = {};
  const problems: TbProblem[] = [];
  const addonIds = new Set<string>();
  const toppingIds = new Set<string>();
  let imageCount = 0;

  const error = (message: string, itemId?: string) => problems.push({ level: "error", message, itemId });
  const warn = (message: string, itemId?: string) => problems.push({ level: "warning", message, itemId });

  /** An option (or size) as a topping-option Product, in the add-ons category. */
  const optionProduct = (id: string, name: string, second: string | null | undefined, price: string, active: boolean) => {
    if (!items[id]) {
      items[id] = {
        id,
        type: "Product",
        title: localized(name, second),
        price,
        active,
        isPrepackedItem: false,
        isExpressItem: false,
        excludeDishInformation: true,
      };
    }
    addonIds.add(id);
  };

  /**
   * Emit one Topping (group) and its option products.
   *
   * `level` is 1 or 2. Options at level 1 may open level-2 groups only when
   * this group is pick-exactly-one; level-2 options may open nothing.
   * Returns the topping id, or null when the group was dropped.
   */
  const emitGroup = (gid: string, level: 1 | 2, owner: TbSrcItem): string | null => {
    const g = src.groups.get(gid);
    if (!g) {
      warn(`"${owner.name}" uses a modifier group that no longer exists (${gid}) — skipped.`, owner.id);
      return null;
    }
    // The same group can be first-level for one product and second-level for
    // another, and the two must not share option products: a level-1 option
    // carries follow-up toppings that a level-2 copy may not. Level-2 copies
    // get their own ids (and so do their options that would otherwise drag
    // nested toppings down a level).
    const tid = level === 1 ? g.id : `${g.id}${L2}`;
    if (toppingIds.has(tid)) return tid;

    const options = g.options;
    if (options.length === 0) {
      if (g.min > 0) error(`"${owner.name}": required group "${g.name}" has no options, so it can never be satisfied.`, owner.id);
      else warn(`"${owner.name}": group "${g.name}" has no options — left off.`, owner.id);
      return null;
    }
    const max = g.max == null || g.max <= 0 ? options.length : g.max;
    if (g.min > max) {
      error(`"${owner.name}": group "${g.name}" requires ${g.min} but allows at most ${max}.`, owner.id);
      return null;
    }
    if (g.min > options.length) {
      error(`"${owner.name}": group "${g.name}" requires ${g.min} choices but only has ${options.length}.`, owner.id);
      return null;
    }

    toppingIds.add(tid);
    const products: Record<string, Ref<"Product"> & { price: string }> = {};
    options.forEach((o, i) => {
      const price = tbPrice(o.price);
      if (price == null) {
        error(`"${owner.name}": option "${o.name}" in "${g.name}" has an invalid price (${o.price}).`, owner.id);
        return;
      }
      const pid = level === 2 && o.groupIds?.length ? `${o.id}${L2}` : o.id;
      optionProduct(pid, o.name, o.secondLanguageName, price, o.available);
      products[pid] = { id: pid, type: "Product", order: i, price };

      const nested = o.groupIds ?? [];
      if (!nested.length) return;
      const allowed = level === 1 && isPickOne(g);
      const nestedToppings: Record<string, Ref<"Topping">> = {};
      for (const nid of nested) {
        const ng = src.groups.get(nid);
        if (!allowed) {
          const why =
            level === 2
              ? "Talabat allow two levels of choices and this would be a third"
              : `Talabat only allow follow-up choices under a pick-exactly-one group, and "${g.name}" is not one`;
          if (ng && ng.min > 0) {
            error(`"${owner.name}": "${o.name}" opens required group "${ng.name}", but ${why}.`, owner.id);
          } else {
            warn(`"${owner.name}": optional group "${ng?.name ?? nid}" under "${o.name}" left off — ${why}.`, owner.id);
          }
          continue;
        }
        const nestedId = emitGroup(nid, 2, owner);
        if (nestedId) nestedToppings[nestedId] = { id: nestedId, type: "Topping" };
      }
      if (Object.keys(nestedToppings).length) {
        // The option product carries its follow-up toppings, like their
        // SIZE_GRANDE → ESPRESSO_SHOT example.
        items[pid] = { ...items[pid]!, toppings: { ...((items[pid]!.toppings as object) ?? {}), ...nestedToppings } };
      }
    });

    items[tid] = {
      id: tid,
      type: "Topping",
      title: localized(g.name, g.secondLanguageName),
      quantity: { minimum: g.min, maximum: max },
      products,
    };
    return tid;
  };

  const mainProducts: string[] = [];
  const productOk = new Set<string>();

  for (const it of src.items) {
    const before = problems.filter((p) => p.level === "error").length;
    if (!it.name.trim()) {
      error(`An item has no name (${it.id}).`, it.id);
      continue;
    }
    const toppings: Record<string, Ref<"Topping">> = {};

    let basePrice: number;
    if (it.sizes?.length) {
      // Sizes → first-level pick-one topping. Base = the cheapest size, each
      // size option = its difference, so the customer total is exact.
      basePrice = Math.min(...it.sizes.map((s) => s.price));
      const sizeTopping = `${it.id}${SIZE_TOPPING_SUFFIX}`;
      const sizeProducts: Record<string, Ref<"Product"> & { price: string }> = {};
      it.sizes.forEach((s, i) => {
        const delta = tbPrice(s.price - basePrice);
        if (delta == null) {
          error(`"${it.name}": size "${s.name}" has an invalid price.`, it.id);
          return;
        }
        optionProduct(s.id, s.name, null, delta, true);
        sizeProducts[s.id] = { id: s.id, type: "Product", order: i, price: delta };
        const second: Record<string, Ref<"Topping">> = {};
        for (const gid of s.groupIds) {
          const tid = emitGroup(gid, 2, it);
          if (tid) second[tid] = { id: tid, type: "Topping" };
        }
        if (Object.keys(second).length) items[s.id] = { ...items[s.id]!, toppings: second };
      });
      items[sizeTopping] = {
        id: sizeTopping,
        type: "Topping",
        title: { default: "Size" },
        quantity: { minimum: 1, maximum: 1 },
        products: sizeProducts,
      };
      toppingIds.add(sizeTopping);
      toppings[sizeTopping] = { id: sizeTopping, type: "Topping", order: 0 };
    } else {
      basePrice = it.price;
      it.groupIds.forEach((gid, i) => {
        const tid = emitGroup(gid, 1, it);
        if (tid) toppings[tid] = { id: tid, type: "Topping", order: i };
      });
    }

    const price = tbPrice(basePrice);
    if (price == null) error(`"${it.name}" has an invalid price (${basePrice}).`, it.id);
    if (price === "0.00" && !it.sizes?.length && !Object.keys(toppings).length) {
      // "All Products that are added to a menu must have a price" — a free
      // standalone item is almost always a missing price, not a giveaway.
      error(`"${it.name}" has no price. Set one, or hide it from Talabat.`, it.id);
    }

    const images: Record<string, Ref<"Image">> = {};
    const img = usableImage(it.imageUrl);
    if (img) {
      const imgId = `img-${it.id}`;
      items[imgId] = { id: imgId, type: "Image", url: img, alt: { default: it.name } };
      images[imgId] = { id: imgId, type: "Image" };
      imageCount++;
    } else if (it.imageUrl) {
      warn(`"${it.name}": image is not an https URL Talabat can fetch — published without a photo.`, it.id);
    }

    items[it.id] = {
      id: it.id,
      type: "Product",
      title: localized(it.name, it.secondLanguageName),
      ...(it.description?.trim() ? { description: localized(it.description.trim()) } : {}),
      price: price ?? "0.00",
      // 86'd items publish INACTIVE rather than vanishing, so the next
      // availability call can restore them without a re-import.
      active: it.available,
      isPrepackedItem: false,
      isExpressItem: false,
      excludeDishInformation: false,
      ...(Object.keys(images).length ? { images } : {}),
      ...(Object.keys(toppings).length ? { toppings } : {}),
      ...(it.calories && it.calories > 0 ? { calories: it.calories } : {}),
      ...(it.minAge && it.minAge >= 16 ? { tags: { ageRestrictedItem: ["ID_CHECK_18"] } } : {}),
    };
    if (problems.filter((p) => p.level === "error").length === before) productOk.add(it.id);
  }

  // Categories, in our order. An item can sit in several of our categories,
  // but a Delivery Hero product belongs to ONE (stated for Pandora; the
  // first-seen category wins everywhere, which is never invalid).
  const placed = new Set<string>();
  let categoryCount = 0;
  src.categories.forEach((c, ci) => {
    const products: Record<string, Ref<"Product">> = {};
    c.itemIds.forEach((id, i) => {
      if (!items[id] || placed.has(id) || addonIds.has(id)) return;
      placed.add(id);
      products[id] = { id, type: "Product", order: i };
    });
    if (!Object.keys(products).length) return;
    categoryCount++;
    items[`cat-${c.id}`] = {
      id: `cat-${c.id}`,
      type: "Category",
      title: localized(c.name, c.secondLanguageName),
      ...(c.description?.trim() ? { description: localized(c.description.trim()) } : {}),
      products,
      order: ci,
    };
    mainProducts.push(...Object.keys(products));
  });

  // A product that is both sold on its own AND an option elsewhere stays in
  // its real category; only option-only products go to the hidden one.
  const addonOnly = [...addonIds].filter((id) => !placed.has(id));
  if (addonOnly.length) {
    items[ADDONS_CATEGORY_ID] = {
      id: ADDONS_CATEGORY_ID,
      type: "Category",
      title: { default: "Add-ons" },
      products: Object.fromEntries(addonOnly.map((id, i) => [id, { id, type: "Product", order: i }])),
    };
    categoryCount++;
  }

  const unplaced = src.items.filter((it) => !placed.has(it.id) && items[it.id]);
  for (const it of unplaced) {
    warn(`"${it.name}" is not in any visible category — it will not be on Talabat.`, it.id);
    delete items[it.id];
  }

  const schedule = tbSchedule(src.hours);
  for (const s of schedule) items[s.id] = { ...s, type: "ScheduleEntry" };

  const menuId = `menu-${src.menuId}`;
  items[menuId] = {
    id: menuId,
    type: "Menu",
    title: { default: src.menuName || "Menu" },
    menuType: "DELIVERY",
    products: Object.fromEntries(mainProducts.map((id) => [id, { id, type: "Product" }])),
    schedule: Object.fromEntries(schedule.map((s, i) => [s.id, { id: s.id, type: "ScheduleEntry", order: i }])),
  };

  if (!mainProducts.length) error("Nothing on this menu can be published — no visible items in any visible category.");

  const errors = problems.filter((p) => p.level === "error");
  return {
    catalog: errors.length ? null : { items },
    problems,
    stats: {
      categories: categoryCount,
      products: mainProducts.length,
      toppings: toppingIds.size,
      options: addonIds.size,
      images: imageCount,
      scheduleEntries: schedule.length,
    },
  };
}

/**
 * For each of OUR option ids, every catalog product id it was published under
 * when that is more than just itself (second-level copies, size-specific
 * copies). Saved on the connection at publish so an option 86 can name them
 * all; Talabat answer "not found" for none of them, since they were all sent.
 */
export function talabatOptionAliases(catalog: TbCatalog, ourOptionIds: Iterable<string>): Record<string, string[]> {
  const ids = Object.keys(catalog.items).filter((k) => catalog.items[k]!.type === "Product");
  const out: Record<string, string[]> = {};
  for (const opt of ourOptionIds) {
    const hits = ids.filter((id) => id === opt || id.startsWith(`${opt}__`));
    if (hits.length > 1 || (hits.length === 1 && hits[0] !== opt)) out[opt] = hits;
  }
  return out;
}
