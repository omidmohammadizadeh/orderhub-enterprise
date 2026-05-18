// ESC/POS command constants
const ESC = "\x1B";
const GS = "\x1D";
const LF = "\x0A";
const NUL = "\x00";

export const ESCPOS = {
  INIT: ESC + "@",
  BOLD_ON: ESC + "E\x01",
  BOLD_OFF: ESC + "E\x00",
  ALIGN_LEFT: ESC + "a\x00",
  ALIGN_CENTER: ESC + "a\x01",
  ALIGN_RIGHT: ESC + "a\x02",
  FONT_SIZE_NORMAL: GS + "!\x00",
  FONT_SIZE_DOUBLE_HEIGHT: GS + "!\x01",
  FONT_SIZE_DOUBLE_WIDTH: GS + "!\x10",
  FONT_SIZE_DOUBLE: GS + "!\x11",
  CUT_PARTIAL: GS + "V\x01",
  CUT_FULL: GS + "V\x00",
  CASH_DRAWER: ESC + "p\x00\x19\xFA",
  LINE_FEED: LF,
} as const;

export interface PrintLine {
  text: string;
  bold?: boolean;
  align?: "left" | "center" | "right";
  size?: "normal" | "double-height" | "double-width" | "double";
  linesBefore?: number;
  linesAfter?: number;
}

export interface PrintDocument {
  lines: PrintLine[];
  cut?: boolean;
  openDrawer?: boolean;
}

export function renderEscPos(doc: PrintDocument): string {
  let out = ESCPOS.INIT;

  for (const line of doc.lines) {
    if (line.linesBefore) {
      out += ESCPOS.LINE_FEED.repeat(line.linesBefore);
    }

    // Alignment
    if (line.align === "center") out += ESCPOS.ALIGN_CENTER;
    else if (line.align === "right") out += ESCPOS.ALIGN_RIGHT;
    else out += ESCPOS.ALIGN_LEFT;

    // Size
    if (line.size === "double") out += ESCPOS.FONT_SIZE_DOUBLE;
    else if (line.size === "double-height") out += ESCPOS.FONT_SIZE_DOUBLE_HEIGHT;
    else if (line.size === "double-width") out += ESCPOS.FONT_SIZE_DOUBLE_WIDTH;
    else out += ESCPOS.FONT_SIZE_NORMAL;

    // Bold
    if (line.bold) out += ESCPOS.BOLD_ON;

    out += line.text + ESCPOS.LINE_FEED;

    if (line.bold) out += ESCPOS.BOLD_OFF;
    out += ESCPOS.FONT_SIZE_NORMAL;
    out += ESCPOS.ALIGN_LEFT;

    if (line.linesAfter) {
      out += ESCPOS.LINE_FEED.repeat(line.linesAfter);
    }
  }

  if (doc.openDrawer) out += ESCPOS.CASH_DRAWER;
  if (doc.cut !== false) out += ESCPOS.CUT_PARTIAL;

  return out;
}

// ── High-level document builders ──────────────────────────────────────────────

export interface OrderPrintData {
  displayId?: string;
  platform: string;
  orderSource: string;
  fulfillmentType: string;
  customerName: string;
  customerPhone?: string;
  deliveryAddress?: { line1: string; city: string; postcode: string };
  items: Array<{
    quantity: number;
    name: string;
    unitPrice: number;
    totalPrice: number;
    notes?: string;
    modifiers?: Array<{ name: string; price: number }>;
  }>;
  subtotal: number;
  deliveryFee?: number;
  taxAmount?: number;
  discount?: number;
  total: number;
  specialInstructions?: string;
  receivedAt: Date;
  locationName: string;
}

function ruler(char = "-", width = 42): string {
  return char.repeat(width);
}

function padded(left: string, right: string, width = 42): string {
  const gap = width - left.length - right.length;
  return left + " ".repeat(Math.max(1, gap)) + right;
}

function formatPrice(p: number): string {
  return `£${p.toFixed(2)}`;
}

export function buildReceiptDocument(order: OrderPrintData): PrintDocument {
  const lines: PrintLine[] = [];

  // Header
  lines.push({ text: order.locationName, align: "center", bold: true, size: "double-height", linesBefore: 1 });
  lines.push({ text: "ORDER RECEIPT", align: "center" });
  lines.push({ text: ruler(), linesAfter: 0 });

  // Order info
  const orderNum = order.displayId ?? "—";
  lines.push({ text: `Order #${orderNum}`, bold: true, size: "double-height", align: "center", linesBefore: 1 });
  lines.push({ text: order.platform.replace("_", " "), align: "center" });
  lines.push({ text: order.fulfillmentType.replace("_", " "), align: "center", linesAfter: 1 });

  // Customer
  lines.push({ text: ruler() });
  lines.push({ text: `CUSTOMER: ${order.customerName}`, bold: true });
  if (order.customerPhone) lines.push({ text: `PHONE: ${order.customerPhone}` });
  if (order.fulfillmentType === "DELIVERY" && order.deliveryAddress) {
    lines.push({ text: `DELIVER TO:`, bold: true });
    lines.push({ text: `  ${order.deliveryAddress.line1}` });
    lines.push({ text: `  ${order.deliveryAddress.city} ${order.deliveryAddress.postcode}` });
  }
  lines.push({ text: ruler() });

  // Items
  for (const item of order.items) {
    lines.push({ text: padded(`${item.quantity}x ${item.name}`, formatPrice(item.totalPrice)), bold: true });
    if (item.modifiers?.length) {
      for (const mod of item.modifiers) {
        lines.push({ text: `  + ${mod.name}${mod.price > 0 ? ` (${formatPrice(mod.price)})` : ""}` });
      }
    }
    if (item.notes) lines.push({ text: `  Note: ${item.notes}` });
  }
  lines.push({ text: ruler() });

  // Totals
  lines.push({ text: padded("Subtotal", formatPrice(order.subtotal)) });
  if ((order.deliveryFee ?? 0) > 0) lines.push({ text: padded("Delivery", formatPrice(order.deliveryFee!)) });
  if ((order.taxAmount ?? 0) > 0) lines.push({ text: padded("Tax", formatPrice(order.taxAmount!)) });
  if ((order.discount ?? 0) > 0) lines.push({ text: padded("Discount", `-${formatPrice(order.discount!)}`) });
  lines.push({ text: ruler() });
  lines.push({ text: padded("TOTAL", formatPrice(order.total)), bold: true, size: "double-height" });
  lines.push({ text: ruler() });

  // Special instructions
  if (order.specialInstructions) {
    lines.push({ text: "SPECIAL INSTRUCTIONS:", bold: true });
    lines.push({ text: order.specialInstructions });
    lines.push({ text: ruler() });
  }

  // Footer
  const time = new Date(order.receivedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  lines.push({ text: time, align: "center", linesAfter: 1 });
  lines.push({ text: "Powered by OrderHub", align: "center", linesAfter: 2 });

  return { lines, cut: true };
}

export function buildKitchenTicketDocument(order: OrderPrintData): PrintDocument {
  const lines: PrintLine[] = [];

  // Header — large and readable from a distance
  lines.push({ text: "KITCHEN TICKET", align: "center", bold: true, size: "double", linesBefore: 1 });
  lines.push({ text: `#${order.displayId ?? "—"}`, align: "center", bold: true, size: "double", linesAfter: 1 });
  lines.push({ text: order.fulfillmentType.replace("_", " "), align: "center", bold: true });
  lines.push({ text: order.customerName, align: "center" });
  lines.push({ text: ruler() });

  // Items only — no prices on kitchen ticket
  for (const item of order.items) {
    lines.push({ text: `${item.quantity}x  ${item.name.toUpperCase()}`, bold: true, size: "double-height" });
    if (item.modifiers?.length) {
      for (const mod of item.modifiers) {
        lines.push({ text: `    + ${mod.name}` });
      }
    }
    if (item.notes) {
      lines.push({ text: `    *** ${item.notes} ***`, bold: true });
    }
    lines.push({ text: "" });
  }

  lines.push({ text: ruler() });

  if (order.specialInstructions) {
    lines.push({ text: "NOTE:", bold: true });
    lines.push({ text: order.specialInstructions, bold: true });
    lines.push({ text: ruler() });
  }

  const time = new Date(order.receivedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  lines.push({ text: time, align: "center", linesAfter: 2 });

  return { lines, cut: true };
}
