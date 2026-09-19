import { GlovoOrderSyncService } from "../glovo-order-sync.service";
import { GlovoApiError } from "../glovo-client.service";

// Our board status → Glovo, once per status, never for cancels.

function makeSync(order: Partial<any> = {}, opts: { requestError?: Error } = {}) {
  const latches = new Set<string>();
  const row = {
    id: "order-1",
    tenantId: "tenant-1",
    locationId: "loc-1",
    brandId: "brand-1",
    externalId: "12345",
    displayId: "BA7DWBUL",
    status: "ACCEPTED",
    fulfillmentType: "PLATFORM_COURIER",
    metadata: { glovo: { storeId: "OH-TESTSTORE1" } },
    ...order,
  };
  const prisma: any = {
    order: { findFirst: jest.fn(async ({ where }: any) => (where.tenantId === row.tenantId ? row : null)) },
    brandPlatformConnection: { findFirst: jest.fn(async () => null) },
    webhookEvent: {
      create: jest.fn(async ({ data }: any) => {
        if (latches.has(data.externalEventId)) throw Object.assign(new Error("dup"), { code: "P2002" });
        latches.add(data.externalEventId);
      }),
      delete: jest.fn(async ({ where }: any) => latches.delete(where.platform_externalEventId.externalEventId)),
    },
  };
  const client: any = {
    configured: true,
    request: jest.fn(async () => {
      if (opts.requestError) throw opts.requestError;
      return null;
    }),
  };
  const activity = { record: jest.fn() };
  return { sync: new GlovoOrderSyncService(prisma, client, activity as any), row, client, activity, latches };
}

describe("GlovoOrderSyncService", () => {
  it("PUTs ACCEPTED to the order's store with the documented path", async () => {
    const { sync, client } = makeSync();
    await sync.onStatusChanged({ orderId: "order-1", tenantId: "tenant-1" });
    expect(client.request).toHaveBeenCalledWith(
      "PUT",
      "/webhook/stores/OH-TESTSTORE1/orders/12345/status",
      expect.objectContaining({ body: { status: "ACCEPTED" } }),
    );
  });

  it("sends ACCEPTED once even though ACCEPTED and PREPARING both map to it", async () => {
    const { sync, client, row } = makeSync();
    await sync.onStatusChanged({ orderId: "order-1", tenantId: "tenant-1" });
    row.status = "PREPARING";
    await sync.onStatusChanged({ orderId: "order-1", tenantId: "tenant-1" });
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("releases the latch when Glovo fails, so the next transition can retry", async () => {
    const { sync, latches } = makeSync({}, { requestError: new GlovoApiError(500, "boom", "500") });
    await sync.onStatusChanged({ orderId: "order-1", tenantId: "tenant-1" });
    expect(latches.size).toBe(0);
  });

  it("keeps the latch when Glovo says the order was already accepted (auto-accept)", async () => {
    const err = new GlovoApiError(400, "Status ACCEPTED invalid, this order has been already accepted", "400");
    const { sync, latches } = makeSync({}, { requestError: err });
    const res = await sync.sync("order-1", "tenant-1");
    expect(res.reason).toBe("already_accepted");
    expect(latches.size).toBe(1);
  });

  it("does not echo a transition a Glovo webhook caused", async () => {
    const { sync, client } = makeSync({ status: "READY" });
    await sync.onStatusChanged({ orderId: "order-1", tenantId: "tenant-1", actorType: "WEBHOOK" });
    expect(client.request).not.toHaveBeenCalled();
  });

  it("a cancel that came FROM Glovo does not tell staff to phone Glovo about it", async () => {
    const { sync, activity } = makeSync({ status: "CANCELLED" });
    await sync.onStatusChanged({ orderId: "order-1", tenantId: "tenant-1", actorType: "WEBHOOK" });
    expect(activity.record).not.toHaveBeenCalled();
  });

  it("a staff cancel calls nothing (no cancel API) but tells the operator to phone Glovo", async () => {
    const { sync, client, activity } = makeSync({ status: "CANCELLED" });
    await sync.onStatusChanged({ orderId: "order-1", tenantId: "tenant-1", actorType: "STAFF" });
    expect(client.request).not.toHaveBeenCalled();
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ERROR", message: expect.stringContaining("phone Glovo support") }),
    );
  });

  it("never calls Glovo for a simulated order", async () => {
    const { sync, client } = makeSync({ metadata: { simulatedPlatform: "GLOVO" } });
    await sync.onStatusChanged({ orderId: "order-1", tenantId: "tenant-1" });
    expect(client.request).not.toHaveBeenCalled();
  });

  it("is tenant-scoped: another tenant's order id does nothing", async () => {
    const { sync, client } = makeSync();
    await sync.onStatusChanged({ orderId: "order-1", tenantId: "tenant-2" });
    expect(client.request).not.toHaveBeenCalled();
  });
});
