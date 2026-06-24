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
const offerCache = new Map<string, { url: string | null; caption: string }>();

// Resolve the storefront QR + live marketing caption for a marketplace
// order. Returns null for non-marketplace orders, when the brand has no
// online ordering set up, or on any failure (so printing never breaks).
export async function resolveReceiptOffer(
  order: any,
): Promise<{ url: string; caption: string } | null> {
  if (!isMarketplaceOrder(order)) return null;
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
    if (!offer?.url) return null;
    return { url: offer.url, caption: offer.caption };
  } catch {
    return null;
  }
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
  // Build the payload once + resolve the marketplace QR offer once.
  const payload = buildPrintPayload(order);
  const offer = await resolveReceiptOffer(order);
  if (offer) {
    payload.qrData = offer.url;
    payload.qrCaption = offer.caption;
  }
  for (const p of targets) {
    const copies = Math.max(
      1,
      Number((p as any).defaults?.copiesReprint ?? 1) || 1,
    );
    const single = await renderReceiptBytes(payload, p.paperWidth ?? 80, {
      printLogo: (p as any).defaults?.printLogo,
      qrCode: (p as any).defaults?.qrCode,
    });
    await writeToPrinter(p, repeatReceipt(single, copies));
  }
  // Clear this order's job(s) from the queue + bump "last print".
  void printersClient.markOrderPrinted(order.id);
  return targets.length === 1 ? "Printed" : `Printed to ${targets.length} printers`;
}
