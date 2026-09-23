import type { Order } from "@/lib/api/orders.client";

// Which orders can go into a bulk dispatch.
//
// Mirrors the API's own checks (StuartDispatchService.loadBulk and
// DispatchService.assignToDriver) so the board never offers a pick the server
// will refuse: a delivery, not carried by the marketplace's own rider, not
// already on a courier, and taken by the shop but not yet handed to anyone.
// Its own module so the list can ask without loading the modal's chunk.

const BULK_STATUSES = new Set(["ACCEPTED", "PREPARING", "READY"]);

/**
 * Every fulfillment type that IS a delivery. MERCHANT_DELIVERY is a
 * marketplace order the shop drives itself (Just Eat "delivery-by-merchant",
 * and the Deliveroo / Uber Eats equivalents) — comparing with DELIVERY alone
 * hid Dispatch, the map and bulk dispatch on every one of them.
 * PLATFORM_COURIER is listed too; those are excluded by deliveryType instead,
 * in one place, so the rule reads the same everywhere.
 */
export const DELIVERY_FULFILLMENTS = [
  "DELIVERY",
  "MERCHANT_DELIVERY",
  "PLATFORM_COURIER",
];

export function isDeliveryFulfillment(type: string | null | undefined): boolean {
  return DELIVERY_FULFILLMENTS.includes(String(type ?? ""));
}

export function canBulkDispatch(o: Order): boolean {
  return (
    isDeliveryFulfillment(o.fulfillmentType) &&
    (o as any).deliveryType !== "PLATFORM" &&
    !(o as any).courierJobId &&
    BULK_STATUSES.has(o.status)
  );
}
