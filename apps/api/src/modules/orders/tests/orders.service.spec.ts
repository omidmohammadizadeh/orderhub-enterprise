import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, BadRequestException, NotFoundException } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull";
import { OrdersService } from "../orders.service";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { SocketService } from "../../../infrastructure/socket/socket.service";
import { QUEUES } from "@orderhub/shared";
import type { CanonicalOrder } from "@orderhub/shared";

// ── Mocks ────────────────────────────────────────────────

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
  orderStatusHistory: { create: jest.fn() },
  location: { findFirst: jest.fn() },
  $transaction: jest.fn(),
};

const mockSocket = {
  emitNewOrder: jest.fn(),
  emitOrderUpdated: jest.fn(),
  emitToLocation: jest.fn(),
};

const mockQueue = { add: jest.fn() };

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

const makeOrder = (overrides?: object) => ({
  id: "order-001",
  tenantId: "tenant-001",
  locationId: "loc-001",
  externalId: "ext-123",
  platform: "UBER_EATS",
  status: "PENDING",
  updatedAt: new Date("2024-01-01T00:00:00Z"),
  cancelReason: null,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  total: 26,
  ...overrides,
});

// ── Tests ─────────────────────────────────────────────────

describe("OrdersService", () => {
  let service: OrdersService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SocketService, useValue: mockSocket },
        { provide: getQueueToken(QUEUES.ORDER_PROCESSING), useValue: mockQueue },
        { provide: getQueueToken(QUEUES.PRINTING), useValue: mockQueue },
      ],
    }).compile();

    service = module.get(OrdersService);
  });

  // ── ingestCanonical ───────────────────────────────────

  describe("ingestCanonical", () => {
    it("creates a new order and enqueues processing", async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      mockPrisma.order.create.mockResolvedValue(makeOrder());
      mockQueue.add.mockResolvedValue({});

      const order = await service.ingestCanonical(makeCanonical(), "tenant-001", "loc-001");

      expect(order.id).toBe("order-001");
      expect(mockPrisma.order.create).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledWith(
        "ORDER_INGEST",
        expect.objectContaining({ orderId: "order-001", tenantId: "tenant-001" }),
      );
      expect(mockSocket.emitNewOrder).toHaveBeenCalledWith("loc-001", expect.any(Object));
    });

    it("returns existing order on duplicate externalId/platform (idempotent)", async () => {
      const existingOrder = makeOrder();
      mockPrisma.order.findUnique.mockResolvedValue(existingOrder);

      const result = await service.ingestCanonical(makeCanonical(), "tenant-001", "loc-001");

      expect(result).toBe(existingOrder);
      expect(mockPrisma.order.create).not.toHaveBeenCalled();
      expect(mockQueue.add).not.toHaveBeenCalled();
      expect(mockSocket.emitNewOrder).not.toHaveBeenCalled();
    });

    it("returns existing order on duplicate idempotencyKey", async () => {
      const existingOrder = makeOrder();
      // First findUnique (externalId/platform) returns null, second (idempotencyKey) returns existing
      mockPrisma.order.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existingOrder);

      const canonical = makeCanonical({ idempotencyKey: "ikey-001" });
      const result = await service.ingestCanonical(canonical, "tenant-001", "loc-001");

      expect(result).toBe(existingOrder);
      expect(mockPrisma.order.create).not.toHaveBeenCalled();
    });

    it("stores customerName and customerPhone on create", async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      mockPrisma.order.create.mockResolvedValue(makeOrder());
      mockQueue.add.mockResolvedValue({});

      await service.ingestCanonical(makeCanonical(), "tenant-001", "loc-001");

      const createCall = mockPrisma.order.create.mock.calls[0][0];
      expect(createCall.data.customerName).toBe("Alice Test");
      expect(createCall.data.customerPhone).toBe("+447700900000");
    });
  });

  // ── updateStatus ─────────────────────────────────────

  describe("updateStatus", () => {
    it("transitions to a valid new status", async () => {
      const pendingOrder = makeOrder({ status: "PENDING" });
      const acceptedOrder = makeOrder({ status: "ACCEPTED" });

      mockPrisma.order.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.$transaction.mockImplementation(async (fn: Function) => {
        mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.order.findUniqueOrThrow.mockResolvedValue(acceptedOrder);
        mockPrisma.orderStatusHistory.create.mockResolvedValue({});
        return fn(mockPrisma);
      });
      mockQueue.add.mockResolvedValue({});

      const result = await service.updateStatus(
        "order-001",
        "tenant-001",
        { status: "ACCEPTED" },
        "user-001",
      );

      expect(result.status).toBe("ACCEPTED");
      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "order-001", updatedAt: pendingOrder.updatedAt },
          data: expect.objectContaining({ status: "ACCEPTED" }),
        }),
      );
    });

    it("throws ConflictException when optimistic concurrency fails (count=0)", async () => {
      mockPrisma.order.findFirst.mockResolvedValue(makeOrder({ status: "PENDING" }));
      mockPrisma.$transaction.mockImplementation(async (fn: Function) => {
        mockPrisma.order.updateMany.mockResolvedValue({ count: 0 });
        return fn(mockPrisma);
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
      mockPrisma.$transaction.mockImplementation(async (fn: Function) => {
        mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.order.findUniqueOrThrow.mockResolvedValue(cancelledOrder);
        mockPrisma.orderStatusHistory.create.mockResolvedValue({});
        return fn(mockPrisma);
      });
      mockQueue.add.mockResolvedValue({});

      await service.updateStatus(
        "order-001",
        "tenant-001",
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
      mockPrisma.$transaction.mockImplementation(async (fn: Function) => {
        mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.order.findUniqueOrThrow.mockResolvedValue(makeOrder({ status: "ACCEPTED" }));
        mockPrisma.orderStatusHistory.create.mockResolvedValue({});
        return fn(mockPrisma);
      });
      mockQueue.add.mockResolvedValue({});

      await service.updateStatus("order-001", "tenant-001", { status: "ACCEPTED" }, "user-001", "STAFF");

      const historyCall = mockPrisma.orderStatusHistory.create.mock.calls[0][0];
      expect(historyCall.data.actorType).toBe("STAFF");
      expect(historyCall.data.tenantId).toBe("tenant-001");
    });
  });
});
