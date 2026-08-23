import { CareemOrderService } from "../careem-order.service";
import {
  careemCancellationReason,
  CareemOrderSyncService,
} from "../careem-order-sync.service";

// Careem's branch id IS our Location id — their brand and branch endpoints
// take an id "provided by vendor or restaurant", so we publish our own. No
// mapping table, nothing to drift.

const order = (over: Record<string, unknown> = {}) => ({
  id: 62503433,
  status: "pending",
  delivery_type: "careem",
  branch: { id: "loc-1", brand_id: "brand-1" },
  price: { total_taxable_price: 4.4, delivery_fee: 2, service_fee: 0.15 },
  items: [{ id: "item-1", quantity: 1, unit_price: 2, total_price: 2.25 }],
  ...over,
});

const buildIngest = (location: unknown) => {
  const prisma = {
    location: { findFirst: jest.fn().mockResolvedValue(location) },
    order: { findFirst: jest.fn().mockResolvedValue(null) },
    menuItem: {
      findMany: jest.fn().mockResolvedValue([{ id: "item-1", name: "Shawarma" }]),
    },
    modifierOption: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
  const orders = {
    ingestCanonical: jest.fn().mockResolvedValue({ id: "our-order-1" }),
    updateStatus: jest.fn().mockResolvedValue({}),
  } as any;
  return { svc: new CareemOrderService(prisma, orders), prisma, orders };
};

describe("CareemOrderService.ingest", () => {
  it("routes the order to the location whose id Careem sent as the branch", async () => {
    const { svc, prisma, orders } = buildIngest({
      id: "loc-1",
      country: "AE",
      brand: { tenantId: "t1" },
    });
    await expect(svc.ingest(order() as never)).resolves.toEqual({
      orderId: "our-order-1",
    });
    expect(prisma.location.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "loc-1" }) }),
    );
    const [canonical, tenantId, locationId] = orders.ingestCanonical.mock.calls[0];
    expect(tenantId).toBe("t1");
    expect(locationId).toBe("loc-1");
    expect(canonical.externalId).toBe("62503433");
    expect(canonical.items[0].name).toBe("Shawarma");
  });

  it("drops an order for a branch that matches no location, rather than throwing", async () => {
    // Throwing would return a non-2xx and provoke four retries of something
    // that cannot succeed. It means a branch was published to Careem that no
    // longer exists here — loud in the log, but not retried.
    const { svc, orders } = buildIngest(null);
    await expect(svc.ingest(order() as never)).resolves.toBeNull();
    expect(orders.ingestCanonical).not.toHaveBeenCalled();
  });

  it("resolves nested option names, however deep", async () => {
    const { svc, prisma, orders } = buildIngest({
      id: "loc-1",
      country: "AE",
      brand: { tenantId: "t1" },
    });
    prisma.modifierOption.findMany.mockResolvedValue([
      { id: "opt-1", name: "BBQ sauce" },
      { id: "opt-2", name: "Ketchup" },
    ]);
    await svc.ingest(
      order({
        items: [
          {
            id: "item-1",
            quantity: 1,
            unit_price: 2,
            total_price: 2,
            groups: [
              {
                id: "g1",
                options: [
                  {
                    id: "opt-1",
                    quantity: 1,
                    total_price: 1,
                    groups: [{ id: "g2", options: [{ id: "opt-2", quantity: 1, total_price: 0 }] }],
                  },
                ],
              },
            ],
          },
        ],
      }) as never,
    );
    // Both levels were collected for the lookup — a shallow scan would have
    // missed the nested one and printed a UUID on the ticket.
    const asked = prisma.modifierOption.findMany.mock.calls[0][0].where.id.in;
    expect(asked.sort()).toEqual(["opt-1", "opt-2"]);
    const canonical = orders.ingestCanonical.mock.calls[0][0];
    expect(canonical.items[0].modifiers.map((m: { name: string }) => m.name)).toEqual([
      "BBQ sauce",
      "Ketchup",
    ]);
  });
});

describe("CareemOrderService.applyStatus", () => {
  const buildStatus = (existing: unknown) => {
    const prisma = {
      location: { findFirst: jest.fn() },
      order: { findFirst: jest.fn().mockResolvedValue(existing) },
      menuItem: { findMany: jest.fn().mockResolvedValue([]) },
      modifierOption: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const orders = { updateStatus: jest.fn().mockResolvedValue({}) } as any;
    return { svc: new CareemOrderService(prisma, orders), orders };
  };

  it.each([
    ["accepted", "ACCEPTED"],
    ["driver_coming", "ASSIGNED_DRIVER"],
    ["driver_here", "RIDER_ARRIVED"],
    ["trip_started", "OUT_FOR_DELIVERY"],
    ["trip_ended", "COMPLETED"],
    ["cancelled", "CANCELLED"],
  ])("maps %s to %s", async (careem, ours) => {
    const { svc, orders } = buildStatus({ id: "o1", tenantId: "t1", status: "PENDING" });
    await svc.applyStatus({ id: 1, status: careem } as never);
    expect(orders.updateStatus).toHaveBeenCalledWith(
      "o1",
      "t1",
      expect.objectContaining({ status: ours }),
      "careem",
      "WEBHOOK",
    );
  });

  it.each(["slot_upcoming", "slot_started"])(
    "ignores the scheduled warm-up state %s",
    async (careem) => {
      // Acting on these would start cooking hours before the delivery slot.
      const { svc, orders } = buildStatus({ id: "o1", tenantId: "t1", status: "PENDING" });
      await svc.applyStatus({ id: 1, status: careem } as never);
      expect(orders.updateStatus).not.toHaveBeenCalled();
    },
  );

  it("does nothing when the status already matches", async () => {
    const { svc, orders } = buildStatus({ id: "o1", tenantId: "t1", status: "ACCEPTED" });
    await svc.applyStatus({ id: 1, status: "accepted" } as never);
    expect(orders.updateStatus).not.toHaveBeenCalled();
  });

  it("swallows a refused transition instead of failing the webhook", async () => {
    // Careem's courier lifecycle routinely outruns our kitchen state — a
    // captain can arrive while the board still says PREPARING. Their retries
    // must not be provoked by our own state machine.
    const { svc, orders } = buildStatus({ id: "o1", tenantId: "t1", status: "COMPLETED" });
    orders.updateStatus.mockRejectedValue(new Error("invalid transition"));
    await expect(
      svc.applyStatus({ id: 1, status: "accepted" } as never),
    ).resolves.toBeUndefined();
  });
});

describe("outboundState", () => {
  it("maps only the three states Careem accepts", () => {
    expect(CareemOrderService.outboundState("ACCEPTED")).toBe("accepted");
    expect(CareemOrderService.outboundState("READY")).toBe("ready");
    expect(CareemOrderService.outboundState("CANCELLED")).toBe("cancelled");
    expect(CareemOrderService.outboundState("REJECTED")).toBe("cancelled");
    // No counterpart — sending it would be rejected.
    expect(CareemOrderService.outboundState("PREPARING")).toBeNull();
    expect(CareemOrderService.outboundState("OUT_FOR_DELIVERY")).toBeNull();
  });
});

describe("careemCancellationReason", () => {
  // Their enum is fixed and case-sensitive, and the field is required on every
  // call. Staff type free text, so it has to be mapped — a rejected call means
  // a cancelled order Careem never hears about, and a customer waiting for
  // food nobody is making.
  it.each([
    ["out of stock", "ITEM_TEMPORARILY_UNAVAILABLE"],
    ["Sold out", "ITEM_TEMPORARILY_UNAVAILABLE"],
    ["item discontinued", "ITEM_PERMANENTLY_NOT_AVAILABLE"],
    ["kitchen too busy", "KITCHEN_TOO_BUSY_TO_PREPARE_ORDER"],
    ["we are closed", "OUTLET_CLOSED"],
    ["outside opening hours", "OUT_OF_KITCHEN_OPERATIONAL_HOURS"],
    ["POS outage", "PARTNER_POS_OUTAGE"],
    ["timed out", "PARTNER_ORDER_TIMEOUT"],
  ])("maps %j to %s", (raw, expected) => {
    expect(careemCancellationReason(raw)).toBe(expected);
  });

  it("passes one of their own values straight through, whatever the case", () => {
    expect(careemCancellationReason("outlet_closed")).toBe("OUTLET_CLOSED");
  });

  it("falls back to OTHER rather than sending something they'd reject", () => {
    expect(careemCancellationReason("driver never showed up")).toBe("OTHER");
    expect(careemCancellationReason("")).toBe("OTHER");
    expect(careemCancellationReason(null)).toBe("OTHER");
  });
});

describe("CareemOrderSyncService", () => {
  const build = (order: unknown, configured = true) => {
    const prisma = { order: { findFirst: jest.fn().mockResolvedValue(order) } } as any;
    const client = {
      configured: () => configured,
      request: jest.fn().mockResolvedValue({}),
    } as any;
    return { svc: new CareemOrderSyncService(prisma, client), client };
  };

  it("pushes accepted with the scoping headers Careem requires", async () => {
    const { svc, client } = build({
      id: "o1",
      externalId: "62503433",
      status: "ACCEPTED",
      failureReason: null,
      metadata: { careemBrandId: "brand-1", careemBranchId: "loc-1" },
    });
    await svc.onStatusChanged({ orderId: "o1", tenantId: "t1" });
    expect(client.request).toHaveBeenCalledWith(
      "/orders/62503433",
      expect.objectContaining({
        method: "PUT",
        brandId: "brand-1",
        branchId: "loc-1",
        body: { state: "accepted", cancellation_reason: "OTHER" },
      }),
    );
  });

  it("maps the staff cancel reason onto their vocabulary", async () => {
    const { svc, client } = build({
      id: "o1",
      externalId: "1",
      status: "CANCELLED",
      failureReason: "sold out",
      metadata: {},
    });
    await svc.onStatusChanged({ orderId: "o1", tenantId: "t1" });
    expect(client.request.mock.calls[0][1].body).toEqual({
      state: "cancelled",
      cancellation_reason: "ITEM_TEMPORARILY_UNAVAILABLE",
    });
  });

  it("sends nothing for a status Careem has no counterpart for", async () => {
    const { svc, client } = build({
      id: "o1",
      externalId: "1",
      status: "PREPARING",
      metadata: {},
    });
    await svc.onStatusChanged({ orderId: "o1", tenantId: "t1" });
    expect(client.request).not.toHaveBeenCalled();
  });

  it("never throws into the status transition", async () => {
    // Our order has already moved. Failing here would roll back a kitchen
    // state staff can see, to fix a marketplace they cannot.
    const { svc, client } = build({
      id: "o1",
      externalId: "1",
      status: "ACCEPTED",
      metadata: {},
    });
    client.request.mockRejectedValue(new Error("502"));
    await expect(
      svc.onStatusChanged({ orderId: "o1", tenantId: "t1" }),
    ).resolves.toBeUndefined();
  });

  it("does nothing at all when Careem isn't configured", async () => {
    const { svc, client } = build({ id: "o1", externalId: "1", status: "ACCEPTED" }, false);
    await svc.onStatusChanged({ orderId: "o1", tenantId: "t1" });
    expect(client.request).not.toHaveBeenCalled();
  });
});
