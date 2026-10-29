// What a printer puts on its ticket, and how big.
//
// Both live on `printer.defaults` so they travel with the printer and reach
// every render path through printerRenderOptions:
//   ticketHide  — keys of TICKET_FIELDS this printer leaves off
//   itemSize    — 1–30, item headline size (10 = the printer's own font)
//   modifierSize— 1–30, options/extras size
//
// Banners (ORDER CANCELLED, ORDER UPDATED, SCHEDULED) and the item lines
// themselves are not in the list on purpose: a ticket that hides "this order
// was cancelled" or the food itself is a remake or a refund waiting to happen.

export type TicketFieldKey =
  | "brandName"
  | "locationAddress"
  | "locationPhone"
  | "customerVisitTag"
  | "orderNumber"
  | "receivedAt"
  | "channel"
  | "orderType"
  | "table"
  | "readyTime"
  | "customerName"
  | "customerPhone"
  | "deliveryAddress"
  | "itemPrices"
  | "modifiers"
  | "modifierPrices"
  | "itemNotes"
  | "itemSeparators"
  | "subtotal"
  | "deliveryFee"
  | "tip"
  | "serviceCharge"
  | "tax"
  | "discount"
  | "total"
  | "payment"
  | "specialInstructions";

export const TICKET_FIELD_GROUPS: ReadonlyArray<{
  title: string;
  fields: ReadonlyArray<readonly [TicketFieldKey, string]>;
}> = [
  {
    title: "Header",
    fields: [
      ["brandName", "Shop / brand name"],
      ["locationAddress", "Shop address"],
      ["locationPhone", "Shop phone"],
    ],
  },
  {
    title: "Order",
    fields: [
      ["orderNumber", "Order number"],
      ["receivedAt", "Date and time received"],
      ["customerVisitTag", "Returning-customer banner"],
      ["channel", "Channel (Just Eat, Uber…)"],
      ["orderType", "Order type (delivery / collection)"],
      ["table", "Table"],
      ["readyTime", "Deliver / collect time"],
    ],
  },
  {
    title: "Customer",
    fields: [
      ["customerName", "Customer name"],
      ["customerPhone", "Customer phone"],
      ["deliveryAddress", "Delivery address"],
    ],
  },
  {
    title: "Items",
    fields: [
      ["itemPrices", "Item prices"],
      ["modifiers", "Options / extras"],
      ["modifierPrices", "Option prices"],
      ["itemNotes", "Item notes"],
      ["itemSeparators", "Dashed line between items"],
    ],
  },
  {
    title: "Totals",
    fields: [
      ["subtotal", "Subtotal"],
      ["deliveryFee", "Delivery fee"],
      ["tip", "Tip"],
      ["serviceCharge", "Service charge"],
      ["tax", "Tax"],
      ["discount", "Discount"],
      ["total", "Total"],
    ],
  },
  {
    title: "Footer",
    fields: [
      ["payment", "Payment (paid / cash due)"],
      ["specialInstructions", "Special instructions"],
    ],
  },
];

const ALL_KEYS = new Set<string>(
  TICKET_FIELD_GROUPS.flatMap((g) => g.fields.map(([k]) => k)),
);

/** Fields this printer hides. Unknown keys are dropped so a stale save can't hide something new. */
export function readTicketHide(printer: any): Set<TicketFieldKey> {
  const raw = printer?.defaults?.ticketHide;
  const list = Array.isArray(raw) ? raw : [];
  return new Set(list.filter((k): k is TicketFieldKey => ALL_KEYS.has(String(k))));
}

export const TEXT_SIZE_MIN = 1;
export const TEXT_SIZE_MAX = 30;
/** The printer's own font — plain text, no image. */
export const TEXT_SIZE_NATIVE = 10;

/** A saved 1–30 size, or null when the printer still uses the old Standard/Large/XL presets. */
export function readTextSize(v: unknown): number | null {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < TEXT_SIZE_MIN) return null;
  return Math.min(TEXT_SIZE_MAX, n);
}

/**
 * Pixel height for a 1–30 size. Linear from the printer's own font: Font A is
 * 24 dots tall, so 10 → 24 (same as the text font), 20 → 48 (double height),
 * 30 → 72. Below ~10px a thermal head can't draw legible glyphs, so the
 * smallest sizes bottom out there.
 */
export function textSizeToPx(size: number): number {
  return Math.max(10, Math.round(size * 2.4));
}

/** The nearest built-in height multiplier, for printers that can't print images (Star). */
export function textSizeToMultiplier(size: number): number {
  return Math.max(1, Math.min(4, Math.round(size / TEXT_SIZE_NATIVE)));
}
