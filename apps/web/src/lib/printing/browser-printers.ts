// Printing from a plain desktop browser (Windows/Mac Chrome or Edge), with
// no tablet app and no Print Bridge install.
//
// A printer record is LINKED to this computer, one of three ways:
//   webusb    — raw bytes down the USB cable (Chrome/Edge WebUSB). Same
//               ESC/POS stream the tablet sends, so logos, QR, cut, drawer
//               kick all work. On Windows the printer's own driver usually
//               holds the device; then claimInterface fails and the shop
//               either swaps it to WinUSB (Zadig) or uses `system` below.
//   webserial — raw bytes to a COM port (Chrome/Edge Web Serial). Covers
//               USB-serial printers AND Bluetooth printers paired in
//               Windows, which appear as an "outgoing" COM port.
//   system    — the browser's print dialog to any printer Windows has a
//               driver for (Epson TM, Star, generic 80mm). The ESC/POS
//               ticket is redrawn as HTML so every receipt layout, filter
//               and copy count still applies. Silent with Chrome/Edge
//               started with --kiosk-printing.
//
// The link lives in this browser's localStorage, keyed by printer id —
// the USB/COM device is physically attached to THIS computer, so it's a
// per-device setting like the tablet's printer pin, not a server field.

export type BrowserPrinterLink =
  | {
      mode: "webusb";
      vendorId: number;
      productId: number;
      serialNumber?: string | null;
      label: string;
    }
  | {
      mode: "webserial";
      usbVendorId?: number;
      usbProductId?: number;
      bluetoothServiceClassId?: string | number;
      baudRate: number;
      label: string;
    }
  | { mode: "system"; label: string };

const STORAGE_KEY = "orderhub.browser-printers.v1";

function readLinks(): Record<string, BrowserPrinterLink> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export const BROWSER_PRINTERS_CHANGED = "orderhub:browser-printers-changed";

function writeLinks(links: Record<string, BrowserPrinterLink>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(links));
  } catch {
    // private window / storage blocked — the link just won't persist
  }
  // Auto-print decides once per render whether this browser can print;
  // tell it a printer was just linked or unlinked.
  window.dispatchEvent(new Event(BROWSER_PRINTERS_CHANGED));
}

export function getBrowserPrinterLink(printerId: string | undefined | null): BrowserPrinterLink | null {
  if (typeof window === "undefined" || !printerId) return null;
  return readLinks()[printerId] ?? null;
}

export function setBrowserPrinterLink(printerId: string, link: BrowserPrinterLink | null) {
  const links = readLinks();
  if (link) links[printerId] = link;
  else delete links[printerId];
  writeLinks(links);
}

export function hasBrowserPrinterLinks(): boolean {
  if (typeof window === "undefined") return false;
  return Object.keys(readLinks()).length > 0;
}

export function browserSupportsWebUsb(): boolean {
  return typeof navigator !== "undefined" && !!(navigator as any).usb;
}

export function browserSupportsWebSerial(): boolean {
  return typeof navigator !== "undefined" && !!(navigator as any).serial;
}

// ── Linking (needs a user click — the browser's device chooser) ─────

const USB_CLASS_PRINTER = 7;
const USB_CLASS_VENDOR = 0xff;

export async function chooseUsbPrinter(): Promise<BrowserPrinterLink> {
  const usb = (navigator as any).usb;
  if (!usb) throw new Error("This browser can't reach USB devices — use Chrome or Edge.");
  // No filter: plenty of ESC/POS printers report vendor class (0xFF), not
  // printer class, so filtering on class 7 would hide them.
  const device = await usb.requestDevice({ filters: [] });
  return {
    mode: "webusb",
    vendorId: device.vendorId,
    productId: device.productId,
    serialNumber: device.serialNumber ?? null,
    label: [device.manufacturerName, device.productName].filter(Boolean).join(" ") || "USB printer",
  };
}

export async function chooseSerialPrinter(baudRate = 9600): Promise<BrowserPrinterLink> {
  const serial = (navigator as any).serial;
  if (!serial) throw new Error("This browser can't reach COM ports — use Chrome or Edge.");
  const port = await serial.requestPort();
  const info = port.getInfo?.() ?? {};
  return {
    mode: "webserial",
    usbVendorId: info.usbVendorId,
    usbProductId: info.usbProductId,
    bluetoothServiceClassId: info.bluetoothServiceClassId,
    baudRate,
    label: info.bluetoothServiceClassId
      ? "Bluetooth COM port"
      : info.usbVendorId
        ? `COM port (USB ${hex(info.usbVendorId)}:${hex(info.usbProductId)})`
        : "COM port",
  };
}

function hex(n: unknown): string {
  return typeof n === "number" ? n.toString(16).padStart(4, "0") : "?";
}

// ── Printing ────────────────────────────────────────────────────────

export async function printViaBrowserLink(
  link: BrowserPrinterLink,
  bytes: Uint8Array,
  printer: { paperWidth?: number | null; defaults?: any; model?: string | null },
): Promise<void> {
  if (link.mode === "webusb") return writeWebUsb(link, bytes);
  if (link.mode === "webserial") return writeWebSerial(link, bytes);
  return printViaSystemDialog(bytes, {
    paperWidth: printer.paperWidth === 58 ? 58 : 80,
    star: isStarPrinter(printer),
  });
}

async function writeWebUsb(
  link: Extract<BrowserPrinterLink, { mode: "webusb" }>,
  bytes: Uint8Array,
) {
  const usb = (navigator as any).usb;
  if (!usb) throw new Error("USB printing needs Chrome or Edge on this computer.");
  const devices: any[] = await usb.getDevices();
  const device =
    devices.find(
      (d) =>
        d.vendorId === link.vendorId &&
        d.productId === link.productId &&
        (!link.serialNumber || d.serialNumber === link.serialNumber),
    ) ?? devices.find((d) => d.vendorId === link.vendorId && d.productId === link.productId);
  if (!device) {
    throw new Error("USB printer not found — check the cable, or link it again under Printers.");
  }
  if (!device.opened) await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);

  const target = findBulkOut(device);
  if (!target) throw new Error("This USB device has no printer output — is it a receipt printer?");
  try {
    const iface = device.configuration.interfaces.find(
      (i: any) => i.interfaceNumber === target.interfaceNumber,
    );
    if (!iface?.claimed) await device.claimInterface(target.interfaceNumber);
  } catch {
    throw new Error(
      "Windows' printer driver is holding this USB printer. Either link it as \"Windows printer\" instead, or switch its driver to WinUSB (Zadig) and link it again.",
    );
  }
  const CHUNK = 16 * 1024;
  for (let off = 0; off < bytes.length; off += CHUNK) {
    const res = await device.transferOut(target.endpointNumber, bytes.subarray(off, off + CHUNK));
    if (res?.status && res.status !== "ok") {
      throw new Error(`USB printer stopped accepting data (${res.status}) — check paper and cover.`);
    }
  }
}

function findBulkOut(device: any): { interfaceNumber: number; endpointNumber: number } | null {
  let fallback: { interfaceNumber: number; endpointNumber: number } | null = null;
  for (const iface of device.configuration?.interfaces ?? []) {
    for (const alt of iface.alternates ?? []) {
      const ep = (alt.endpoints ?? []).find((e: any) => e.direction === "out" && e.type === "bulk");
      if (!ep) continue;
      const hit = { interfaceNumber: iface.interfaceNumber, endpointNumber: ep.endpointNumber };
      if (alt.interfaceClass === USB_CLASS_PRINTER) return hit;
      if (!fallback && alt.interfaceClass === USB_CLASS_VENDOR) fallback = hit;
    }
  }
  return fallback;
}

async function writeWebSerial(
  link: Extract<BrowserPrinterLink, { mode: "webserial" }>,
  bytes: Uint8Array,
) {
  const serial = (navigator as any).serial;
  if (!serial) throw new Error("COM port printing needs Chrome or Edge on this computer.");
  const ports: any[] = await serial.getPorts();
  const matches = ports.filter((p) => {
    const info = p.getInfo?.() ?? {};
    if (link.usbVendorId) {
      return info.usbVendorId === link.usbVendorId && info.usbProductId === link.usbProductId;
    }
    if (link.bluetoothServiceClassId) {
      return info.bluetoothServiceClassId === link.bluetoothServiceClassId;
    }
    return true;
  });
  const port = matches[0];
  if (!port) {
    throw new Error("COM port not found — check the printer is connected, or link it again under Printers.");
  }
  if (!port.writable) await port.open({ baudRate: link.baudRate || 9600 });
  const writer = port.writable.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    writer.releaseLock();
  }
}

function isStarPrinter(printer: { defaults?: any; model?: string | null }): boolean {
  const d = printer?.defaults ?? {};
  return (
    String(d.commandSet ?? "").toUpperCase() === "STAR" ||
    String(d.brand ?? "").toLowerCase() === "star" ||
    /star/i.test(String(printer?.model ?? ""))
  );
}

// ── System print dialog: ESC/POS → HTML ─────────────────────────────

// CP437 upper half — the code page the renderer selects (ESC t 0); £ is 0x9C.
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

type Seg = { text: string; bold: boolean; w: number; h: number; reverse: boolean };
type Line = { align: "left" | "center" | "right"; segs: Seg[]; image?: string; feed?: boolean };

/**
 * Replays the byte stream the receipt renderers produce (bridge.ts:
 * ESC/POS, or Star Line Mode) into lines of styled text. Only the commands
 * our own renderers emit are understood; anything else is skipped by its
 * declared length so it can't desync the text.
 */
export function receiptBytesToTickets(bytes: Uint8Array, star = false): Line[][] {
  const tickets: Line[][] = [];
  let lines: Line[] = [];
  let align: Line["align"] = "left";
  let bold = false;
  let w = 1;
  let h = 1;
  let reverse = false;
  let segs: Seg[] = [];
  let text = "";

  const flushText = () => {
    if (text) segs.push({ text, bold, w, h, reverse });
    text = "";
  };
  const endLine = () => {
    flushText();
    lines.push({ align, segs });
    segs = [];
  };
  const cut = () => {
    if (text || segs.length) endLine();
    if (lines.length) tickets.push(lines);
    lines = [];
  };
  const style = (fn: () => void) => {
    flushText();
    fn();
  };

  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i]!;
    if (b === 0x0a) {
      endLine();
      i++;
    } else if (b === 0x1b) {
      const c = bytes[i + 1];
      if (c === 0x40) {
        style(() => {
          align = "left";
          bold = false;
          w = h = 1;
          reverse = false;
        });
        i += 2;
      } else if (star && c === 0x1d && bytes[i + 2] === 0x61) {
        const v = bytes[i + 3] ?? 0;
        align = v === 1 ? "center" : v === 2 ? "right" : "left";
        i += 4;
      } else if (star && (c === 0x34 || c === 0x35)) {
        // ESC 4 / ESC 5 — Star reverse print on / off
        style(() => (reverse = c === 0x34));
        i += 2;
      } else if (star && c === 0x45) {
        style(() => (bold = true));
        i += 2;
      } else if (star && c === 0x46) {
        style(() => (bold = false));
        i += 2;
      } else if (star && c === 0x69) {
        // ESC i n1 n2 — height, width (0 = normal)
        style(() => {
          h = (bytes[i + 2] ?? 0) + 1;
          w = (bytes[i + 3] ?? 0) + 1;
        });
        i += 4;
      } else if (star && c === 0x64) {
        cut();
        i += 3;
      } else if (c === 0x61) {
        const v = bytes[i + 2] ?? 0;
        align = v === 1 || v === 0x31 ? "center" : v === 2 || v === 0x32 ? "right" : "left";
        i += 3;
      } else if (c === 0x45) {
        style(() => (bold = (bytes[i + 2] ?? 0) & 1 ? true : false));
        i += 3;
      } else if (c === 0x21) {
        const v = bytes[i + 2] ?? 0;
        style(() => {
          bold = !!(v & 0x08);
          h = v & 0x10 ? 2 : 1;
          w = v & 0x20 ? 2 : 1;
        });
        i += 3;
      } else if (c === 0x64 || c === 0x4a) {
        // feed n lines
        const count = Math.min(10, bytes[i + 2] ?? 1);
        if (text || segs.length) endLine();
        for (let k = 0; k < count; k++) lines.push({ align, segs: [], feed: true });
        i += 3;
      } else if (c === 0x70) {
        i += 5; // ESC p m t1 t2 — cash drawer kick
      } else if (c === 0x2a) {
        const m = bytes[i + 2] ?? 0;
        const cols = (bytes[i + 3] ?? 0) + (bytes[i + 4] ?? 0) * 256;
        i += 5 + cols * (m >= 32 ? 3 : 1);
      } else if (c === 0x69 || c === 0x6d) {
        cut();
        i += 2;
      } else {
        // ESC t / M / - / G / 2 / 3 … all take a single parameter byte
        i += c === 0x32 ? 2 : 3;
      }
    } else if (b === 0x1d) {
      const c = bytes[i + 1];
      if (c === 0x21) {
        const v = bytes[i + 2] ?? 0;
        style(() => {
          w = (v >> 4) + 1;
          h = (v & 0x0f) + 1;
        });
        i += 3;
      } else if (c === 0x42) {
        style(() => (reverse = !!((bytes[i + 2] ?? 0) & 1)));
        i += 3;
      } else if (c === 0x56) {
        const m = bytes[i + 2] ?? 0;
        cut();
        i += m === 0x41 || m === 0x42 || m === 65 || m === 66 ? 4 : 3;
      } else if (c === 0x76 && bytes[i + 2] === 0x30) {
        const xBytes = (bytes[i + 4] ?? 0) + (bytes[i + 5] ?? 0) * 256;
        const yDots = (bytes[i + 6] ?? 0) + (bytes[i + 7] ?? 0) * 256;
        const start = i + 8;
        const end = start + xBytes * yDots;
        if (text || segs.length) endLine();
        const image = rasterToDataUrl(bytes.subarray(start, Math.min(end, n)), xBytes, yDots);
        if (image) lines.push({ align, segs: [], image });
        i = end;
      } else if (c === 0x28) {
        // GS ( <fn> pL pH data — QR / 2D codes
        const len = (bytes[i + 3] ?? 0) + (bytes[i + 4] ?? 0) * 256;
        i += 5 + len;
      } else if (c === 0x4c || c === 0x57) {
        i += 4;
      } else {
        i += 3;
      }
    } else if (b >= 0x20) {
      text += b < 0x80 ? String.fromCharCode(b) : (CP437_HIGH[b - 0x80] ?? "?");
      i++;
    } else {
      i++; // CR and other control bytes
    }
  }
  cut();
  return tickets;
}

function rasterToDataUrl(data: Uint8Array, xBytes: number, yDots: number): string | null {
  if (typeof document === "undefined" || !xBytes || !yDots) return null;
  const canvas = document.createElement("canvas");
  canvas.width = xBytes * 8;
  canvas.height = yDots;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < yDots; y++) {
    for (let xb = 0; xb < xBytes; xb++) {
      const byte = data[y * xBytes + xb] ?? 0;
      for (let bit = 0; bit < 8; bit++) {
        const on = (byte >> (7 - bit)) & 1;
        const p = (y * canvas.width + xb * 8 + bit) * 4;
        const v = on ? 0 : 255;
        img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
        img.data[p + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function ticketsToHtml(tickets: Line[][], paperWidth: 58 | 80): string {
  // Printable width of an 80mm / 58mm roll, and the column count the
  // renderer laid the text out for (Font A).
  const printMm = paperWidth === 58 ? 48 : 72;
  const cols = paperWidth === 58 ? 32 : 42;
  const charMm = printMm / cols;
  const body = tickets
    .map((lines) => {
      const rows = lines
        .map((l) => {
          const justify = l.align === "center" ? "center" : l.align === "right" ? "flex-end" : "flex-start";
          if (l.image) {
            return `<div class="l" style="justify-content:${justify}"><img src="${l.image}" alt="" /></div>`;
          }
          const maxH = Math.max(1, ...l.segs.map((s) => s.h));
          const spans = l.segs
            .map((s) => {
              const scaleY = s.h / s.w;
              const css = [
                `font-size:${(charMm / 0.6) * s.w}mm`,
                s.bold ? "font-weight:700" : "",
                s.reverse ? "background:#000;color:#fff" : "",
                scaleY !== 1 ? `display:inline-block;transform:scaleY(${scaleY});transform-origin:left bottom` : "",
              ]
                .filter(Boolean)
                .join(";");
              return `<span style="${css}">${escapeHtml(s.text)}</span>`;
            })
            .join("");
          return `<div class="l" style="justify-content:${justify};min-height:${(charMm / 0.6) * 1.2 * maxH}mm">${spans || "&nbsp;"}</div>`;
        })
        .join("");
      return `<section class="t">${rows}</section>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Receipt</title><style>
@page { size: ${paperWidth}mm auto; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body { width: ${printMm}mm; padding: 2mm ${(paperWidth - printMm) / 2}mm; font-family: "Courier New", Consolas, monospace; }
.l { white-space: pre; line-height: 1.2; overflow: hidden; display: flex; align-items: flex-end; }
.l img { max-width: 100%; image-rendering: pixelated; }
.t { break-after: page; page-break-after: always; padding-bottom: 4mm; }
.t:last-child { break-after: auto; page-break-after: auto; }
</style></head><body>${body}</body></html>`;
}

// One dialog at a time — a second print() while one is open is dropped by
// the browser, so queue them the same way the raw transports are queued.
async function printViaSystemDialog(
  bytes: Uint8Array,
  opts: { paperWidth: 58 | 80; star: boolean },
): Promise<void> {
  const tickets = receiptBytesToTickets(bytes, opts.star);
  if (tickets.length === 0) return; // e.g. a drawer kick — nothing to put on paper
  const html = ticketsToHtml(tickets, opts.paperWidth);

  await new Promise<void>((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(frame);
    const cleanup = () => setTimeout(() => frame.remove(), 1000);
    frame.onload = () => {
      try {
        const win = frame.contentWindow!;
        win.focus();
        // Blocks until the dialog closes (or returns at once with
        // --kiosk-printing), so resolving after it means "sent".
        win.print();
        cleanup();
        resolve();
      } catch (e: any) {
        cleanup();
        reject(new Error(e?.message ?? "Browser print failed"));
      }
    };
    frame.srcdoc = html;
  });
}
