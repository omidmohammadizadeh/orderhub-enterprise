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
 * Deliveroo rider status → our OrderStatus.
 *
 * Covers the OFFICIAL rider.status_update vocabulary from
 * https://api-docs.deliveroo.com/docs/listen-to-rider-status-webhook —
 *   rider_assigned → rider_arrived → rider_confirmed_at_restaurant →
 *   rider_check_in → rider_in_transit → rider_delivered
 * (plus rider_unassigned when a rider drops off) — AND the older aliases
 * from the Base44 audit (en_route, collected, completed, …) so we stay
 * tolerant of whichever spelling actually lands on the wire.
 *
 * `rider_check_in` is Deliveroo's NFC on-site check-in signal (added 2026,
 * mandatory to handle by 28 Jul 2026). It happens while the rider is at the
 * restaurant ready to collect, so it maps to RIDER_ARRIVED (it must NOT push
 * the order forward to OUT_FOR_DELIVERY). The precise "checked in" moment is
 * still preserved verbatim on Order.courierStatus for the UI to surface.
 * `pending`/`unassigned` don't move the order.
 */
/** Forward-only rank of our rider-driven order stages. */
const RIDER_STAGE_RANK: Record<string, number> = {
  ASSIGNED_DRIVER: 1,
  RIDER_ARRIVED: 2,
  OUT_FOR_DELIVERY: 3,
  COMPLETED: 4,
};

/**
 * The FURTHEST-progressed order stage across a list of raw rider statuses
 * (the rider.status_update `status_log` history plus any bare status field).
 *
 * Deliveroo can append a non-terminal line — e.g. `rider_unassigned` when the
 * rider is released — AFTER `rider_delivered`, so trusting only the last log
 * entry would leave a delivered order stuck at "out for delivery". The rider
 * lifecycle is monotonic forward and updateStatus refuses to regress a
 * terminal order, so taking the max stage is safe and completes the order as
 * soon as `rider_delivered` appears anywhere in the history.
 */
export function furthestRiderStage(
  statuses: Array<string | undefined | null>,
): string | null {
  let best: string | null = null;
  for (const s of statuses) {
    const m = mapDeliverooRiderStatus(s ?? undefined);
    if (
      m &&
      (best === null ||
        (RIDER_STAGE_RANK[m] ?? 0) > (RIDER_STAGE_RANK[best] ?? 0))
    ) {
      best = m;
    }
  }
  return best;
}

/**
 * The furthest-progressed RAW status, for display.
 *
 * `Order.courierStatus` is shown to staff verbatim, and the last line of the
 * log is routinely `rider_unassigned` — so a rider standing in the shop was
 * being rendered as "not assigned". Statuses that map to no stage
 * (rider_unassigned, pending) never win, so the column keeps the last
 * MEANINGFUL thing the rider did. Returns null when nothing in the list maps.
 */
export function furthestRiderRawStatus(
  statuses: Array<string | undefined | null>,
): string | null {
  let best: string | null = null;
  let bestRank = 0;
  for (const s of statuses) {
    const m = mapDeliverooRiderStatus(s ?? undefined);
    if (!m) continue;
    const rank = RIDER_STAGE_RANK[m] ?? 0;
    // >= so that within one stage the LATER entry wins (rider_confirmed_at
    // _restaurant reads better than the rider_arrived that preceded it).
    if (best === null || rank >= bestRank) {
      best = String(s);
      bestRank = rank;
    }
  }
  return best;
}

/** Stages that mean the rider is physically at the restaurant. */
const AT_RESTAURANT = new Set(["RIDER_ARRIVED"]);

/**
 * Did the rider collect the food and leave?
 *
 * Deliveroo NEVER sends `rider_in_transit` or `rider_delivered` to the
 * merchant. Confirmed against production orders #5049 and #5116 (40 rider
 * events, zero `rider_delivered`): the log runs
 *
 *   rider_assigned → rider_arrived → rider_confirmed_at_restaurant →
 *   rider_unassigned
 *
 * and then repeats unchanged, with `lat`/`lon` pinned to 0,0, until the
 * events stop. Deliveroo cuts the restaurant's visibility of the rider at
 * pickup — the leg to the customer is simply not exposed to the merchant.
 *
 * So `rider_unassigned` AFTER an at-restaurant stage is the collection
 * signal, and the only one we get. Order matters: an unassign BEFORE the
 * rider ever arrived is a genuine drop (the rider cancelled and Deliveroo
 * re-assigns), which must not read as a pickup — #5116 does exactly that,
 * unassigning 6 seconds after being assigned and then re-assigning 10
 * minutes later.
 */
export function riderCollectedFromLog(
  statuses: Array<string | undefined | null>,
): boolean {
  let reachedRestaurant = false;
  for (const s of statuses) {
    const raw = (s ?? "").toLowerCase();
    if (raw === "rider_unassigned" && reachedRestaurant) return true;
    const m = mapDeliverooRiderStatus(s ?? undefined);
    if (m && AT_RESTAURANT.has(m)) reachedRestaurant = true;
    // A later stage already implies collection; nothing to infer.
    if (m === "OUT_FOR_DELIVERY" || m === "COMPLETED") return true;
  }
  return false;
}

export function mapDeliverooRiderStatus(status?: string): string | null {
  switch ((status ?? "").toLowerCase()) {
    case "rider_assigned":
    case "assigned":
    case "en_route":
    case "en_route_to_restaurant":
      return "ASSIGNED_DRIVER";
    case "rider_arrived":
    case "rider_confirmed_at_restaurant":
    case "rider_check_in":
    case "confirmed_at_restaurant":
    case "arrived_at_restaurant":
    case "at_restaurant":
      return "RIDER_ARRIVED";
    case "rider_in_transit":
    case "collected":
    case "picked_up":
    case "en_route_to_customer":
    case "arrived_at_customer":
      return "OUT_FOR_DELIVERY";
    case "rider_delivered":
    case "delivered":
    case "completed":
      return "COMPLETED";
    default:
      // rider_unassigned / pending / unknown → no forward move (raw value
      // is still written to Order.courierStatus by the caller).
      return null;
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
