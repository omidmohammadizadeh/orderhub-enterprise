// ── Phase AK — Menu pricing & SKU helpers ───────────────────────────────────
//
// Pure functions shared by the API (order ingest, cart validation) and the
// web POS modal. Mirrors Base44's `ModifierSelectionModal` arithmetic 1:1
// so a price calculated client-side matches what the server records.
//
// Three concepts you need to hold together:
//
//   1. A *product* can declare multiple SKUs (sizes). When it does,
//      `hasMultipleSkus = true` and `productSkus[]` carries one entry per
//      size — each with its own price, PLU, and modifier-group list.
//
//   2. A *modifier* can be priced differently by size via `pricesBySize`.
//      Keys are size strings (e.g. "10", "12") extracted from the chosen
//      size-modifier's name. If the selected size key is not in the map,
//      the modifier is *hidden* (not just disabled) — this matches
//      Base44's behaviour where a 14-inch-only topping doesn't even
//      appear when you pick a 10-inch base.
//
//   3. A *cart item's* unit price already includes its modifier costs.
//      Quantity multiplication happens once, on top of the unit price.
//      Don't multiply the modifier prices by quantity separately.

// Structural type so we can accept Prisma's Decimal without adding a
// runtime dependency on decimal.js inside @orderhub/shared.
interface DecimalLike {
  toNumber(): number;
}

// ── Public types ────────────────────────────────────────────────────────────

/**
 * One row of the productSkus JSON column.
 * Modifier groups are listed by ID — the SKU "owns" which groups apply.
 */
export interface ProductSku {
  /** Human-readable size name, e.g. "10 inch", "Large", "Family size". */
  name: string;
  /** PLU stamped on the order line. */
  plu: string;
  /** Base price for this SKU before modifiers. */
  price: number;
  /** Modifier-group IDs that apply when this SKU is selected. */
  modifierGroups: string[];
}

/** Minimal shape needed for pricing — accepts both DB rows and DTOs. */
export interface PriceableModifier {
  id: string;
  name: string;
  /** Default / fallback price when no size key matches. */
  priceAdjustment: number | string | DecimalLike;
  /** Per-size price map: { "10": 0.50, "12": 0.75 }. */
  pricesBySize?: Record<string, number> | null;
  /** Per-size PLU map: { "10": "TOP-CHEESE-10", ... }. */
  skuPlus?: Record<string, string> | null;
  isAvailable?: boolean;
  visibleToCustomers?: boolean;
}

/** A modifier the customer has actually picked, with the group context. */
export interface SelectedModifier {
  id: string;
  name: string;
  groupId: string;
  groupName: string;
  /** Unit price for this modifier given the current size context. */
  price: number;
  /** PLU at the time of selection (size-aware). */
  plu?: string | null;
}

// ── Size key extraction ─────────────────────────────────────────────────────

/**
 * Pulls the numeric size from a SKU or modifier name.
 *
 * Examples (all return "10"):
 *   "10 inch"
 *   "10\""
 *   "10in"
 *   "Pizza 10 inches"
 *
 * Returns null when there's no numeric size in the name (e.g. "Large").
 * Callers should fall back to the SKU's full name as the lookup key in
 * that case, matching what Base44 does on bespoke size names.
 *
 * Regex matches Base44's: /(\d+)\s*(?:inch|"|in)?/i
 */
export function extractSizeKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const match = name.match(/(\d+)\s*(?:inch|"|in)?/i);
  return match && match[1] ? match[1] : null;
}

// ── Per-modifier pricing ────────────────────────────────────────────────────

const toNum = (v: number | string | DecimalLike | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseFloat(v) || 0;
  if (typeof (v as DecimalLike).toNumber === "function") {
    return (v as DecimalLike).toNumber();
  }
  return Number(v) || 0;
};

/**
 * Price a single modifier given the currently selected size key.
 *
 * Resolution order (matches Base44):
 *   1. If pricesBySize has the size key → use that.
 *   2. Otherwise → fall back to priceAdjustment.
 *
 * Returns a plain number; cents/decimals preserved.
 */
export function getModifierPrice(
  modifier: PriceableModifier,
  sizeKey: string | null,
): number {
  if (sizeKey && modifier.pricesBySize && modifier.pricesBySize[sizeKey] !== undefined) {
    return Number(modifier.pricesBySize[sizeKey]);
  }
  return toNum(modifier.priceAdjustment);
}

/**
 * PLU for this modifier given the currently selected size key. Falls back
 * to no PLU when neither skuPlus nor a default PLU is set.
 */
export function getModifierPlu(
  modifier: PriceableModifier & { plu?: string | null },
  sizeKey: string | null,
): string | null {
  if (sizeKey && modifier.skuPlus && modifier.skuPlus[sizeKey]) {
    return modifier.skuPlus[sizeKey];
  }
  return modifier.plu ?? null;
}

/**
 * Visibility rule for a modifier given the current size.
 *
 *   - If the modifier declares pricesBySize keys AND the selected size key
 *     is NOT among them → HIDDEN. (A 14-inch-only topping won't show when
 *     a 10-inch base is selected.)
 *   - If pricesBySize is empty / absent → always shown.
 *   - Inherits `isAvailable` / `visibleToCustomers` if provided.
 */
export function isModifierAvailable(
  modifier: PriceableModifier,
  sizeKey: string | null,
  opts: { audience?: "pos" | "customer" } = {},
): boolean {
  if (modifier.isAvailable === false) return false;
  if (opts.audience === "customer" && modifier.visibleToCustomers === false) {
    return false;
  }
  const byKeys = modifier.pricesBySize ? Object.keys(modifier.pricesBySize) : [];
  if (byKeys.length > 0 && sizeKey && !byKeys.includes(sizeKey)) {
    return false;
  }
  return true;
}

// ── Cart item totals ────────────────────────────────────────────────────────

export interface CartItemInput {
  /** Base price — `MenuItem.basePrice` or `selectedSku.price`. */
  basePrice: number;
  /** Selected modifiers (already priced per current size). */
  modifiers: SelectedModifier[];
  /** Quantity of this cart line. */
  quantity: number;
  /**
   * When a modifier group allows duplicate selections, the same modifier can
   * appear multiple times in `modifiers[]`. Default: false.
   */
  allowDuplicates?: boolean;
}

export interface CartItemBreakdown {
  /** Unit price including modifiers, before quantity. */
  unitPrice: number;
  /** Quantity multiplied through. */
  lineTotal: number;
  /** Sum of modifier prices only (for receipt breakdown). */
  modifierTotal: number;
}

/**
 * Computes a single cart line's totals. Mirrors Base44's
 * `ModifierSelectionModal.calculateTotal()` exactly:
 *
 *   unitPrice = basePrice + sum(modifier.price)
 *   lineTotal = unitPrice * quantity
 *
 * Duplicate selections (when the group allows them) ARE counted: each
 * occurrence in `modifiers[]` adds its own price. The caller is
 * responsible for deduping when `allowDuplicates` is false at the group
 * level — this function trusts the array it's given.
 */
export function calculateCartItem(input: CartItemInput): CartItemBreakdown {
  const modifierTotal = input.modifiers.reduce(
    (sum, m) => sum + (Number.isFinite(m.price) ? m.price : 0),
    0,
  );
  const unitPrice = round2(input.basePrice + modifierTotal);
  const lineTotal = round2(unitPrice * Math.max(1, Math.trunc(input.quantity)));
  return { unitPrice, lineTotal, modifierTotal: round2(modifierTotal) };
}

/**
 * Round to two decimal places using bankers-style rounding to keep totals
 * stable across the API/web boundary. Avoids the classic
 * "1.005.toFixed(2) === '1.00'" floating-point trap.
 */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ── Sku selection helpers ───────────────────────────────────────────────────

/** Find a SKU in a product's productSkus[] by name (case-insensitive). */
export function findSkuByName(
  productSkus: ProductSku[],
  name: string,
): ProductSku | null {
  const target = name.toLowerCase().trim();
  return productSkus.find((s) => s.name.toLowerCase().trim() === target) ?? null;
}

/**
 * Active modifier group IDs for a product given the currently chosen SKU.
 *
 * - If the product has no SKUs, the product's own `modifier_groups` array
 *   applies to every order.
 * - If the product has SKUs, the chosen SKU's list applies. The product-
 *   level `modifier_groups` is ignored.
 *
 * Callers may then load ModifierGroup rows whose id IN this list.
 */
export function activeModifierGroupIds(
  product: { modifierGroupIds?: string[] | null },
  productSkus: ProductSku[],
  selectedSku: ProductSku | null,
): string[] {
  if (selectedSku) return selectedSku.modifierGroups ?? [];
  return product.modifierGroupIds ?? [];
}

// ── Cart-line display name (KDS / printer parsing depends on this) ──────────

/**
 * Builds the "10 inch Margherita (Classic Crust, Extra Cheese) - Note: ..."
 * string that the KDS regex and printer payload parse downstream. The
 * exact format (parentheses for modifiers, " - Note: " suffix) is
 * load-bearing — do not change it without updating the KDS parser in
 * `parseItemDisplay` as well.
 */
export function buildCartItemName(args: {
  productName: string;
  selectedSku?: ProductSku | null;
  modifiers: Array<{ name: string }>;
  note?: string | null;
}): string {
  const prefix = args.selectedSku ? `${args.selectedSku.name} ${args.productName}` : args.productName;
  const mods = args.modifiers.map((m) => m.name).filter(Boolean).join(", ");
  const withMods = mods ? `${prefix} (${mods})` : prefix;
  return args.note ? `${withMods} - Note: ${args.note.trim()}` : withMods;
}
