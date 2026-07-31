// Browser-side ESC/POS rendering + native Bluetooth bridge.
//
// When the dashboard is loaded inside the OrderHub Solutions Android
// app, window.OrderHubBT is injected by the WebView. We can render
// receipts in JS, base64-encode them, and the native side writes the
// raw bytes to the printer's Bluetooth Serial Port Profile socket.
//
// No print agent, no pair code, no API round-trip — direct.

// ── ESC/POS command bytes ───────────────────────────────────────────
const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

// Reset (ESC @) then select code page CP437 (ESC t 0). CP437 is the
// power-on default on virtually all ESC/POS printers and puts the £
// sign at byte 0x9C — which is how we render currency (see strBytes).
const INIT = [ESC, 0x40, ESC, 0x74, 0x00];
const ALIGN_LEFT = [ESC, 0x61, 0x00];
const ALIGN_CENTER = [ESC, 0x61, 0x01];
const BOLD_ON = [ESC, 0x45, 0x01];
const BOLD_OFF = [ESC, 0x45, 0x00];
const DOUBLE_ON = [GS, 0x21, 0x11];
const DOUBLE_OFF = [GS, 0x21, 0x00];
const CUT = [GS, 0x56, 0x42, 0x00];
const reverseOn = () => [GS, 0x42, 0x01];
const reverseOff = () => [GS, 0x42, 0x00];

// GS ! n — character size. High nibble = width multiplier - 1, low
// nibble = height multiplier - 1. Double HEIGHT alone (2,1) is the
// sweet spot for item lines: twice as tall and easy to read across a
// kitchen, but still the full column count so prices stay aligned on
// the right. Double width halves the usable columns.
const sizeOn = (w: number, h: number) => [
  GS,
  0x21,
  ((Math.max(1, Math.min(8, w)) - 1) << 4) | (Math.max(1, Math.min(8, h)) - 1),
];

// How big the customer-facing lines print. Set per printer in
// Printers → (pen icon) → Receipt options → Text size.
//   NORMAL — the old compact ticket
//   LARGE  — items, address and totals double height (recommended)
//   XLARGE — items double height AND width, for older eyes / busy passes
export type FontScale = "NORMAL" | "LARGE" | "XLARGE";

export function normaliseFontScale(v: any): FontScale {
  const s = String(v ?? "").toUpperCase();
  if (s === "XLARGE" || s === "XL" || s === "EXTRA_LARGE") return "XLARGE";
  if (s === "LARGE" || s === "L") return "LARGE";
  if (s === "NORMAL" || s === "STANDARD" || s === "S") return "NORMAL";
  return "NORMAL";
}

// Read the text size off a printer record. `largeFont` was the old
// boolean toggle — it was saved but never actually reached the renderer,
// so anyone who ticked it got no change. Honour it as LARGE so those
// printers start printing the way their owner already asked for.
export function resolveFontScale(printer: any): FontScale {
  const d = printer?.defaults ?? {};
  if (d.fontScale) return normaliseFontScale(d.fontScale);
  return d.largeFont ? "LARGE" : "NORMAL";
}

// Options / modifiers are sized separately from the item headline. Shops
// vary: some want the toppings as loud as the item, others keep them
// small so a 12-option meal deal doesn't run a foot of paper.
export function resolveModifierScale(printer: any): FontScale {
  return normaliseFontScale(printer?.defaults?.modifierScale);
}

// Typeface. ESC/POS thermal printers carry two built-in fonts and no more —
// they are ROM bitmaps, not scalable outlines, so "any font you like" is not
// physically available. What you can choose is:
//   A — the standard face: wider, heavier, easier to read across a pass
//   B — a narrow condensed face: ~40% more characters per line, useful for
//       long item names or a 58mm roll
// Anything beyond these two would have to be rendered as an image per line,
// which is slow on a thermal head and prints noticeably greyer.
export type PrintFont = "A" | "B";

export function normalisePrintFont(v: any): PrintFont {
  return String(v ?? "").toUpperCase() === "B" ? "B" : "A";
}

export function resolvePrintFont(printer: any): PrintFont {
  return normalisePrintFont(printer?.defaults?.printFont);
}

// ESC M n — select character font (0 = A, 1 = B).
const selectFont = (f: PrintFont) => [0x1b, 0x4d, f === "B" ? 1 : 0];

// Font B is physically narrower, so a line fits more characters. Getting
// this wrong is what makes a "condensed" receipt look ragged: the text
// changes width but the column maths doesn't follow it.
function colsForFont(paperWidth: number, font: PrintFont): number {
  const base = paperWidth === 58 ? 32 : 42;
  return font === "B" ? Math.floor(base * 1.33) : base;
}

function colsFor(paperWidth: number): number {
  return paperWidth === 58 ? 32 : 42;
}

// Light separator between individual items ("- - - - -"), as opposed to
// the solid rule that closes a whole section. Cheap way to stop a long
// order reading as one grey block.
function dashes(cols: number): string {
  return "- ".repeat(Math.floor(cols / 2)).trimEnd();
}

function strBytes(s: string): number[] {
  // CP437 / ASCII subset only — non-ASCII becomes "?". Real menus
  // shouldn't have funky glyphs on a thermal printer anyway.
  // Exception: £ (U+00A3) maps to 0x9C, its CP437 position, so prices
  // print with the pound sign instead of "?".
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x00a3) out.push(0x9c); // £
    else out.push(c < 0x80 ? c : 0x3f);
  }
  return out;
}

function line(buf: number[], text: string) {
  for (const b of strBytes(text)) buf.push(b);
  buf.push(LF);
}

// wrap() splits on whitespace, so it eats any leading indent. Sub-lines
// (modifiers, item notes) must hang under their item, so wrap the bare
// text and re-apply the indent to every line including continuations.
function indented(text: string, prefix: string, width: number): string[] {
  return wrap(text, Math.max(8, width - prefix.length)).map(
    (w) => prefix + w,
  );
}

function padBetween(left: string, right: string, width: number): string {
  const total = left.length + right.length;
  if (total >= width) return (left + " " + right).slice(0, width);
  return left + " ".repeat(width - total) + right;
}

// ── Public helpers ──────────────────────────────────────────────────

export type BridgeWindow = Window & {
  OrderHubBT?: {
    isReady: boolean;
    listDevices(): Promise<Array<{ name: string; address: string }>>;
    print(mac: string, base64Bytes: string): Promise<{ ok: true }>;
    // LAN / network printer over raw TCP (port 9100). Added in the
    // tablet app alongside Bluetooth.
    printLan?(
      ip: string,
      port: number,
      base64Bytes: string,
    ): Promise<{ ok: true }>;
  };
};

export function hasNativeBridge(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window as BridgeWindow).OrderHubBT?.isReady;
}

// True if the installed app build supports LAN printing (older APKs
// only expose Bluetooth).
export function hasLanBridge(): boolean {
  if (typeof window === "undefined") return false;
  const bt = (window as BridgeWindow).OrderHubBT;
  return !!bt?.isReady && typeof bt.printLan === "function";
}

export async function bridgePrint(
  mac: string,
  bytes: Uint8Array,
): Promise<void> {
  if (!hasNativeBridge()) throw new Error("Bluetooth bridge not available");
  const b64 = bytesToBase64(bytes);
  await (window as BridgeWindow).OrderHubBT!.print(mac, b64);
}

export async function bridgeLanPrint(
  ip: string,
  port: number,
  bytes: Uint8Array,
): Promise<void> {
  const bt = (window as BridgeWindow).OrderHubBT;
  if (!bt?.isReady || typeof bt.printLan !== "function") {
    throw new Error(
      "LAN printing needs the latest tablet app — please update the app.",
    );
  }
  await bt.printLan(ip, port || 9100, bytesToBase64(bytes));
}

// Route a print to the right transport based on the printer's
// connectionType: BLUETOOTH → bridgePrint(mac), LAN → bridgeLanPrint(ip).
// `ipAddress` holds the MAC for Bluetooth and the IP for LAN.
export async function writeToPrinter(
  printer: { connectionType?: string; ipAddress?: string | null; port?: number | null },
  bytes: Uint8Array,
): Promise<void> {
  const conn = String(printer?.connectionType ?? "").toUpperCase();
  if (!printer?.ipAddress) throw new Error("Printer has no address configured");
  if (conn === "LAN") {
    await bridgeLanPrint(printer.ipAddress, printer.port ?? 9100, bytes);
  } else {
    await bridgePrint(printer.ipAddress, bytes);
  }
}

// Can the current app build print to this printer?
export function bridgeSupportsPrinter(printer: {
  connectionType?: string;
}): boolean {
  const conn = String(printer?.connectionType ?? "").toUpperCase();
  return conn === "LAN" ? hasLanBridge() : hasNativeBridge();
}

// Repeat a fully-rendered receipt N times into one buffer. Each copy
// already ends in a paper cut, so the printer spits out N separate
// receipts. We concatenate rather than calling print() N times so the
// whole job goes down a single Bluetooth connection — issuing several
// back-to-back connect/print cycles races the printer and historically
// dropped all copies but the first.
export function repeatReceipt(bytes: Uint8Array, copies: number): Uint8Array {
  const n = Math.max(1, Math.floor(copies) || 1);
  if (n === 1) return bytes;
  const out = new Uint8Array(bytes.length * n);
  for (let i = 0; i < n; i++) out.set(bytes, i * bytes.length);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)),
    );
  }
  return btoa(bin);
}

// ── Receipt templates ──────────────────────────────────────────────

// ── Cash drawer ─────────────────────────────────────────────────────
//
// A till drawer isn't wired to the computer — it hangs off the RJ11
// "DK" port on the receipt printer and only opens when the printer
// pulses it. So "open the drawer" is a print job with no paper: send
// the kick bytes down the same Bluetooth/LAN socket the receipts use.
//
// ESC p m t1 t2 — pulse connector pin `m` for t1 on / t2 off (x2ms).
// Drawers are wired to either pin 2 or pin 5 depending on the cable,
// and there's no way to detect which. Both pulses are sent: the pin
// that isn't connected does nothing, so this is harmless and saves the
// operator diagnosing a cable they can't see.
export function buildDrawerKick(commandSet?: string): Uint8Array {
  if (String(commandSet ?? "").toUpperCase() === "STAR") {
    // Star Line Mode: BEL fires the drawer. ESC BEL n t sets the pulse
    // first so drawers that need a longer pulse still latch.
    return new Uint8Array([ESC, 0x07, 0x0b, 0x37, 0x07]);
  }
  return new Uint8Array([
    ESC, 0x70, 0x00, 0x19, 0xfa, // pin 2
    ESC, 0x70, 0x01, 0x19, 0xfa, // pin 5
  ]);
}

export function buildTestReceipt(paperWidth: number = 80): Uint8Array {
  const buf: number[] = [];
  buf.push(...INIT);
  buf.push(...ALIGN_CENTER, ...BOLD_ON, ...DOUBLE_ON);
  line(buf, "ORDER HUB");
  line(buf, "SOLUTIONS");
  buf.push(...DOUBLE_OFF, ...BOLD_OFF);
  line(buf, "");
  line(buf, "TEST PRINT");
  line(buf, new Date().toLocaleString());
  line(buf, "");
  buf.push(...ALIGN_LEFT);
  line(buf, "-".repeat(colsFor(paperWidth)));
  line(buf, "Connected via Bluetooth bridge");
  line(buf, "Status: OK");
  line(buf, "-".repeat(colsFor(paperWidth)));
  line(buf, "");
  line(buf, "If you can read this,");
  line(buf, "automatic order printing");
  line(buf, "is ready to go.");
  buf.push(LF, LF, LF);
  buf.push(...CUT);
  return new Uint8Array(buf);
}

// Format a money amount the printer can render. We keep this
// transport-agnostic — the API already chose £/$/€, so we just print
// "10.99" with up to 2 decimals.
// Compact, ASCII-safe date+time for the receipt, e.g. "Tue 24 Jun 18:30".
function fmtWhen(iso: any): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const date = d.toLocaleDateString([], {
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}

function money(n: any): string {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return "";
  // £ is encoded to its CP437 byte (0x9C) by strBytes so it prints.
  return `£${v.toFixed(2)}`;
}

// Word-wrap a long string at column boundaries. Thermal printers
// don't auto-wrap — long lines just truncate at the column count.
function wrap(text: string, width: number): string[] {
  const words = String(text).split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) {
      cur = w;
      continue;
    }
    if (cur.length + 1 + w.length <= width) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

// ── Logo + QR (graphics) ────────────────────────────────────────────

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Needed so we can read pixels back from the canvas (logo URLs are
    // served from Supabase storage with permissive CORS).
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("logo image failed to load"));
    img.src = url;
  });
}

// Cache rastered logos per (url|width) so we don't re-decode the image
// on every order print.
const logoCache = new Map<string, number[] | null>();

// Convert an image URL to an ESC/POS raster bitmap (GS v 0). Returns the
// command bytes, or null if the image can't be loaded / pixels can't be
// read — callers then just print the text receipt, so a bad logo never
// stops the order printing.
export async function imageToRaster(
  url: string,
  maxWidthDots: number,
): Promise<number[] | null> {
  const key = `${url}|${maxWidthDots}`;
  if (logoCache.has(key)) return logoCache.get(key) ?? null;
  let result: number[] | null = null;
  try {
    const img = await loadImage(url);
    const srcW = img.width || maxWidthDots;
    const srcH = img.height || maxWidthDots;
    let w = Math.min(maxWidthDots, srcW);
    w = Math.floor(w / 8) * 8; // width must be a multiple of 8 dots
    if (w >= 8) {
      let h = Math.round(w * (srcH / srcW));
      if (h > 0) {
        if (h > 1200) h = 1200; // sanity cap on logo height
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const data = ctx.getImageData(0, 0, w, h).data;
          const bytesPerRow = w / 8;
          const raster: number[] = [];
          for (let y = 0; y < h; y++) {
            for (let bx = 0; bx < bytesPerRow; bx++) {
              let byte = 0;
              for (let bit = 0; bit < 8; bit++) {
                const x = bx * 8 + bit;
                const i = (y * w + x) * 4;
                const a = data[i + 3]!;
                const lum =
                  a < 32
                    ? 255
                    : 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
                if (lum < 160) byte |= 0x80 >> bit; // dark pixel → black dot
              }
              raster.push(byte);
            }
          }
          result = [
            GS,
            0x76,
            0x30,
            0x00,
            bytesPerRow & 0xff,
            (bytesPerRow >> 8) & 0xff,
            h & 0xff,
            (h >> 8) & 0xff,
            ...raster,
          ];
        }
      }
    }
  } catch {
    result = null;
  }
  logoCache.set(key, result);
  return result;
}

// Native ESC/POS QR code (GS ( k). Supported by Epson TM-m30, Star, and
// most modern thermal printers. EC level L, configurable module size.
export function qrEscPos(data: string, size = 6): number[] {
  const bytes = strBytes(data);
  const s = Math.max(1, Math.min(16, size));
  const storeLen = bytes.length + 3;
  return [
    // Model 2
    GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00,
    // Module size
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, s,
    // Error-correction level L
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x30,
    // Store the data
    GS, 0x28, 0x6b, storeLen & 0xff, (storeLen >> 8) & 0xff, 0x31, 0x50, 0x30,
    ...bytes,
    // Print
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30,
  ];
}

// Receipt from the PrintJob.payload structure that PrintJobsService
// builds on the server. The shape is stable across renderers:
//   - print-bridge desktop produces the same receipt from the same
//     payload via apps/print-bridge/src/renderer/escpos-renderer.ts;
//   - this function does the same thing in the browser so bridge-mode
//     tablets get a 1-for-1 match.
//
// We deliberately don't render brandLogoUrl — server-side rasterising
// to ESC/POS bitmap is non-trivial in JS, and the bridge event payload
// drops the base64 PNG anyway. Everything else (header, returning-
// customer banner, items + modifiers + notes, totals, payment, special
// instructions, footer) is rendered to match.
export function buildOrderReceipt(
  payload: any,
  paperWidth: number = 80,
  opts?: {
    logoBytes?: number[] | null;
    qr?: string | null;
    fontScale?: FontScale;
    modifierScale?: FontScale;
    printFont?: PrintFont;
  },
): Uint8Array {
  const font = normalisePrintFont(opts?.printFont);
  const cols = colsForFont(paperWidth, font);
  const scale = normaliseFontScale(opts?.fontScale);
  const modScale = normaliseFontScale(opts?.modifierScale);
  const modH = modScale === "NORMAL" ? 1 : 2;
  const modW = modScale === "XLARGE" ? 2 : 1;
  const modCols = Math.floor(cols / modW);
  const MOD_ON = modScale === "NORMAL" ? [] : sizeOn(modW, modH);
  const MOD_OFF = modScale === "NORMAL" ? [] : DOUBLE_OFF;
  // Item lines: taller on LARGE, taller AND wider on XLARGE. Double
  // width halves the columns we have to lay a line out in, so every
  // scaled block measures itself against `itemCols`, not `cols`.
  const itemH = scale === "NORMAL" ? 1 : 2;
  const itemW = scale === "XLARGE" ? 2 : 1;
  const itemCols = Math.floor(cols / itemW);
  const ITEM_ON = sizeOn(itemW, itemH);
  const buf: number[] = [];
  buf.push(...INIT);
  // Select the typeface once, straight after INIT — INIT resets it, so
  // this has to come after or the choice is silently discarded.
  buf.push(...selectFont(font));

  // ── Logo (top, centered) ──────────────────────────────────────────
  if (opts?.logoBytes && opts.logoBytes.length) {
    buf.push(...ALIGN_CENTER);
    buf.push(...opts.logoBytes);
    buf.push(LF);
  }

  // ── Banner (e.g. ORDER CANCELLED) ─────────────────────────────────
  if (payload?.banner) {
    buf.push(...ALIGN_CENTER, ...BOLD_ON, ...DOUBLE_ON, ...reverseOn());
    for (const w of wrap(String(payload.banner), Math.floor(cols / 2)))
      line(buf, w);
    buf.push(...reverseOff(), ...DOUBLE_OFF, ...BOLD_OFF);
    line(buf, "");
  }

  // ── Header ────────────────────────────────────────────────────────
  buf.push(...ALIGN_CENTER, ...BOLD_ON, ...DOUBLE_ON);
  const brandName = String(payload?.brandName ?? payload?.locationName ?? "");
  if (brandName) line(buf, brandName.slice(0, Math.floor(cols / 2)));
  buf.push(...DOUBLE_OFF);
  if (payload?.locationAddress) {
    for (const w of wrap(String(payload.locationAddress), cols))
      line(buf, w);
  }
  if (payload?.locationPhone)
    line(buf, `Tel: ${payload.locationPhone}`);
  buf.push(...BOLD_OFF);
  line(buf, "");

  // ── Returning-customer banner ─────────────────────────────────────
  if (payload?.customerVisitTag) {
    buf.push(...BOLD_ON, ...reverseOn());
    for (const w of wrap(String(payload.customerVisitTag), cols))
      line(buf, w);
    buf.push(...reverseOff(), ...BOLD_OFF);
    line(buf, "");
  }

  // ── Order number (big and bold) ───────────────────────────────────
  buf.push(...BOLD_ON, ...DOUBLE_ON);
  const orderNo = String(
    payload?.displayId ?? payload?.orderNumber ?? "",
  );
  if (orderNo) line(buf, `#${orderNo}`);
  buf.push(...DOUBLE_OFF, ...BOLD_OFF);
  const received = payload?.receivedAt
    ? new Date(payload.receivedAt).toLocaleString()
    : new Date().toLocaleString();
  line(buf, received);
  line(buf, "");

  // ── SCHEDULED banner (bold, with date + time) ─────────────────────
  if (payload?.scheduledFor) {
    buf.push(...ALIGN_CENTER, ...BOLD_ON, ...DOUBLE_ON, ...reverseOn());
    line(buf, "SCHEDULED");
    buf.push(...reverseOff(), ...DOUBLE_OFF);
    for (const w of wrap(fmtWhen(payload.scheduledFor), cols)) line(buf, w);
    buf.push(...BOLD_OFF, ...ALIGN_LEFT);
    line(buf, "");
  }

  // ── Order meta ────────────────────────────────────────────────────
  buf.push(...ALIGN_LEFT);
  if (payload?.platform || payload?.orderSource)
    line(buf, `Channel : ${payload?.platform ?? payload?.orderSource}`);
  if (payload?.fulfillmentType)
    line(buf, `Type    : ${payload.fulfillmentType}`);
  // Table Tabs — dine-in prints name the table.
  if (payload?.tableName) line(buf, `TABLE   : ${payload.tableName}`);
  // Always show the expected delivery / collection time.
  {
    const isDelivery = /DELIV/i.test(String(payload?.fulfillmentType ?? ""));
    const label = isDelivery ? "Deliver " : "Collect ";
    const when = payload?.scheduledFor ?? payload?.estimatedReadyAt ?? null;
    buf.push(...BOLD_ON);
    line(buf, `${label}: ${when ? fmtWhen(when) : "ASAP"}`);
    buf.push(...BOLD_OFF);
  }
  if (payload?.customerName)
    line(buf, `Customer: ${String(payload.customerName).slice(0, cols - 10)}`);
  if (payload?.customerPhone)
    line(buf, `Phone   : ${payload.customerPhone}`);
  // Delivery address gets the same height bump as the items — it's read
  // at arm's length in a car, in the dark. Height only, never double
  // width: a wrapped postcode is worse than a small one.
  if (payload?.deliveryAddress) {
    line(buf, "Address :");
    buf.push(...BOLD_ON, ...sizeOn(1, itemH));
    for (const w of wrap(String(payload.deliveryAddress), cols - 2))
      line(buf, `  ${w}`);
    buf.push(...DOUBLE_OFF, ...BOLD_OFF);
  }
  line(buf, "-".repeat(cols));

  // ── Items ─────────────────────────────────────────────────────────
  //
  // The line staff actually read. Each item is its own block: a big bold
  // "2x Item ............ £9.50" headline, its options indented beneath
  // in normal weight, then a light dashed rule so a ten-line order never
  // reads as one grey slab.
  const items = Array.isArray(payload?.items) ? payload.items : [];
  items.forEach((it: any, idx: number) => {
    const qty = String(it?.quantity ?? 1);
    const name = String(
      it?.name ?? it?.productName ?? it?.title ?? "Item",
    );
    const lineTotal =
      typeof it?.totalPrice === "number"
        ? it.totalPrice
        : typeof it?.price === "number"
          ? it.price * (it?.quantity ?? 1)
          : NaN;
    const priceStr = Number.isFinite(lineTotal) ? money(lineTotal) : "";

    buf.push(...BOLD_ON, ...ITEM_ON);
    const head = `${qty}x ${name}`;
    if (head.length + 1 + priceStr.length <= itemCols) {
      line(buf, padBetween(head, priceStr, itemCols));
    } else {
      // Item name too long for one line at this size — wrap the name,
      // then right-align the price on the last line so the money column
      // still reads straight down the ticket.
      const wrapped = wrap(head, itemCols);
      wrapped.forEach((w, i) => {
        if (i === wrapped.length - 1 && priceStr)
          line(buf, padBetween(w, priceStr, itemCols));
        else line(buf, w);
      });
    }
    buf.push(...DOUBLE_OFF, ...BOLD_OFF);

    if (Array.isArray(it?.modifiers) && it.modifiers.length) {
      buf.push(...MOD_ON);
      for (const m of it.modifiers) {
        const mname = String(m?.name ?? m?.title ?? "");
        if (!mname) continue;
        const mprice =
          typeof m?.price === "number" && m.price > 0
            ? `+${money(m.price)}`
            : "";
        const mline = `  - ${mname}`;
        if (mprice && mline.length + 1 + mprice.length <= modCols)
          line(buf, padBetween(mline, mprice, modCols));
        else for (const w of indented(mname, "  - ", modCols)) line(buf, w);
      }
      buf.push(...MOD_OFF);
    }
    // Item note — bold, because a missed "NO ONIONS" is a remake. Sized
    // with the options, since it's the same class of "don't miss this".
    if (it?.notes) {
      buf.push(...BOLD_ON, ...MOD_ON);
      for (const w of indented(String(it.notes), "  ** ", modCols))
        line(buf, w);
      buf.push(...MOD_OFF, ...BOLD_OFF);
    }
    if (idx < items.length - 1) line(buf, dashes(cols));
  });
  line(buf, "-".repeat(cols));

  // ── Totals ────────────────────────────────────────────────────────
  const showRow = (label: string, value: any) => {
    const s = money(value);
    if (s) line(buf, padBetween(label, s, cols));
  };
  showRow("Subtotal", payload?.subtotal);
  if (typeof payload?.deliveryFee === "number" && payload.deliveryFee > 0)
    showRow("Delivery", payload.deliveryFee);
  // Service charge is its own line so a customer querying the bill can see
  // exactly what the extra was.
  if (typeof payload?.serviceCharge === "number" && payload.serviceCharge > 0)
    showRow("Service", payload.serviceCharge);
  if (typeof payload?.taxAmount === "number" && payload.taxAmount > 0)
    showRow("Tax", payload.taxAmount);
  if (typeof payload?.discount === "number" && payload.discount > 0)
    showRow("Discount", -payload.discount);

  if (
    typeof payload?.total === "number" ||
    typeof payload?.totalAmount === "number"
  ) {
    const total = payload?.total ?? payload?.totalAmount;
    buf.push(...BOLD_ON, ...DOUBLE_ON);
    line(buf, padBetween("TOTAL", money(total), Math.floor(cols / 2)));
    buf.push(...DOUBLE_OFF, ...BOLD_OFF);
  }
  line(buf, "");

  // ── Payment ───────────────────────────────────────────────────────
  if (payload?.paymentLabel) {
    buf.push(...ALIGN_CENTER, ...BOLD_ON);
    for (const w of wrap(String(payload.paymentLabel), cols)) line(buf, w);
    buf.push(...BOLD_OFF, ...ALIGN_LEFT);
  } else if (payload?.paymentMethod) {
    buf.push(...ALIGN_CENTER, ...BOLD_ON);
    line(
      buf,
      `${payload.paymentMethod}${
        payload?.paymentStatus ? ` · ${payload.paymentStatus}` : ""
      }`,
    );
    buf.push(...BOLD_OFF, ...ALIGN_LEFT);
  }

  // ── Special instructions ──────────────────────────────────────────
  if (payload?.specialInstructions) {
    line(buf, "");
    buf.push(...BOLD_ON);
    line(buf, "Special instructions:");
    buf.push(...BOLD_OFF);
    for (const w of wrap(String(payload.specialInstructions), cols))
      line(buf, w);
  }

  // ── QR code (reorder link + live marketing caption) ──────────────
  if (opts?.qr) {
    line(buf, "");
    buf.push(...ALIGN_CENTER);
    if (payload?.qrCaption) {
      buf.push(...BOLD_ON);
      for (const w of wrap(String(payload.qrCaption), cols)) line(buf, w);
      buf.push(...BOLD_OFF);
    }
    buf.push(...qrEscPos(String(opts.qr), paperWidth === 58 ? 5 : 6));
    buf.push(LF);
    buf.push(...ALIGN_LEFT);
  }

  // ── Footer ────────────────────────────────────────────────────────
  buf.push(LF, LF, LF, LF);
  buf.push(...CUT);
  return new Uint8Array(buf);
}

// ── Star Line Mode (Star Micronics printers) ────────────────────────
//
// Star printers ship in "Star Line Mode" by default, which does NOT
// understand ESC/POS — send ESC/POS to a Star and you get a blank or
// garbage ticket (the exact symptom operators hit). These printers use
// Star's own command set. We render the same receipt content with Star
// commands so Star LAN/Bluetooth printers work without the operator
// having to flip the printer into ESC/POS emulation.
//
// Text + cut only for now: Star's raster (logo) and QR commands differ
// from ESC/POS and aren't implemented yet, so Star tickets print clean
// text without the logo/QR. Epson + Sunmi keep the full ESC/POS path.
const STAR_ALIGN_LEFT = [ESC, GS, 0x61, 0x00];
const STAR_ALIGN_CENTER = [ESC, GS, 0x61, 0x01];
const STAR_BOLD_ON = [ESC, 0x45];
const STAR_BOLD_OFF = [ESC, 0x46];
const STAR_EXPAND_ON = [ESC, 0x69, 0x01, 0x01]; // ESC i 1 1 — double height+width
const STAR_EXPAND_OFF = [ESC, 0x69, 0x00, 0x00];
const STAR_CUT = [ESC, 0x64, 0x03]; // ESC d 3 — partial cut with feed

export function buildOrderReceiptStar(
  payload: any,
  paperWidth: number = 80,
  opts?: { fontScale?: FontScale; modifierScale?: FontScale },
): Uint8Array {
  const cols = colsFor(paperWidth);
  // ESC i n1 n2 — n1 expands height, n2 expands width (0 = normal,
  // 1 = double). Same policy as ESC/POS: LARGE is tall only, XLARGE is
  // tall and wide (which halves the usable columns).
  const scale = normaliseFontScale(opts?.fontScale);
  const itemW = scale === "XLARGE" ? 2 : 1;
  const itemCols = Math.floor(cols / itemW);
  const STAR_ITEM_ON =
    scale === "NORMAL" ? [] : [ESC, 0x69, 0x01, itemW === 2 ? 0x01 : 0x00];
  const STAR_ITEM_OFF = scale === "NORMAL" ? [] : STAR_EXPAND_OFF;
  const modScale = normaliseFontScale(opts?.modifierScale);
  const modW = modScale === "XLARGE" ? 2 : 1;
  const modCols = Math.floor(cols / modW);
  const STAR_MOD_ON =
    modScale === "NORMAL" ? [] : [ESC, 0x69, 0x01, modW === 2 ? 0x01 : 0x00];
  const STAR_MOD_OFF = modScale === "NORMAL" ? [] : STAR_EXPAND_OFF;
  const buf: number[] = [];
  buf.push(ESC, 0x40); // ESC @ — initialise

  // ── Banner (e.g. ORDER CANCELLED) ─────────────────────────────────
  if (payload?.banner) {
    buf.push(...STAR_ALIGN_CENTER, ...STAR_BOLD_ON, ...STAR_EXPAND_ON);
    for (const w of wrap(String(payload.banner), Math.floor(cols / 2)))
      line(buf, w);
    buf.push(...STAR_EXPAND_OFF, ...STAR_BOLD_OFF);
    line(buf, "");
  }

  // ── Header ────────────────────────────────────────────────────────
  buf.push(...STAR_ALIGN_CENTER, ...STAR_BOLD_ON, ...STAR_EXPAND_ON);
  const brandName = String(payload?.brandName ?? payload?.locationName ?? "");
  if (brandName) line(buf, brandName.slice(0, Math.floor(cols / 2)));
  buf.push(...STAR_EXPAND_OFF);
  if (payload?.locationAddress)
    for (const w of wrap(String(payload.locationAddress), cols)) line(buf, w);
  if (payload?.locationPhone) line(buf, `Tel: ${payload.locationPhone}`);
  buf.push(...STAR_BOLD_OFF);
  line(buf, "");

  // ── Returning-customer banner ─────────────────────────────────────
  if (payload?.customerVisitTag) {
    buf.push(...STAR_BOLD_ON);
    for (const w of wrap(String(payload.customerVisitTag), cols)) line(buf, w);
    buf.push(...STAR_BOLD_OFF);
    line(buf, "");
  }

  // ── Order number ──────────────────────────────────────────────────
  buf.push(...STAR_BOLD_ON, ...STAR_EXPAND_ON);
  const orderNo = String(payload?.displayId ?? payload?.orderNumber ?? "");
  if (orderNo) line(buf, `#${orderNo}`);
  buf.push(...STAR_EXPAND_OFF, ...STAR_BOLD_OFF);
  line(
    buf,
    payload?.receivedAt
      ? new Date(payload.receivedAt).toLocaleString()
      : new Date().toLocaleString(),
  );
  line(buf, "");

  // ── SCHEDULED banner ──────────────────────────────────────────────
  if (payload?.scheduledFor) {
    buf.push(...STAR_ALIGN_CENTER, ...STAR_BOLD_ON, ...STAR_EXPAND_ON);
    line(buf, "SCHEDULED");
    buf.push(...STAR_EXPAND_OFF);
    for (const w of wrap(fmtWhen(payload.scheduledFor), cols)) line(buf, w);
    buf.push(...STAR_BOLD_OFF, ...STAR_ALIGN_LEFT);
    line(buf, "");
  }

  // ── Order meta ────────────────────────────────────────────────────
  buf.push(...STAR_ALIGN_LEFT);
  if (payload?.platform || payload?.orderSource)
    line(buf, `Channel : ${payload?.platform ?? payload?.orderSource}`);
  if (payload?.fulfillmentType)
    line(buf, `Type    : ${payload.fulfillmentType}`);
  // Table Tabs — dine-in prints name the table.
  if (payload?.tableName) line(buf, `TABLE   : ${payload.tableName}`);
  {
    const isDelivery = /DELIV/i.test(String(payload?.fulfillmentType ?? ""));
    const label = isDelivery ? "Deliver " : "Collect ";
    const when = payload?.scheduledFor ?? payload?.estimatedReadyAt ?? null;
    buf.push(...STAR_BOLD_ON);
    line(buf, `${label}: ${when ? fmtWhen(when) : "ASAP"}`);
    buf.push(...STAR_BOLD_OFF);
  }
  if (payload?.customerName)
    line(buf, `Customer: ${String(payload.customerName).slice(0, cols - 10)}`);
  if (payload?.customerPhone) line(buf, `Phone   : ${payload.customerPhone}`);
  if (payload?.deliveryAddress) {
    line(buf, "Address :");
    buf.push(...STAR_BOLD_ON);
    if (scale !== "NORMAL") buf.push(ESC, 0x69, 0x01, 0x00);
    for (const w of wrap(String(payload.deliveryAddress), cols - 2))
      line(buf, `  ${w}`);
    if (scale !== "NORMAL") buf.push(...STAR_EXPAND_OFF);
    buf.push(...STAR_BOLD_OFF);
  }
  line(buf, "-".repeat(cols));

  // ── Items ─────────────────────────────────────────────────────────
  const items = Array.isArray(payload?.items) ? payload.items : [];
  items.forEach((it: any, idx: number) => {
    const qty = String(it?.quantity ?? 1);
    const name = String(it?.name ?? it?.productName ?? it?.title ?? "Item");
    const lineTotal =
      typeof it?.totalPrice === "number"
        ? it.totalPrice
        : typeof it?.price === "number"
          ? it.price * (it?.quantity ?? 1)
          : NaN;
    const priceStr = Number.isFinite(lineTotal) ? money(lineTotal) : "";
    buf.push(...STAR_BOLD_ON, ...STAR_ITEM_ON);
    const head = `${qty}x ${name}`;
    if (head.length + 1 + priceStr.length <= itemCols) {
      line(buf, padBetween(head, priceStr, itemCols));
    } else {
      const wrapped = wrap(head, itemCols);
      wrapped.forEach((w, i) => {
        if (i === wrapped.length - 1 && priceStr)
          line(buf, padBetween(w, priceStr, itemCols));
        else line(buf, w);
      });
    }
    buf.push(...STAR_ITEM_OFF, ...STAR_BOLD_OFF);
    if (Array.isArray(it?.modifiers) && it.modifiers.length) {
      buf.push(...STAR_MOD_ON);
      for (const m of it.modifiers) {
        const mname = String(m?.name ?? m?.title ?? "");
        if (!mname) continue;
        const mprice =
          typeof m?.price === "number" && m.price > 0
            ? `+${money(m.price)}`
            : "";
        const mline = `  - ${mname}`;
        if (mprice && mline.length + 1 + mprice.length <= modCols)
          line(buf, padBetween(mline, mprice, modCols));
        else for (const w of indented(mname, "  - ", modCols)) line(buf, w);
      }
      buf.push(...STAR_MOD_OFF);
    }
    if (it?.notes) {
      buf.push(...STAR_BOLD_ON, ...STAR_MOD_ON);
      for (const w of indented(String(it.notes), "  ** ", modCols))
        line(buf, w);
      buf.push(...STAR_MOD_OFF, ...STAR_BOLD_OFF);
    }
    if (idx < items.length - 1) line(buf, dashes(cols));
  });
  line(buf, "-".repeat(cols));

  // ── Totals ────────────────────────────────────────────────────────
  const showRow = (label: string, value: any) => {
    const s = money(value);
    if (s) line(buf, padBetween(label, s, cols));
  };
  showRow("Subtotal", payload?.subtotal);
  if (typeof payload?.deliveryFee === "number" && payload.deliveryFee > 0)
    showRow("Delivery", payload.deliveryFee);
  // Star renderer needs the same service-charge line as ESC/POS, or a Star
  // shop's bill silently wouldn't add up.
  if (typeof payload?.serviceCharge === "number" && payload.serviceCharge > 0)
    showRow("Service", payload.serviceCharge);
  if (typeof payload?.taxAmount === "number" && payload.taxAmount > 0)
    showRow("Tax", payload.taxAmount);
  if (typeof payload?.discount === "number" && payload.discount > 0)
    showRow("Discount", -payload.discount);
  if (
    typeof payload?.total === "number" ||
    typeof payload?.totalAmount === "number"
  ) {
    const total = payload?.total ?? payload?.totalAmount;
    buf.push(...STAR_BOLD_ON, ...STAR_EXPAND_ON);
    line(buf, padBetween("TOTAL", money(total), Math.floor(cols / 2)));
    buf.push(...STAR_EXPAND_OFF, ...STAR_BOLD_OFF);
  }
  line(buf, "");

  // ── Payment ───────────────────────────────────────────────────────
  if (payload?.paymentLabel) {
    buf.push(...STAR_ALIGN_CENTER, ...STAR_BOLD_ON);
    for (const w of wrap(String(payload.paymentLabel), cols)) line(buf, w);
    buf.push(...STAR_BOLD_OFF, ...STAR_ALIGN_LEFT);
  } else if (payload?.paymentMethod) {
    buf.push(...STAR_ALIGN_CENTER, ...STAR_BOLD_ON);
    line(
      buf,
      `${payload.paymentMethod}${
        payload?.paymentStatus ? ` - ${payload.paymentStatus}` : ""
      }`,
    );
    buf.push(...STAR_BOLD_OFF, ...STAR_ALIGN_LEFT);
  }

  // ── Special instructions ──────────────────────────────────────────
  if (payload?.specialInstructions) {
    line(buf, "");
    buf.push(...STAR_BOLD_ON);
    line(buf, "Special instructions:");
    buf.push(...STAR_BOLD_OFF);
    for (const w of wrap(String(payload.specialInstructions), cols))
      line(buf, w);
  }

  buf.push(LF, LF, LF, LF);
  buf.push(...STAR_CUT);
  return new Uint8Array(buf);
}

// Star Line Mode test receipt — mirrors buildTestReceipt for Star printers.
export function buildTestReceiptStar(paperWidth: number = 80): Uint8Array {
  const buf: number[] = [];
  buf.push(ESC, 0x40);
  buf.push(...STAR_ALIGN_CENTER, ...STAR_BOLD_ON, ...STAR_EXPAND_ON);
  line(buf, "ORDER HUB");
  buf.push(...STAR_EXPAND_OFF, ...STAR_BOLD_OFF);
  line(buf, "");
  line(buf, "TEST PRINT (Star)");
  line(buf, new Date().toLocaleString());
  line(buf, "");
  buf.push(...STAR_ALIGN_LEFT);
  line(buf, "-".repeat(colsFor(paperWidth)));
  line(buf, "Star Line Mode receipt OK");
  line(buf, "Automatic order printing ready.");
  line(buf, "-".repeat(colsFor(paperWidth)));
  buf.push(LF, LF, LF);
  buf.push(...STAR_CUT);
  return new Uint8Array(buf);
}

// Async wrapper that prepares graphics (logo raster) then builds the
// receipt. Logo prints by default when the payload carries a brand logo
// (disable per-printer with defaults.printLogo === false); the QR prints
// only when the printer has defaults.qrCode on and the payload has a
// qrData value. Logo failures fall back to a clean text receipt.
export async function renderReceiptBytes(
  payload: any,
  paperWidth: number = 80,
  opts?: {
    printLogo?: boolean;
    qrCode?: boolean;
    commandSet?: string;
    fontScale?: FontScale;
    modifierScale?: FontScale;
    printFont?: PrintFont;
  },
): Promise<Uint8Array> {
  // Star printers speak Star Line Mode, not ESC/POS — render their own
  // command set (text + cut; logo/QR are ESC/POS-only for now).
  if (String(opts?.commandSet ?? "").toUpperCase() === "STAR") {
    return buildOrderReceiptStar(payload, paperWidth, {
      fontScale: opts?.fontScale,
      modifierScale: opts?.modifierScale,
    });
  }
  let logoBytes: number[] | null = null;
  if (opts?.printLogo !== false && payload?.brandLogoUrl) {
    const maxDots = paperWidth === 58 ? 360 : 512;
    logoBytes = await imageToRaster(String(payload.brandLogoUrl), maxDots);
  }
  const qr = opts?.qrCode && payload?.qrData ? String(payload.qrData) : null;
  return buildOrderReceipt(payload, paperWidth, {
    logoBytes,
    qr,
    fontScale: opts?.fontScale,
    modifierScale: opts?.modifierScale,
    printFont: opts?.printFont,
  });
}
