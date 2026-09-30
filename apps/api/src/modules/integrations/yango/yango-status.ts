// Phase BK — Yango claim statuses and what they mean for an OrderHub order.
//
// Yango documents 26 statuses in its enum and a 27th (`pay_waiting`) only in
// prose, so an unknown status is expected, not an error: it is recorded on the
// order and moves nothing.

/** Yango claim status → our OrderStatus. null = record it, don't move the order. */
export const YANGO_STATUS_MAP: Record<string, string | null> = {
  new: null,
  estimating: null,
  ready_for_approval: null,
  accepted: null,
  // Order routed, courier search running. Nobody has taken it yet — telling a
  // customer "your rider is on the way" here would be a lie.
  performer_lookup: null,
  performer_draft: null,
  // A courier has accepted and is heading to the shop.
  performer_found: "ASSIGNED_DRIVER",
  pickup_arrived: "ASSIGNED_DRIVER",
  ready_for_pickup_confirmation: "ASSIGNED_DRIVER",
  pickuped: "OUT_FOR_DELIVERY",
  delivery_arrived: "OUT_FOR_DELIVERY",
  ready_for_delivery_confirmation: "OUT_FOR_DELIVERY",
  pay_waiting: "OUT_FOR_DELIVERY",
  // `delivered` is per drop-off; with our single drop-off it IS the handover.
  delivered: "COMPLETED",
  delivered_finish: "COMPLETED",
  // Food coming back to the shop: a refund decision for a person, not for us.
  returning: null,
  return_arrived: null,
  ready_for_return_confirmation: null,
  returned: null,
  returned_finish: null,
};

/** No further change will come for these — the poller stops asking. */
export const YANGO_TERMINAL = new Set([
  "delivered_finish",
  "returned_finish",
  "cancelled",
  "cancelled_with_payment",
  "cancelled_by_taxi",
  "cancelled_with_items_on_hands",
  "failed",
  "performer_not_found",
  // Terminal unless someone edits the claim, which we never do.
  "estimating_failed",
]);

/** Yango gave up on the delivery itself. The shop paid our dispatch fee for a
 *  courier that never came, so the fee goes back. */
export const YANGO_FAILED_BY_YANGO = new Set([
  "cancelled_by_taxi",
  "performer_not_found",
  "failed",
  "estimating_failed",
]);

/** Cancelled, but not by Yango — and not through OrderHub either (our own
 *  cancel clears the order synchronously, so the poller never sees it). That
 *  leaves the shop's Yango cabinet. No refund: otherwise cancelling in the
 *  cabinet and re-dispatching here would be a free loop. */
export const YANGO_CANCELLED_ELSEWHERE = new Set([
  "cancelled",
  "cancelled_with_payment",
  "cancelled_with_items_on_hands",
]);

/** A courier is attached and moving — the window where a position exists. */
export const YANGO_COURIER_LIVE = new Set([
  "performer_found",
  "pickup_arrived",
  "ready_for_pickup_confirmation",
  "pickuped",
  "delivery_arrived",
  "ready_for_delivery_confirmation",
  "pay_waiting",
  "returning",
  "return_arrived",
]);

export const YANGO_RETURN_STATUSES = new Set([
  "returning",
  "return_arrived",
  "ready_for_return_confirmation",
  "returned",
  "returned_finish",
]);

export function normStatus(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

/** How far Yango's binding offer may exceed the check-price quote before we
 *  refuse to accept it. check-price is only an estimate; the offer on the claim
 *  is what the shop actually pays. 25% by default. */
export function maxPriceDrift(): number {
  const n = Number(process.env.YANGO_MAX_PRICE_DRIFT);
  return Number.isFinite(n) && n >= 0 ? n : 0.25;
}

/** Decide whether an offer is acceptable. Pure — the tests pin the edges. */
export function offerVerdict(args: {
  offerPrice: number | null;
  quotedPrice: number | null;
  validUntil: string | null | undefined;
  now?: number;
  drift?: number;
}): { ok: true } | { ok: false; reason: "expired" | "too_expensive" | "no_price" } {
  const now = args.now ?? Date.now();
  if (args.validUntil) {
    const t = new Date(args.validUntil).getTime();
    // Accepting an expired offer returns 200 and then the claim goes `failed`,
    // so it has to be caught here, before the call.
    if (Number.isFinite(t) && t <= now) return { ok: false, reason: "expired" };
  }
  if (args.offerPrice == null || !Number.isFinite(args.offerPrice)) {
    return { ok: false, reason: "no_price" };
  }
  if (args.quotedPrice != null && Number.isFinite(args.quotedPrice) && args.quotedPrice > 0) {
    const cap = args.quotedPrice * (1 + (args.drift ?? maxPriceDrift()));
    // A cent of float noise must not refuse an exactly-quoted offer.
    if (args.offerPrice > cap + 1e-6) return { ok: false, reason: "too_expensive" };
  }
  return { ok: true };
}

export function decimalOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
