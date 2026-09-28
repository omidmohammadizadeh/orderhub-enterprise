// Multi-buy offers — "3 for £2", "buy 3, cheapest free", "meal deal £3.50".
//
// One pure engine shared by the till, the storefront cart and the server
// checkout, so all three arrive at the same saving for the same basket. The
// server's figure is the one charged; the other two only preview it.
//
// A deal is a MULTI_BUY MarketingCampaign: `itemIds` is the pool for the two
// quantity modes, `metadata.slots` the courses of a meal deal.
//
// Units are grouped most-expensive first. For a fixed bundle price that is
// what gives the customer the biggest saving; for "cheapest free" it is the
// usual shop rule (the free unit is the cheapest of each group of N, not the
// cheapest in the whole basket). A unit counts towards one deal only, and
// £0 lines (BOGO copies, gifts, loyalty rewards) never count.

export type MultiBuyMode = "FIXED_PRICE" | "CHEAPEST_FREE" | "MEAL_DEAL";

export const MULTI_BUY_MODES: readonly MultiBuyMode[] = ["FIXED_PRICE", "CHEAPEST_FREE", "MEAL_DEAL"];

export interface MultiBuySlot {
  name: string;
  itemIds: string[];
}

export interface MultiBuyDeal {
  id: string;
  name: string;
  mode: MultiBuyMode;
  /** FIXED_PRICE / CHEAPEST_FREE: units per deal (≥ 2). */
  quantity: number;
  /** FIXED_PRICE / MEAL_DEAL: what one deal costs. */
  price: number;
  /** FIXED_PRICE / CHEAPEST_FREE: the products that count. */
  itemIds: string[];
  /** MEAL_DEAL: one product from each slot. */
  slots: MultiBuySlot[];
}

export interface MultiBuyLine {
  menuItemId: string;
  /** Per unit, modifiers included — what the line charges before the deal. */
  unitPrice: number;
  quantity: number;
}

export interface MultiBuyApplication {
  dealId: string;
  name: string;
  times: number;
  saving: number;
}

export interface MultiBuyResult {
  savings: number;
  applied: MultiBuyApplication[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A human label for a deal: "3 for £2.00", "Buy 3, cheapest free", "Meal deal £3.50". */
export function describeMultiBuy(deal: Pick<MultiBuyDeal, "mode" | "quantity" | "price">, symbol = "£"): string {
  const money = `${symbol}${Number(deal.price).toFixed(2)}`;
  if (deal.mode === "CHEAPEST_FREE") return `Buy ${deal.quantity}, cheapest free`;
  if (deal.mode === "MEAL_DEAL") return `Meal deal ${money}`;
  return `${deal.quantity} for ${money}`;
}

/**
 * Read a MULTI_BUY campaign row (or anything shaped like one) into a deal.
 * Returns null for a row that could never apply, so a half-built campaign is
 * inert rather than an error at checkout.
 */
export function parseMultiBuyDeal(row: {
  id: string;
  name?: string | null;
  itemIds?: string[] | null;
  metadata?: unknown;
}): MultiBuyDeal | null {
  const meta = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, any>;
  const cfg = (meta.multiBuy && typeof meta.multiBuy === "object" ? meta.multiBuy : {}) as Record<string, any>;
  const mode = MULTI_BUY_MODES.includes(cfg.mode) ? (cfg.mode as MultiBuyMode) : null;
  if (!mode) return null;
  const quantity = Math.trunc(Number(cfg.quantity ?? 0));
  const price = r2(Number(cfg.price ?? 0));
  const itemIds = [...new Set((row.itemIds ?? []).filter((x): x is string => typeof x === "string" && !!x))];
  const slots: MultiBuySlot[] = Array.isArray(cfg.slots)
    ? cfg.slots
        .map((s: any) => ({
          name: String(s?.name ?? "").trim() || "Choice",
          itemIds: [...new Set<string>((Array.isArray(s?.itemIds) ? s.itemIds : []).filter((x: any) => typeof x === "string" && !!x))],
        }))
        .filter((s: MultiBuySlot) => s.itemIds.length > 0)
    : [];
  const deal: MultiBuyDeal = { id: row.id, name: String(row.name ?? "Multi-buy"), mode, quantity, price, itemIds, slots };
  return validateMultiBuy(deal) ? null : deal;
}

/** Why a deal can't be saved, or null when it's fine. */
export function validateMultiBuy(deal: Pick<MultiBuyDeal, "mode" | "quantity" | "price" | "itemIds" | "slots">): string | null {
  if (!MULTI_BUY_MODES.includes(deal.mode)) return "Pick a multi-buy type";
  if (deal.mode === "MEAL_DEAL") {
    if ((deal.slots ?? []).length < 2) return "A meal deal needs at least two parts, each with products";
    if (!(deal.price > 0)) return "Set the meal deal price";
    return null;
  }
  if (!Number.isInteger(deal.quantity) || deal.quantity < 2 || deal.quantity > 50) return "Quantity must be between 2 and 50";
  if (!(deal.itemIds ?? []).length) return "Pick the products that count towards the deal";
  if (deal.mode === "FIXED_PRICE" && !(deal.price > 0)) return "Set the deal price";
  return null;
}

interface Unit {
  itemId: string;
  price: number;
  used: boolean;
}

function expand(lines: MultiBuyLine[]): Unit[] {
  const units: Unit[] = [];
  for (const l of lines) {
    const price = Number(l.unitPrice);
    const qty = Math.trunc(Number(l.quantity));
    if (!(price > 0) || !(qty > 0) || !l.menuItemId) continue;
    for (let i = 0; i < Math.min(qty, 500); i++) units.push({ itemId: l.menuItemId, price, used: false });
  }
  // Most expensive first; stable on item id so ties group the same way everywhere.
  return units.sort((a, b) => b.price - a.price || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
}

/** Apply one deal to the unused units, marking what it consumes. */
function run(deal: MultiBuyDeal, units: Unit[]): MultiBuyApplication {
  let times = 0;
  let saving = 0;
  const take = (picked: Unit[]) => {
    for (const u of picked) u.used = true;
  };
  if (deal.mode === "MEAL_DEAL") {
    // Fill the most constrained part first, each with its dearest match.
    const slots = [...deal.slots].sort((a, b) => a.itemIds.length - b.itemIds.length);
    for (let guard = 0; guard < 500; guard++) {
      const picked: Unit[] = [];
      for (const slot of slots) {
        const pool = new Set(slot.itemIds);
        const u = units.find((x) => !x.used && !picked.includes(x) && pool.has(x.itemId));
        if (!u) break;
        picked.push(u);
      }
      if (picked.length < slots.length) break;
      const gain = r2(picked.reduce((s, u) => s + u.price, 0) - deal.price);
      if (gain <= 0) break;
      take(picked);
      times++;
      saving += gain;
    }
  } else {
    const pool = new Set(deal.itemIds);
    const n = deal.quantity;
    for (let guard = 0; guard < 500; guard++) {
      const picked = units.filter((x) => !x.used && pool.has(x.itemId)).slice(0, n);
      if (picked.length < n) break;
      const gain =
        deal.mode === "CHEAPEST_FREE"
          ? r2(picked[picked.length - 1]!.price)
          : r2(picked.reduce((s, u) => s + u.price, 0) - deal.price);
      // Groups only get cheaper from here, so a group that saves nothing ends it.
      if (gain <= 0) break;
      take(picked);
      times++;
      saving += gain;
    }
  }
  return { dealId: deal.id, name: deal.name, times, saving: r2(saving) };
}

/**
 * The multi-buy saving on a basket. Deals are tried biggest-saving first and
 * a unit counts towards one deal only.
 */
export function applyMultiBuys(lines: MultiBuyLine[], deals: MultiBuyDeal[]): MultiBuyResult {
  if (!deals.length || !lines.length) return { savings: 0, applied: [] };
  const valid = deals.filter((d) => !validateMultiBuy(d));
  // Rank each deal by what it would save on its own.
  const ranked = valid
    .map((d) => ({ d, alone: run(d, expand(lines)).saving }))
    .filter((x) => x.alone > 0)
    .sort((a, b) => b.alone - a.alone || (a.d.id < b.d.id ? -1 : 1));
  const units = expand(lines);
  const applied: MultiBuyApplication[] = [];
  for (const { d } of ranked) {
    const a = run(d, units);
    if (a.times > 0 && a.saving > 0) applied.push(a);
  }
  return { savings: r2(applied.reduce((s, a) => s + a.saving, 0)), applied };
}
