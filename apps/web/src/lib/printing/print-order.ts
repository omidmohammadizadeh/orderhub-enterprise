// Shared "print this order now" routine — the exact path the order
// detail popup uses, so the order-list printer icon prints identically.
//
// Prints the full receipt straight to every Bluetooth printer at the
// order's location via the native bridge, then clears the order's
// server-side job(s) from the queue. Throws a clear message on failure
// so the caller can surface it.

import { printersClient } from "../api/printers.client";
import { marketingClient } from "../api/marketing.client";
import {
  hasNativeBridge,
  bridgeSupportsPrinter,
  writeToPrinter,
  renderReceiptBytes,
  repeatReceipt,
} from "./bridge";
import { buildPrintPayload } from "./order-receipt";

// Channels that should get a "scan to order online" QR. Online ordering
// and WhatsApp are excluded (they're already direct); everything else —
// the marketplaces (Uber Eats / Deliveroo / Just Eat / HubRise) and any
// future external channel — qualifies.
const QR_EXCLUDED = new Set([
  "ONLINE",
  "DIRECT",
  "POS",
  "PHONE",
  "WHATSAPP",
  "WHATS_APP",
]);

export function isMarketplaceOrder(order: any): boolean {
  const src = String(order?.orderSource ?? order?.platform ?? "").toUpperCase();
  if (!src) return false;
  return !QR_EXCLUDED.has(src);
}

// Cache the brand offer per (brandId|locationId) for the session so we
// don't hit the API on every print.
const offerCache = new Map<
  string,
  { url: string | null; caption: string; logoUrl: string | null }
>();

export interface ReceiptOffer {
  // Storefront QR target — only set when the brand/location has online
  // ordering configured AND the order is a marketplace channel.
  url: string | null;
  caption: string;
  // Receipt logo (brand logo, else the location's own logo). Resolved
  // for ALL channels so the logo prints on every receipt without
  // bloating the live-orders feed with a base64 data-URI per row.
  logoUrl: string | null;
  isMarketplace: boolean;
}

// Resolve the receipt logo + (for marketplace orders) the storefront QR
// and live marketing caption. Returns null only when we can't key it
// (no brand/location) or on failure, so printing never breaks.
export async function resolveReceiptOffer(
  order: any,
): Promise<ReceiptOffer | null> {
  const brandId = order?.brandId ?? order?.brand?.id;
  const locationId = order?.locationId;
  if (!brandId || !locationId) return null;
  const key = `${brandId}|${locationId}`;
  try {
    let offer = offerCache.get(key);
    if (!offer) {
      offer = await marketingClient.receiptOffer(brandId, locationId);
      offerCache.set(key, offer);
    }
    return {
      url: offer.url ?? null,
      caption: offer.caption,
      logoUrl: offer.logoUrl ?? null,
      isMarketplace: isMarketplaceOrder(order),
    };
  } catch {
    return null;
  }
}

// Apply a resolved offer onto a receipt payload: logo for every order,
// QR + caption only for marketplace orders that actually have a
// storefront URL.
export function applyReceiptOffer(payload: any, offer: ReceiptOffer | null) {
  if (!offer) return;
  if (offer.logoUrl) payload.brandLogoUrl = offer.logoUrl;
  if (offer.isMarketplace && offer.url) {
    payload.qrData = offer.url;
    payload.qrCaption = offer.caption;
  }
}

// Which command language to render for this printer. Star printers need
// Star Line Mode; Epson / Sunmi / generic all use ESC/POS. Prefer the
// explicit commandSet saved on the printer, fall back to the brand, then
// sniff the free-text model (so a printer already labelled "Star …" works
// without re-adding it).
function resolveCommandSet(p: any): string {
  const explicit = String(p?.defaults?.commandSet ?? "").toUpperCase();
  if (explicit) return explicit;
  const brand = String(p?.defaults?.brand ?? "").toLowerCase();
  if (brand === "star") return "STAR";
  if (/star/i.test(String(p?.model ?? ""))) return "STAR";
  return "ESCPOS";
}

export async function printOrderViaBridge(order: any): Promise<string> {
  if (!hasNativeBridge()) {
    throw new Error(
      "Native printing only works inside the OrderHub Solutions tablet app.",
    );
  }
  const printers = await printersClient.list(order.locationId);
  // Bluetooth or LAN printers at this location that the current app
  // build can actually reach.
  const targets = printers.filter(
    (p: any) =>
      p.locationId === order.locationId &&
      (p.connectionType === "BLUETOOTH" || p.connectionType === "LAN") &&
      p.ipAddress &&
      p.isActive !== false &&
      bridgeSupportsPrinter(p),
  );
  if (targets.length === 0) {
    throw new Error(
      "No reachable printer for this location. Add a Bluetooth or LAN printer in Printers.",
    );
  }
  // Build the payload once + resolve the receipt logo / QR offer once.
  const payload = buildPrintPayload(order);
  applyReceiptOffer(payload, await resolveReceiptOffer(order));

  // Print to each target independently. Crucially, one bad target must
  // NOT fail the whole job: locations often accumulate a stale/duplicate
  // printer row (a leftover LAN entry with a dead IP, or a re-registered
  // Bluetooth printer that left a second record). Before this, the real
  // receipt printed on the good printer, then the dead one threw, and the
  // icon went red every time despite a perfectly good print. We keep the
  // loop sequential (the native BT bridge holds one shared socket, so
  // concurrent writes would fight over it) but isolate each target's
  // failure and only report red if EVERY printer failed.
  let printed = 0;
  const failures: string[] = [];
  for (const p of targets) {
    try {
      const copies = Math.max(
        1,
        Number((p as any).defaults?.copiesReprint ?? 1) || 1,
      );
      const single = await renderReceiptBytes(payload, p.paperWidth ?? 80, {
        printLogo: (p as any).defaults?.printLogo,
        qrCode: (p as any).defaults?.qrCode,
        commandSet: resolveCommandSet(p),
      });
      await writeToPrinter(p, repeatReceipt(single, copies));
      printed++;
    } catch (e: any) {
      const label = (p as any)?.name ?? p.ipAddress ?? "printer";
      failures.push(`${label}: ${e?.message ?? "failed"}`);
    }
  }

  if (printed === 0) {
    throw new Error(
      failures.length
        ? `Print failed — ${failures.join("; ")}`
        : "Print failed — no printer accepted the job.",
    );
  }

  // At least one printer produced the receipt — clear the order's queued
  // job(s) + bump "last print".
  void printersClient.markOrderPrinted(order.id);

  if (failures.length) {
    // Success overall (green), but flag the printers that didn't take it so
    // a stale entry is visible without turning a good print into an error.
    return `Printed to ${printed} of ${targets.length} printers`;
  }
  return targets.length === 1 ? "Printed" : `Printed to ${targets.length} printers`;
}
