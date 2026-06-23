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

export function buildTestReceipt(paperWidth: 58 | 80 = 80): Uint8Array {
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

// Best-effort order receipt. We accept a loose shape so any Order
// payload from the API works — missing fields just collapse cleanly.
export function buildOrderReceipt(
  order: any,
  paperWidth: 58 | 80 = 80,
): Uint8Array {
  const cols = colsFor(paperWidth);
  const buf: number[] = [];
  buf.push(...INIT);

  buf.push(...ALIGN_CENTER, ...BOLD_ON, ...DOUBLE_ON);
  line(buf, order?.displayId ? `#${order.displayId}` : "NEW ORDER");
  buf.push(...DOUBLE_OFF);
  line(buf, String(order?.brand?.name ?? order?.location?.name ?? ""));
  buf.push(...BOLD_OFF);
  line(buf, new Date(order?.createdAt ?? Date.now()).toLocaleString());
  line(buf, "");

  buf.push(...ALIGN_LEFT);
  line(buf, `Channel : ${order?.source ?? order?.platform ?? "POS"}`);
  if (order?.fulfillmentType)
    line(buf, `Type    : ${order.fulfillmentType}`);
  if (order?.customerName)
    line(buf, `Customer: ${String(order.customerName).slice(0, cols - 10)}`);
  if (order?.customerPhone)
    line(buf, `Phone   : ${order.customerPhone}`);
  line(buf, "-".repeat(cols));

  const items = Array.isArray(order?.items) ? order.items : [];
  for (const it of items) {
    const qty = String(it?.quantity ?? 1);
    const name = String(it?.name ?? it?.productName ?? "Item").slice(
      0,
      cols - 10,
    );
    const price =
      typeof it?.totalPrice === "number"
        ? it.totalPrice.toFixed(2)
        : typeof it?.price === "number"
          ? (it.price * (it?.quantity ?? 1)).toFixed(2)
          : "";
    buf.push(...BOLD_ON);
    line(buf, padBetween(`${qty}x ${name}`, price, cols));
    buf.push(...BOLD_OFF);
    if (Array.isArray(it?.modifiers)) {
      for (const m of it.modifiers) {
        const mname = String(m?.name ?? "").slice(0, cols - 4);
        if (mname) line(buf, `   + ${mname}`);
      }
    }
    if (it?.notes) line(buf, `   ! ${String(it.notes).slice(0, cols - 5)}`);
  }
  line(buf, "-".repeat(cols));

  const total =
    typeof order?.totalAmount === "number"
      ? order.totalAmount.toFixed(2)
      : typeof order?.total === "number"
        ? order.total.toFixed(2)
        : "";
  if (total) {
    buf.push(...BOLD_ON, ...DOUBLE_ON);
    line(buf, padBetween("TOTAL", total, Math.floor(cols / 2)));
    buf.push(...DOUBLE_OFF, ...BOLD_OFF);
  }

  if (order?.notes) {
    line(buf, "");
    line(buf, "Notes:");
    line(buf, String(order.notes).slice(0, cols * 3));
  }

  buf.push(LF, LF, LF);
  buf.push(...CUT);
  return new Uint8Array(buf);
}
