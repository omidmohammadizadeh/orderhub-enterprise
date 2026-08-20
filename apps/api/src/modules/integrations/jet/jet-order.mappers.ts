// Phase JE-1 — pure JET Connect order mappers.
//
// Dependency-free (no Nest, no Prisma, no OrdersService) so the routing
// service can lean on them and they unit-test in isolation. This is the
// riskiest surface in the integration: everything here is written from the
// spec's own `x-examples` and must be re-checked against the first real
// webhook envelope before any store goes live.

/** JET's fulfilment types, and what each means for us. */
export type JetFulfilment = {
  /** CanonicalOrder.fulfillmentType */
  fulfillmentType: "PICKUP" | "DELIVERY" | "MERCHANT_DELIVERY" | "PLATFORM_COURIER";
  /**
   * Order.deliveryType — who drives it. PLATFORM gates the post-READY steps
   * in the operator UI (the courier webhooks own them); MERCHANT lets staff
   * walk the order all the way to delivered; null for collection.
   */
  deliveryType: "MERCHANT" | "PLATFORM" | null;
};

/**
 * Map JET's `type` onto our fulfilment model.
 *
 * The spec pins this to exactly three values. An unknown value is treated as
 * a partner delivery rather than defaulted to collection: mis-labelling a
 * delivery as a collection strands the food on the pass with nobody coming
 * for it, whereas the reverse merely shows an extra gated step.
 */
export function mapJetFulfilment(type?: string): JetFulfilment {
  switch ((type ?? "").trim().toLowerCase()) {
    case "collection-by-customer":
      return { fulfillmentType: "PICKUP", deliveryType: null };
    case "delivery-by-merchant":
      return { fulfillmentType: "MERCHANT_DELIVERY", deliveryType: "MERCHANT" };
    case "delivery-by-delivery-partner":
      return { fulfillmentType: "PLATFORM_COURIER", deliveryType: "PLATFORM" };
    default:
      return { fulfillmentType: "PLATFORM_COURIER", deliveryType: "PLATFORM" };
  }
}

/**
 * JET's driver status codes → our OrderStatus.
 *
 * Only four codes exist. Modelled on HubRiseDeliverySyncService's courier
 * mapping so the board renders identical stages regardless of marketplace.
 */
export function mapJetDriverStatus(code?: string): string | null {
  switch ((code ?? "").trim()) {
    case "driverArrivingAtRestaurant":
      return "ASSIGNED_DRIVER";
    case "driverAtRestaurant":
      return "RIDER_ARRIVED";
    case "onItsWay":
      return "OUT_FOR_DELIVERY";
    case "delivered":
      return "COMPLETED";
    default:
      return null;
  }
}

/**
 * JET's cancellation reason codes → our terminal status.
 *
 * The enum has 27 values in three families and they do NOT all mean the same
 * thing to a restaurant. `restCancelled*` is the shop's own decision and
 * `deletedRejectedByRestaurant` is an outright refusal — those are REJECTED.
 * Everything else (customer changed their mind, platform-side deletion,
 * system error) is a CANCELLED order that the shop did not refuse. The
 * distinction drives reporting and, for the operator, whether the cancel
 * counts against them.
 */
export function mapJetCancellationStatus(code?: string): "CANCELLED" | "REJECTED" {
  const c = (code ?? "").trim();
  if (c === "deletedRejectedByRestaurant") return "REJECTED";
  if (c.startsWith("restCancelled")) return "REJECTED";
  return "CANCELLED";
}

/** Human-readable cancellation text for the order's cancelReason field. */
export function describeJetCancellation(code?: string, initiatedBy?: string): string {
  const c = (code ?? "unknown").trim();
  // Split the camelCase code into words: custCancelledMadeMistake →
  // "cust cancelled made mistake". Better than showing staff a raw code, and
  // it cannot go stale when JET adds a value we haven't enumerated.
  const words = c
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  const who = (initiatedBy ?? "").trim();
  return who && who !== "unknown"
    ? `Cancelled on Just Eat by ${who} (${words})`
    : `Cancelled on Just Eat (${words})`;
}

/**
 * The JET Connect order id — the key for idempotency and for every outbound
 * call about this order. Distinct from `third_party_order_reference`, which is
 * the number the CUSTOMER sees and what staff will be asked for at the door.
 */
export function jetOrderIdFrom(payload: any): string | null {
  const v = payload?.id ?? payload?.orderID ?? payload?.orderId ?? null;
  return v != null && String(v).trim() ? String(v).trim() : null;
}

/**
 * The identifier WE gave JET for this restaurant, which they stamp on every
 * order. This is the routing key: it resolves to a BrandPlatformConnection and
 * therefore to a tenant, brand and location.
 *
 * `location.id` (JET's own numeric location id) is accepted as a fallback for
 * a mis-configured restaurant, but a hit on it is worth a warning — it means
 * posLocationId was never set on JET's side, which is exactly the
 * INCORRECT_SETUP failure their error enum describes.
 */
export function jetPosLocationIdFrom(payload: any): {
  value: string | null;
  field: string | null;
} {
  const candidates: Array<[string, unknown]> = [
    ["posLocationId", payload?.posLocationId],
    ["pos_location_id", payload?.pos_location_id],
    ["location.id", payload?.location?.id],
  ];
  for (const [field, raw] of candidates) {
    if (raw != null && String(raw).trim()) {
      return { value: String(raw).trim(), field };
    }
  }
  return { value: null, field: null };
}

/**
 * Minor units (pence/cents) → major units (pounds/dollars).
 *
 * Every money field in the JET order payload is an integer in the minor unit —
 * `1950` is £19.50. No heuristics here: guessing whether a number is already
 * in pounds is how a £19.50 order becomes a £0.20 one.
 */
export function jetMoney(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n / 100;
}

/** UNIX seconds (JET sends them as strings) → Date, or null. */
export function jetUnixToDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The error codes JET's async-failure endpoint accepts. */
export type JetFailureCode =
  | "UNKNOWN"
  | "INACTIVE"
  | "INCORRECT_SETUP"
  | "IN_USE"
  | "TIMEOUT"
  | "NOT_SUPPORTED"
  | "MENU_ERROR"
  | "MALFORMED_REQUEST"
  | "AUTH_FAILED"
  | "STORE_CLOSED"
  | "TENDER_ERROR";

/**
 * Classify an intake failure into JET's error enum.
 *
 * This is not cosmetic. JET reports these codes to the restaurant and uses
 * them to decide what happens next, and an accurate `INCORRECT_SETUP` is the
 * difference between someone fixing a store mapping and someone re-keying
 * orders by hand all night. The default is UNKNOWN rather than a plausible
 * guess — a wrong code sends the operator to the wrong place.
 */
export function classifyJetFailure(err: unknown): {
  code: JetFailureCode;
  message: string;
} {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const msg = raw.slice(0, 300) || "Order could not be injected";
  const lower = raw.toLowerCase();

  if (lower.includes("no connected") || lower.includes("not connected")) {
    return { code: "INCORRECT_SETUP", message: msg };
  }
  if (lower.includes("poslocationid") || lower.includes("unknown restaurant")) {
    return { code: "INCORRECT_SETUP", message: msg };
  }
  if (lower.includes("plu") || lower.includes("menu item") || lower.includes("out of stock")) {
    return { code: "MENU_ERROR", message: msg };
  }
  if (lower.includes("malformed") || lower.includes("unexpected token") || lower.includes("json")) {
    return { code: "MALFORMED_REQUEST", message: msg };
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    return { code: "TIMEOUT", message: msg };
  }
  if (lower.includes("closed")) return { code: "STORE_CLOSED", message: msg };
  return { code: "UNKNOWN", message: msg };
}

/**
 * A stable signature for one order line, used to collapse repeats.
 *
 * JET order items carry NO quantity field — the spec's item schema has
 * name/description/plu/price/notes/children and nothing else, so three
 * cheeseburgers arrive as three identical objects. Collapsing them needs a
 * key that folds genuine duplicates together while keeping lines the kitchen
 * must treat separately apart, so the modifiers and the customer's own note
 * are both part of the identity: "no pickles" on one of three burgers is not
 * the same line as the other two.
 */
export function jetItemSignature(item: any): string {
  const children = Array.isArray(item?.children) ? item.children : [];
  const childSig = children
    .map((c: any) => `${c?.plu ?? ""}:${c?.name ?? ""}:${c?.price ?? 0}`)
    .join("|");
  return [
    item?.plu ?? "",
    item?.name ?? "",
    item?.price ?? 0,
    (item?.notes ?? "").trim(),
    childSig,
  ].join("~");
}
