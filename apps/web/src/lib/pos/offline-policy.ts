// Offline POS — the rules, kept pure so they can be tested without a browser.
//
// What a till may do with no connection, which failures mean "the network is
// gone" (queue the order) rather than "the server said no" (show the error),
// and which sync failures are worth retrying.

import { isAwaitingOurPayment } from "@/lib/orders/awaiting-payment";

/**
 * Payment methods a till can take with no connection.
 *
 *  CASH              — money in the drawer; nothing to authorise.
 *  PAY_ON_COLLECTION — settled later from the order card, like online.
 *  CARD_TERMINAL     — ONLY as "card on the shop's own machine": the operator
 *                      keys the amount into a card machine that has its own
 *                      connection (4G / offline mode) and confirms APPROVED.
 *                      Our Stripe reader charge is server-driven and cannot
 *                      run offline, so the till records it as paid manually.
 *
 * Payment link, QR code and online card all need Stripe to be reachable.
 */
const OFFLINE_METHODS = new Set(["CASH", "PAY_ON_COLLECTION", "CARD_TERMINAL"]);

export function canTakeOffline(paymentMethod: string | null | undefined): boolean {
  return OFFLINE_METHODS.has(String(paymentMethod ?? ""));
}

/**
 * Did this request fail because the network (or the API behind the proxy) is
 * unreachable? Those are the failures where queueing is right: the order's
 * idempotencyKey means that, if the request did land after all, the later sync
 * returns the same order instead of creating a second one.
 *
 * `navigator.onLine` alone misses the commonest real outage — the shop's Wi-Fi
 * is up but the line behind the router is down — so the till has to judge by
 * what the request actually did.
 */
export function isNetworkFailure(err: unknown): boolean {
  const e = err as {
    response?: { status?: number };
    code?: string;
    message?: string;
  } | null;
  if (!e) return false;
  const status = e.response?.status;
  if (status === undefined) {
    // No response at all: DNS, refused, dropped, timed out.
    return (
      e.code === "ERR_NETWORK" ||
      e.code === "ECONNABORTED" ||
      e.code === "ETIMEDOUT" ||
      /network error|timeout/i.test(String(e.message ?? ""))
    );
  }
  // The Next.js proxy answers for an API it can't reach.
  return status === 502 || status === 503 || status === 504;
}

/**
 * Should a failed sync be retried later, or parked for the operator?
 *
 * Only a request the server understood and refused is parked. A 401 (token
 * expired during a long outage), a 429 (the reconnect burst hit the rate
 * limit) and anything 5xx will succeed on a later pass — parking those lost
 * real orders until somebody noticed the red badge.
 */
export function isRetryableSyncError(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 401 || status === 408 || status === 425 || status === 429) return true;
  return status >= 500;
}

/** The fields the sync worker needs from a queued POST /v1/orders body. */
export interface QueuedOrderBody {
  paymentMethod?: string;
  paymentStatus?: string;
  isWalkIn?: boolean;
  [k: string]: unknown;
}

/**
 * Is the till still collecting for this order? Mirrors the online placement:
 * such orders are NOT accepted (they'd print as unpaid), they wait for the
 * payment to be recorded.
 */
export function holdsForPayment(body: QueuedOrderBody): boolean {
  return isAwaitingOurPayment({
    status: "PENDING",
    paymentMethod: body.paymentMethod,
    paymentStatus: body.paymentStatus,
    isWalkIn: body.isWalkIn,
  });
}

/** Short reference the kitchen and the customer can use before the order has a server number. */
export function offlineRef(localId: string): string {
  return `OFF-${localId.replace(/[^a-z0-9]/gi, "").slice(-4).toUpperCase()}`;
}

/**
 * An order-shaped object for the receipt renderer, built from the queued body,
 * so a ticket can print with no connection.
 */
export function offlineOrderForPrint(
  localId: string,
  body: Record<string, any>,
  extra: { location?: unknown; queuedAt?: number } = {},
): Record<string, any> {
  const addr = body.deliveryAddress ?? null;
  return {
    id: localId,
    locationId: body.locationId,
    brandId: body.brandId ?? null,
    location: extra.location ?? null,
    orderSource: "POS",
    platform: "POS",
    displayId: offlineRef(localId),
    fulfillmentType: body.fulfillmentType,
    customerName: body.customerInfo?.name ?? null,
    customerPhone: body.customerInfo?.phone ?? null,
    addressLine1: addr?.line1 ?? null,
    addressLine2: addr?.line2 ?? null,
    city: addr?.city ?? null,
    postcode: addr?.postcode ?? null,
    receivedAt: new Date(extra.queuedAt ?? Date.now()).toISOString(),
    scheduledFor: body.scheduledFor ?? null,
    items: (body.items ?? []).map((i: any, idx: number) => ({
      id: `${localId}:${idx}`,
      ...i,
    })),
    subtotal: body.subtotal,
    deliveryFee: body.deliveryFee,
    discount: body.discount,
    taxAmount: body.taxAmount,
    total: body.total,
    paymentMethod: body.paymentMethod,
    paymentStatus: body.paymentStatus,
    specialInstructions: [
      "OFFLINE ORDER — will sync when back online",
      body.specialInstructions,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
