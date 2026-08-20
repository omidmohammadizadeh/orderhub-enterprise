import { JetOrderService } from "../jet-order.service";
import {
  COLLECTION_BY_CUSTOMER,
  DELIVERY_BY_MERCHANT,
  DELIVERY_BY_PARTNER,
} from "./jet-order.fixtures";

// Intake wiring: a verified webhook payload becoming an order on the board,
// and JET being told what happened either way.
//
// The invariant these tests exist to protect: EVERY path acknowledges. An
// order we never answer for expires silently on JET's side — no backup flow,
// no food, and an SLA hit. An order we explicitly fail still reaches the
// restaurant's tablet with a reason attached.

const CONNECTION = {
  tenantId: "tenant-1",
  brandId: "brand-1",
  locationId: "location-1",
};

function makeService(
  opts: {
    connection?: typeof CONNECTION | null;
    ingest?: jest.Mock;
    existingOrder?: { id: string } | null;
    resync?: jest.Mock;
  } = {},
) {
  const ingestCanonical =
    opts.ingest ?? jest.fn().mockResolvedValue({ id: "order-1" });
  const resyncMarketplaceItems =
    opts.resync ?? jest.fn().mockResolvedValue({ id: "order-1" });

  const orderUpdate = jest.fn().mockResolvedValue({});
  const prisma = {
    brandPlatformConnection: {
      findFirst: jest.fn(async () =>
        opts.connection === undefined ? CONNECTION : opts.connection,
      ),
    },
    order: {
      findFirst: jest.fn(async () => opts.existingOrder ?? null),
      update: orderUpdate,
    },
  } as any;

  const orders = { ingestCanonical, resyncMarketplaceItems } as any;
  const ack = {
    markPending: jest.fn().mockResolvedValue(undefined),
    ackSuccess: jest.fn().mockResolvedValue(true),
    ackFailure: jest.fn().mockResolvedValue(true),
  } as any;
  const activity = { record: jest.fn() } as any;

  return {
    service: new JetOrderService(prisma, orders, ack, activity),
    prisma,
    ingestCanonical,
    resyncMarketplaceItems,
    orderUpdate,
    ack,
    activity,
  };
}

describe("JetOrderService.ingestOrder — the happy path", () => {
  it("routes by posLocationId and ingests against that tenant + location", async () => {
    const { service, prisma, ingestCanonical } = makeService();
    const result = await service.ingestOrder(DELIVERY_BY_PARTNER);

    expect(result).toEqual({ handled: true, orderId: "order-1" });
    expect(prisma.brandPlatformConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          platform: "JUST_EAT",
          externalStoreId: "AKZ12",
        }),
      }),
    );
    const [canonical, tenantId, locationId] = ingestCanonical.mock.calls[0]!;
    expect(tenantId).toBe("tenant-1");
    expect(locationId).toBe("location-1");
    expect(canonical.externalId).toBe("38bbeb45-f520-4438-a44f-0fcdbb29e166");
  });

  it("pins the order to the connection's brand rather than guessing by name", async () => {
    // A direct integration knows its brand. None of the HubRise brand-hint
    // resolution or duplicate-brand disambiguation applies here.
    const { service, ingestCanonical } = makeService();
    await service.ingestOrder(DELIVERY_BY_PARTNER);
    expect(ingestCanonical.mock.calls[0]![0].brandId).toBe("brand-1");
  });

  it("acknowledges success with the connection's identifiers", async () => {
    const { service, ack } = makeService();
    await service.ingestOrder(DELIVERY_BY_PARTNER);
    expect(ack.ackSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        jetOrderId: "38bbeb45-f520-4438-a44f-0fcdbb29e166",
        tenantId: "tenant-1",
        brandId: "brand-1",
        orderId: "order-1",
      }),
    );
    expect(ack.ackFailure).not.toHaveBeenCalled();
  });

  it("registers the pending ack against the resolved brand before ingesting", async () => {
    // The watchdog can only resolve the right JET key if it knows the brand,
    // so the pending record is upgraded as soon as routing succeeds.
    const { service, ack } = makeService();
    await service.ingestOrder(DELIVERY_BY_PARTNER);
    expect(ack.markPending).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", brandId: "brand-1" }),
    );
  });

  it("writes the driver JET already assigned onto the courier columns", async () => {
    const { service, orderUpdate } = makeService();
    await service.ingestOrder(DELIVERY_BY_PARTNER);
    expect(orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-1" },
        data: expect.objectContaining({
          courierName: "John Smith",
          courierPhone: "555-111-3344",
        }),
      }),
    );
  });

  it("does not touch courier columns for a collection order", async () => {
    const { service, orderUpdate } = makeService();
    await service.ingestOrder(COLLECTION_BY_CUSTOMER);
    expect(orderUpdate).not.toHaveBeenCalled();
  });
});

describe("JetOrderService.ingestOrder — failures always acknowledge", () => {
  it("fails with INCORRECT_SETUP when no restaurant matches the posLocationId", async () => {
    const { service, ack, ingestCanonical } = makeService({ connection: null });
    const result = await service.ingestOrder(DELIVERY_BY_PARTNER);

    expect(result.handled).toBe(false);
    expect(ingestCanonical).not.toHaveBeenCalled();
    expect(ack.ackFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INCORRECT_SETUP" }),
    );
    // The message names the value the operator has to go and fix.
    expect(ack.ackFailure.mock.calls[0]![0].message).toContain("AKZ12");
  });

  it("fails explicitly when the order carries nothing routable", async () => {
    const { service, ack } = makeService();
    const result = await service.ingestOrder({
      ...DELIVERY_BY_PARTNER,
      posLocationId: undefined,
      location: undefined,
    });
    expect(result.handled).toBe(false);
    expect(ack.ackFailure).toHaveBeenCalled();
  });

  it("acknowledges a failure when the ingest itself throws", async () => {
    const ingest = jest.fn().mockRejectedValue(new Error("PLU M2 not on the menu"));
    const { service, ack } = makeService({ ingest });
    const result = await service.ingestOrder(DELIVERY_BY_MERCHANT);

    expect(result.handled).toBe(false);
    expect(ack.ackFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "MENU_ERROR" }),
    );
  });

  it("never throws out of ingestOrder — the caller is a fire-and-forget", async () => {
    const ingest = jest.fn().mockRejectedValue(new Error("anything"));
    const { service } = makeService({ ingest });
    await expect(service.ingestOrder(DELIVERY_BY_PARTNER)).resolves.toBeDefined();
  });

  it("gives up without acking only when there is no order id to ack", async () => {
    // JET's own id is the sole handle for the acknowledgement endpoints; with
    // no id there is literally nothing to call.
    const { service, ack } = makeService();
    const result = await service.ingestOrder({ ...DELIVERY_BY_PARTNER, id: undefined });
    expect(result).toEqual({ handled: false, reason: "no_order_id" });
    expect(ack.ackFailure).not.toHaveBeenCalled();
  });
});

describe("JetOrderService.ingestOrder — final picked order", () => {
  it("resyncs an existing order rather than silently keeping the old items", async () => {
    // ingestCanonical is create-only: it returns the existing row untouched.
    // For the final picked copy that is exactly wrong — its whole purpose is
    // that items and totals may have CHANGED during the pick.
    const { service, resyncMarketplaceItems, ingestCanonical, ack } = makeService({
      existingOrder: { id: "order-1" },
    });
    const result = await service.ingestOrder(DELIVERY_BY_PARTNER, { kind: "final" });

    expect(resyncMarketplaceItems).toHaveBeenCalledTimes(1);
    const [externalId, platform, tenantId, canonical] =
      resyncMarketplaceItems.mock.calls[0]!;
    expect(externalId).toBe("38bbeb45-f520-4438-a44f-0fcdbb29e166");
    expect(platform).toBe("JUST_EAT");
    expect(tenantId).toBe("tenant-1");
    expect(canonical.items.length).toBeGreaterThan(0);
    expect(ingestCanonical).not.toHaveBeenCalled();
    expect(ack.ackSuccess).toHaveBeenCalled();
    expect(result.handled).toBe(true);
  });

  it("ingests a final copy as new when no initial order arrived", async () => {
    // Scenario 2 in the spec: a brand can subscribe to the final pick ONLY.
    // Dropping it would lose the order entirely.
    const { service, ingestCanonical, resyncMarketplaceItems } = makeService({
      existingOrder: null,
    });
    const result = await service.ingestOrder(DELIVERY_BY_PARTNER, { kind: "final" });

    expect(resyncMarketplaceItems).not.toHaveBeenCalled();
    expect(ingestCanonical).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
  });

  it("echoes a transmission id through to the acknowledgement", async () => {
    const { service, ack } = makeService({ existingOrder: { id: "order-1" } });
    await service.ingestOrder(
      { ...DELIVERY_BY_PARTNER, transmissionId: "tx-77" },
      { kind: "final" },
    );
    expect(ack.ackSuccess.mock.calls[0]![0].transmissionId).toBe("tx-77");
  });
});

describe("JetOrderService.ingestOrder — routing fallbacks", () => {
  it("falls back to JET's own location id when posLocationId is missing", async () => {
    const { service, prisma, ingestCanonical } = makeService();
    await service.ingestOrder({ ...DELIVERY_BY_PARTNER, posLocationId: undefined });
    expect(prisma.brandPlatformConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ externalStoreId: "1296" }),
      }),
    );
    expect(ingestCanonical).toHaveBeenCalled();
  });

  it("looks up the connection metadata when the store id does not match", async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(CONNECTION);
    const { service, prisma } = makeService();
    prisma.brandPlatformConnection.findFirst = findFirst;

    const result = await service.ingestOrder(DELIVERY_BY_PARTNER);
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(findFirst.mock.calls[1]![0].where.metadata).toEqual({
      path: ["posLocationId"],
      equals: "AKZ12",
    });
    expect(result.handled).toBe(true);
  });
});
