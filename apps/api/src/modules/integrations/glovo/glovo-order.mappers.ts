// Phase GL-2 — pure Glovo order mappers.
//
// Dependency-free (no Nest, no Prisma) so they unit-test in isolation. Written
// from the restaurant Partners API spec (definition.yaml, Order model) and
// MUST be re-checked against the first real `order dispatched` envelope — the
// receiver logs and persists every one for exactly that reason.

/** Glovo's order id: the idempotency key and the handle for every outbound call. */
export function glovoOrderIdFrom(payload: any): string | null {
  const v = payload?.order_id ?? payload?.orderId ?? payload?.id ?? null;
  return v != null && String(v).trim() ? String(v).trim() : null;
}

/**
 * The store id on the order — the external id WE gave Glovo for this store
 * address. It is the routing key to a BrandPlatformConnection.
 */
export function glovoStoreIdFrom(payload: any): string | null {
  const v = payload?.store_id ?? payload?.storeId ?? null;
  return v != null && String(v).trim() ? String(v).trim() : null;
}

/**
 * Integer cents → major units.
 *
 * Every money field on a Glovo ORDER is integer cents ("denominated in
 * cents"). Menu prices go the other way — decimals in major units — which is
 * exactly the kind of asymmetry that turns a €30.80 order into €3,080.
 * `null` (a Glovo-courier order's delivery_fee) becomes 0.
 */
export function glovoMoney(value: unknown): number {
  if (value == null || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

/** Rounds to cents, killing float noise from summing lines. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * A Glovo local timestamp → a real instant.
 *
 * `order_time` and `estimated_pickup_time` are LOCAL wall-clock times with no
 * offset ("yyyy-MM-dd HH:mm:ss"), and the offset rides alongside as
 * `utc_offset_minutes` — a STRING. Parsing the local time as if it were UTC
 * puts every Madrid order an hour or two out, which is how a courier ends up
 * "due" before the order was placed.
 */
export function glovoLocalToDate(
  local: unknown,
  utcOffsetMinutes: unknown,
): Date | null {
  const s = String(local ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  const offset = Number(utcOffsetMinutes);
  const asUtc = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  );
  if (!Number.isFinite(asUtc)) return null;
  // local = UTC + offset, so UTC = local − offset.
  return new Date(asUtc - (Number.isFinite(offset) ? offset : 0) * 60_000);
}

export type GlovoFulfilment = {
  fulfillmentType: "PICKUP" | "MERCHANT_DELIVERY" | "PLATFORM_COURIER";
  /** Order.deliveryType — PLATFORM gates the post-READY steps behind the courier. */
  deliveryType: "MERCHANT" | "PLATFORM" | null;
  /** True for a "marketplace" order: the store delivers with its own riders. */
  marketplace: boolean;
};

/**
 * Who takes the food to the customer.
 *
 * Glovo has no `type` field. The spec says it three ways instead:
 *   - `is_picked_up_by_customer: true`  → the customer collects;
 *   - a non-null `delivery_address`     → a MARKETPLACE order, delivered by
 *     the store ("If the order is delivered by Glovo this will be set to null");
 *   - otherwise                         → a Glovo courier collects.
 *
 * `delivery_fee` / `total_customer_to_pay` are marketplace-only too and are
 * used as a second signal, so a marketplace order whose address arrives empty
 * is not mistaken for a Glovo-courier one and left waiting for a rider who is
 * never coming.
 */
export function mapGlovoFulfilment(payload: any): GlovoFulfilment {
  if (payload?.is_picked_up_by_customer === true) {
    return { fulfillmentType: "PICKUP", deliveryType: null, marketplace: false };
  }
  const marketplace =
    (payload?.delivery_address != null && typeof payload.delivery_address === "object") ||
    payload?.total_customer_to_pay != null ||
    payload?.delivery_fee != null;
  return marketplace
    ? { fulfillmentType: "MERCHANT_DELIVERY", deliveryType: "MERCHANT", marketplace: true }
    : { fulfillmentType: "PLATFORM_COURIER", deliveryType: "PLATFORM", marketplace: false };
}

/** Glovo's cancel reasons, in words staff can act on. */
const CANCEL_REASON_TEXT: Record<string, string> = {
  PRODUCTS_NOT_AVAILABLE: "products not available in store",
  STORE_CAN_NOT_DELIVER: "the store could not deliver",
  PARTNER_PRINTER_ISSUE: "a problem with the store's device",
  USER_ERROR: "the customer cancelled",
  ORDER_NOT_FEASIBLE: "Glovo could not fulfil it",
  OTHER: "other reason",
};

/** Human-readable cancel reason for Order.cancelReason. Unknown codes are echoed. */
export function describeGlovoCancellation(
  reason?: string | null,
  paymentStrategy?: string | null,
): string {
  const code = String(reason ?? "").trim();
  const words = CANCEL_REASON_TEXT[code] ?? (code ? `reason "${code}"` : "no reason given");
  const pay =
    paymentStrategy === "PAY_PRODUCTS"
      ? " — Glovo will pay for the products"
      : paymentStrategy === "PAY_NOTHING"
        ? " — Glovo will not pay for the products"
        : "";
  return `Cancelled on Glovo: ${words}${pay}`;
}

/**
 * CANCELLED vs REJECTED.
 *
 * Glovo gives no initiator, only a reason. PRODUCTS_NOT_AVAILABLE and
 * PARTNER_PRINTER_ISSUE are the store's side of the counter — those count as
 * REJECTED for reporting, the same split the JET mapper makes. Everything else
 * (customer, Glovo, other) is a CANCELLED order the store did not refuse.
 */
export function mapGlovoCancellationStatus(reason?: string | null): "CANCELLED" | "REJECTED" {
  const code = String(reason ?? "").trim();
  if (code === "PRODUCTS_NOT_AVAILABLE" || code === "PARTNER_PRINTER_ISSUE") {
    return "REJECTED";
  }
  return "CANCELLED";
}

/** The four statuses Glovo's `PUT …/orders/{id}/status` accepts. */
export type GlovoOutboundStatus =
  | "ACCEPTED"
  | "READY_FOR_PICKUP"
  | "OUT_FOR_DELIVERY"
  | "PICKED_UP_BY_CUSTOMER";

/**
 * Our board status → the Glovo status to send, or null for "nothing to say".
 *
 * Each Glovo status is valid for one kind of order only, per the spec:
 *   READY_FOR_PICKUP       — Glovo-courier orders (and a customer collecting)
 *   OUT_FOR_DELIVERY       — marketplace orders, the store's own rider
 *   PICKED_UP_BY_CUSTOMER  — customer-collection orders
 * Sending one to the wrong kind is a 400, so it is filtered here rather than
 * sent and logged as a failure on every order.
 *
 * CANCELLED / REJECTED map to NOTHING: Glovo has no cancel endpoint ("It is
 * not possible to cancel or refuse orders via the API"). The sync service
 * surfaces that to the operator instead.
 */
export function glovoStatusFor(
  ourStatus: string,
  fulfillmentType: string | null | undefined,
): GlovoOutboundStatus | null {
  const ft = String(fulfillmentType ?? "");
  switch (ourStatus) {
    case "ACCEPTED":
    case "PREPARING":
      return "ACCEPTED";
    case "READY":
      return ft === "PLATFORM_COURIER" || ft === "PICKUP" ? "READY_FOR_PICKUP" : null;
    case "OUT_FOR_DELIVERY":
    case "DISPATCHED":
      return ft === "MERCHANT_DELIVERY" ? "OUT_FOR_DELIVERY" : null;
    case "COMPLETED":
      return ft === "PICKUP" ? "PICKED_UP_BY_CUSTOMER" : null;
    default:
      return null;
  }
}
