// Weighed products — loose fruit and veg, deli counters, pick-and-mix.
//
// A product sold by weight carries MenuItem.sellBy ("KG" or "100G") and its
// basePrice is the price per that unit. An order line for one keeps its
// quantity (packs) and adds a weight in grams; the line's unit price is the
// price of one pack of that weight. Stock for a weighed product is in grams.
//
// Shop label scales print EAN-13 barcodes starting with "2" that carry the
// product's scale code and either the price or the weight. The layout varies
// by scale, so a shop picks one of SCALE_FORMATS.

export const SELL_BY = ["KG", "100G"] as const;
export type SellBy = (typeof SELL_BY)[number];

export function normaliseSellBy(v: unknown): SellBy | null {
  return (SELL_BY as readonly string[]).includes(String(v)) ? (v as SellBy) : null;
}

export function gramsPerUnit(sellBy: SellBy): number {
  return sellBy === "KG" ? 1000 : 100;
}

/** "/kg" or "/100g" — for "£1.10/kg". */
export function sellByLabel(sellBy: SellBy): string {
  return sellBy === "KG" ? "/kg" : "/100g";
}

/** Price of `grams` of a product priced `unitPrice` per kg / per 100 g. */
export function priceForWeight(unitPrice: number, sellBy: SellBy, grams: number): number {
  return Math.round((Number(unitPrice) * Number(grams) * 100) / gramsPerUnit(sellBy)) / 100;
}

/** 642 → "642 g", 1250 → "1.25 kg". */
export function formatWeight(grams: number): string {
  const g = Math.round(Number(grams));
  if (g < 1000) return `${g} g`;
  return `${(g / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")} kg`;
}

/** Limits on a weighed line — a slipped finger shouldn't ring up 64 kg of bananas. */
export const MIN_WEIGHT_GRAMS = 5;
export const MAX_WEIGHT_GRAMS = 25_000;

export function isValidWeight(grams: unknown): grams is number {
  const g = Number(grams);
  return Number.isInteger(g) && g >= MIN_WEIGHT_GRAMS && g <= MAX_WEIGHT_GRAMS;
}

/** The amounts a shopper can choose online. */
export function onlineWeightOptions(sellBy: SellBy): number[] {
  return sellBy === "KG"
    ? [250, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000]
    : [100, 150, 200, 250, 300, 400, 500, 750, 1000];
}

/** An online weight must be one of the offered amounts. */
export function isOnlineWeight(sellBy: SellBy, grams: unknown): boolean {
  return onlineWeightOptions(sellBy).includes(Number(grams));
}

// ── Scale label barcodes ───────────────────────────────────────────────────

export type ScaleFormatId = "PRICE_5" | "WEIGHT_5" | "PRICE_4_CHECK" | "WEIGHT_4_CHECK";

export const SCALE_FORMATS: ReadonlyArray<{ id: ScaleFormatId; label: string; example: string }> = [
  { id: "PRICE_5", label: "Price in the barcode (5 digits)", example: "2 X CCCCC PPPPP K" },
  { id: "WEIGHT_5", label: "Weight in the barcode (5 digits, grams)", example: "2 X CCCCC WWWWW K" },
  { id: "PRICE_4_CHECK", label: "Price with a price check digit (4 digits)", example: "2 X CCCCC V PPPP K" },
  { id: "WEIGHT_4_CHECK", label: "Weight with a check digit (4 digits, grams)", example: "2 X CCCCC V WWWW K" },
];

export function normaliseScaleFormat(v: unknown): ScaleFormatId {
  return SCALE_FORMATS.some((f) => f.id === v) ? (v as ScaleFormatId) : "PRICE_5";
}

function ean13CheckOk(code: string): boolean {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

export interface ScaleLabel {
  /** The scale code, leading zeros removed. */
  itemCode: string;
  /** Price-embedded labels. */
  price?: number;
  /** Weight-embedded labels. */
  grams?: number;
}

/**
 * Read a label-scale barcode, or null when `code` isn't one: 13 digits,
 * starting with 2, valid check digit. Digit 2 (a flag some scales use) is
 * ignored; digits 3–7 are the item's scale code.
 */
export function parseScaleBarcode(code: string, format: ScaleFormatId): ScaleLabel | null {
  const c = String(code ?? "").trim();
  if (!/^2\d{12}$/.test(c) || !ean13CheckOk(c)) return null;
  const itemCode = c.slice(2, 7).replace(/^0+/, "") || "0";
  const value = Number(format.endsWith("_CHECK") ? c.slice(8, 12) : c.slice(7, 12));
  if (!Number.isFinite(value) || value <= 0) return null;
  return format.startsWith("PRICE") ? { itemCode, price: value / 100 } : { itemCode, grams: value };
}

/**
 * The barcode a label scale would print, in this shop's layout — for test
 * labels. The inverse of parseScaleBarcode. Null when the value doesn't fit.
 */
export function buildScaleBarcode(
  itemCode: string,
  format: ScaleFormatId,
  value: { price?: number; grams?: number },
): string | null {
  const code = String(itemCode ?? "").replace(/\D/g, "");
  if (!code || code.length > 5) return null;
  const raw = format.startsWith("PRICE") ? Math.round(Number(value.price ?? 0) * 100) : Math.round(Number(value.grams ?? 0));
  const width = format.endsWith("_CHECK") ? 4 : 5;
  if (!(raw > 0) || String(raw).length > width) return null;
  // The price check digit some scales print isn't read back; 0 keeps it valid.
  const twelve = `20${code.padStart(5, "0")}${format.endsWith("_CHECK") ? "0" : ""}${String(raw).padStart(width, "0")}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
  return twelve + String((10 - (sum % 10)) % 10);
}

/** Scale codes compare as numbers: "00412" and "412" are the same product. */
export function sameScaleCode(a: unknown, b: unknown): boolean {
  const n = (v: unknown) => String(v ?? "").trim().replace(/^0+/, "");
  return !!n(a) && n(a) === n(b);
}

/** "Bananas — 642 g @ £1.10/kg": what the ticket, receipt and picker read. */
export function weighedLineName(name: string, grams: number, unitPrice: number, sellBy: SellBy, symbol = "£"): string {
  return `${name} — ${formatWeight(grams)} @ ${symbol}${Number(unitPrice).toFixed(2)}${sellByLabel(sellBy)}`;
}
