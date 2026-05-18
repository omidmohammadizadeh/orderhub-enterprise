import { OutboxService } from "../outbox.service";

describe("OutboxService", () => {
  let service: OutboxService;

  beforeEach(() => {
    service = new OutboxService();
  });

  describe("forOrderReceived", () => {
    it("builds a correct outbox event input", () => {
      const result = service.forOrderReceived(
        "tenant-1",
        "loc-1",
        "order-123",
        "UBER_EATS",
        "ext-456",
      );

      expect(result.tenantId).toBe("tenant-1");
      expect(result.locationId).toBe("loc-1");
      expect(result.aggregateType).toBe("order");
      expect(result.aggregateId).toBe("order-123");
      expect(result.eventType).toBe("order.received");
      expect((result.payload as any).orderId).toBe("order-123");
      expect((result.payload as any).tenantId).toBe("tenant-1");
      expect((result.payload as any).locationId).toBe("loc-1");
    });

    it("generates idempotencyKey from platform + externalId", () => {
      const r = service.forOrderReceived("t", "l", "o", "DELIVEROO", "ext-789");
      expect(r.idempotencyKey).toBe("recv-DELIVEROO-ext-789");
    });

    it("produces the same idempotencyKey for the same external ID", () => {
      const r1 = service.forOrderReceived("t", "l", "o1", "UBER_EATS", "same-ext");
      const r2 = service.forOrderReceived("t", "l", "o2", "UBER_EATS", "same-ext");
      expect(r1.idempotencyKey).toBe(r2.idempotencyKey);
    });
  });

  describe("forStatusChanged", () => {
    it("builds a correct status-change outbox event input", () => {
      const result = service.forStatusChanged(
        "tenant-1", "loc-1", "order-123", "PENDING", "ACCEPTED", undefined,
      );

      expect(result.eventType).toBe("order.status_changed");
      expect((result.payload as any).fromStatus).toBe("PENDING");
      expect((result.payload as any).toStatus).toBe("ACCEPTED");
      expect((result.payload as any).cancelReason).toBeUndefined();
    });

    it("includes cancelReason when provided", () => {
      const result = service.forStatusChanged(
        "t1", "l1", "o1", "ACCEPTED", "CANCELLED", "kitchen_closed",
      );
      expect((result.payload as any).cancelReason).toBe("kitchen_closed");
    });

    it("generates idempotencyKey from orderId + toStatus", () => {
      const r = service.forStatusChanged("t", "l", "order-abc", "PENDING", "ACCEPTED");
      expect(r.idempotencyKey).toBe("status-order-abc-ACCEPTED");
    });

    it("produces unique keys for each valid transition", () => {
      const keys = ["ACCEPTED", "PREPARING", "READY", "DISPATCHED", "COMPLETED"].map(
        (s) => service.forStatusChanged("t", "l", "o-1", "PENDING", s).idempotencyKey,
      );
      expect(new Set(keys).size).toBe(keys.length);
    });
  });
});

// ── OrdersService transaction contract ────────────────────────────────────────

describe("OrdersService outbox transaction contract", () => {
  const makeOrder = (overrides?: Partial<any>) => ({
    id: "order-abc",
    platform: "UBER_EATS",
    orderSource: "UBER_EATS",
    fulfillmentType: "PLATFORM_COURIER",
    status: "PENDING",
    displayId: "#42",
    total: 1000,
    scheduledFor: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    tenantId: "t1",
    locationId: "l1",
    externalId: "ext-001",
    customerInfo: { name: "Alice" },
    ...overrides,
  });

  const makeCanonical = (overrides?: Partial<any>) => ({
    externalId: "ext-001",
    platform: "UBER_EATS",
    displayId: "#42",
    orderSource: "UBER_EATS",
    integrationSource: "DIRECT",
    viaHubrise: false,
    fulfillmentType: "PLATFORM_COURIER",
    customerInfo: { name: "Alice", phone: "+44700000" },
    deliveryAddress: null,
    items: [{ name: "Burger", quantity: 1, unitPrice: 500, totalPrice: 500, modifiers: [], notes: null }],
    subtotal: 500, taxAmount: 0, deliveryFee: 200, discount: 0, total: 700,
    specialInstructions: null, scheduledFor: undefined,
    idempotencyKey: "idem-001", metadata: {},
    ...overrides,
  });

  let service: any;
  let txMock: jest.Mock;
  let outboxCreateMock: jest.Mock;
  let orderCreateMock: jest.Mock;
  let orderFindFirstMock: jest.Mock;

  beforeEach(() => {
    const outbox = new OutboxService();
    outboxCreateMock = jest.fn().mockResolvedValue({});
    orderCreateMock = jest.fn().mockResolvedValue(makeOrder());
    orderFindFirstMock = jest.fn().mockResolvedValue(makeOrder());

    const txPrisma = {
      order: {
        create: orderCreateMock,
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(makeOrder()),
      },
      orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
      outboxEvent: { create: outboxCreateMock },
    };

    txMock = jest.fn().mockImplementation(async (fn: any) => fn(txPrisma));

    const mockPrisma = {
      $transaction: txMock,
      order: { findFirst: orderFindFirstMock },
    };

    const mockSocket = {
      emitNewOrder: jest.fn(),
      emitOrderUpdated: jest.fn(),
      emitToLocation: jest.fn(),
    };

    const mockAudit = { log: jest.fn().mockResolvedValue(undefined) };

    // Import OrdersService — it lives in ../../orders relative to __tests__
    // but since rootDir=src, we go via require with module resolution
    const { OrdersService } = require("../../orders/orders.service");
    service = new OrdersService(mockPrisma, mockSocket, mockAudit, outbox);
  });

  it("uses $transaction for ingestCanonical", async () => {
    await service.ingestCanonical(makeCanonical(), "t1", "l1");
    expect(txMock).toHaveBeenCalledTimes(1);
  });

  it("inserts outbox event inside the transaction alongside the order", async () => {
    await service.ingestCanonical(makeCanonical(), "t1", "l1");
    expect(outboxCreateMock).toHaveBeenCalledTimes(1);
    const call = outboxCreateMock.mock.calls[0][0];
    expect(call.data.eventType).toBe("order.received");
  });

  it("does not inject a Bull queue — outbox owns downstream dispatch", () => {
    expect((service as any).orderQueue).toBeUndefined();
    expect((service as any).printQueue).toBeUndefined();
  });

  it("inserts outbox event inside the status-change transaction", async () => {
    // Patch txPrisma to capture outboxEvent.create for updateStatus path
    let updateOutboxCreate: jest.Mock | undefined;
    txMock.mockImplementation(async (fn: any) => {
      const txPrisma = {
        order: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue(makeOrder()),
        },
        orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
        outboxEvent: { create: (updateOutboxCreate = jest.fn().mockResolvedValue({})) },
      };
      return fn(txPrisma);
    });

    await service.updateStatus("order-abc", "t1", { status: "ACCEPTED" }, "user-1");

    expect(updateOutboxCreate).toHaveBeenCalledTimes(1);
    const call = updateOutboxCreate!.mock.calls[0][0];
    expect(call.data.eventType).toBe("order.status_changed");
    expect((call.data.payload as any).toStatus).toBe("ACCEPTED");
  });

  it("on P2002, returns existing order without a second transaction attempt", async () => {
    const p2002 = Object.assign(new Error("Unique constraint"), { code: "P2002" });
    txMock.mockRejectedValueOnce(p2002);
    orderFindFirstMock.mockResolvedValue(makeOrder({ id: "existing-order" }));

    const result = await service.ingestCanonical(
      makeCanonical({ externalId: "ext-dupe" }), "t1", "l1",
    );

    expect(result.id).toBe("existing-order");
    expect(txMock).toHaveBeenCalledTimes(1); // only one attempt
  });
});
