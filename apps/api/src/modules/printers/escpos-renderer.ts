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
// Reverse video (white on black). `GS B n` — the only way to get a solid
// highlight band out of a thermal printer; bold alone is a weight change the
// eye skates over on a busy pass.
const reverseOn = () => [GS, 0x42, 0x01];
const reverseOff = () => [GS, 0x42, 0x00];
const cut = () => [GS, 0x56, 0x42, 0x00];
const openCashDrawer = () => [ESC, 0x70, 0x00, 0x40, 0xc8];


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

  // Phase AW-30 — prefer the customer-friendly displayId ("AB31C") over
  // the internal-sequential orderNumber. Marketplaces also populate
  // displayId with their platform code (JE-123, UE-987 …) so this
  // ordering does the right thing for both paths.
  const orderRef =
    payload.displayId ?? payload.orderNumber ?? payload.orderId ?? null;
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
    write(`${it.quantity}x ${it.name}`);
    newline();
    if (itemScale !== "NORMAL") out.push(...textScale("NORMAL"));
    if (boldItems) out.push(...boldOff());
    for (const m of it.modifiers ?? []) {
      if (modScale !== "NORMAL") out.push(...textScale(modScale));
      write(`  ${modifierIndent(m)}+ ${m.name}`);
      newline();
      if (modScale !== "NORMAL") out.push(...textScale("NORMAL"));
    }
    // Item note — reversed out, the same black bar the payment banner uses.
    // Shops were reading the old marker as a footnote rather than an
    // instruction, and a missed "NO ONIONS" is a remake. Padded to the full
    // width so the bar is a rectangle rather than ragged around the text.
    if (it.notes) {
      if (modScale !== "NORMAL") out.push(...textScale(modScale));
      out.push(...reverseOn());
      write(`  Note: ${it.notes}`.padEnd(width, " "));
      out.push(...reverseOff());
      newline();
      if (modScale !== "NORMAL") out.push(...textScale("NORMAL"));
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
    if (Number(payload.serviceCharge ?? 0) > 0) {
      const svc = Number(payload.serviceCharge);
      write(pad("Service charge", width - 10) + padRight(svc.toFixed(2), 10));
      newline();
    }
    if (Number(payload.tipAmount ?? 0) > 0) {
      const tip = Number(payload.tipAmount);
      write(pad("Tip", width - 10) + padRight(tip.toFixed(2), 10));
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
