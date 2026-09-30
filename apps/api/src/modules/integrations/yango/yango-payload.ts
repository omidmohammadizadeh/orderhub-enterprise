// Phase BK — build Yango request bodies from an order. Pure, so every trap in
// the docs can be pinned by a test without a network or a database.

import { currencyDecimals } from "@orderhub/shared";
import {
  toYangoCoords,
  type YangoCheckPriceBody,
  type YangoCreateBody,
  type YangoLatLng,
} from "./yango-client.service";

/** Our own point ids on the claim. Yango answers with its OWN server ids for
 *  the same points; anything that later needs a point (courier phone) must
 *  read those back from the claim, not reuse these. */
export const SOURCE_POINT = 1;
export const DEST_POINT = 2;

/** Per-class weight ceilings from Yango's FAQ, in kg. */
const CLASS_MAX_KG: Record<string, number> = { courier: 10, express: 20 };
/** A takeaway bag, in METRES — well inside the courier class box (0.8×0.5×0.5). */
const BAG_SIZE = { length: 0.4, width: 0.3, height: 0.3 };

/**
 * Yango requires international format ("+…") and answers anything else with
 * invalid_phone_must_start_plus_symbol. UAE numbers reach us every way:
 * "050 123 4567", "971501234567", "00971501234567", "+971 50-123-4567".
 * Returns null when there is nothing phone-shaped to send.
 */
export function toYangoPhone(raw: unknown, defaultDial = "+971"): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const hadPlus = s.startsWith("+");
  let digits = s.replace(/\D/g, "");
  if (!digits) return null;
  if (hadPlus) return digits.length >= 8 ? `+${digits}` : null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  else {
    const cc = defaultDial.replace(/\D/g, "");
    if (digits.startsWith(cc) && digits.length >= cc.length + 8) {
      // already carries the country code, just no "+"
    } else if (digits.startsWith("0")) {
      digits = cc + digits.slice(1);
    } else if (digits.length <= 9) {
      digits = cc + digits;
    }
  }
  return digits.length >= 8 ? `+${digits}` : null;
}

/** Money as Yango wants it: a decimal STRING in the currency's own precision
 *  (a dirham has 2 places, a Kuwaiti dinar 3). */
export function yangoMoney(amount: unknown, currency: string): string {
  const n = Number(amount);
  const safe = Number.isFinite(n) && n > 0 ? n : 0;
  return safe.toFixed(currencyDecimals(currency));
}

/** ~500g per unit, floored at 500g and capped at the class limit: we hold no
 *  real weights, and an honest cap beats a claim refused for "too heavy". */
export function orderWeightKg(order: any, taxiClass: string): number {
  const items = Array.isArray(order?.items) ? order.items : [];
  const units = items.reduce(
    (sum: number, it: any) => sum + Math.max(Number(it?.quantity ?? 1) || 1, 1),
    0,
  );
  const max = CLASS_MAX_KG[taxiClass] ?? CLASS_MAX_KG.courier!;
  return Math.min(Math.max(units * 0.5, 0.5), max);
}

export function orderRef(order: any): string {
  const ref =
    (typeof order?.displayId === "string" && order.displayId.trim()) ||
    (order?.orderNumber != null ? String(order.orderNumber) : "");
  return (ref || String(order?.id ?? "").slice(-8).toUpperCase()).slice(0, 64);
}

export interface YangoRoute {
  pickup: YangoLatLng;
  pickupAddress: string;
  dropoff: YangoLatLng;
  dropoffAddress: string;
}

export function buildCheckPriceBody(
  order: any,
  route: YangoRoute,
  taxiClass: string,
): YangoCheckPriceBody {
  return {
    items: [
      {
        quantity: 1,
        weight: orderWeightKg(order, taxiClass),
        size: BAG_SIZE,
        pickup_point: SOURCE_POINT,
        // check-price spelling — NOT the create endpoint's `droppof_point`.
        dropoff_point: DEST_POINT,
      },
    ],
    // check-price wants `id` and flat coordinates/fullname; create wants
    // `point_id` and an `address` object. Same data, two shapes.
    route_points: [
      { id: SOURCE_POINT, coordinates: toYangoCoords(route.pickup), fullname: route.pickupAddress },
      { id: DEST_POINT, coordinates: toYangoCoords(route.dropoff), fullname: route.dropoffAddress },
    ],
    requirements: { taxi_class: taxiClass },
  };
}

export function buildCreateBody(args: {
  order: any;
  location: any;
  route: YangoRoute;
  taxiClass: string;
  currency: string;
  contactEmail: string;
  shopPhone: string;
  customerPhone: string;
  callbackUrl: string | null;
}): YangoCreateBody {
  const { order, location, route, taxiClass, currency } = args;
  const ref = orderRef(order);
  const total = yangoMoney(order?.total, currency);
  const shopName = String(location?.name ?? "").trim().slice(0, 100) || "Restaurant";
  const notes = [order?.specialInstructions, order?.deliveryInstructions]
    .filter((v) => typeof v === "string" && v.trim())
    .map((v: string) => v.trim())
    .join(" · ")
    .slice(0, 1000);

  return {
    items: [
      {
        // One bag per order. The courier needs "which bag", not our line items,
        // and a single item keeps the declared value equal to the order total.
        title: `Order ${ref}`.slice(0, 250),
        quantity: 1,
        cost_value: total,
        cost_currency: currency,
        pickup_point: SOURCE_POINT,
        droppof_point: DEST_POINT, // sic — Yango's spelling on create.
        weight: orderWeightKg(order, taxiClass),
        size: BAG_SIZE,
        extra_id: ref,
      },
    ],
    route_points: [
      {
        point_id: SOURCE_POINT,
        visit_order: 1,
        type: "source",
        // Yango requires an email on the source contact.
        contact: { name: shopName, phone: args.shopPhone, email: args.contactEmail },
        address: {
          fullname: route.pickupAddress,
          coordinates: toYangoCoords(route.pickup),
          comment: `OrderHub order ${ref} — ask at the counter`.slice(0, 300),
        },
        // Default is an SMS code at every handover. A restaurant counter has no
        // phone to read a code from, so the pickup skips it.
        skip_confirmation: true,
      },
      {
        point_id: DEST_POINT,
        visit_order: 2,
        type: "destination",
        contact: {
          name: String(order?.customerName ?? "").trim().slice(0, 100) || "Customer",
          phone: args.customerPhone,
        },
        address: {
          fullname: route.dropoffAddress,
          coordinates: toYangoCoords(route.dropoff),
          ...(notes ? { comment: notes } : {}),
        },
        // No code at the door either: our customer never received one.
        skip_confirmation: true,
        // Only allowed on destination points (external_order_id_not_allowed
        // otherwise). The courier sees it at pickup.
        external_order_id: ref,
        external_order_cost: { value: total, currency },
      },
    ],
    client_requirements: { taxi_class: taxiClass },
    ...(args.callbackUrl ? { callback_properties: { callback_url: args.callbackUrl } } : {}),
    skip_client_notify: false,
    comment: `Food order ${ref} from ${shopName}. Keep upright.`.slice(0, 1000),
    emergency_contact: { name: shopName, phone: args.shopPhone },
    referral_source: "OrderHub",
  };
}
