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
// Phase AW-30 — reverse video (white on black). Used to highlight the
// returning-customer banner so the counter staff can't miss it.
const reverseOn = () => [GS, 0x42, 0x01];
const reverseOff = () => [GS, 0x42, 0x00];
const cut = () => [GS, 0x56, 0x42, 0x00]; // partial cut
const openCashDrawer = () => [ESC, 0x70, 0x00, 0x40, 0xc8]; // kick pin 2

// QR code: model 2, error correction L, module size 6.

/**
 * Indent for a nested modifier line. A modifier group can hang off an option
 * ("Make It a Meal" → "Choose Side" → "Fries" → a dip), and without the indent
 * the ticket reads as four separate things the kitchen owes rather than one
 * meal. Absent depth = a flat selection, which is every order line placed
 * before nested groups existed.
 *
 * Duplicated rather than imported: this file is twinned with the Print Bridge
 * copy, which has no dependency on @orderhub/shared. Keep the two identical.
 */
function modifierIndent(m: { depth?: number | null }): string {
  const d = Number(m?.depth ?? 0);
  if (!Number.isFinite(d) || d <= 0) return "";
  return "  ".repeat(Math.min(Math.trunc(d), 3));
}

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

/**
 * Centre `s` inside `width` columns, padded with spaces on BOTH sides.
 *
 * Used for the reverse-video payment band: `alignCenter` would centre the
 * printed glyphs but leave the highlight hugging them, so the band has to be
 * built out of real spaces instead. Over-long labels are truncated rather
 * than wrapped — a band that spills onto a second line stops reading as a
 * band.
 */
function centreOn(s: string, width: number): string {
  const text = s.length > width ? s.slice(0, width) : s;
  const left = Math.floor((width - text.length) / 2);
  const right = width - text.length - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

function colsForWidth(paperWidth: number): number {
  // 80mm ≈ 42 cols at font A, 58mm ≈ 32 cols.
  return paperWidth === 58 ? 32 : 42;
}

/**
 * Thermal text sizing for the item block.
 *
 * `GS ! n` packs two multipliers into one byte: the low nibble is height,
 * the high nibble is width. So double-height alone is 0x01 and
 * double-height-plus-width is 0x11 — which is exactly what the operator
 * picks between in the printer settings ("Twice the height" vs "Tall +
 * wide").
 *
 * Width doubling halves the usable columns, so a long product name wraps
 * sooner. That is the operator's trade to make: they chose the size because
 * a name they cannot read from arm's length is worse than one that wraps.
 */
export type TextScale = "NORMAL" | "LARGE" | "XLARGE";

const SCALE_BYTE: Record<TextScale, number> = {
  NORMAL: 0x00,
  LARGE: 0x01, // double height
  XLARGE: 0x11, // double height + double width
};

const textScale = (scale: TextScale | undefined) => [
  GS,
  0x21,
  SCALE_BYTE[scale ?? "NORMAL"] ?? 0x00,
];

/** Normalise whatever is stored on the printer's defaults JSON. */
function asScale(v: unknown): TextScale {
  return v === "LARGE" || v === "XLARGE" ? v : "NORMAL";
}

export interface RenderOptions {
  paperWidth: 58 | 80;
  openCashDrawer?: boolean;
  printLogo?: boolean;
  /** Size of the "2x Cheeseburger" headline. Default NORMAL. */
  fontScale?: TextScale;
  /** Size of the "+ Extra cheese" lines under it. Default NORMAL — a
   *  twelve-option meal deal at double height runs a lot of paper, so
   *  shops opt into big options rather than getting them by default. */
  modifierScale?: TextScale;
  /** Item headlines print bold. Default true (long-standing behaviour);
   *  shops that want a flat ticket can turn it off. */
  boldItems?: boolean;
}

import { renderLogo } from "./escpos-image";

// Async wrapper that lets the renderer fetch + rasterize the brand logo
// before assembling the buffer. The agent path that calls this already
// awaits send(), so the extra await is cheap and the logo is cached
// after the first print anyway. Kept renderToEscPos synchronous for
// backwards compatibility with test-print and any caller that doesn't
// have an async context — that path skips the logo entirely.
export async function renderToEscPosAsync(
  payload: any,
  opts: RenderOptions,
): Promise<Buffer> {
  const logoBytes = payload?.brandLogoUrl
    ? await renderLogo(String(payload.brandLogoUrl), opts.paperWidth)
    : null;
  return renderToEscPos(payload, opts, logoBytes ?? undefined);
}

export function renderToEscPos(
  payload: any,
  opts: RenderOptions,
  logoBytes?: number[],
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

  // ── Restaurant header ────────────────────────────────────────────
  // What the customer sees on the receipt is the SHOP they're buying
  // from, not the SaaS account name. So locationName (e.g.
  // "pizza uno pelton") goes in big bold at the top; brandName only
  // appears as a small subtitle when the operator runs multiple
  // distinct brands out of one location (e.g. brand="Pizza Uno",
  // location="Pelton High Street"). When the brand is just the tenant
  // umbrella (matches/contains the SaaS account name), it adds nothing
  // useful and we hide it.
  const shopTitle = payload.locationName ?? payload.brandName ?? null;
  const showBrandSubtitle =
    payload.brandName &&
    payload.locationName &&
    payload.brandName !== payload.locationName &&
    !payload.locationName
      .toLowerCase()
      .includes(String(payload.brandName).toLowerCase());

  out.push(...alignCenter());
  // Brand logo (pre-rasterized by renderToEscPosAsync). Sits above the
  // shop title so the receipt opens with the brand visual the way a
  // proper restaurant ticket does.
  if (logoBytes && logoBytes.length) {
    out.push(...logoBytes);
    out.push(LF);
  }
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

  // Order source banner (DIRECT / UBER_EATS / DELIVEROO / JUST_EAT / POS).
  const sourceLabel = friendlySource(payload.orderSource, payload.platform);
  if (sourceLabel) {
    out.push(...alignCenter(), ...boldOn());
    write(sourceLabel);
    newline();
    out.push(...boldOff(), ...alignLeft());
  }

  // Phase AW-30 — prefer the 5-char displayId ("AB31C") over the
  // internal-sequential orderNumber so the receipt shows the same
  // code the customer sees in their app + emails. Marketplace orders
  // also populate displayId with their platform code so this ordering
  // works for both paths.
  const orderRef =
    payload.displayId ?? payload.orderNumber ?? payload.orderId ?? null;
  out.push(...alignCenter(), ...boldOn(), ...doubleSizeOn());
  write(orderRef ? `#${orderRef}` : "ORDER");
  newline();
  out.push(...doubleSizeOff(), ...boldOff(), ...alignLeft());

  // Phase AW-26 — NEW / RETURNING customer banner. Server pre-renders
  // the wording in `customerVisitTag` so every print client agrees
  // ("*** NEW CUSTOMER ***" / "*** RETURNING CUSTOMER · ORDER #N ***").
  // Bold + centred so it's the second thing the counter notices after
  // the order number.
  if (payload.customerVisitTag) {
    // Phase AW-30 — double-size + reverse video. Bold alone gets lost
    // between the order number and the customer block; the highlight
    // is what makes a returning regular obvious at a glance.
    newline();
    out.push(...alignCenter(), ...boldOn(), ...reverseOn());
    write(` ${String(payload.customerVisitTag)} `);
    newline();
    out.push(...reverseOff(), ...boldOff(), ...alignLeft());
    newline();
  }

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
  // Item block sizing/weight is per printer. Both scales reset to NORMAL
  // after each block so nothing downstream (totals, address, footer) inherits
  // a double-size state — an unreset `GS !` is how one large item turns the
  // rest of the ticket into a poster.
  const itemScale = asScale(opts.fontScale);
  const modScale = asScale(opts.modifierScale);
  const boldItems = opts.boldItems !== false;

  for (const it of payload.items ?? []) {
    if (boldItems) out.push(...boldOn());
    if (itemScale !== "NORMAL") out.push(...textScale(itemScale));
    // Kitchen-language name wins when the location has translations on and
    // this product has one. Not printed as an extra line: a kitchen reading
    // Chinese should not have to scan past the English to find it.
    //
    // NOTE: this desktop bridge is a Node process with no canvas, so it cannot
    // raster the glyphs the way the tablet renderer does — non-Latin text here
    // still depends on the printer's own font. The tablet path is the one that
    // draws pixels; see rasterTextLine in apps/web/src/lib/printing/bridge.ts.
    write(`${it.quantity}x ${it.secondLanguageName || it.name}`);
    newline();
    if (itemScale !== "NORMAL") out.push(...textScale("NORMAL"));
    if (boldItems) out.push(...boldOff());
    for (const m of it.modifiers ?? []) {
      if (modScale !== "NORMAL") out.push(...textScale(modScale));
      write(`  ${modifierIndent(m)}+ ${m.name}`);
      newline();
      if (modScale !== "NORMAL") out.push(...textScale("NORMAL"));
    }
    if (it.notes) {
      if (modScale !== "NORMAL") out.push(...textScale(modScale));
      write(`  Note: ${it.notes}`);
      newline();
      if (modScale !== "NORMAL") out.push(...textScale("NORMAL"));
    }
  }
  hr();

  // Totals (only on receipts). Field names below match the API's
  // ReceiptPayload contract (apps/api/.../formatters/receipt.formatter.ts);
  // earlier versions of this renderer used `delivery`/`tax`/`address`
  // and silently dropped values because the keys never matched.
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

  // Customer contact + delivery address. The API sends
  // `deliveryAddress` as a single pre-joined string for receipts/kitchen
  // tickets; driver slips may also include a structured `address` object
  // — both shapes are accepted so older payloads still print.
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

  // Order-level note (POS "delivery instructions" / customer note).
  if (payload.specialInstructions) {
    hr();
    out.push(...boldOn());
    write("NOTE");
    newline();
    out.push(...boldOff());
    write(String(payload.specialInstructions));
    newline();
  }

  // Payment banner. Server pre-renders this as `paymentLabel` so every
  // client gets identical wording (PAID/CASH ON HANDOVER/etc).
  if (payload.paymentLabel) {
    // Payment state as a solid black band, the full width of the paper.
    //
    // It used to print as centred bold text wrapped in asterisks, which on a
    // busy pass reads as just more text — and "is this one paid?" is the one
    // question a driver or counter cashier must not get wrong. Padding the
    // label out to the full column count is what makes the inverted region
    // span the paper instead of hugging the words.
    //
    // Double height, not double width: at double width a 32-column 58mm roll
    // fits 16 characters, and "CASH NOT PAID" plus padding does not.
    const label = String(payload.paymentLabel).trim();
    const banner = centreOn(label, width);
    hr();
    out.push(...alignLeft(), ...textScale("LARGE"), ...reverseOn());
    write(banner);
    // Close the highlight BEFORE the line feed. A LF emitted while reverse
    // video is on feeds an inverted line on some firmware, which prints as a
    // ragged black tail hanging off the band.
    out.push(...reverseOff());
    newline();
    out.push(...textScale("NORMAL"));
  } else if (payload.paymentMethod) {
    hr();
    write(`Payment: ${payload.paymentMethod} (${payload.paymentStatus ?? ""})`);
    newline();
  }

  // Phase BN-QR — marketing QR, pre-rasterised.
  //
  // Bytes only: the raster is built once when the print job is created
  // (qr-raster.ts) and carried on the payload as base64, so this stays
  // synchronous and this file stays byte-identical to its twin.
  //
  // A raster rather than `GS ( k` because Sunmi implements no QR command —
  // it accepts the ESC/POS one and silently prints nothing.
  if (payload.qrRaster) {
    try {
      const raster = Buffer.from(String(payload.qrRaster), "base64");
      if (raster.length > 8) {
        hr();
        out.push(...alignCenter());
        if (payload.qrCaption) {
          write(String(payload.qrCaption));
          newline();
        }
        out.push(...Array.from(raster));
        newline();
        out.push(...alignLeft());
      }
    } catch {
      // A malformed raster must never cost the ticket.
    }
  }

  newline();
  newline();
  newline();
  out.push(...cut());
  if (opts.openCashDrawer) out.push(...openCashDrawer());

  return Buffer.from(out);
}

// Maps OrderSource / OrderPlatform enums to a human-readable banner.
// Returns null if neither field is known so we don't print "UNKNOWN".
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
  // Prefer the pre-rasterised pixels over the ESC/POS QR command. Sunmi
  // implements no QR command — it accepts `GS ( k` and prints nothing — so
  // the command form is kept only as the fallback for printers that do.
  if (payload.qrRaster) {
    try {
      const raster = Buffer.from(String(payload.qrRaster), "base64");
      if (raster.length > 8) {
        out.push(...alignCenter(), ...Array.from(raster));
        newline();
        out.push(...alignLeft());
      }
    } catch {
      // A malformed raster must never cost the test print.
    }
  } else if (payload.qrCode) {
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
