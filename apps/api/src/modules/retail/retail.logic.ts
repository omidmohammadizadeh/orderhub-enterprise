// Retail R1 — the pure rules behind scanning, stock and returns.
//
// Everything here is side-effect free so it can be tested without a database:
// the services load rows, hand them to these functions, and write whatever
// comes back. Money is handled in MINOR units (pence) throughout — decimals
// only exist at the edges, where rows are read and written.

export const BUSINESS_TYPES = ["RESTAURANT", "GROCERY", "RETAIL"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export function isBusinessType(v: unknown): v is BusinessType {
  return typeof v === "string" && (BUSINESS_TYPES as readonly string[]).includes(v);
}

/** Shops, not kitchens: GROCERY and RETAIL share every retail behaviour in R1. */
export function isRetailType(v: unknown): boolean {
  return v === "GROCERY" || v === "RETAIL";
}

// ── Barcodes ────────────────────────────────────────────────────────────────

/**
 * Clean a scanned or typed barcode. Scanners in keyboard mode sometimes send
 * stray whitespace, and people paste codes with spaces between digit groups
 * ("5 012345 678900"). Returns null for anything that cannot be a barcode.
 */
export function normalizeBarcode(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  // A spreadsheet hands an EAN back as a number, and a big one as 5.01234E+12.
  // The scientific form has already lost digits, so refuse it rather than
  // store a barcode that matches nothing on the shelf.
  let s = typeof raw === "number" ? String(Math.trunc(raw)) : String(raw);
  s = s.replace(/\s+/g, "").trim();
  if (!s || /e\+/i.test(s)) return null;
  if (!/^[0-9A-Za-z\-./+]{3,64}$/.test(s)) return null;
  return s;
}

/** GS1 check digit for EAN-8, UPC-A, EAN-13 and GTIN-14. */
export function isValidGtin(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop()!;
  let sum = 0;
  // Weights run 3,1,3,1… from the digit nearest the check digit.
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += digits[i]! * w;
  }
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * Every form the same product's barcode may arrive in. A UPC-A (12 digits)
 * is an EAN-13 with a leading zero, and scanners disagree about whether to
 * send that zero — so a code stored one way must still match when scanned
 * the other way.
 */
export function barcodeLookupKeys(code: string): string[] {
  const keys = [code];
  if (/^\d{12}$/.test(code)) keys.push(`0${code}`);
  if (/^0\d{12}$/.test(code)) keys.push(code.slice(1));
  return keys;
}

// ── Receipt codes ───────────────────────────────────────────────────────────

/** Prefix of the QR printed on a retail receipt, so a return can find the sale. */
export const RECEIPT_CODE_PREFIX = "OHR:";

export function receiptCodeFor(orderId: string): string {
  return `${RECEIPT_CODE_PREFIX}${orderId}`;
}

/**
 * What a scan at the returns screen refers to. A receipt QR carries the order
 * id; anything else is treated as the number printed on the receipt (the
 * displayId, or the bare sequential number), which staff can also type.
 */
export function parseReceiptScan(
  raw: unknown,
): { kind: "orderId"; orderId: string } | { kind: "number"; value: string } | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (s.toUpperCase().startsWith(RECEIPT_CODE_PREFIX)) {
    const id = s.slice(RECEIPT_CODE_PREFIX.length).trim();
    return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? { kind: "orderId", orderId: id } : null;
  }
  return { kind: "number", value: s.replace(/^#/, "") };
}

// ── Order lines → variants ──────────────────────────────────────────────────

export interface LineForVariant {
  menuItemId: string | null;
  metadata: unknown;
}

export interface VariantRef {
  id: string;
  menuItemId: string;
  sku: string | null;
  trackStock: boolean;
}

/**
 * Which variant an order line sold. In order of certainty:
 *   1. the till said so (metadata.variantId — a scanned line),
 *   2. the line's sku matches a variant of that product (a size chosen in the
 *      picker — multi-variant products mirror variant.sku into productSkus[].plu),
 *   3. the product has exactly one variant, so there is nothing to choose.
 * Anything else is unknown, and unknown lines are never guessed at: a wrong
 * stock movement is worse than a missing one.
 */
export function resolveVariantForLine(
  line: LineForVariant,
  variantsByItem: Map<string, VariantRef[]>,
  variantsById: Map<string, VariantRef>,
): VariantRef | null {
  const meta = (line.metadata ?? {}) as Record<string, unknown>;
  const explicitId = typeof meta.variantId === "string" ? meta.variantId : null;
  if (explicitId) {
    const v = variantsById.get(explicitId);
    if (v && (!line.menuItemId || v.menuItemId === line.menuItemId)) return v;
  }
  if (!line.menuItemId) return null;
  const candidates = variantsByItem.get(line.menuItemId) ?? [];
  const sku = typeof meta.sku === "string" ? meta.sku : null;
  if (sku) {
    const bySku = candidates.filter((v) => v.sku === sku);
    if (bySku.length === 1) return bySku[0]!;
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

// ── Returns ─────────────────────────────────────────────────────────────────

export interface ReturnableItem {
  id: string;
  name: string;
  quantity: number;
  /** Line total in minor units, modifiers included. */
  totalMinor: number;
}

export interface ReturnRequestLine {
  orderItemId: string;
  quantity: number;
}

export interface PriorReturnLine {
  orderItemId: string;
  quantity: number;
}

/** How many of each line can still come back. */
export function returnableQuantities(
  items: ReturnableItem[],
  prior: PriorReturnLine[],
): Map<string, number> {
  const returned = new Map<string, number>();
  for (const p of prior) returned.set(p.orderItemId, (returned.get(p.orderItemId) ?? 0) + p.quantity);
  const out = new Map<string, number>();
  for (const it of items) out.set(it.id, Math.max(0, it.quantity - (returned.get(it.id) ?? 0)));
  return out;
}

/**
 * Price each returned line.
 *
 * A line is refunded at what the customer actually paid for it: its share of
 * the line total, scaled down by any order-level discount (a £10 basket with
 * £2 off refunds 80p for a £1 item, not £1). Delivery, service charge and
 * tips are never part of an item return.
 *
 * Throws a plain Error with a staff-readable message for an impossible
 * request; the service turns it into a 400.
 */
export function priceReturn(args: {
  items: ReturnableItem[];
  prior: PriorReturnLine[];
  request: ReturnRequestLine[];
  subtotalMinor: number;
  discountMinor: number;
}): Array<{ orderItemId: string; quantity: number; amountMinor: number }> {
  const { items, prior, request, subtotalMinor, discountMinor } = args;
  if (!request.length) throw new Error("Choose at least one item to return");
  const byId = new Map(items.map((i) => [i.id, i]));
  const left = returnableQuantities(items, prior);
  const factor =
    subtotalMinor > 0 && discountMinor > 0
      ? Math.max(0, subtotalMinor - discountMinor) / subtotalMinor
      : 1;

  const seen = new Set<string>();
  return request.map((r) => {
    const item = byId.get(r.orderItemId);
    if (!item) throw new Error("That item is not on this receipt");
    if (seen.has(r.orderItemId)) throw new Error(`${item.name} is listed twice`);
    seen.add(r.orderItemId);
    if (!Number.isInteger(r.quantity) || r.quantity < 1) {
      throw new Error(`Return at least one ${item.name}`);
    }
    const max = left.get(item.id) ?? 0;
    if (r.quantity > max) {
      throw new Error(
        max === 0
          ? `${item.name} has already been returned`
          : `Only ${max} × ${item.name} can still be returned`,
      );
    }
    const unitMinor = item.quantity > 0 ? item.totalMinor / item.quantity : 0;
    return {
      orderItemId: item.id,
      quantity: r.quantity,
      amountMinor: Math.round(unitMinor * r.quantity * factor),
    };
  });
}

// ── CSV / spreadsheet import ────────────────────────────────────────────────

export interface ImportVariantRow {
  /** 1-based row number in the sheet, header excluded — for error messages. */
  row: number;
  variantName: string;
  options: Record<string, string>;
  barcode: string | null;
  sku: string | null;
  price: number;
  costPrice: number | null;
  stock: number | null;
}

export interface ImportProduct {
  name: string;
  category: string;
  description: string | null;
  variants: ImportVariantRow[];
}

export interface ImportError {
  row: number;
  message: string;
}

// Header → field. Matched after lower-casing and stripping everything but
// letters, so "Selling Price (£)" and "selling_price" both land on price.
const HEADER_ALIASES: Record<string, string> = {
  name: "name",
  product: "name",
  productname: "name",
  item: "name",
  itemname: "name",
  title: "name",
  description: "description",
  category: "category",
  department: "category",
  section: "category",
  price: "price",
  retailprice: "price",
  sellingprice: "price",
  saleprice: "price",
  rrp: "price",
  barcode: "barcode",
  ean: "barcode",
  eancode: "barcode",
  upc: "barcode",
  gtin: "barcode",
  sku: "sku",
  plu: "sku",
  code: "sku",
  productcode: "sku",
  stock: "stock",
  qty: "stock",
  quantity: "stock",
  onhand: "stock",
  stocklevel: "stock",
  cost: "cost",
  costprice: "cost",
  variant: "variant",
  size: "size",
  colour: "colour",
  color: "colour",
};

function headerKey(h: string): string | undefined {
  return HEADER_ALIASES[h.toLowerCase().replace(/[^a-z]/g, "")];
}

/** "£1,299.50" → 1299.5. Null for blank, NaN-free otherwise. */
export function parseMoney(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[^\d.,-]/g, "").replace(/,(?=\d{3}(\D|$))/g, "");
  if (!s) return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function parseCount(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

/**
 * Turn raw spreadsheet rows into products with variants.
 *
 * Rows sharing a product name (case-insensitive) become one product with a
 * variant per row, named from the Variant column or Size / Colour. A name
 * repeated WITHOUT anything to tell the rows apart is an error rather than a
 * silent overwrite. Bad rows are reported and skipped; the rest import.
 */
export function normalizeImportRows(
  rows: Array<Record<string, unknown>>,
  opts: { defaultCategory?: string } = {},
): { products: ImportProduct[]; errors: ImportError[] } {
  const errors: ImportError[] = [];
  const products = new Map<string, ImportProduct>();
  const barcodesSeen = new Map<string, number>();

  rows.forEach((raw, idx) => {
    const row = idx + 1;
    const r: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw ?? {})) {
      const key = headerKey(k);
      if (key && (r[key] === undefined || r[key] === "")) r[key] = v;
    }
    const name = text(r.name);
    if (!name) {
      // A completely blank row (common at the bottom of a sheet) is not an error.
      if (Object.values(raw ?? {}).some((v) => text(v))) {
        errors.push({ row, message: "No product name" });
      }
      return;
    }
    const price = parseMoney(r.price);
    if (price === null || price < 0) {
      errors.push({ row, message: `${name}: price is missing or not a number` });
      return;
    }
    let barcode: string | null = null;
    if (text(r.barcode)) {
      barcode = normalizeBarcode(r.barcode);
      if (!barcode) {
        errors.push({
          row,
          message: `${name}: barcode "${text(r.barcode)}" is not valid — format the column as Text so the spreadsheet keeps every digit`,
        });
        return;
      }
      const first = barcodesSeen.get(barcode);
      if (first) {
        errors.push({ row, message: `${name}: barcode ${barcode} is already used on row ${first}` });
        return;
      }
      barcodesSeen.set(barcode, row);
    }

    const size = text(r.size);
    const colour = text(r.colour);
    const options: Record<string, string> = {};
    if (size) options.size = size;
    if (colour) options.colour = colour;
    const variantName = text(r.variant) || [size, colour].filter(Boolean).join(" / ") || "Default";

    const key = name.toLowerCase();
    let product = products.get(key);
    if (!product) {
      product = {
        name,
        category: text(r.category) || opts.defaultCategory || "Products",
        description: text(r.description) || null,
        variants: [],
      };
      products.set(key, product);
    }
    if (product.variants.some((v) => v.variantName.toLowerCase() === variantName.toLowerCase())) {
      errors.push({
        row,
        message:
          variantName === "Default"
            ? `${name} appears more than once — add a Size, Colour or Variant column to tell the rows apart`
            : `${name} (${variantName}) appears more than once`,
      });
      return;
    }
    const cost = parseMoney(r.cost);
    product.variants.push({
      row,
      variantName,
      options,
      barcode,
      sku: text(r.sku) || null,
      price,
      costPrice: cost !== null && cost >= 0 ? cost : null,
      stock: parseCount(r.stock),
    });
  });

  return { products: [...products.values()], errors };
}

/** Minor units → a 2dp decimal string for Prisma Decimal columns. */
export const toMajor = (minor: number) => (minor / 100).toFixed(2);
export const toMinor = (major: unknown) => Math.round(Number(major ?? 0) * 100);

// ── Online grocery: substitutions and picking (R3) ─────────────────────────

/** What the customer asked for if a line is out of stock at picking time. */
export const SUBSTITUTION_PREFS = ["BEST_MATCH", "NONE"] as const;
export type SubstitutionPref = (typeof SUBSTITUTION_PREFS)[number];

export function parseSubstitutionPref(v: unknown): SubstitutionPref | undefined {
  return typeof v === "string" && (SUBSTITUTION_PREFS as readonly string[]).includes(v)
    ? (v as SubstitutionPref)
    : undefined;
}

/**
 * A line's picking state, kept in OrderItem.metadata.pick. `picked` of the
 * ordered quantity came off the shelf; `sub` replaced some of the rest with
 * another product. Whatever is left is missing.
 */
export interface PickState {
  picked: number;
  sub?: { variantId?: string | null; menuItemId?: string | null; name: string; qty: number; unitPrice: number } | null;
}

export interface PickLine {
  id: string;
  name: string;
  quantity: number;
  /** Line total in minor units, as ordered. */
  totalMinor: number;
  pick?: PickState | null;
}

/** Validate a pick update against the ordered quantity; throws a staff-readable Error. */
export function normalizePick(line: { name: string; quantity: number }, pick: PickState): PickState {
  const picked = Math.trunc(Number(pick.picked));
  if (!Number.isFinite(picked) || picked < 0 || picked > line.quantity) {
    throw new Error(`Picked must be between 0 and ${line.quantity} for ${line.name}`);
  }
  if (!pick.sub) return { picked, sub: null };
  const qty = Math.trunc(Number(pick.sub.qty));
  if (!Number.isFinite(qty) || qty < 1) throw new Error("A substitute needs a quantity of at least 1");
  if (picked + qty > line.quantity) {
    throw new Error(`Only ${line.quantity - picked} × ${line.name} can be substituted`);
  }
  const unitPrice = Number(pick.sub.unitPrice);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error("The substitute needs a price");
  const name = String(pick.sub.name ?? "").trim();
  if (!name) throw new Error("Name the substitute");
  return {
    picked,
    sub: {
      variantId: pick.sub.variantId ?? null,
      menuItemId: pick.sub.menuItemId ?? null,
      name,
      qty,
      unitPrice: Math.round(unitPrice * 100) / 100,
    },
  };
}

/**
 * What goes back to the customer once picking is done.
 *
 * Each unit is worth what they actually paid for it (its share of the line,
 * scaled by any order discount — the same rule as a till return). A missing
 * unit is refunded in full. A substituted unit is charged at the cheaper of
 * the two prices, never more: a customer who asked for a £1 own-brand and got
 * a £1.40 branded one is not asked for 40p, and gets the difference back if
 * the substitute is cheaper. A line never touched counts as all missing.
 */
export function priceShortfall(args: {
  lines: PickLine[];
  subtotalMinor: number;
  discountMinor: number;
}): {
  refundMinor: number;
  lines: Array<{ id: string; missing: number; substituted: number; refundMinor: number }>;
} {
  const factor =
    args.subtotalMinor > 0 && args.discountMinor > 0
      ? Math.max(0, args.subtotalMinor - args.discountMinor) / args.subtotalMinor
      : 1;
  const out = args.lines.map((l) => {
    const picked = Math.min(l.quantity, Math.max(0, l.pick?.picked ?? 0));
    const subQty = Math.min(l.quantity - picked, Math.max(0, l.pick?.sub?.qty ?? 0));
    const missing = l.quantity - picked - subQty;
    const unitPaid = l.quantity > 0 ? (l.totalMinor / l.quantity) * factor : 0;
    const subUnit = Math.round((l.pick?.sub?.unitPrice ?? 0) * 100) * factor;
    const refund = missing * unitPaid + subQty * Math.max(0, unitPaid - subUnit);
    return { id: l.id, missing, substituted: subQty, refundMinor: Math.round(refund) };
  });
  return { refundMinor: out.reduce((s, l) => s + l.refundMinor, 0), lines: out };
}
