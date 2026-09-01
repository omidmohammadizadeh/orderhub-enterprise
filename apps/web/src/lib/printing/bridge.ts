import { formatMoney } from "@orderhub/shared";
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

// Punctuation that routinely reaches a ticket from menus, marketplace notes
// and our own separators, transliterated to ASCII. Without this each one
// prints as a bare "?" — a customer note reading "NO CUTLERY ? Ring the
// doorbell" looks like corrupted data rather than two instructions.
const TRANSLIT: Record<string, string> = {
  "·": "-", // · middot (our own separator between notes)
  "•": "-", // • bullet
  "–": "-", // – en dash
  "—": "-", // — em dash
  "‘": "'", // ' curly quotes
  "’": "'",
  "‚": "'",
  "“": '"',
  "”": '"',
  "…": "...", // … ellipsis
  " ": " ", // non-breaking space
  "½": "1/2",
  "¼": "1/4",
  "¾": "3/4",
  "×": "x", // × multiplication sign
  "€": "EUR",
};

function strBytes(s: string): number[] {
  // CP437 / ASCII subset only — anything we can't render becomes "?".
  // Exceptions: £ (U+00A3) maps to 0x9C, its CP437 position, so prices print
  // with the pound sign; and the TRANSLIT table above rewrites common
  // punctuation to a readable ASCII equivalent first.
  const out: number[] = [];
  for (const ch of s) {
    const mapped = TRANSLIT[ch];
    if (mapped !== undefined) {
      for (let j = 0; j < mapped.length; j++) out.push(mapped.charCodeAt(j));
      continue;
    }
    const c = ch.charCodeAt(0);
    if (c === 0x00a3) out.push(0x9c); // £
    else out.push(c < 0x80 ? c : 0x3f);
  }
  return out;
}

/**
 * Centre `s` in `width` columns using real spaces on both sides.
 *
 * ALIGN_CENTER positions the glyphs but leaves a reverse-video highlight
 * hugging them; the solid band has to be built from padding. Over-long text is
 * truncated rather than wrapped — a band that runs onto a second line stops
 * reading as a band. Mirrors centreOn() in the two server renderers.
 */
function centreOn(s: string, width: number): string {
  const text = s.length > width ? s.slice(0, width) : s;
  const left = Math.floor((width - text.length) / 2);
  return " ".repeat(left) + text + " ".repeat(width - text.length - left);
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

function moneyIn(n: any, currency?: string | null): string {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return "";
  // £ is encoded to its CP437 byte (0x9C) by strBytes so it prints. Other
  // currencies come back as plain ASCII letters ("AED 24.00"), which CP437
  // carries without any mapping — and formatMoney keeps a dinar's third
  // decimal place, which a .toFixed(2) here would have silently dropped.
  return formatMoney(v, currency ?? "GBP", { compact: true });
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

/**
 * True when a string contains anything the printer's CP437 character set
 * cannot represent — CJK, Arabic, Cyrillic, Greek.
 *
 * strBytes() turns every one of those into "?", so a Chinese kitchen ticket
 * would print as a row of question marks. Lines that trip this get drawn as
 * pixels instead (see rasterTextLine).
 */
export function needsRaster(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) continue;
    if (TRANSLIT[ch] !== undefined) continue; // rewritten to ASCII already
    if (c === 0x00a3) continue; // £ has a real CP437 byte
    return true;
  }
  return false;
}

/**
 * Draw one line of text as an ESC/POS raster bitmap.
 *
 * The printer is locked to CP437 and most units sold in the UK have no CJK
 * font chip at all, so the only way to put Chinese on the paper reliably is to
 * send pixels — the same trick the QR code already uses, and it works on any
 * printer that can print a logo. The tablet's own system font does the
 * rendering, and Android and iOS both ship CJK coverage.
 *
 * `bold` doubles the weight for item lines, which is what the kitchen reads
 * first. Returns null when there is no canvas (server-side render or a
 * headless test), so the caller falls back to plain text.
 */
export function rasterTextLine(
  text: string,
  dotWidth: number,
  opts?: {
    bold?: boolean;
    fontPx?: number;
    /**
     * Right-aligned text on the SAME raster row — the line's price.
     *
     * A raster is a picture, so a price printed after it lands on the next
     * line with nothing tying the two together: the ticket read as a row of
     * names and a separate column of floating numbers. Drawing it into the
     * same bitmap puts the money back beside its item, which is how every
     * other line on the ticket reads.
     */
    right?: string;
  },
): { bytes: number[]; rightDrawn: boolean } | null {
  if (typeof document === "undefined") return null;
  const fontPx = opts?.fontPx ?? 30;
  // Raster rows are padded to whole bytes, so the width must be a multiple
  // of 8 — packRaster divides by 8 and would drop a partial byte otherwise.
  const w = Math.floor(dotWidth / 8) * 8;
  const h = Math.ceil((fontPx * 1.35) / 8) * 8;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#000";
  ctx.textBaseline = "middle";
  // No explicit family: the platform picks one that actually has the glyphs.
  // Naming a Latin font here would render CJK as tofu boxes.
  ctx.font = `${opts?.bold ? "bold " : ""}${fontPx}px sans-serif`;

  const right = (opts?.right ?? "").trim();
  const textW = ctx.measureText(text).width;
  // Keep a gap so the name and the money never touch.
  const rightW = right ? ctx.measureText(right).width + fontPx * 0.5 : 0;

  // Only share the row if the WHOLE name still fits beside the price. At a
  // large font "2x 椒盐鸡" and "17.00" do not both fit on 80mm, and trimming
  // the name to make room for the money is the wrong way round — the kitchen
  // needs the dish. When it will not fit, the price goes back to its own line
  // and the caller is told so.
  const rightDrawn = !!right && textW + rightW <= w;
  if (rightDrawn) {
    ctx.textAlign = "right";
    ctx.fillText(right, w, h / 2);
    ctx.textAlign = "left";
  }

  // Trim rather than squeeze: fillText's maxWidth compresses the glyphs, and a
  // squashed CJK character is harder to read than a shortened name.
  const available = rightDrawn ? w - rightW : w;
  let shown = text;
  while (shown.length > 1 && ctx.measureText(shown).width > available) {
    shown = shown.slice(0, -1);
  }
  ctx.fillText(shown, 0, h / 2);
  return { bytes: packRaster(ctx, w, h), rightDrawn };
}

// Cache rastered logos per (url|width) so we don't re-decode the image
// on every order print.
const logoCache = new Map<string, number[] | null>();

// Pack a canvas region into an ESC/POS raster bitmap (GS v 0): 1 bit per
// dot, rows padded to whole bytes. Shared by the logo and the QR — a raster
// is just pixels, so any printer that can print a logo can print it.
function packRaster(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): number[] {
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
  return [
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
          result = packRaster(ctx, w, h);
        }
      }
    }
  } catch {
    result = null;
  }
  logoCache.set(key, result);
  return result;
}

/**
 * How to get a QR onto the paper.
 *
 *   ESCPOS — GS ( k, the printer draws the code from the data. Compact and
 *            fast, and what Epson and most thermal printers implement.
 *   RASTER — we draw the code ourselves and send it as a bitmap.
 *
 * Sunmi needs RASTER. Its firmware implements neither GS ( k (which it drops
 * silently, leaving a blank slip) nor Sunmi's own documented ESC Z (which it
 * failed to recognise, printing the raw URL as text — worse than blank). A
 * raster is just pixels: any printer that can print a logo can print it, and
 * Sunmi prints logos fine.
 */
export type QrDialect = "ESCPOS" | "RASTER";

// Rendered QRs cached per (data|width) — the offer URL is the same on every
// order, so this encodes once per session rather than once per ticket.
const qrRasterCache = new Map<string, number[] | null>();

/**
 * Draw a QR to an ESC/POS raster bitmap.
 *
 * Rendered through qrcode.react, which is already how the dashboard draws
 * table-tent and payment-link codes — a proven encoder rather than a
 * hand-rolled one, and no new dependency. It's a React component, so it goes
 * into a detached container off-screen; both it and React are imported
 * dynamically so a page that never prints doesn't carry them.
 *
 * Returns null if anything fails, and the caller falls back to the native
 * command — a printer that ignores GS ( k is no worse off than before.
 */
export async function qrToRaster(
  data: string,
  maxWidthDots: number,
): Promise<number[] | null> {
  if (typeof document === "undefined") return null;
  const key = `${data}|${maxWidthDots}`;
  if (qrRasterCache.has(key)) return qrRasterCache.get(key) ?? null;

  let result: number[] | null = null;
  let host: HTMLDivElement | null = null;
  let root: { render: (n: any) => void; unmount: () => void } | null = null;
  try {
    const [{ createRoot }, { QRCodeCanvas }, React] = await Promise.all([
      import("react-dom/client"),
      import("qrcode.react"),
      import("react"),
    ]);

    host = document.createElement("div");
    // Off-screen rather than display:none — a hidden subtree can skip layout,
    // and we need the canvas to actually paint before reading it back.
    host.style.cssText =
      "position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden";
    document.body.appendChild(host);

    root = createRoot(host);
    root.render(
      React.createElement(QRCodeCanvas, {
        value: data,
        size: maxWidthDots,
        level: "L",
        marginSize: 2, // quiet zone, or scanners struggle at the edges
      }),
    );

    // React 18 commits asynchronously and qrcode.react paints in an effect,
    // so wait for the canvas to exist and have been drawn.
    const canvas = await waitForCanvas(host);
    if (canvas && canvas.width > 0) {
      // The backing store is devicePixelRatio-scaled; resample to whole dots.
      let w = Math.min(maxWidthDots, canvas.width);
      w = Math.floor(w / 8) * 8; // raster rows are whole bytes
      if (w >= 8) {
        const out = document.createElement("canvas");
        out.width = w;
        out.height = w; // QRs are square
        const ctx = out.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, w, w);
          // Nearest-neighbour: smoothing greys the module edges, and a grey
          // edge either side of the threshold is a code that won't scan.
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(canvas, 0, 0, w, w);
          result = packRaster(ctx, w, w);
        }
      }
    }
  } catch {
    result = null;
  } finally {
    try {
      root?.unmount();
    } catch {
      /* already gone */
    }
    if (host?.parentNode) host.parentNode.removeChild(host);
  }

  qrRasterCache.set(key, result);
  return result;
}

/**
 * Wait for the canvas qrcode.react paints into.
 *
 * Polled with a timer, deliberately NOT requestAnimationFrame: auto-print
 * fires when an order lands, and by then the POS tab is often in the
 * background, where rAF callbacks are throttled to a standstill. Waiting on
 * one there would never resolve and the whole print would hang behind it.
 * Resolves null once the deadline passes so the caller falls back instead.
 */
function waitForCanvas(
  host: HTMLElement,
  timeoutMs = 2000,
): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const canvas = host.querySelector("canvas") as HTMLCanvasElement | null;
      if (canvas && canvas.width > 0) {
        resolve(canvas);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(tick, 16);
    };
    setTimeout(tick, 0);
  });
}

/**
 * The QR command bytes for this printer: a bitmap where the firmware can't
 * draw codes itself, the native command everywhere else.
 */
export async function qrCommandBytes(
  data: string,
  paperWidth: number,
  dialect: QrDialect = "ESCPOS",
): Promise<number[]> {
  if (dialect === "RASTER") {
    // ~48mm on 80mm paper, ~35mm on 58mm (203dpi heads are 8 dots/mm).
    // Matches what the native command produces rather than filling the roll,
    // and both are comfortably inside the printable width.
    const raster = await qrToRaster(data, paperWidth === 58 ? 280 : 384);
    if (raster) return raster;
  }
  return qrEscPos(data, qrModuleSize(data, paperWidth));
}


/**
 * Largest module size whose code still fits the paper.
 *
 * A QR wider than the print head is discarded whole by most firmware —
 * another way to get a blank space where the code should be. Module count
 * grows with the data, so a long reorder URL on 58mm paper is the case that
 * overflows. Estimating the version from the byte count (EC level L) is
 * enough: we only need an upper bound on the width.
 */
export function qrModuleSize(data: string, paperWidth: number): number {
  // Printable dots, minus a margin so the quiet zone isn't clipped.
  const dots = paperWidth === 58 ? 360 : 512;
  const len = strBytes(data).length;
  // Byte-mode capacity at EC level L, by version. Index = version - 1.
  const CAPACITY_L = [
    17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586,
    644, 718, 792, 858,
  ];
  let version = CAPACITY_L.findIndex((cap) => len <= cap) + 1;
  if (version <= 0) version = CAPACITY_L.length; // absurdly long — clamp
  const modules = 17 + 4 * version + 8; // code width + 4-module quiet zone each side
  const fits = Math.floor(dots / modules);
  // Never below 3: smaller than that and a phone camera struggles. If even
  // 3 doesn't fit the code is unprintable at this width anyway.
  return Math.max(3, Math.min(paperWidth === 58 ? 5 : 6, fits));
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
    /** Pre-encoded QR (raster or native). Falls back to GS ( k when absent. */
    qrCodeBytes?: number[] | null;
    fontScale?: FontScale;
    modifierScale?: FontScale;
    printFont?: PrintFont;
  },
): Uint8Array {
  // Bound to this order's currency; shadows the module-level helper so every
  // price below prints in the shop's own money.
  const money = (n: any) => moneyIn(n, (payload as any)?.currency);
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
    // Kitchen-language name wins when the location has translations on and
    // this product has one. Replaces the English rather than adding a line:
    // a kitchen reading Chinese should not scan past the English to find it.
    const name = String(
      it?.secondLanguageName ||
        it?.name ||
        it?.productName ||
        it?.title ||
        "Item",
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
    // CP437 cannot represent CJK — strBytes would turn the whole name into
    // question marks — so a translated line is drawn as pixels instead, the
    // same way the QR code and logo already are. Falls through to normal text
    // when there is no canvas (a headless render), which prints English.
    const rastered = needsRaster(head)
      // Same dot widths the QR raster uses for each paper size.
      ? rasterTextLine(head, paperWidth === 58 ? 280 : 384, {
          bold: true,
          // A raster is pixels, so the printer's double-height command does
          // nothing to it — the size setting has to be applied to the FONT.
          // Without this, turning item text up enlarged the price and left the
          // Chinese name exactly as it was.
          fontPx: 30 * itemH,
          right: priceStr,
        })
      : null;
    if (rastered) {
      buf.push(...ALIGN_LEFT, ...rastered.bytes);
      // Too wide to share the row — the price keeps its own line rather than
      // costing the name characters.
      if (!rastered.rightDrawn && priceStr)
        line(buf, padBetween("", priceStr, itemCols));
    } else if (head.length + 1 + priceStr.length <= itemCols) {
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
        // Kitchen-language name wins, same rule as the item line above.
        const mname = String(
          m?.secondLanguageName || m?.name || m?.title || "",
        );
        if (!mname) continue;
        const mprice =
          typeof m?.price === "number" && m.price > 0
            ? `+${money(m.price)}`
            : "";
        const mline = `  - ${mname}`;
        // CP437 cannot carry CJK, so a translated option is drawn as pixels
        // like the item line. Modifier text is smaller, so the raster is too.
        const modRaster = needsRaster(mline)
          ? rasterTextLine(mline, paperWidth === 58 ? 280 : 384, {
              // Same reason as the item line: the printer cannot scale a
              // bitmap, so the modifier size setting is applied to the font.
              fontPx: 22 * modH,
              right: mprice,
            })
          : null;
        if (modRaster) {
          buf.push(...ALIGN_LEFT, ...modRaster.bytes);
          if (!modRaster.rightDrawn && mprice)
            line(buf, padBetween("", mprice, modCols));
        } else if (mprice && mline.length + 1 + mprice.length <= modCols)
          line(buf, padBetween(mline, mprice, modCols));
        else for (const w of indented(mname, "  - ", modCols)) line(buf, w);
      }
      buf.push(...MOD_OFF);
    }
    // Item note — reversed out, like the payment banner.
    //
    // It used to print as "** seperate", which shops read as a footnote
    // marker rather than an instruction, and asked what the stars meant. A
    // missed "NO ONIONS" is a remake, so it now says Note: and carries the
    // same black bar the payment line uses — the one thing on the ticket
    // staff already know means read this. Lines are padded to the full width
    // so the bar is a rectangle rather than ragged around the text.
    if (it?.notes) {
      buf.push(...BOLD_ON, ...MOD_ON, ...reverseOn());
      for (const w of indented(String(it.notes), "  Note: ", modCols))
        line(buf, w.padEnd(modCols, " "));
      buf.push(...reverseOff(), ...MOD_OFF, ...BOLD_OFF);
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
  if (typeof payload?.tipAmount === "number" && payload.tipAmount > 0)
    showRow("Tip", payload.tipAmount);
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
    // Full-width reverse-video band, matching the two server renderers. This
    // is the path the POS prints through, so it is the one the counter
    // actually sees — it printed plain bold while the server renderers were
    // already inverting, which is why tickets looked unhighlighted.
    buf.push(...ALIGN_LEFT, ...sizeOn(1, 2), ...reverseOn());
    line(buf, centreOn(String(payload.paymentLabel).trim(), cols));
    buf.push(...reverseOff(), ...DOUBLE_OFF);
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
    buf.push(
      ...(opts.qrCodeBytes ??
        qrEscPos(String(opts.qr), qrModuleSize(String(opts.qr), paperWidth))),
    );
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
// Star Line Mode inverse (white on black) — ESC 4 / ESC 5. The counterpart of
// ESC/POS `GS B`, which Star firmware does not implement.
const STAR_REVERSE_ON = [ESC, 0x34];
const STAR_REVERSE_OFF = [ESC, 0x35];

export function buildOrderReceiptStar(
  payload: any,
  paperWidth: number = 80,
  opts?: { fontScale?: FontScale; modifierScale?: FontScale },
): Uint8Array {
  // Bound to this order's currency; shadows the module-level helper so every
  // price below prints in the shop's own money.
  const money = (n: any) => moneyIn(n, (payload as any)?.currency);
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
    // Item note — see the note in the ESC/POS variant above.
    if (it?.notes) {
      buf.push(...STAR_BOLD_ON, ...STAR_MOD_ON, ...reverseOn());
      for (const w of indented(String(it.notes), "  Note: ", modCols))
        line(buf, w.padEnd(modCols, " "));
      buf.push(...reverseOff(), ...STAR_MOD_OFF, ...STAR_BOLD_OFF);
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
  if (typeof payload?.tipAmount === "number" && payload.tipAmount > 0)
    showRow("Tip", payload.tipAmount);
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
    // Same band on Star hardware. Star Line Mode has no `GS B`, so this uses
    // ESC 4 / ESC 5 — the ESC/POS bytes would print as stray characters.
    buf.push(...STAR_ALIGN_LEFT, ...STAR_REVERSE_ON);
    line(buf, centreOn(String(payload.paymentLabel).trim(), cols));
    buf.push(...STAR_REVERSE_OFF);
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
//
// The QR attaches to the bottom of the ticket itself, above the single
// closing cut — NOT a separate cut-free slip. A separate second ticket
// (its own INIT + cut mid-job) turned out to not be supported by every
// printer model in the field, so this went back to one continuous ticket
// like it originally was.
export async function renderReceiptBytes(
  payload: any,
  paperWidth: number = 80,
  opts?: {
    printLogo?: boolean;
    qrCode?: boolean;
    commandSet?: string;
    /** Sunmi can't draw codes itself — see QrDialect. */
    qrDialect?: QrDialect;
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
  const qrCodeBytes = qr
    ? await qrCommandBytes(qr, paperWidth, opts?.qrDialect ?? "ESCPOS")
    : null;
  return buildOrderReceipt(payload, paperWidth, {
    logoBytes,
    qr,
    qrCodeBytes,
    fontScale: opts?.fontScale,
    modifierScale: opts?.modifierScale,
    printFont: opts?.printFont,
  });
}

/**
 * Receipt (without QR) plus the same receipt WITH the QR attached at the
 * bottom, built separately so callers printing N copies can repeat the
 * plain receipt for the kitchen/counter and only attach the QR to the
 * LAST copy — the one that goes in the customer's bag. Baking the QR into
 * every copy would print it N times for one order.
 */
/**
 * A QR on a ticket of its own, printed after the receipt.
 *
 * Some shops want the reorder QR attached to the bottom of the receipt (one
 * ticket, one cut); others want it separate, so it can go in the bag while the
 * receipt goes to the customer, or on the counter, or in the bin when they
 * don't want it. Both are reasonable, and which one is right depends on how
 * that shop hands food over — so it's a printer setting rather than a rule.
 *
 * Deliberately its own ESC/POS document: INIT at the top and CUT at the bottom,
 * so the printer treats it as a second ticket rather than more of the first.
 */
function buildQrSlip(
  payload: any,
  paperWidth: number,
  qr: string,
  qrCodeBytes: number[] | null,
  printFont: PrintFont = "A",
): Uint8Array {
  const buf: number[] = [];
  const cols = colsForFont(paperWidth, printFont);
  buf.push(...INIT);
  buf.push(...ALIGN_CENTER);
  buf.push(LF);

  // Enough of the order to tie the slip back to the receipt it followed —
  // two tickets landing in a pile are otherwise impossible to pair up.
  if (payload?.orderNumber || payload?.displayId) {
    buf.push(...BOLD_ON);
    line(buf, String(payload.displayId ?? `#${payload.orderNumber}`));
    buf.push(...BOLD_OFF);
  }
  if (payload?.qrCaption) {
    buf.push(...BOLD_ON);
    for (const w of wrap(String(payload.qrCaption), cols)) line(buf, w);
    buf.push(...BOLD_OFF);
  }
  buf.push(LF);
  buf.push(
    ...(qrCodeBytes ?? qrEscPos(qr, qrModuleSize(qr, paperWidth))),
  );
  buf.push(LF);
  buf.push(...ALIGN_LEFT);
  buf.push(LF, LF, LF, LF);
  buf.push(...CUT);
  return new Uint8Array(buf);
}

export async function renderReceiptParts(
  payload: any,
  paperWidth: number = 80,
  opts?: Parameters<typeof renderReceiptBytes>[2],
): Promise<{
  receipt: Uint8Array;
  receiptWithQr: Uint8Array | null;
  qrSlip: Uint8Array | null;
}> {
  if (String(opts?.commandSet ?? "").toUpperCase() === "STAR") {
    // Star Line Mode has its own builder and no QR support here.
    return {
      receipt: await renderReceiptBytes(payload, paperWidth, opts),
      receiptWithQr: null,
      qrSlip: null,
    };
  }
  let logoBytes: number[] | null = null;
  if (opts?.printLogo !== false && payload?.brandLogoUrl) {
    const maxDots = paperWidth === 58 ? 360 : 512;
    logoBytes = await imageToRaster(String(payload.brandLogoUrl), maxDots);
  }
  const qr = opts?.qrCode && payload?.qrData ? String(payload.qrData) : null;
  const receipt = buildOrderReceipt(payload, paperWidth, {
    logoBytes,
    qr: null,
    fontScale: opts?.fontScale,
    modifierScale: opts?.modifierScale,
    printFont: opts?.printFont,
  });
  if (!qr) return { receipt, receiptWithQr: null, qrSlip: null };
  const qrCodeBytes = await qrCommandBytes(
    qr,
    paperWidth,
    opts?.qrDialect ?? "ESCPOS",
  );
  const receiptWithQr = buildOrderReceipt(payload, paperWidth, {
    logoBytes,
    qr,
    qrCodeBytes,
    fontScale: opts?.fontScale,
    modifierScale: opts?.modifierScale,
    printFont: opts?.printFont,
  });
  return {
    receipt,
    receiptWithQr,
    qrSlip: buildQrSlip(payload, paperWidth, qr, qrCodeBytes, opts?.printFont),
  };
}

/**
 * `copies - 1` plain receipts followed by ONE receipt with the QR attached
 * at its bottom — every copy is still one continuous ticket with a single
 * cut, just the last one carries the QR.
 */
export function joinReceiptAndQr(
  receipt: Uint8Array,
  receiptWithQr: Uint8Array | null,
  copies: number,
  /**
   * A QR on its own ticket, for shops that want it separate from the receipt.
   * When given, every copy is a plain receipt and the slip follows the last
   * one — so the QR can go in the bag while the receipt goes to the customer.
   */
  qrSlip?: Uint8Array | null,
): Uint8Array {
  const n = Math.max(1, Math.floor(copies) || 1);

  if (qrSlip) {
    const body = repeatReceipt(receipt, n);
    const out = new Uint8Array(body.length + qrSlip.length);
    out.set(body, 0);
    out.set(qrSlip, body.length);
    return out;
  }

  if (!receiptWithQr) return repeatReceipt(receipt, n);
  const leading = n > 1 ? repeatReceipt(receipt, n - 1) : new Uint8Array(0);
  const out = new Uint8Array(leading.length + receiptWithQr.length);
  out.set(leading, 0);
  out.set(receiptWithQr, leading.length);
  return out;
}
