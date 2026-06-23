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
  if (method === "CARD") {
    if (status === "PAID" || status === "AUTHORIZED") return "*** PAID (CARD) ***";
    if (status === "REFUNDED" || status === "PARTIALLY_REFUNDED")
      return "*** REFUNDED ***";
    return "*** CARD NOT PAID ***";
  }
  if (method === "CASH") {
    if (status === "PAID") return "*** PAID (CASH) ***";
    return "*** CASH ON HANDOVER ***";
  }
  if (status === "PAID") return "*** PAID ***";
  return "*** UNPAID ***";
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
  const deliveryAddress =
    [
      (order as any).addressLine1,
      (order as any).addressLine2,
      (order as any).city,
      (order as any).postcode,
    ]
      .filter(Boolean)
      .join(", ") || null;
  return {
    banner: opts?.banner ?? null,
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
    customerName: (order as any).customerName ?? null,
    customerPhone: (order as any).customerPhone ?? null,
    deliveryAddress,
    receivedAt: (order as any).receivedAt ?? (order as any).createdAt ?? null,
    items: (order.items ?? []).map((i: any) => ({
      name: i.name,
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
