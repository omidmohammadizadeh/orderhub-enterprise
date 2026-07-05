// Phase UE-4 — Uber Eats order → CanonicalOrder mapping.
//
// Built against the partner OpenAPI spec (Order Fulfillment API 1.0.0):
//   • GET /v1/delivery/order/{id} returns { order: {...} } (restaurant_order).
//   • Money is `amount_e5` (value × 10^5): 750000 = £7.50. Each money object
//     carries net/tax/gross currency_amounts.
//   • Items carry NO price — per-line prices live in
//     payment.payment_detail.item_charges.price_breakdown[], keyed by
//     cart_item_id (price_type ITEM|OPTION), with unit + total money.
//   • Modifiers are selected_modifier_groups[].selected_items[] (recursive
//     item shape).
//   • fulfillment_type: DELIVERY_BY_UBER | DELIVERY_BY_MERCHANT | PICKUP |
//     DINE_IN. Customer phone may be anonymised with a pin_code.

import type { CanonicalOrder } from "@orderhub/shared";

type Money = {
  gross?: { amount_e5?: number };
  net?: { amount_e5?: number };
  tax?: { amount_e5?: number };
};

const e5 = (v: unknown): number =>
  Number.isFinite(Number(v)) ? Number(v) / 100_000 : 0;

/** Money → pounds (gross preferred; net+tax fallback). Never negative. */
export function moneyToPounds(m: Money | null | undefined): number {
  if (!m) return 0;
  if (m.gross?.amount_e5 != null) return Math.max(0, e5(m.gross.amount_e5));
  return Math.max(0, e5(m.net?.amount_e5) + e5(m.tax?.amount_e5));
}

export function mapUberFulfillment(
  t: string | undefined,
): CanonicalOrder["fulfillmentType"] {
  switch (t) {
    case "PICKUP":
      return "PICKUP";
    case "DINE_IN":
      return "DINE_IN";
    case "DELIVERY_BY_MERCHANT":
      return "MERCHANT_DELIVERY";
    case "DELIVERY_BY_UBER":
    default:
      return "PLATFORM_COURIER";
  }
}

interface PriceLine {
  unit: number; // pounds
  total: number; // pounds
}

/** price_breakdown[] → cart_item_id → prices in pounds. */
function indexPrices(order: any): Map<string, PriceLine> {
  const out = new Map<string, PriceLine>();
  const breakdown =
    order?.payment?.payment_detail?.item_charges?.price_breakdown;
  if (!Array.isArray(breakdown)) return out;
  for (const line of breakdown) {
    const key = String(line?.cart_item_id ?? "");
    if (!key) continue;
    out.set(key, {
      unit: moneyToPounds(line?.unit),
      total: moneyToPounds(line?.total),
    });
  }
  return out;
}

function itemQuantity(it: any): number {
  const q = Number(it?.quantity?.amount);
  return Number.isInteger(q) && q > 0 ? q : 1;
}

/**
 * Map one Uber order object (the `order` key of the GET response, or of a
 * webhook-expanded payload) into our canonical shape.
 */
export function mapUberEatsOrder(order: any): CanonicalOrder | null {
  const externalId: string = order?.id ?? "";
  if (!externalId) return null;

  const prices = indexPrices(order);
  const cart = Array.isArray(order?.carts) ? order.carts[0] : undefined;

  const items = (cart?.items ?? []).map((it: any) => {
    const line = prices.get(String(it?.cart_item_id ?? ""));
    const quantity = itemQuantity(it);
    const modifiers = (it?.selected_modifier_groups ?? []).flatMap((g: any) =>
      (g?.selected_items ?? []).map((m: any) => {
        const mline = prices.get(String(m?.cart_item_id ?? ""));
        return {
          name: String(m?.title ?? "Option"),
          price: mline?.unit ?? 0,
          quantity: itemQuantity(m),
        };
      }),
    );
    // unit price excludes modifiers (they're separate breakdown lines);
    // totalPrice is the line total for the item entity itself.
    const unitPrice = line?.unit ?? 0;
    const totalPrice = line?.total ?? unitPrice * quantity;
    return {
      externalId: it?.cart_item_id ? String(it.cart_item_id) : undefined,
      name: String(it?.title ?? "Item"),
      quantity,
      unitPrice,
      totalPrice,
      modifiers,
      notes: it?.customer_request?.special_instructions
        ? String(it.customer_request.special_instructions)
        : undefined,
      sku: it?.external_data ? String(it.external_data) : undefined,
    };
  });

  const detail = order?.payment?.payment_detail ?? {};
  const total = moneyToPounds(detail?.order_total);
  const taxAmount = Math.max(0, e5(detail?.order_total?.tax?.amount_e5));
  const subtotal = moneyToPounds(detail?.item_charges?.total) || total;
  const discount = moneyToPounds(detail?.promotions?.total);
  const cashDue = moneyToPounds(detail?.cash_amount_due);

  // Primary customer (fall back to the first).
  const customers: any[] = Array.isArray(order?.customers)
    ? order.customers
    : [];
  const cust =
    customers.find((c) => c?.is_primary_customer) ?? customers[0] ?? {};
  const name =
    cust?.name?.display_name ||
    [cust?.name?.first_name, cust?.name?.last_name].filter(Boolean).join(" ") ||
    "Uber Eats customer";
  const phoneNumber = cust?.contact?.phone?.number
    ? String(cust.contact.phone.number)
    : undefined;
  const phonePin = cust?.contact?.phone?.pin_code
    ? String(cust.contact.phone.pin_code)
    : undefined;

  // Delivery address — per spec, `deliveries[].location` is ONLY populated
  // for merchant-fulfilled (BYOC) orders; for DELIVERY_BY_UBER (courier)
  // Uber omits the eater address entirely (courier handles dropoff), so it
  // stays undefined and the UI simply shows no address for those.
  const deliveries: any[] = Array.isArray(order?.deliveries)
    ? order.deliveries
    : [];
  const loc =
    deliveries.map((d) => d?.location).find((l) => l && (l.street_address_line_one || l.city)) ??
    null;
  const deliveryAddress = loc
    ? {
        line1: String(loc.street_address_line_one ?? ""),
        line2: loc.street_address_line_two ?? loc.unit_number ?? undefined,
        city: String(loc.city ?? ""),
        postcode: String(loc.postal_code ?? loc.postcode ?? ""),
        country: String(loc.country ?? "GB"),
        ...(loc.latitude && loc.longitude
          ? { coordinates: { lat: Number(loc.latitude), lng: Number(loc.longitude) } }
          : {}),
      }
    : undefined;

  const scheduledStart =
    order?.scheduled_order_target_delivery_time_range?.start_time;
  const scheduledFor =
    order?.status === "SCHEDULED" && scheduledStart
      ? new Date(scheduledStart)
      : undefined;

  return {
    externalId,
    platform: "UBER_EATS",
    orderSource: "UBER_EATS",
    integrationSource: "DIRECT",
    viaHubrise: false,
    fulfillmentType: mapUberFulfillment(order?.fulfillment_type),
    displayId: order?.display_id ? String(order.display_id) : undefined,
    customerInfo: {
      name,
      phone: phoneNumber,
      ...(phonePin ? { phoneAccessCode: phonePin } : {}),
    },
    items,
    ...(deliveryAddress ? { deliveryAddress } : {}),
    subtotal,
    taxAmount,
    deliveryFee: 0, // marketplace collects its own delivery fee from the customer
    discount,
    total,
    specialInstructions: cart?.special_instructions
      ? String(cart.special_instructions)
      : undefined,
    ...(scheduledFor && !Number.isNaN(scheduledFor.getTime())
      ? { scheduledFor }
      : {}),
    metadata: {
      uberState: order?.state ?? null,
      uberStatus: order?.status ?? null,
      uberStoreId: order?.store?.id ?? null,
      phonePin: phonePin ?? null,
      cashDue: cashDue || 0,
      storeInstructions: order?.store_instructions ?? null,
      readyForPickupTime:
        order?.preparation_time?.ready_for_pickup_time ?? null,
      deliveryType:
        order?.fulfillment_type === "DELIVERY_BY_UBER"
          ? "PLATFORM"
          : order?.fulfillment_type === "DELIVERY_BY_MERCHANT"
            ? "MERCHANT"
            : undefined,
    },
  } as CanonicalOrder;
}
