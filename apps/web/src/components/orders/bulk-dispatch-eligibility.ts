import type { Order } from "@/lib/api/orders.client";

// Which orders can go into a bulk dispatch.
//
// Mirrors the API's own checks (StuartDispatchService.loadBulk and
// DispatchService.assignToDriver) so the board never offers a pick the server
// will refuse: a delivery, not carried by the marketplace's own rider, not
// already on a courier, and taken by the shop but not yet handed to anyone.
// Its own module so the list can ask without loading the modal's chunk.

const BULK_STATUSES = new Set(["ACCEPTED", "PREPARING", "READY"]);

export function canBulkDispatch(o: Order): boolean {
  return (
    o.fulfillmentType === "DELIVERY" &&
    (o as any).deliveryType !== "PLATFORM" &&
    !(o as any).courierJobId &&
    BULK_STATUSES.has(o.status)
  );
}
