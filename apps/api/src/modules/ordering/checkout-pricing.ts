// Server-side re-pricing of a storefront basket.
//
// The checkout used to charge whatever unit price the browser sent, so a
// tampered request could buy anything for a penny. This prices every line
// again from the SAME storefront payload the customer's browser priced from
// (getStorefrontBySlug: channel-resolved item/size prices, the modifier
// catalogue, item promos, BOGO and free-gift rules), with the same formulas
// (calculateCartItem / getModifierPrice / the promo rounding in the
// storefront), so an honest basket prices identically and a tampered one
// cannot pay less than the menu says.
//
// Two ways a line is matched:
//   • exactly — the storefront now sends the size's plu and each modifier's
//     option id; the server charges ITS figure;
//   • by name — a tab opened before this change sends neither. Matching is
//     then best-effort (a size name inside the line name, an option by name),
//     so the server takes the CHEAPEST legal reading as a floor: the line is
//     refused below it, and otherwise charged what the customer saw. It can
//     never charge more than they were shown.
//
// Pure: no database, no Nest. OrderingService.checkout loads the storefront
// and calls priceBasket.

import { extractSizeKey, getModifierPrice, round2 } from "@orderhub/shared";

/** A penny of slack for rounding between browser and server arithmetic. */
const TOLERANCE = 0.01;

export interface BasketModifier {
  name: string;
  price: number;
  optionId?: string | null;
  depth?: number;
  path?: string[];
  parentOptionId?: string | null;
}

export interface BasketLine {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  modifiers?: BasketModifier[];
  /** The chosen size of a multi-size product (sent by current storefronts). */
  skuPlu?: string | null;
  skuName?: string | null;
}

export type LineKind = "PAID" | "BOGO" | "GIFT";

export interface PricedLine {
  index: number;
  kind: LineKind;
  unitPrice: number;
  /** Rebuilt from the server's options when matched exactly; else as sent, repriced. */
  modifiers: BasketModifier[];
  /** True when every part of the price came from an exact match. */
  exact: boolean;
}

export interface PricingContext {
  items: Map<string, any>;
  options: Map<string, any>;
  optionsByName: Map<string, any[]>;
  itemPromos: Record<string, { percentageOff?: number | null } | undefined>;
  bogoTriggers: Set<string>;
  freeItem: { minOrder: number; freeItemIds: Set<string>; excludedItemIds: Set<string> } | null;
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** Index the storefront payload the customer priced from. */
export function buildPricingContext(storefront: any): PricingContext {
  const items = new Map<string, any>();
  for (const cat of storefront?.menu?.categories ?? []) {
    for (const link of cat.items ?? []) {
      if (link?.item?.id) items.set(link.item.id, link.item);
    }
  }
  const options = new Map<string, any>();
  const optionsByName = new Map<string, any[]>();
  const addGroup = (g: any) => {
    for (const o of g?.options ?? []) {
      if (!o?.id || options.has(o.id)) continue;
      options.set(o.id, o);
      const k = norm(o.name);
      optionsByName.set(k, [...(optionsByName.get(k) ?? []), o]);
    }
  };
  for (const g of storefront?.brandModifierGroups ?? []) addGroup(g);
  // Groups still embedded on item links (hoisting normally moves them all).
  for (const item of items.values()) for (const gl of item.modifierGroupLinks ?? []) addGroup(gl?.group);

  const fi = storefront?.freeItem;
  return {
    items,
    options,
    optionsByName,
    itemPromos: storefront?.itemPromos ?? {},
    bogoTriggers: new Set<string>(storefront?.bogo?.triggerItemIds ?? []),
    freeItem:
      fi && fi.minOrder != null
        ? {
            minOrder: Number(fi.minOrder),
            freeItemIds: new Set<string>(fi.freeItemIds ?? []),
            excludedItemIds: new Set<string>(fi.excludedItemIds ?? []),
          }
        : null,
  };
}

/** The item promo, applied exactly as the storefront applies it when adding. */
function withPromo(ctx: PricingContext, itemId: string, unit: number): number {
  const pct = Number(ctx.itemPromos[itemId]?.percentageOff ?? 0);
  return pct > 0 ? Math.round(unit * (1 - pct / 100) * 100) / 100 : unit;
}

/**
 * The list price of one line: exact when size + options were identified,
 * otherwise the cheapest legal reading (a floor).
 */
function listPrice(
  ctx: PricingContext,
  item: any,
  line: BasketLine,
): { unit: number; exact: boolean; modifiers: BasketModifier[] } {
  let exact = true;
  let base = Number(item.basePrice ?? 0);
  let sizeKey: string | null = null;

  const skus: any[] = item.hasMultipleSkus && Array.isArray(item.productSkus) ? item.productSkus : [];
  if (skus.length) {
    const byPlu = line.skuPlu ? skus.filter((s) => s?.plu && s.plu === line.skuPlu) : [];
    const byName = line.skuName ? skus.filter((s) => norm(s?.name) === norm(line.skuName)) : [];
    // Older tabs: the size is in the display name ("Margherita (12 inch)").
    const inName = skus.filter((s) => s?.name && norm(line.name).includes(norm(s.name)));
    const sku =
      (byPlu.length === 1 && byPlu[0]) || (byName.length === 1 && byName[0]) || (inName.length === 1 && inName[0]);
    if (sku) {
      base = Number(sku.price ?? 0);
      sizeKey = extractSizeKey(sku.name);
    } else {
      exact = false;
      base = Math.min(...skus.map((s) => Number(s?.price ?? 0)));
    }
  }

  const modifiers: BasketModifier[] = [];
  let modTotal = 0;
  for (const m of line.modifiers ?? []) {
    const byId = m.optionId ? ctx.options.get(m.optionId) : undefined;
    if (byId) {
      const price = getModifierPrice(byId, sizeKey);
      modTotal += price;
      modifiers.push({ ...m, name: byId.name ?? m.name, price });
      continue;
    }
    const named = ctx.optionsByName.get(norm(m.name)) ?? [];
    const prices = [...new Set(named.map((o) => getModifierPrice(o, sizeKey)))];
    if (prices.length === 1) {
      modTotal += prices[0]!;
      modifiers.push({ ...m, price: prices[0]! });
    } else {
      // Unknown or ambiguous option: never assume it's dearer than the
      // cheapest thing it could be. An unknown name counts as free here —
      // the floor stays honest and the line is charged what was shown.
      exact = false;
      const floor = prices.length ? Math.min(...prices) : 0;
      modTotal += floor;
      modifiers.push({ ...m });
    }
  }
  return { unit: withPromo(ctx, item.id, round2(base + modTotal)), exact, modifiers };
}

export class BasketPriceError extends Error {}

/**
 * Price every line of a basket. Throws BasketPriceError (a customer-readable
 * message) when a line is gone from the menu, pays less than the menu says,
 * or claims to be free when it isn't.
 */
export function priceBasket(ctx: PricingContext, lines: BasketLine[]): { lines: PricedLine[]; subtotal: number } {
  const problems: string[] = [];
  const priced: PricedLine[] = [];
  const zeroLines: Array<{ index: number; line: BasketLine; item: any; list: ReturnType<typeof listPrice> }> = [];

  lines.forEach((line, index) => {
    const qty = Number(line.quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      problems.push(`${line.name}: quantity must be a whole number`);
      return;
    }
    const item = ctx.items.get(line.menuItemId);
    if (!item) {
      problems.push(`${line.name} is no longer available`);
      return;
    }
    const list = listPrice(ctx, item, line);
    const sent = Number(line.unitPrice);
    if (list.unit > 0 && sent === 0) {
      zeroLines.push({ index, line, item, list });
      return;
    }
    if (!Number.isFinite(sent) || sent + TOLERANCE < list.unit) {
      problems.push(`the price of ${line.name} has changed`);
      return;
    }
    priced.push({
      index,
      kind: "PAID",
      // Exact: the server's figure (never above what was shown, since a lower
      // send was refused above). By name: what the customer saw, which has
      // just been checked against the cheapest legal reading.
      unitPrice: list.exact ? list.unit : round2(sent),
      modifiers: list.modifiers,
      exact: list.exact,
    });
  });

  // Freebies: a £0 line must be a real BOGO copy or the free gift.
  const paid = priced.filter((p) => p.kind === "PAID");
  const paidLinesOf = (itemId: string) => paid.filter((p) => lines[p.index]!.menuItemId === itemId).length;
  const bogoUsed = new Map<string, number>();
  let giftUsed = false;
  const eligibleForGift = () =>
    ctx.freeItem
      ? paid
          .filter((p) => !ctx.freeItem!.excludedItemIds.has(lines[p.index]!.menuItemId))
          .reduce((s, p) => s + p.unitPrice * lines[p.index]!.quantity, 0)
      : 0;
  // Lines named as the gift are considered for the gift first.
  zeroLines.sort((a, b) => Number(/free gift/i.test(b.line.name)) - Number(/free gift/i.test(a.line.name)));
  for (const z of zeroLines) {
    const id = z.item.id as string;
    const zeroed = z.list.modifiers.map((m) => ({ ...m, price: 0 }));
    const giftOk =
      !giftUsed &&
      !!ctx.freeItem &&
      ctx.freeItem.freeItemIds.has(id) &&
      z.line.quantity === 1 &&
      eligibleForGift() + TOLERANCE >= ctx.freeItem.minOrder;
    const bogoOk =
      ctx.bogoTriggers.has(id) && z.line.quantity === 1 && (bogoUsed.get(id) ?? 0) < paidLinesOf(id);
    if (giftOk && (/free gift/i.test(z.line.name) || !bogoOk)) {
      giftUsed = true;
      priced.push({ index: z.index, kind: "GIFT", unitPrice: 0, modifiers: [], exact: true });
    } else if (bogoOk) {
      bogoUsed.set(id, (bogoUsed.get(id) ?? 0) + 1);
      priced.push({ index: z.index, kind: "BOGO", unitPrice: 0, modifiers: zeroed, exact: true });
    } else {
      problems.push(`${z.line.name} isn't free any more`);
    }
  }

  if (problems.length) {
    throw new BasketPriceError(
      `Your basket needs a refresh — ${problems.join("; ")}. Reload the page to see today's prices.`,
    );
  }
  priced.sort((a, b) => a.index - b.index);
  const subtotal = round2(priced.reduce((s, p) => s + p.unitPrice * lines[p.index]!.quantity, 0));
  return { lines: priced, subtotal };
}
