import { JetLifecycleService } from "../jet-lifecycle.service";
import { JetLifecycleController } from "../jet-lifecycle.controller";

// The four lifecycle notifications. Two contract details drive most of these
// tests: the endpoints must ECHO the payload back (the spec says so for all
// four; a bare {ok:true} is a 400 to JET), and they carry NO HMAC, so the
// Authorization header is their only authentication.

const ORDER = {
  id: "order-1",
  tenantId: "tenant-1",
  locationId: "location-1",
  brandId: "brand-1",
  status: "PREPARING",
  displayId: "22721763",
  courierAssignedAt: null,
  courierPickedUpAt: null,
  courierDeliveredAt: null,
};

function makeService(
  opts: { order?: any; connection?: any; updateStatus?: jest.Mock } = {},
) {
  const updateStatus = opts.updateStatus ?? jest.fn().mockResolvedValue({});
  const orderUpdate = jest.fn().mockResolvedValue({});
  const connectionUpdate = jest.fn().mockResolvedValue({});
  const prisma = {
    order: {
      findFirst: jest.fn(async () =>
        opts.order === undefined ? ORDER : opts.order,
      ),
      update: orderUpdate,
    },
    brandPlatformConnection: {
      findFirst: jest.fn(async () => opts.connection ?? null),
      update: connectionUpdate,
    },
  } as any;
  const orders = { updateStatus } as any;
  const activity = { record: jest.fn() } as any;
  return {
    service: new JetLifecycleService(prisma, orders, activity),
    updateStatus,
    orderUpdate,
    connectionUpdate,
    activity,
    prisma,
  };
}

describe("JetLifecycleService.handleCancellation", () => {
  it("cancels the order with a readable reason", async () => {
    const { service, updateStatus } = makeService();
    const result = await service.handleCancellation({
      orderID: "jet-1",
      reason: { code: "custCancelledMadeMistake" },
      happenedAt: "2026-08-15T10:12:56Z",
    });

    expect(result).toEqual({ handled: true, orderId: "order-1" });
    const [orderId, tenantId, dto, actor, actorType] = updateStatus.mock.calls[0]!;
    expect(orderId).toBe("order-1");
    expect(tenantId).toBe("tenant-1");
    expect(dto.status).toBe("CANCELLED");
    // Staff should not be shown a raw camelCase enum value.
    expect(dto.cancelReason).toContain("cust cancelled made mistake");
    expect(actorType).toBe("WEBHOOK");
    expect(actor).toBe("jet-cancel-webhook");
  });

  it("records a restaurant-side cancellation as REJECTED", async () => {
    // Whether the shop refused the order or the customer changed their mind
    // drives reporting and whether the cancel counts against the operator.
    const { service, updateStatus } = makeService();
    await service.handleCancellation({
      orderID: "jet-1",
      reason: { code: "restCancelledTooBusy" },
    });
    expect(updateStatus.mock.calls[0]![2].status).toBe("REJECTED");
  });

  it("names who initiated it when JET says", async () => {
    const { service, updateStatus } = makeService();
    await service.handleCancellation({
      orderID: "jet-1",
      reason: { code: "custCancelledOther" },
      initiatedBy: { code: "customer" },
    });
    expect(updateStatus.mock.calls[0]![2].cancelReason).toContain("by customer");
  });

  it("ignores a cancellation for an order we do not have", async () => {
    // A cancellation can outrun the order, or belong to another restaurant.
    const { service, updateStatus } = makeService({ order: null });
    const result = await service.handleCancellation({
      orderID: "unknown",
      reason: { code: "custCancelledOther" },
    });
    expect(result.handled).toBe(false);
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("swallows a rejected transition on an already-terminal order", async () => {
    const updateStatus = jest.fn().mockRejectedValue(new Error("terminal"));
    const { service } = makeService({ updateStatus });
    await expect(
      service.handleCancellation({ orderID: "jet-1", reason: { code: "unknown" } }),
    ).resolves.toMatchObject({ handled: false, reason: "transition_rejected" });
  });

  it("does nothing when the order is already in that state", async () => {
    const { service, updateStatus } = makeService({
      order: { ...ORDER, status: "CANCELLED" },
    });
    await service.handleCancellation({
      orderID: "jet-1",
      reason: { code: "custCancelledOther" },
    });
    expect(updateStatus).not.toHaveBeenCalled();
  });
});

describe("JetLifecycleService.handleDriverStatus", () => {
  it("advances the order and stamps the milestone from JET's timestamp", async () => {
    const { service, updateStatus, orderUpdate } = makeService();
    const happenedAt = "2026-08-15T10:12:56.371Z";
    await service.handleDriverStatus({
      orderID: "jet-1",
      driverStatus: { code: "onItsWay" },
      happenedAt,
    });

    expect(updateStatus.mock.calls[0]![2].status).toBe("OUT_FOR_DELIVERY");
    const data = orderUpdate.mock.calls[0]![0].data;
    expect(data.courierStatus).toBe("onItsWay");
    // The moment it happened, not the moment we processed it.
    expect(data.courierPickedUpAt.toISOString()).toBe(
      new Date(happenedAt).toISOString(),
    );
  });

  it("maps all four documented codes", async () => {
    for (const [code, status] of [
      ["driverArrivingAtRestaurant", "ASSIGNED_DRIVER"],
      ["driverAtRestaurant", "RIDER_ARRIVED"],
      ["onItsWay", "OUT_FOR_DELIVERY"],
      ["delivered", "COMPLETED"],
    ] as const) {
      const { service, updateStatus } = makeService();
      await service.handleDriverStatus({
        orderID: "jet-1",
        driverStatus: { code },
      });
      expect(updateStatus.mock.calls[0]![2].status).toBe(status);
    }
  });

  it("never overwrites a milestone it already has", async () => {
    // A redelivered notification must not replace the real pickup time.
    const existing = new Date("2026-08-15T09:00:00Z");
    const { service, orderUpdate } = makeService({
      order: { ...ORDER, courierPickedUpAt: existing },
    });
    await service.handleDriverStatus({
      orderID: "jet-1",
      driverStatus: { code: "onItsWay" },
      happenedAt: "2026-08-15T11:00:00Z",
    });
    expect(orderUpdate.mock.calls[0]![0].data.courierPickedUpAt).toBeUndefined();
  });

  it("keeps the courier columns even when the status move is refused", async () => {
    // The courier lifecycle outruns the kitchen one. The drawer should still
    // show the truth when the board's status will not move.
    const updateStatus = jest.fn().mockRejectedValue(new Error("bad transition"));
    const { service, orderUpdate } = makeService({ updateStatus });
    await service.handleDriverStatus({
      orderID: "jet-1",
      driverStatus: { code: "delivered" },
    });
    expect(orderUpdate).toHaveBeenCalled();
  });

  it("records an unknown code verbatim without moving the order", async () => {
    const { service, updateStatus, orderUpdate } = makeService();
    const result = await service.handleDriverStatus({
      orderID: "jet-1",
      driverStatus: { code: "driverTookADetour" },
    });
    expect(updateStatus).not.toHaveBeenCalled();
    expect(orderUpdate.mock.calls[0]![0].data.courierStatus).toBe("driverTookADetour");
    expect(result.reason).toContain("unmapped_code");
  });
});

describe("JetLifecycleService.handleRestaurantTempOffline", () => {
  const CONN = {
    id: "conn-1",
    tenantId: "tenant-1",
    locationId: "location-1",
    brandId: "brand-1",
    metadata: {},
  };

  it("records the per-service state on the connection", async () => {
    const { service, connectionUpdate } = makeService({ connection: CONN });
    const result = await service.handleRestaurantTempOffline({
      restaurantId: "rest-1",
      lastChangedTimeStampUtc: "2026-08-15T10:12:56Z",
      collection: { isOffline: true, allowRestaurantOverride: true },
      delivery: { isOffline: false },
      dineIn: { isOffline: true },
    });

    expect(result.handled).toBe(true);
    const status = connectionUpdate.mock.calls[0]![0].data.metadata.jetServiceStatus;
    expect(status).toMatchObject({ collection: true, delivery: false, dineIn: true });
  });

  it("does NOT pause our own channels", async () => {
    // A JET-side pause silently stopping the shop's own online ordering and
    // POS is a surprise nobody asked for. We surface it; the operator decides.
    const { service, orderUpdate, activity } = makeService({ connection: CONN });
    await service.handleRestaurantTempOffline({
      restaurantId: "rest-1",
      collection: { isOffline: true },
      delivery: { isOffline: true },
    });
    expect(orderUpdate).not.toHaveBeenCalled();
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ category: "STATUS", status: "WARNING" }),
    );
  });

  it("logs a return to service as informational, not a warning", async () => {
    const { service, activity } = makeService({ connection: CONN });
    await service.handleRestaurantTempOffline({
      restaurantId: "rest-1",
      collection: { isOffline: false },
      delivery: { isOffline: false },
      dineIn: { isOffline: false },
    });
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "INFO" }),
    );
  });

  it("ignores a restaurant that is not connected here", async () => {
    const { service } = makeService({ connection: null });
    await expect(
      service.handleRestaurantTempOffline({ restaurantId: "someone-else" }),
    ).resolves.toMatchObject({ handled: false });
  });

  it("tries the restaurant reference before the POS location id", async () => {
    const { service, prisma } = makeService({ connection: CONN });
    await service.handleRestaurantTempOffline({ restaurantId: "rest-1" });
    expect(prisma.brandPlatformConnection.findFirst.mock.calls[0]![0].where.metadata)
      .toEqual({ path: ["restaurantReference"], equals: "rest-1" });
  });
});

describe("JetLifecycleService.handleFailedOrder", () => {
  const CONN = {
    id: "conn-1",
    tenantId: "tenant-1",
    locationId: "location-1",
    brandId: "brand-1",
    metadata: {},
  };

  it("surfaces the unknown item reference — usually the whole story", async () => {
    // A PLU on JET's menu that our last publish did not include. This is
    // exactly the signal the 97% menu-injection target is about.
    const { service, activity } = makeService({ connection: CONN });
    const result = await service.handleFailedOrder({
      validationError: "Item not found in menu",
      unknownReference: "BRGV1",
      menuId: "2d4006f6",
      order: { friendlyOrderReference: "1806363209", restaurantId: "rest-1" },
    });

    expect(result.handled).toBe(true);
    const entry = activity.record.mock.calls[0]![0];
    expect(entry.status).toBe("ERROR");
    expect(entry.message).toContain("BRGV1");
    expect(entry.details).toMatchObject({ menuId: "2d4006f6", unknownReference: "BRGV1" });
  });

  it("never ingests the rejected order onto the board", async () => {
    // JET refused it; it is going to the tablet. Showing it as live would tell
    // the kitchen to make food that the platform does not think exists.
    const { service, orderUpdate } = makeService({ connection: CONN });
    await service.handleFailedOrder({
      validationError: "bad",
      order: { friendlyOrderReference: "123", restaurantId: "rest-1", items: [] },
    });
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it("still acknowledges when the restaurant cannot be resolved", async () => {
    const { service } = makeService({ connection: null });
    await expect(
      service.handleFailedOrder({ validationError: "bad", order: {} }),
    ).resolves.toMatchObject({ handled: true });
  });
});

describe("JetLifecycleController", () => {
  function makeController(opts: { keyOk?: boolean; duplicate?: boolean } = {}) {
    const created: any[] = [];
    const prisma = {
      webhookEvent: {
        create: jest.fn(async ({ data }: any) => {
          if (opts.duplicate) {
            const err: any = new Error("dup");
            err.code = "P2002";
            throw err;
          }
          created.push(data);
          return data;
        }),
        update: jest.fn(async () => ({})),
      },
    } as any;
    const client = {
      verifyInboundApiKey: jest.fn(() => opts.keyOk ?? true),
    } as any;
    const lifecycle = {
      handleCancellation: jest.fn().mockResolvedValue({ handled: true }),
      handleDriverStatus: jest.fn().mockResolvedValue({ handled: true }),
      handleRestaurantTempOffline: jest.fn().mockResolvedValue({ handled: true }),
      handleFailedOrder: jest.fn().mockResolvedValue({ handled: true }),
    } as any;
    return {
      controller: new JetLifecycleController(prisma, client, lifecycle),
      lifecycle,
      created,
    };
  }

  const cancelBody = {
    orderID: "38bbeb45",
    reason: { code: "custCancelledMadeMistake" },
    happenedAt: "2026-08-15T10:12:56.371917Z",
  };

  it("echoes the payload back — that IS the acknowledgement", async () => {
    // The spec: "return a 200 status code and the same payload we sent you as
    // acknowledgement". A bare {ok:true} is a 400 to JET.
    const { controller } = makeController();
    await expect(controller.cancel(cancelBody, "key")).resolves.toEqual(cancelBody);
  });

  it("echoes on every one of the four endpoints", async () => {
    const { controller } = makeController();
    const driver = { orderID: "x", driverStatus: { code: "onItsWay" }, happenedAt: "t" };
    const store = { restaurantId: "r", lastChangedTimeStampUtc: "t" };
    const failed = { validationError: "bad" };
    await expect(controller.driverStatus(driver, "key")).resolves.toEqual(driver);
    await expect(controller.storeStatus(store, "key")).resolves.toEqual(store);
    await expect(controller.failedOrder(failed, "key")).resolves.toEqual(failed);
  });

  it("401s on a bad API key — there is no HMAC to fall back on", async () => {
    const { controller, lifecycle } = makeController({ keyOk: false });
    await expect(controller.cancel(cancelBody, "wrong")).rejects.toThrow();
    expect(lifecycle.handleCancellation).not.toHaveBeenCalled();
  });

  it("keys the event so it cannot collide with the order's own record", async () => {
    // WebhookEvent is unique on [platform, externalEventId] and order intake
    // already holds the bare JET order id. Keying on the order id alone would
    // make every cancellation look like a duplicate of the order itself.
    const { controller, created } = makeController();
    await controller.cancel(cancelBody, "key");
    expect(created[0]!.externalEventId).not.toBe(cancelBody.orderID);
    expect(created[0]!.externalEventId).toContain("cancel");
    expect(created[0]!.externalEventId).toContain(cancelBody.orderID);
  });

  it("distinguishes two driver stages for the same order", async () => {
    const { controller, created } = makeController();
    await controller.driverStatus(
      { orderID: "x", driverStatus: { code: "driverAtRestaurant" }, happenedAt: "t1" },
      "key",
    );
    await controller.driverStatus(
      { orderID: "x", driverStatus: { code: "onItsWay" }, happenedAt: "t2" },
      "key",
    );
    expect(created[0]!.externalEventId).not.toBe(created[1]!.externalEventId);
  });

  it("does not reprocess a retry, but still echoes", async () => {
    const { controller, lifecycle } = makeController({ duplicate: true });
    await expect(controller.cancel(cancelBody, "key")).resolves.toEqual(cancelBody);
    expect(lifecycle.handleCancellation).not.toHaveBeenCalled();
  });

  it("echoes even when the handler throws", async () => {
    // JET retries 5× on a 5xx. Reprocessing cannot fix a handler bug, and a
    // retry loop against a live shop costs everyone.
    const { controller, lifecycle } = makeController();
    lifecycle.handleCancellation.mockRejectedValue(new Error("boom"));
    await expect(controller.cancel(cancelBody, "key")).resolves.toEqual(cancelBody);
  });
});
