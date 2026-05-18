import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, BadRequestException, NotFoundException } from "@nestjs/common";
import { OrdersService } from "../orders.service";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { SocketService } from "../../../infrastructure/socket/socket.service";
import { AuditLogService } from "../../auth/services/audit-log.service";
import { OutboxService } from "../../outbox/outbox.service";
import type { CanonicalOrder } from "@orderhub/shared";

// ── Mocks ────────────────────────────────────────────────

const mockOutboxEvent = { create: jest.fn().mockResolvedValue({}) };

const makeTxPrisma = (orderOverride?: object) => ({
  order: {
    create: jest.fn().mockResolvedValue(makeOrder(orderOverride)),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUniqueOrThrow: jest.fn().mockResolvedValue(makeOrder(orderOverride)),
  },
  orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  outboxEvent: mockOutboxEvent,
});

const mockPrisma = {
  order: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    count: jest.fn(),
  },
  outboxEvent: mockOutboxEvent,
  orderStatusHistory: { create: jest.fn() },
  location: { findFirst: jest.fn() },
  $transaction: jest.fn(),
};

const mockSocket = {
  emitNewOrder: jest.fn(),
  emitOrderUpdated: jest.fn(),
  emitToLocation: jest.fn(),
};

const mockAudit = {
  log: jest.fn().mockResolvedValue(undefined),
};

// ── Test Canonical Order ──────────────────────────────────

const makeCanonical = (overrides?: Partial<CanonicalOrder>): CanonicalOrder => ({
  externalId: "ext-123",
  platform: "UBER_EATS",
  displayId: "#42",
  orderSource: "UBER_EATS",
  integrationSource: "DIRECT",
  viaHubrise: false,
  fulfillmentType: "PLATFORM_COURIER",
  customerInfo: { name: "Alice Test", phone: "+447700900000" },
  deliveryAddress: { line1: "1 Test St", city: "London", postcode: "SW1A 1AA", country: "GB" },
  items: [
    {
      name: "Burger",
      quantity: 2,
      unitPrice: 10,
      totalPrice: 20,
      modifiers: [],
      notes: null,
    },
  ],
  subtotal: 20,
  taxAmount: 4,
  deliveryFee: 2,
  discount: 0,
  total: 26,
  specialInstructions: undefined,
  scheduledFor: undefined,
  idempotencyKey: undefined,
  metadata: {},
  ...overrides,
});

function makeOrder(overrides?: object) {
  return {
    id: "order-001",
    tenantId: "tenant-001",
    locationId: "loc-001",
    externalId: "ext-123",
    platform: "UBER_EATS",
    orderSource: "UBER_EATS",
    fulfillmentType: "PLATFORM_COURIER",
    status: "PENDING",
    displayId: "#42",
    total: 26,
    scheduledFor: null,
    customerInfo: { name: "Alice Test", phone: "+447700900000" },
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    cancelReason: null,
    cancelledAt: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────

describe("OrdersService", () => {
  let service: OrdersService;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Default: $transaction executes the callback
    const defaultTx = makeTxPrisma();
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(defaultTx));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SocketService, useValue: mockSocket },
        { provide: AuditLogService, useValue: mockAudit },
        OutboxService,
      ],
    }).compile();

    service = module.get(OrdersService);
  });

  // ── ingestCanonical ───────────────────────────────────

  describe("ingestCanonical", () => {
    it("creates a new order and emits socket event", async () => {
      const order = await service.ingestCanonical(makeCanonical(), "tenant-001", "loc-001");

      expect(order.id).toBe("order-001");
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockSocket.emitNewOrder).toHaveBeenCalledWith("loc-001", expect.any(Object));
    });

    it("inserts outbox event in the same transaction", async () => {
      let capturedOutboxCreate: jest.Mock | undefined;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = makeTxPrisma();
        capturedOutboxCreate = tx.outboxEvent.create;
        return fn(tx);
      });

      await service.ingestCanonical(makeCanonical(), "tenant-001", "loc-001");

      expect(capturedOutboxCreate).toHaveBeenCalledTimes(1);
      const call = capturedOutboxCreate!.mock.calls[0][0];
      expect(call.data.eventType).toBe("order.received");
    });

    it("does not inject Bull queues", () => {
      expect((service as any).orderQueue).toBeUndefined();
      expect((service as any).printQueue).toBeUndefined();
    });

    it("stores customerName and customerPhone on create", async () => {
      let capturedOrderCreate: jest.Mock | undefined;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = makeTxPrisma();
        capturedOrderCreate = tx.order.create;
        return fn(tx);
      });

      await service.ingestCanonical(makeCanonical(), "tenant-001", "loc-001");

      expect(capturedOrderCreate).toHaveBeenCalledTimes(1);
      const createCall = capturedOrderCreate!.mock.calls[0][0];
      expect(createCall.data.customerName).toBe("Alice Test");
      expect(createCall.data.customerPhone).toBe("+447700900000");
    });

    it("returns existing order on P2002 duplicate (idempotent)", async () => {
      const existing = makeOrder({ id: "order-existing" });
      const p2002 = Object.assign(new Error("Unique constraint"), { code: "P2002" });
      mockPrisma.$transaction.mockRejectedValueOnce(p2002);
      mockPrisma.order.findFirst = jest.fn().mockResolvedValue(existing);

      const result = await service.ingestCanonical(makeCanonical(), "tenant-001", "loc-001");

      expect(result.id).toBe("order-existing");
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  // ── updateStatus ─────────────────────────────────────

  describe("updateStatus", () => {
    it("transitions to a valid new status", async () => {
      const pendingOrder = makeOrder({ status: "PENDING" });
      const acceptedOrder = makeOrder({ status: "ACCEPTED" });

      mockPrisma.order.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          order: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUniqueOrThrow: jest.fn().mockResolvedValue(acceptedOrder),
          },
          orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
          outboxEvent: { create: jest.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      });

      const result = await service.updateStatus(
        "order-001", "tenant-001", { status: "ACCEPTED" }, "user-001",
      );

      expect(result.status).toBe("ACCEPTED");
    });

    it("inserts outbox event in the status-change transaction", async () => {
      const pendingOrder = makeOrder({ status: "PENDING" });
      mockPrisma.order.findFirst.mockResolvedValue(pendingOrder);

      let outboxCreate: jest.Mock | undefined;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          order: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUniqueOrThrow: jest.fn().mockResolvedValue(makeOrder({ status: "ACCEPTED" })),
          },
          orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
          outboxEvent: { create: (outboxCreate = jest.fn().mockResolvedValue({})) },
        };
        return fn(tx);
      });

      await service.updateStatus("order-001", "tenant-001", { status: "ACCEPTED" }, "user-001");

      expect(outboxCreate).toHaveBeenCalledTimes(1);
      const call = outboxCreate!.mock.calls[0][0];
      expect(call.data.eventType).toBe("order.status_changed");
    });

    it("throws ConflictException when optimistic concurrency fails (count=0)", async () => {
      mockPrisma.order.findFirst.mockResolvedValue(makeOrder({ status: "PENDING" }));
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          order: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
          orderStatusHistory: { create: jest.fn() },
          outboxEvent: { create: jest.fn() },
        };
        return fn(tx);
      });

      await expect(
        service.updateStatus("order-001", "tenant-001", { status: "ACCEPTED" }, "user-001"),
      ).rejects.toThrow(ConflictException);
    });

    it("throws BadRequestException for invalid status transition", async () => {
      mockPrisma.order.findFirst.mockResolvedValue(makeOrder({ status: "COMPLETED" }));

      await expect(
        service.updateStatus("order-001", "tenant-001", { status: "ACCEPTED" }, "user-001"),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException when order does not belong to tenant", async () => {
      mockPrisma.order.findFirst.mockResolvedValue(null);

      await expect(
        service.updateStatus("order-001", "other-tenant", { status: "ACCEPTED" }, "user-001"),
      ).rejects.toThrow(NotFoundException);
    });

    it("emits order:cancelled socket event on cancellation", async () => {
      const pendingOrder = makeOrder({ status: "PENDING", locationId: "loc-001" });
      const cancelledOrder = makeOrder({ status: "CANCELLED", cancelledAt: new Date() });

      mockPrisma.order.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          order: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUniqueOrThrow: jest.fn().mockResolvedValue(cancelledOrder),
          },
          orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
          outboxEvent: { create: jest.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      });

      await service.updateStatus(
        "order-001", "tenant-001",
        { status: "CANCELLED", cancelReason: "Customer request" },
        "user-001",
      );

      expect(mockSocket.emitToLocation).toHaveBeenCalledWith(
        "loc-001",
        "order:cancelled",
        expect.objectContaining({ orderId: "order-001", reason: "Customer request" }),
      );
    });

    it("writes actorType to OrderStatusHistory", async () => {
      const pendingOrder = makeOrder({ status: "PENDING" });
      mockPrisma.order.findFirst.mockResolvedValue(pendingOrder);

      let historyCreate: jest.Mock | undefined;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          order: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUniqueOrThrow: jest.fn().mockResolvedValue(makeOrder({ status: "ACCEPTED" })),
          },
          orderStatusHistory: { create: (historyCreate = jest.fn().mockResolvedValue({})) },
          outboxEvent: { create: jest.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      });

      await service.updateStatus("order-001", "tenant-001", { status: "ACCEPTED" }, "user-001", "STAFF");

      const historyCall = historyCreate!.mock.calls[0][0];
      expect(historyCall.data.actorType).toBe("STAFF");
      expect(historyCall.data.tenantId).toBe("tenant-001");
    });
  });
});
