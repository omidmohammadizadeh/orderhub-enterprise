// Shared receipt payload builder.
//
// Turns a live Order object (as the board / drawer already hold it) into
// the flat payload shape buildOrderReceipt() renders. Used by BOTH the
// manual "print" button in the order drawer AND the client-side
// auto-print hook, so auto and manual produce byte-identical receipts.

import type { Order } from "../api/orders.client";

// The customer-facing channel for the receipt. HubRise is an aggregator
// — the real marketplace (Deliveroo / Uber Eats / Just Eat) is carried
// in `orderSource`, while `platform` is the literal string "HUBRISE".
// Never print "HUBRISE": resolve to the real channel and tidy it up.
export function displayChannelFor(order: any): string | null {
  const platform = String(order?.platform ?? "").toUpperCase();
  const source = String(order?.orderSource ?? "").toUpperCase();
  let channel = platform && platform !== "HUBRISE" ? platform : source;
  if (!channel || channel === "HUBRISE") channel = source && source !== "HUBRISE" ? source : "ONLINE";
  return channel.replace(/_/g, " ");
}

export function paymentLabelFor(
  method: string | null | undefined,
  status: string | null | undefined,
): string {
  // No asterisks: the renderers print this as a full-width reverse-video
  // band (white on black), so decoration in the string would sit INSIDE the
  // highlight and just eat characters. Wording is deliberately two words —
  // "<METHOD> PAID" / "<METHOD> NOT PAID" — so the state is readable across
  // the counter at a glance rather than parsed.
  if (method === "CARD") {
    if (status === "PAID" || status === "AUTHORIZED") return "CARD PAID";
    if (status === "REFUNDED" || status === "PARTIALLY_REFUNDED")
      return "REFUNDED";
    return "CARD NOT PAID";
  }
  if (method === "CASH") {
    if (status === "PAID") return "CASH PAID";
    // Covers collection AND delivery: cash is owed until someone takes it.
    // Marking the order paid on the POS flips this to "CASH PAID" on the
    // next print and on the order card.
    return "CASH NOT PAID";
  }
  if (status === "PAID") return "PAID";
  return "NOT PAID";
}

/**
 * Customer phone with the marketplace access code appended, matching the
 * server renderer's format exactly so a ticket reads the same whichever
 * path printed it. Falls back to the bare number when there's no code
 * (POS, storefront, WhatsApp).
 */
function phoneWithAccessCode(order: any): string | null {
  const phone = order?.customerPhone ?? null;
  if (!phone) return null;
  // Adapters have put the code in three different places over time:
  // Uber writes customerInfo.phoneAccessCode (+ metadata.phonePin),
  // and the Order row has its own courierPhoneAccessCode column.
  const code =
    order?.customerInfo?.phoneAccessCode ??
    order?.courierPhoneAccessCode ??
    (order?.metadata as any)?.phonePin ??
    null;
  return code ? `${phone} PIN ${code}` : phone;
}

// The POS / storefront cart writes OrderItem.name as
//   "MEAL DEAL 4 (+CHIPS, CAN COKE) - Note: no salt"
// (see buildCartItemName in @orderhub/shared) so the KDS parser can pull
// the modifiers and note back out of a single column. The print payload
// already carries both as STRUCTURED fields, so leaving the suffix in
// the name prints every option twice — once in brackets on the headline
// and again in the list underneath.
//
// Strip it for print only; the stored value is untouched because KDS
// still depends on it. This mirrors cleanItemName() in the server's
// print-routing.service.ts, which the desktop-agent path has always
// applied — the tablet bridge renderer just never got the same
// treatment, which is why bracketed names only showed up on tablets.
//
// The trailing "(...)" is only removed when the item ACTUALLY has
// modifiers. A genuine menu name like "Pepsi (330ml)" with no options
// keeps its brackets.
export function cleanItemName(
  raw: string | null | undefined,
  hasModifiers: boolean,
): string {
  if (!raw) return "";
  let s = String(raw);
  const noteIdx = s.indexOf(" - Note: ");
  if (noteIdx >= 0) s = s.slice(0, noteIdx);
  if (hasModifiers) s = s.replace(/\s*\([^()]*\)\s*$/, "");
  return s.trim() || String(raw).trim();
}

// `banner` is an optional reverse-video line printed at the very top —
// used to stamp "ORDER CANCELLED" on a cancellation slip.
export function buildPrintPayload(
  order: Order,
  opts?: { banner?: string },
): Record<string, any> {
  const loc = (order as any).location;
  const brand = (order as any).brand ?? loc?.brand ?? null;
  const brandAddress =
    [brand?.addressLine1, brand?.city, brand?.postcode].filter(Boolean).join(", ") ||
    null;
  const locAddr = loc?.address;
  const locationAddress =
    brandAddress ??
    (locAddr && typeof locAddr === "object"
      ? [locAddr.line1, locAddr.line2, locAddr.city, locAddr.postcode]
          .filter(Boolean)
          .join(", ")
      : typeof locAddr === "string"
        ? locAddr
        : null);
  // Order.deliveryAddress (Json) is the CANONICAL address — it's what every
  // marketplace ingest writes. The flat addressLine1/2/city/postcode columns
  // are only a mirror the POS path fills in, so reading them alone printed no
  // address at all on Deliveroo/Uber merchant-delivery tickets: the drawer
  // showed it (it reads the JSON) while the driver's ticket had nothing.
  // Canonical first, mirror as the fallback.
  const addrJson = (order as any).deliveryAddress;
  const deliveryAddress =
    (addrJson && typeof addrJson === "object"
      ? [addrJson.line1, addrJson.line2, addrJson.city, addrJson.postcode]
          .filter(Boolean)
          .join(", ")
      : typeof addrJson === "string"
        ? addrJson.trim()
        : "") ||
    [
      (order as any).addressLine1,
      (order as any).addressLine2,
      (order as any).city,
      (order as any).postcode,
    ]
      .filter(Boolean)
      .join(", ") ||
    null;
  return {
    banner: opts?.banner ?? null,
    // Brand logo for the receipt header (rastered to ESC/POS by the
    // bridge renderer). Brand wins, else the location's primary brand.
    brandLogoUrl: brand?.logoUrl ?? loc?.brand?.logoUrl ?? null,
    // QR is resolved at print time for marketplace tickets only (the
    // storefront URL + live offer caption) — set by the print path, not
    // here. Left null so non-marketplace receipts never carry a QR.
    qrData: null as string | null,
    qrCaption: null as string | null,
    brandName: brand?.name ?? loc?.name ?? null,
    locationName: loc?.name ?? null,
    locationAddress,
    locationPhone: brand?.phone ?? loc?.phone ?? null,
    displayId: (order as any).displayId ?? null,
    orderNumber: (order as any).orderNumber ?? null,
    // Receipt "Channel" line — resolved real channel, never "HUBRISE".
    platform: displayChannelFor(order),
    orderSource: (order as any).orderSource ?? null,
    fulfillmentType: order.fulfillmentType,
    // Table Tabs — dine-in prints name the table.
    tableName: (order as any).tableName ?? null,
    // New / returning customer banner (matches the order card). Use the
    // server-supplied tag when present, otherwise derive from the count.
    customerVisitCount: (order as any).customerVisitCount ?? null,
    customerVisitTag:
      (order as any).customerVisitTag ??
      (typeof (order as any).customerVisitCount === "number"
        ? (order as any).customerVisitCount <= 1
          ? "*** NEW CUSTOMER ***"
          : `*** RETURNING CUSTOMER · ORDER #${(order as any).customerVisitCount} ***`
        : null),
    // Timing — scheduled slot or estimated ready time, for the receipt's
    // "expected delivery / collection" line + scheduled banner.
    scheduledFor: (order as any).scheduledFor ?? null,
    estimatedReadyAt: (order as any).estimatedReadyAt ?? null,
    customerName: (order as any).customerName ?? null,
    // Marketplace orders (Uber Eats / Deliveroo / Just Eat / HubRise) mask
    // the customer's number — dialling it only connects once the caller
    // keys in the per-order access code, so the PIN has to be on the paper
    // next to the number or the driver is stuck on the doorstep.
    //
    // The server-side renderer already joined these (phoneWithAccessCode in
    // print-routing.service.ts) but that path only feeds the desktop print
    // agent. Tablets build this payload themselves, which is why the PIN
    // never reached a printed ticket.
    customerPhone: phoneWithAccessCode(order),
    // The ORDER's currency, so a ticket prints in the shop's own money. Comes
    // from the order's location rather than the selected one — the board can
    // be showing several locations at once.
    currency: (order as any)?.location?.currency ?? null,
    deliveryAddress,
    receivedAt: (order as any).receivedAt ?? (order as any).createdAt ?? null,
    items: (order.items ?? []).map((i: any) => ({
      name: cleanItemName(i.name, !!(i.modifiers?.length)),
      // Kitchen-language name, attached to the live-orders feed by
      // attachKitchenNames when the location prints translated tickets. The
      // renderer prints THIS instead of `name` and, on a tablet, draws it as
      // pixels — CP437 cannot carry CJK. Absent for every shop that has not
      // turned translations on, which is nearly all of them.
      secondLanguageName: i.secondLanguageName ?? null,
      quantity: i.quantity,
      modifiers: Array.isArray(i.modifiers) ? i.modifiers : [],
      notes: i.notes ?? null,
      totalPrice:
        typeof i.totalPrice === "number"
          ? i.totalPrice
          : typeof i.price === "number"
            ? i.price * (i.quantity ?? 1)
            : undefined,
    })),
    subtotal: Number((order as any).subtotal ?? 0),
    deliveryFee: Number((order as any).deliveryFee ?? 0),
    // The customer's gratuity. Without this the ticket totals don't add up
    // and staff can't see they were tipped.
    tipAmount: Number((order as any).tipAmount ?? 0),
    // Service charge prints as its own line — a customer querying the bill
    // must be able to see what the extra was for.
    serviceCharge: Number((order as any).serviceCharge ?? 0),
    taxAmount: Number((order as any).taxAmount ?? 0),
    discount: Number((order as any).discount ?? 0),
    total: Number(order.total ?? 0),
    paymentMethod: (order as any).paymentMethod ?? null,
    paymentStatus: (order as any).paymentStatus ?? null,
    paymentLabel: paymentLabelFor(
      (order as any).paymentMethod,
      (order as any).paymentStatus,
    ),
    specialInstructions: order.specialInstructions ?? null,
  };
}
