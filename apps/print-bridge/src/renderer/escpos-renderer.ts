// Phase AS-2 — ESC/POS renderer (server-side, transport-agnostic input).
//
// The DB stores PrintJob.payload as structured JSON — never raw bytes.
// This renderer is one of many possible adapters; the Flutter app, the
// macOS bridge, and the future cloud-print service all implement the
// same JSON → transport translation. Keeping the spec JSON-shaped is
// what makes "one API for every client" possible.
//
// The ESC/POS dialect targeted here is the subset that works across
// Epson TM-m30, Star TSP100/143, Sunmi, XPrinter, and generic 80mm
// thermal printers. We deliberately don't use vendor-specific extras
// — no Star-only commands, no logo download. The bridge / Flutter
// app can layer those on if needed (printer.model can be checked).

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

// Command builders → number arrays so they concat cleanly.
const init = () => [ESC, 0x40];
const alignLeft = () => [ESC, 0x61, 0x00];
const alignCenter = () => [ESC, 0x61, 0x01];
const alignRight = () => [ESC, 0x61, 0x02];
const boldOn = () => [ESC, 0x45, 0x01];
const boldOff = () => [ESC, 0x45, 0x00];
const doubleSizeOn = () => [GS, 0x21, 0x11];
const doubleSizeOff = () => [GS, 0x21, 0x00];
const cut = () => [GS, 0x56, 0x42, 0x00]; // partial cut
const openCashDrawer = () => [ESC, 0x70, 0x00, 0x40, 0xc8]; // kick pin 2

// QR code: model 2, error correction L, module size 6.
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

// Pad a string to `width` chars with spaces. ESC/POS thermal printers
// are monospace, so column math just works.
function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}
function padRight(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return " ".repeat(width - s.length) + s;
}

function colsForWidth(paperWidth: number): number {
  // 80mm ≈ 42 cols at font A, 58mm ≈ 32 cols.
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

  // Test print has its own shape — handle first.
  if (payload?.kind === "TEST_PRINT") {
    return renderTestPrint(payload, opts);
  }

  // Header.
  out.push(...alignCenter(), ...boldOn(), ...doubleSizeOn());
  write(payload.orderNumber ? `#${payload.orderNumber}` : "ORDER");
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

  // Items.
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

  // Totals (only on receipts).
  if (typeof payload.total === "number") {
    if (payload.subtotal !== undefined) {
      write(pad("Subtotal", width - 10) + padRight(payload.subtotal.toFixed(2), 10));
      newline();
    }
    if (payload.delivery > 0) {
      write(pad("Delivery", width - 10) + padRight(payload.delivery.toFixed(2), 10));
      newline();
    }
    if (payload.discount > 0) {
      write(pad("Discount", width - 10) + padRight((-payload.discount).toFixed(2), 10));
      newline();
    }
    if (payload.tax > 0) {
      write(pad("Tax", width - 10) + padRight(payload.tax.toFixed(2), 10));
      newline();
    }
    out.push(...boldOn());
    write(pad("TOTAL", width - 10) + padRight(payload.total.toFixed(2), 10));
    newline();
    out.push(...boldOff());
  }

  // Delivery address (driver slip).
  if (payload.address) {
    hr();
    out.push(...boldOn());
    write("DELIVER TO");
    newline();
    out.push(...boldOff());
    if (payload.customerPhone) {
      write(payload.customerPhone);
      newline();
    }
    if (payload.address.line1) {
      write(payload.address.line1);
      newline();
    }
    if (payload.address.line2) {
      write(payload.address.line2);
      newline();
    }
    if (payload.address.city || payload.address.postcode) {
      write(
        [payload.address.city, payload.address.postcode]
          .filter(Boolean)
          .join(", "),
      );
      newline();
    }
  }

  // Payment status footer.
  if (payload.paymentMethod) {
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
