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

const INIT = [ESC, 0x40];
const ALIGN_LEFT = [ESC, 0x61, 0x00];
const ALIGN_CENTER = [ESC, 0x61, 0x01];
const BOLD_ON = [ESC, 0x45, 0x01];
const BOLD_OFF = [ESC, 0x45, 0x00];
const DOUBLE_ON = [GS, 0x21, 0x11];
const DOUBLE_OFF = [GS, 0x21, 0x00];
const CUT = [GS, 0x56, 0x42, 0x00];
const reverseOn = () => [GS, 0x42, 0x01];
const reverseOff = () => [GS, 0x42, 0x00];

function colsFor(paperWidth: number): number {
  return paperWidth === 58 ? 32 : 42;
}

function strBytes(s: string): number[] {
  // CP437 / ASCII subset only — non-ASCII becomes "?". Real menus
  // shouldn't have funky glyphs on a thermal printer anyway.
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out.push(c < 0x80 ? c : 0x3f);
  }
  return out;
}

function line(buf: number[], text: string) {
  for (const b of strBytes(text)) buf.push(b);
  buf.push(LF);
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
  };
};

export function hasNativeBridge(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window as BridgeWindow).OrderHubBT?.isReady;
}

export async function bridgePrint(
  mac: string,
  bytes: Uint8Array,
): Promise<void> {
  if (!hasNativeBridge()) throw new Error("Bluetooth bridge not available");
  const b64 = bytesToBase64(bytes);
  await (window as BridgeWindow).OrderHubBT!.print(mac, b64);
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
function money(n: any): string {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return "";
  return v.toFixed(2);
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
): Uint8Array {
  const cols = colsFor(paperWidth);
  const buf: number[] = [];
  buf.push(...INIT);

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

  // ── Order meta ────────────────────────────────────────────────────
  buf.push(...ALIGN_LEFT);
  if (payload?.platform || payload?.orderSource)
    line(buf, `Channel : ${payload?.platform ?? payload?.orderSource}`);
  if (payload?.fulfillmentType)
    line(buf, `Type    : ${payload.fulfillmentType}`);
  if (payload?.customerName)
    line(buf, `Customer: ${String(payload.customerName).slice(0, cols - 10)}`);
  if (payload?.customerPhone)
    line(buf, `Phone   : ${payload.customerPhone}`);
  if (payload?.deliveryAddress) {
    line(buf, "Address :");
    for (const w of wrap(String(payload.deliveryAddress), cols - 2))
      line(buf, `  ${w}`);
  }
  line(buf, "-".repeat(cols));

  // ── Items ─────────────────────────────────────────────────────────
  const items = Array.isArray(payload?.items) ? payload.items : [];
  for (const it of items) {
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

    buf.push(...BOLD_ON);
    const head = `${qty}x ${name}`;
    if (head.length + 1 + priceStr.length <= cols) {
      line(buf, padBetween(head, priceStr, cols));
    } else {
      // Item name too long — wrap and put price on its own line
      const wrapped = wrap(head, cols - priceStr.length - 1);
      for (let i = 0; i < wrapped.length; i++) {
        if (i === 0) line(buf, padBetween(wrapped[i]!, priceStr, cols));
        else line(buf, wrapped[i]!);
      }
    }
    buf.push(...BOLD_OFF);

    if (Array.isArray(it?.modifiers)) {
      for (const m of it.modifiers) {
        const mname = String(m?.name ?? m?.title ?? "");
        if (!mname) continue;
        const mprice =
          typeof m?.price === "number" && m.price > 0
            ? `+${money(m.price)}`
            : "";
        const mline = `  + ${mname}`;
        if (mprice && mline.length + 1 + mprice.length <= cols)
          line(buf, padBetween(mline, mprice, cols));
        else line(buf, mline);
      }
    }
    if (it?.notes) {
      for (const w of wrap(`! ${String(it.notes)}`, cols - 4))
        line(buf, `   ${w}`);
    }
  }
  line(buf, "-".repeat(cols));

  // ── Totals ────────────────────────────────────────────────────────
  const showRow = (label: string, value: any) => {
    const s = money(value);
    if (s) line(buf, padBetween(label, s, cols));
  };
  showRow("Subtotal", payload?.subtotal);
  if (
    typeof payload?.deliveryFee === "number" &&
    payload.deliveryFee > 0
  )
    showRow("Delivery", payload.deliveryFee);
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

  // ── Footer ────────────────────────────────────────────────────────
  buf.push(LF, LF, LF, LF);
  buf.push(...CUT);
  return new Uint8Array(buf);
}
