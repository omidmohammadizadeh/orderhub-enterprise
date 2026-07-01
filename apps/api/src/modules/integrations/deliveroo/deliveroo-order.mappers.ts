// Phase BA-3b — pure Deliveroo webhook mappers.
//
// Kept dependency-free (no Nest, no Prisma, no OrdersService) so the routing
// service can lean on them and they can be unit-tested in isolation. This is
// the riskiest surface — Deliveroo's status vocabulary and its drifting
// payload field names (see [[feedback-external-api-shape-first]]).

/**
 * Deliveroo order status → our OrderStatus. Returns null when the status
 * shouldn't move the order (unknown, or `placed`/`pending` which is just
 * the ingest state). assertTransition downstream is the final guard, so an
 * out-of-order echo is rejected + swallowed rather than corrupting state.
 */
export function mapDeliverooOrderStatus(status?: string): string | null {
  switch ((status ?? "").toLowerCase()) {
    case "accepted":
    case "confirmed":
      return "ACCEPTED";
    case "in_kitchen":
    case "preparing":
      return "PREPARING";
    case "ready_for_collection_soon":
    case "ready_for_collection":
    case "ready":
      return "READY";
    case "collected":
    case "en_route_to_customer":
      return "OUT_FOR_DELIVERY";
    case "delivered":
    case "completed":
    case "succeeded":
      return "COMPLETED";
    case "rejected":
      return "REJECTED";
    case "canceled":
    case "cancelled":
      return "CANCELLED";
    case "failed":
      return "FAILED";
    default:
      return null; // placed / pending / unknown → no forward move
  }
}

/**
 * Deliveroo rider status → our OrderStatus. Covers both the documented
 * vocabulary and the aliases noted in the Base44 audit
 * (EN_ROUTE → ASSIGNED_DRIVER, EN_ROUTE_TO_CUSTOMER → OUT_FOR_DELIVERY,
 * COMPLETED → COMPLETED). `pending`/`unassigned` don't move the order.
 */
export function mapDeliverooRiderStatus(status?: string): string | null {
  switch ((status ?? "").toLowerCase()) {
    case "assigned":
    case "en_route":
    case "en_route_to_restaurant":
      return "ASSIGNED_DRIVER";
    case "confirmed_at_restaurant":
    case "arrived_at_restaurant":
    case "at_restaurant":
      return "RIDER_ARRIVED";
    case "collected":
    case "picked_up":
    case "en_route_to_customer":
    case "arrived_at_customer":
      return "OUT_FOR_DELIVERY";
    case "delivered":
    case "completed":
      return "COMPLETED";
    default:
      return null; // pending / unassigned / unknown → no forward move
  }
}

/**
 * Pull the Deliveroo Site ID out of an order payload. Deliveroo's field
 * naming has drifted across API versions, so we try the known layouts and
 * the caller logs the raw payload keys on a miss (see
 * [[feedback-external-api-shape-first]] — we don't have a captured
 * production payload yet, so the miss log is how we learn the real field).
 */
export function deliverooSiteIdFrom(order: any, body?: any): string | null {
  const candidates = [
    order?.location_id,
    order?.site_id,
    order?.location?.id,
    order?.site?.id,
    order?.restaurant?.id,
    order?.restaurant_id,
    body?.location_id,
    body?.site_id,
  ];
  const hit = candidates.find((v) => typeof v === "string" && v.trim());
  return hit ? String(hit).trim() : null;
}

/** Pull the Deliveroo order id out of any of the event layouts. */
export function deliverooOrderIdFrom(order: any, body?: any): string | null {
  const v =
    order?.id ?? order?.order_id ?? body?.order_id ?? body?.order?.id ?? null;
  return v ? String(v) : null;
}
