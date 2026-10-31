// Reads a saved Just Eat or Deliveroo shop page into a menu draft.
//
// Both sites refuse server-side fetches (403), and a Deliveroo page carries
// about 12 MB of embedded JSON, which is over the upload limit and far over
// what a model can be sent. So this runs in the operator's browser, on the file
// they saved, and only the small draft is uploaded. No AI, so no invented
// items and no cost.
//
// The draft is the same shape the JSON menu import takes (see
// validate-menu-json.ts), so a preview can later be imported unchanged.
//
// Shapes verified against live pages on 30 Oct 2026. The object keys of
// Just Eat's groups and sets are NOT their ids, so everything is indexed by .id.

export interface ExtractedSize {
  name: string;
  price: number;
  modifierGroupKeys?: string[];
}

export interface ExtractedItem {
  name: string;
  description?: string;
  price?: number;
  sizes?: ExtractedSize[];
  modifierGroupKeys?: string[];
  imageUrl?: string;
}

export interface ExtractedGroup {
  key: string;
  name: string;
  selectionType: "VARIANT" | "ADDON";
  minSelections: number;
  maxSelections: number;
  options: { name: string; priceAdjustment: number }[];
}

export interface ExtractedMenuDraft {
  menuName: string;
  currency: string;
  categories: { name: string; description?: string; items: ExtractedItem[] }[];
  modifierGroups: ExtractedGroup[];
  warnings: string[];
}

export interface ExtractedShop {
  platform: "just_eat" | "deliveroo";
  shopName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  city: string | null;
  postcode: string | null;
  draft: ExtractedMenuDraft;
}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const pounds = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
};
const list = (v: unknown): Json[] => (Array.isArray(v) ? v : []);
const indexById = (o: unknown): Map<string, Json> => {
  const values = Array.isArray(o) ? o : o && typeof o === "object" ? Object.values(o) : [];
  return new Map(values.filter((v: Json) => v?.id != null).map((v: Json) => [String(v.id), v]));
};

/** Collapses identical groups (both sites repeat a group per item under new
 *  ids) and hands back one stable key per distinct group. */
class GroupBook {
  readonly groups: ExtractedGroup[] = [];
  private readonly bySignature = new Map<string, string>();

  add(group: Omit<ExtractedGroup, "key">): string | null {
    const seen = new Set<string>();
    const options = group.options.filter((o) => {
      const name = o.name.toLowerCase();
      if (!o.name || seen.has(name)) return false;
      seen.add(name);
      return true;
    });
    if (!group.name || options.length === 0) return null;
    const maxSelections = Math.max(group.maxSelections, group.minSelections, 1);
    const clean = { ...group, options, maxSelections };
    const signature = JSON.stringify([clean.name, clean.minSelections, maxSelections, options]);
    const known = this.bySignature.get(signature);
    if (known) return known;
    const key = `g${this.groups.length + 1}`;
    this.bySignature.set(signature, key);
    this.groups.push({ key, ...clean });
    return key;
  }
}

const selectionType = (min: number, max: number): "VARIANT" | "ADDON" =>
  min === 1 && max === 1 ? "VARIANT" : "ADDON";

const unique = (keys: (string | null)[]): string[] => [
  ...new Set(keys.filter((k): k is string => !!k)),
];

function finish(
  shopName: string,
  currency: string,
  categories: ExtractedMenuDraft["categories"],
  book: GroupBook,
  warnings: string[],
): ExtractedMenuDraft | null {
  const kept = categories.filter((c) => c.items.length > 0);
  if (kept.length === 0) return null;
  return { menuName: shopName, currency, categories: kept, modifierGroups: book.groups, warnings };
}

// ── Just Eat ────────────────────────────────────────────────────────────────

/** `.../upload/c_fill,q_auto,{transformations}/v1/...` → `.../upload/v1/...`.
 *  Only swapping the placeholder leaves `c_fill,q_auto,v1`, which is a 404. */
const justEatImage = (path: unknown): string | null => {
  const url = text(path);
  if (!url) return null;
  return url.replace(/\/[^/]*\{transformations\}[^/]*\//, "/");
};

export function extractJustEat(nextData: Json): ExtractedShop | null {
  const cdn = nextData?.props?.appProps?.preloadedState?.menu?.restaurant?.cdn;
  const menu = list(cdn?.restaurant?.menus)[0];
  if (!menu) return null;
  const info = cdn.restaurant.restaurantInfo ?? {};
  const shopName = text(info.name) || "Your shop";

  const items = indexById(cdn.items);
  const modifierGroups = indexById(cdn.modifierGroups);
  const modifierSets = indexById(cdn.modifierSets);
  const dealGroups = indexById(cdn.dealGroups);
  const variationOwner = new Map<string, { item: Json; variation: Json }>();
  for (const item of items.values()) {
    for (const variation of list(item.variations)) {
      variationOwner.set(String(variation.id), { item, variation });
    }
  }

  const book = new GroupBook();
  const modifierGroupKey = (id: string, forceOptional = false): string | null => {
    const group = modifierGroups.get(id);
    if (!group) return null;
    const min = forceOptional ? 0 : Number(group.minChoices) || 0;
    const max = Number(group.maxChoices) || 1;
    return book.add({
      name: text(group.name),
      selectionType: selectionType(min, max),
      minSelections: min,
      maxSelections: max,
      options: list(group.modifiers).map((setId) => {
        const modifier = modifierSets.get(String(setId))?.modifier;
        return { name: text(modifier?.name), priceAdjustment: pounds(modifier?.additionPrice) };
      }),
    });
  };

  // A meal-deal pick, followed by the picked items' own choices (a burrito's
  // salsa). Those are required only when every pick has them.
  const dealGroupKeys = (id: string): (string | null)[] => {
    const deal = dealGroups.get(id);
    if (!deal) return [];
    const picks = list(deal.dealItemVariations)
      .map((p) => ({ pick: p, owner: variationOwner.get(String(p.dealItemVariationId)) }))
      .filter((p) => p.owner);
    const choices = Number(deal.numberOfChoices) || 1;
    const pickKey = book.add({
      name: text(deal.name),
      selectionType: selectionType(choices, choices),
      minSelections: choices,
      maxSelections: choices,
      options: picks.map(({ pick, owner }) => ({
        name: [text(owner!.item.name), text(owner!.variation.name)].filter(Boolean).join(" "),
        priceAdjustment: pounds(pick.additionPrice),
      })),
    });
    const nestedIds = unique(
      picks.flatMap(({ owner }) => list(owner!.variation.modifierGroupsIds).map(String)),
    );
    const nested = nestedIds.map((groupId) => {
      const onEveryPick = picks.every(({ owner }) =>
        list(owner!.variation.modifierGroupsIds).map(String).includes(groupId),
      );
      return modifierGroupKey(groupId, !onEveryPick);
    });
    return [pickKey, ...nested];
  };

  const variationKeys = (variation: Json): string[] =>
    unique([
      ...list(variation.modifierGroupsIds).map((id) => modifierGroupKey(String(id))),
      ...list(variation.dealGroupsIds).flatMap((id) => dealGroupKeys(String(id))),
    ]);

  const categories = list(menu.categories).map((category) => ({
    name: text(category.name),
    description: text(category.description) || undefined,
    items: list(category.itemIds)
      .map((id): ExtractedItem | null => {
        const item = items.get(String(id));
        const variations = list(item?.variations);
        if (!item || variations.length === 0) return null;
        const base = {
          name: text(item.name),
          description: text(item.description) || undefined,
          imageUrl: justEatImage(list(item.imageSources)[0]?.path) ?? undefined,
        };
        if (variations.length === 1) {
          const keys = variationKeys(variations[0]);
          return {
            ...base,
            price: pounds(variations[0].basePrice),
            modifierGroupKeys: keys.length ? keys : undefined,
          };
        }
        return {
          ...base,
          sizes: variations.map((v) => {
            const keys = variationKeys(v);
            return {
              name: text(v.name) || "Regular",
              price: pounds(v.basePrice),
              modifierGroupKeys: keys.length ? keys : undefined,
            };
          }),
        };
      })
      .filter((i): i is ExtractedItem => !!i?.name),
  }));

  const warnings: string[] = [];
  if (cdn.truncatedItems && Object.keys(cdn.truncatedItems).length > 0) {
    warnings.push("Just Eat left some items out of this page, so the menu may be incomplete.");
  }
  const draft = finish(shopName, "GBP", categories, book, warnings);
  if (!draft) return null;
  return {
    platform: "just_eat",
    shopName,
    logoUrl: text(info.logoUrl) || null,
    bannerUrl: justEatImage(info.bannerUrl),
    city: text(info.location?.city) || null,
    postcode: text(info.location?.postCode) || null,
    draft,
  };
}

// ── Deliveroo ───────────────────────────────────────────────────────────────

/** Drops `?width={w}&height={h}…`: the bare link is the original photo. */
const deliverooImage = (url: unknown): string | undefined => text(url).split("?")[0] || undefined;

const pence = (price: Json): number => pounds((Number(price?.fractional) || 0) / 100);
const titleCase = (s: string): string => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

export function extractDeliveroo(nextData: Json): ExtractedShop | null {
  const root = nextData?.props?.initialState?.menuPage?.menu?.metas?.root;
  if (!root || !Array.isArray(root.items) || !Array.isArray(root.categories)) return null;
  const restaurant = root.restaurant ?? {};
  const shopName = text(restaurant.name) || "Your shop";
  const groups = indexById(root.modifierGroups);
  const book = new GroupBook();

  // Options can open further groups (a meal's pita opens its sauce). The draft
  // can't nest, so each one follows its parent as a sibling, required only when
  // every option opens it.
  const groupKeys = (id: string, seen: Set<string>, forceOptional = false): (string | null)[] => {
    const group = groups.get(id);
    if (!group || seen.has(id)) return [];
    const nextSeen = new Set(seen).add(id);
    const options = list(group.modifierOptions);
    const min = forceOptional ? 0 : Number(group.minSelection) || 0;
    const max = Number(group.maxSelection) || 1;
    const key = book.add({
      name: text(group.name),
      selectionType: selectionType(min, max),
      minSelections: min,
      maxSelections: max,
      options: options.map((o) => ({ name: text(o.name), priceAdjustment: pence(o.price) })),
    });
    const nested = unique(options.flatMap((o) => list(o.modifierGroupIds).map(String)));
    return [
      key,
      ...nested.flatMap((nestedId) =>
        groupKeys(
          nestedId,
          nextSeen,
          !options.every((o) => list(o.modifierGroupIds).map(String).includes(nestedId)),
        ),
      ),
    ];
  };

  const isSizeGroup = (group: Json): boolean =>
    /\bsize\b/i.test(text(group?.name)) &&
    Number(group?.minSelection) === 1 &&
    Number(group?.maxSelection) === 1 &&
    list(group?.modifierOptions).length > 1;

  const toItem = (item: Json): ExtractedItem | null => {
    const name = text(item.name);
    if (!name) return null;
    const base = {
      name,
      description: text(item.description) || undefined,
      imageUrl: deliverooImage(item.image?.url),
    };
    const ids = list(item.modifierGroupIds).map(String);
    const sizeId = ids.find((id) => isSizeGroup(groups.get(id)));
    const itemKeys = unique(
      ids.filter((id) => id !== sizeId).flatMap((id) => groupKeys(id, new Set())),
    );
    if (!sizeId) {
      return {
        ...base,
        price: pence(item.price),
        modifierGroupKeys: itemKeys.length ? itemKeys : undefined,
      };
    }
    return {
      ...base,
      sizes: list(groups.get(sizeId).modifierOptions).map((option) => {
        // A sized item's picker reads only the size's own groups, so the item's
        // groups have to be listed on every size too.
        const keys = unique([
          ...itemKeys,
          ...list(option.modifierGroupIds).flatMap((id) => groupKeys(String(id), new Set([sizeId]))),
        ]);
        return {
          name: text(option.name),
          price: pounds(pence(item.price) + pence(option.price)),
          modifierGroupKeys: keys.length ? keys : undefined,
        };
      }),
    };
  };

  // Items with an empty categoryId are hidden option-items: thousands of them.
  const categories = root.categories.map((category: Json) => ({
    name: text(category.name),
    items: root.items
      .filter((item: Json) => String(item.categoryId ?? "") === String(category.id))
      .map(toItem)
      .filter((item: ExtractedItem | null): item is ExtractedItem => !!item),
  }));

  const warnings: string[] = [];
  if (root.paginationHasMore) {
    warnings.push("Deliveroo only loaded part of this menu. Scroll to the bottom before saving the page.");
  }
  const draft = finish(shopName, text(restaurant.currencyCode) || "GBP", categories, book, warnings);
  if (!draft) return null;
  const address = restaurant.location?.address ?? {};
  return {
    platform: "deliveroo",
    shopName,
    logoUrl: null,
    bannerUrl: deliverooImage(
      list(root.metatags?.images)[0] ?? root.metatags?.image ?? nextData?.props?.initialState?.menuPage?.menu?.header?.image?.url,
    ) ?? null,
    city: titleCase(text(address.city)) || null,
    // postCode is often null; the postcode is the end of address1 instead.
    postcode:
      text(address.postCode) ||
      /([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\s*$/i.exec(text(address.address1))?.[1]?.toUpperCase() ||
      null,
    draft,
  };
}

// ── Saved page → shop ───────────────────────────────────────────────────────

/** Chrome's single-file save is quoted-printable MHTML. Undo it so the embedded
 *  JSON is readable. Works on UTF-8 bytes decoded as text, so a multi-byte
 *  character such as £ is rebuilt from its escapes. */
function decodeSavedPage(raw: string): string {
  if (!/Content-Transfer-Encoding:\s*quoted-printable/i.test(raw)) return raw;
  return raw
    .replace(/=\r?\n/g, "")
    .replace(/(?:=[0-9A-F]{2})+/g, (run) => {
      const codes = run.split("=").filter(Boolean).map((h) => parseInt(h, 16));
      return decodeUtf8(codes);
    });
}

function decodeUtf8(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    const extra = b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : 0;
    let code = extra === 3 ? b & 0x07 : extra === 2 ? b & 0x0f : extra === 1 ? b & 0x1f : b;
    for (let j = 1; j <= extra; j++) code = (code << 6) | ((bytes[i + j] ?? 0) & 0x3f);
    out += String.fromCodePoint(code);
    i += extra + 1;
  }
  return out;
}

/** The shop on a saved marketplace page, or null when it isn't a page we can
 *  read directly (Uber Eats, a shop's own site, a menu photo…), in which case
 *  the file goes to the AI reader instead. */
export function extractShopFromSavedPage(raw: string): ExtractedShop | null {
  const html = decodeSavedPage(raw);
  const match = /<script[^>]*id=["']?__NEXT_DATA__["']?[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match?.[1]) return null;
  let nextData: Json;
  try {
    nextData = JSON.parse(match[1]);
  } catch {
    return null;
  }
  return extractJustEat(nextData) ?? extractDeliveroo(nextData);
}
