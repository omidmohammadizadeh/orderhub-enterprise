// Shared "print this order now" routine — the exact path the order
// detail popup uses, so the order-list printer icon prints identically.
//
// Prints the full receipt straight to every Bluetooth printer at the
// order's location via the native bridge, then clears the order's
// server-side job(s) from the queue. Throws a clear message on failure
// so the caller can surface it.

import { printersClient } from "../api/printers.client";
import { formatMoney } from "@orderhub/shared";
import { marketingClient } from "../api/marketing.client";
import {
  hasNativeBridge,
  bridgeSupportsPrinter,
  writeToPrinter,
  renderReceiptParts,
  joinReceiptAndQr,
  repeatReceipt,
  resolveFontScale,
  resolveModifierScale,
  resolvePrintFont,
  buildDrawerKick,
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
  "VOICE",
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
// (no location) or on failure, so printing never breaks.
export async function resolveReceiptOffer(
  order: any,
): Promise<ReceiptOffer | null> {
  const locationId = order?.locationId;
  if (!locationId) return null;
  // The order's brand is OPTIONAL. A channel order only gets one when brand
  // matching finds a hint — HubRise keys off connection_name, and an order
  // that arrives without one (an unmapped connection, or a Developer Tools
  // test) is ingested with no brand at all. Requiring it here bailed out
  // before the marketplace check ran, silently costing that ticket both its
  // QR and its logo even though the location is known and has a brand of its
  // own. The API falls back to the location's brand when this is empty.
  const brandId = order?.brandId ?? order?.brand?.id ?? "";
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
export function resolveCommandSet(p: any): string {
  const explicit = String(p?.defaults?.commandSet ?? "").toUpperCase();
  if (explicit) return explicit;
  const brand = String(p?.defaults?.brand ?? "").toLowerCase();
  if (brand === "star") return "STAR";
  if (/star/i.test(String(p?.model ?? ""))) return "STAR";
  return "ESCPOS";
}

// Which QR command this printer understands.
//
// Sunmi is ESC/POS for everything else, which is why its receipts have always
// been fine — but its firmware doesn't implement the GS ( k QR block and drops
// it without complaint. The offer slip prints with a blank space where the
// code should be. Sunmi documents ESC Z instead.
//
// Sniff the model text as well as the saved brand: a printer added before the
// Sunmi option existed, or re-saved through the edit form (which defaults the
// brand back to Epson), carries brand="epson" while still being a Sunmi.
// Same belt-and-braces the Star detection above uses.
export function resolveQrDialect(p: any): "ESCPOS" | "RASTER" {
  const brand = String(p?.defaults?.brand ?? "").toLowerCase();
  if (brand === "sunmi") return "RASTER";
  if (/sunmi/i.test(String(p?.model ?? ""))) return "RASTER";
  if (/sunmi/i.test(String(p?.name ?? ""))) return "RASTER";
  return "ESCPOS";
}

/**
 * Every per-printer render setting, in one place.
 *
 * Auto-print and reprint both feed renderReceiptParts, and they drifted:
 * auto-print carried its own copy of the commandSet rule and passed neither
 * qrDialect nor printFont, so a Sunmi's first ticket got the QR command it
 * cannot draw while a reprint of the same order got the raster and came out
 * right. Anything added here reaches both callers by construction.
 */
export function printerRenderOptions(p: any) {
  return {
    printLogo: p?.defaults?.printLogo,
    qrCode: p?.defaults?.qrCode,
    commandSet: resolveCommandSet(p),
    qrDialect: resolveQrDialect(p),
    fontScale: resolveFontScale(p),
    modifierScale: resolveModifierScale(p),
    printFont: resolvePrintFont(p),
  };
}

/**
 * Pop the cash drawer at a location.
 *
 * The drawer is wired to the receipt printer's DK port, so this is a
 * zero-paper print job. Unlike printing an order we target exactly ONE
 * printer — firing every printer at the site would rattle the kitchen
 * printer too — preferring the front-counter one, which is where the
 * till drawer physically is.
 */
export async function openCashDrawerViaBridge(
  locationId: string,
): Promise<string> {
  if (!hasNativeBridge()) {
    throw new Error(
      "The cash drawer opens through the printer, which only works inside the OrderHub Solutions tablet app.",
    );
  }
  const printers = await printersClient.list(locationId);
  const reachable = printers.filter(
    (p: any) =>
      p.locationId === locationId &&
      (p.connectionType === "BLUETOOTH" || p.connectionType === "LAN") &&
      p.ipAddress &&
      p.isActive !== false &&
      bridgeSupportsPrinter(p),
  );
  if (reachable.length === 0) {
    throw new Error(
      "No reachable printer for this location — the drawer opens via the receipt printer.",
    );
  }
  // Front counter first (that's the till), then anything else.
  const target =
    reachable.find((p: any) => p.kind === "FRONT_COUNTER") ?? reachable[0]!;
  await writeToPrinter(target, buildDrawerKick(resolveCommandSet(target)));
  return target.name ?? "printer";
}

export async function printOrderViaBridge(
  order: any,
  opts?: { billMode?: boolean },
): Promise<string> {
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
  // Table Tabs — "print the bill": same receipt, but the payment banner
  // shouts TO PAY so a check can never be mistaken for a paid receipt.
  if (opts?.billMode) {
    (payload as any).isBill = true;
    (payload as any).paymentLabel = `BILL - TO PAY ${formatMoney(
      order?.total ?? 0,
      (payload as any)?.currency,
      { compact: true },
    )}`;
  }
  const offer = await resolveReceiptOffer(order);
  applyReceiptOffer(payload, offer);
  // Filled in per printer below and posted with markOrderPrinted. Every gate
  // the QR must pass lives in this file, so without reporting them a missing
  // code can only be guessed at from the server side.
  let qrDecision: Record<string, unknown> | null = null;

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
      // Plain + QR-attached variants come back separately so extra copies
      // repeat the plain receipt — only the last (bag) copy carries the QR.
      const renderOpts = printerRenderOptions(p);
      const { receipt, receiptWithQr, qrSlip } = await renderReceiptParts(
        payload,
        p.paperWidth ?? 80,
        renderOpts,
      );
      qrDecision = {
        printer: (p as any)?.name ?? p.ipAddress ?? "?",
        qrEnabled: !!renderOpts.qrCode,
        dialect: renderOpts.qrDialect,
        // marketplace=false has two very different causes: the order really
        // is one of our own channels (POS/online never get the QR — that
        // customer already orders direct), or the offer lookup bailed. These
        // three fields separate them without another round of guessing.
        src: String(
          (order as any)?.orderSource ?? (order as any)?.platform ?? "?",
        ),
        offer: offer ? "ok" : "NULL",
        orderBrand: (order as any)?.brandId ? "yes" : "NONE",
        marketplace: !!offer?.isMarketplace,
        offerUrl: offer?.url ? "yes" : "NONE",
        qrData: (payload as any)?.qrData ? "yes" : "NONE",
        detachedOpt: !!(p as any).defaults?.qrDetached,
        slipBytes: qrSlip?.length ?? 0,
        withQrBytes: receiptWithQr?.length ?? 0,
      };
      // Detached: plain receipts, then the QR on its own ticket.
      const detached = (p as any).defaults?.qrDetached ? qrSlip : null;
      await writeToPrinter(
        p,
        joinReceiptAndQr(receipt, receiptWithQr, copies, detached),
      );
      printed++;
    } catch (e: any) {
      const label = (p as any)?.name ?? p.ipAddress ?? "printer";
      failures.push(`${label}: ${e?.message ?? "failed"}`);
    }
  }

  if (printed === 0) {
    const msg = failures.length
      ? failures.join("; ")
      : "no printer accepted the job";
    // Log the failure to the activity feed so operators/support can see it.
    void printersClient.reportPrint({
      ok: false,
      orderId: order.id,
      message: msg,
      kind: "order",
    });
    throw new Error(`Print failed — ${msg}`);
  }

  // At least one printer produced the receipt — clear the order's queued
  // job(s) + bump "last print" (this also logs the success server-side).
  void printersClient.markOrderPrinted(order.id, qrDecision ?? undefined);

  if (failures.length) {
    // Some (not all) printers failed — log the dead one(s) too.
    void printersClient.reportPrint({
      ok: false,
      orderId: order.id,
      message: `some printers failed — ${failures.join("; ")}`,
      kind: "order",
    });
    // Success overall (green), but flag the printers that didn't take it so
    // a stale entry is visible without turning a good print into an error.
    return `Printed to ${printed} of ${targets.length} printers`;
  }
  return targets.length === 1 ? "Printed" : `Printed to ${targets.length} printers`;
}
