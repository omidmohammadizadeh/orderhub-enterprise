// Phase AS-2 — ESC/POS renderer (server-side, transport-agnostic input).
//
// NOTE: this file MUST stay byte-identical (modulo TypeScript syntax) to
// apps/print-bridge/src/renderer/escpos-renderer.ts. They render the
// same PrintJob payload — one from inside the API (ServerDirectPrintCron
// hot path for LAN printers without a paired agent), one from the
// installed Print Bridge. When the two diverged, the same job rendered
// from each side produced visibly different tickets, which looked to
// operators like "two copies, one is wrong." If you change one, change
// both.

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const init = () => [ESC, 0x40];
const alignLeft = () => [ESC, 0x61, 0x00];
const alignCenter = () => [ESC, 0x61, 0x01];
const boldOn = () => [ESC, 0x45, 0x01];
const boldOff = () => [ESC, 0x45, 0x00];
const doubleSizeOn = () => [GS, 0x21, 0x11];
const doubleSizeOff = () => [GS, 0x21, 0x00];
const cut = () => [GS, 0x56, 0x42, 0x00];
const openCashDrawer = () => [ESC, 0x70, 0x00, 0x40, 0xc8];

function qrCode(text: string): number[] {
  const data = Buffer.from(text, "utf8");
  const length = data.length + 3;
  const pl = length & 0xff;
  const ph = (length >> 8) & 0xff;
  return [
    GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00,
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06,
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x30,
    GS, 0x28, 0x6b, pl, ph, 0x31, 0x50, 0x30,
    ...data,
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30,
  ];
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}
function padRight(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return " ".repeat(width - s.length) + s;
}

function colsForWidth(paperWidth: number): number {
  return paperWidth === 58 ? 32 : 42;
}

export interface RenderOptions {
  paperWidth: 58 | 80;
  openCashDrawer?: boolean;
  printLogo?: boolean;
}

export function renderToEscPos(
  payload: any,
  opts: RenderOptions,
): Buffer {
  const width = colsForWidth(opts.paperWidth);
  const out: number[] = [];
  const write = (s: string) => out.push(...Buffer.from(s, "utf8"));
  const newline = () => out.push(LF);
  const hr = () => {
    write("-".repeat(width));
    newline();
  };

  out.push(...init());

  if (payload?.kind === "TEST_PRINT") {
    return renderTestPrint(payload, opts);
  }

  const shopTitle = payload.locationName ?? payload.brandName ?? null;
  const showBrandSubtitle =
    payload.brandName &&
    payload.locationName &&
    payload.brandName !== payload.locationName &&
    !payload.locationName
      .toLowerCase()
      .includes(String(payload.brandName).toLowerCase());

  out.push(...alignCenter());
  if (shopTitle) {
    out.push(...boldOn(), ...doubleSizeOn());
    write(String(shopTitle));
    newline();
    out.push(...doubleSizeOff(), ...boldOff());
  }
  if (showBrandSubtitle) {
    write(`by ${payload.brandName}`);
    newline();
  }
  if (payload.locationAddress) {
    write(String(payload.locationAddress));
    newline();
  }
  if (payload.locationPhone) {
    write(`Tel: ${payload.locationPhone}`);
    newline();
  }
  out.push(...alignLeft());
  if (shopTitle || payload.locationAddress) {
    hr();
  }

  const sourceLabel = friendlySource(payload.orderSource, payload.platform);
  if (sourceLabel) {
    out.push(...alignCenter(), ...boldOn());
    write(sourceLabel);
    newline();
    out.push(...boldOff(), ...alignLeft());
  }

  const orderRef =
    payload.orderNumber ?? payload.displayId ?? payload.orderId ?? null;
  out.push(...alignCenter(), ...boldOn(), ...doubleSizeOn());
  write(orderRef ? `#${orderRef}` : "ORDER");
  newline();
  out.push(...doubleSizeOff(), ...boldOff(), ...alignLeft());

  if (payload.customerName) {
    write(`Customer: ${payload.customerName}`);
    newline();
  }
  if (payload.fulfillmentType) {
    write(`Type: ${payload.fulfillmentType}`);
    newline();
  }
  if (payload.receivedAt) {
    const dt = new Date(payload.receivedAt).toLocaleString("en-GB");
    write(dt);
    newline();
  }
  if (payload.stationName) {
    write(`Station: ${payload.stationName}`);
    newline();
  }
  hr();

  for (const it of payload.items ?? []) {
    out.push(...boldOn());
    write(`${it.quantity}x ${it.name}`);
    newline();
    out.push(...boldOff());
    for (const m of it.modifiers ?? []) {
      write(`  + ${m.name}`);
      newline();
    }
    if (it.notes) {
      write(`  Note: ${it.notes}`);
      newline();
    }
  }
  hr();

  if (typeof payload.total === "number") {
    if (payload.subtotal !== undefined) {
      write(pad("Subtotal", width - 10) + padRight(Number(payload.subtotal).toFixed(2), 10));
      newline();
    }
    if (Number(payload.deliveryFee ?? payload.delivery ?? 0) > 0) {
      const fee = Number(payload.deliveryFee ?? payload.delivery);
      write(pad("Delivery fee", width - 10) + padRight(fee.toFixed(2), 10));
      newline();
    }
    if (Number(payload.discount ?? 0) > 0) {
      write(pad("Discount", width - 10) + padRight((-Number(payload.discount)).toFixed(2), 10));
      newline();
    }
    if (Number(payload.taxAmount ?? payload.tax ?? 0) > 0) {
      const tax = Number(payload.taxAmount ?? payload.tax);
      write(pad("Tax", width - 10) + padRight(tax.toFixed(2), 10));
      newline();
    }
    out.push(...boldOn());
    write(pad("TOTAL", width - 10) + padRight(Number(payload.total).toFixed(2), 10));
    newline();
    out.push(...boldOff());
  }

  const addressString =
    typeof payload.deliveryAddress === "string"
      ? payload.deliveryAddress
      : null;
  const addressObject =
    payload.address && typeof payload.address === "object"
      ? payload.address
      : null;
  if (payload.customerPhone || addressString || addressObject) {
    hr();
    out.push(...boldOn());
    write(payload.fulfillmentType === "DELIVERY" ? "DELIVER TO" : "CUSTOMER");
    newline();
    out.push(...boldOff());
    if (payload.customerName) {
      write(payload.customerName);
      newline();
    }
    if (payload.customerPhone) {
      write(payload.customerPhone);
      newline();
    }
    if (addressString) {
      write(addressString);
      newline();
    } else if (addressObject) {
      if (addressObject.line1) {
        write(addressObject.line1);
        newline();
      }
      if (addressObject.line2) {
        write(addressObject.line2);
        newline();
      }
      const cityLine = [addressObject.city, addressObject.postcode]
        .filter(Boolean)
        .join(", ");
      if (cityLine) {
        write(cityLine);
        newline();
      }
    }
  }

  if (payload.specialInstructions) {
    hr();
    out.push(...boldOn());
    write("NOTE");
    newline();
    out.push(...boldOff());
    write(String(payload.specialInstructions));
    newline();
  }

  if (payload.paymentLabel) {
    hr();
    out.push(...alignCenter(), ...boldOn());
    write(String(payload.paymentLabel));
    newline();
    out.push(...boldOff(), ...alignLeft());
  } else if (payload.paymentMethod) {
    hr();
    write(`Payment: ${payload.paymentMethod} (${payload.paymentStatus ?? ""})`);
    newline();
  }

  newline();
  newline();
  newline();
  out.push(...cut());
  if (opts.openCashDrawer) out.push(...openCashDrawer());

  return Buffer.from(out);
}

function friendlySource(
  source: string | null | undefined,
  platform: string | null | undefined,
): string | null {
  const s = source ?? platform;
  if (!s) return null;
  const map: Record<string, string> = {
    DIRECT: "DIRECT ONLINE ORDER",
    POS: "POS",
    PLATFORM: "MARKETPLACE",
    UBER_EATS: "UBER EATS",
    DELIVEROO: "DELIVEROO",
    JUST_EAT: "JUST EAT",
  };
  return map[s] ?? s.replace(/_/g, " ");
}

function renderTestPrint(payload: any, opts: RenderOptions): Buffer {
  const width = colsForWidth(opts.paperWidth);
  const out: number[] = [];
  const write = (s: string) => out.push(...Buffer.from(s, "utf8"));
  const newline = () => out.push(LF);
  const hr = () => {
    write("-".repeat(width));
    newline();
  };

  out.push(...init(), ...alignCenter(), ...boldOn(), ...doubleSizeOn());
  write("ORDER HUB");
  newline();
  out.push(...doubleSizeOff(), ...boldOff());
  write("TEST PRINT");
  newline();
  hr();
  out.push(...alignLeft());
  if (payload.printerName) {
    write(`Printer: ${payload.printerName}`);
    newline();
  }
  if (payload.locationName) {
    write(`Location: ${payload.locationName}`);
    newline();
  }
  if (payload.locationAddress) {
    write(payload.locationAddress);
    newline();
  }
  if (payload.datetime) {
    write(new Date(payload.datetime).toLocaleString("en-GB"));
    newline();
  }
  hr();
  if (payload.message) {
    write(payload.message);
    newline();
    hr();
  }
  if (payload.qrCode) {
    out.push(...alignCenter(), ...qrCode(payload.qrCode));
    newline();
    out.push(...alignLeft());
  }
  newline();
  newline();
  out.push(...cut());
  if (payload.openCashDrawer) out.push(...openCashDrawer());
  return Buffer.from(out);
}
