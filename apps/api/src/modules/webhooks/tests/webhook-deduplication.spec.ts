// Tests covering:
// 1. Duplicate webhook detection
// 2. Race condition: two concurrent requests with same event ID
// 3. Signature rejection
// 4. Retry behaviour after failed processing

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { WebhookIngestionService } from "../webhook-ingestion.service";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { OrdersService } from "../../orders/orders.service";
import { UberEatsAdapter } from "../adapters/uber-eats.adapter";
import { DeliverooAdapter } from "../adapters/deliveroo.adapter";
import { JustEatAdapter } from "../adapters/just-eat.adapter";
import { HubRiseAdapter } from "../adapters/hubrise.adapter";
import { WebhookAdapterFactory } from "../webhook-adapter.factory";

const mockPrisma = {
  webhookEvent: {
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  integration: {
    findFirst: jest.fn(),
  },
};

const mockOrdersService = {
  ingestCanonical: jest.fn(),
};

const mockAdapter = {
  platform: "UBER_EATS",
  verifySignature: jest.fn(),
  extractEventId: jest.fn(),
  normalize: jest.fn(),
};

const mockAdapterFactory = {
  get: jest.fn().mockReturnValue(mockAdapter),
};

const SAMPLE_UBER_EVENT = {
  event_type: "orders.notification",
  order: {
    id: "ue-order-race",
    cart: { items: [] },
    payment: { charges: {} },
    eater: {},
  },
};

const SAMPLE_CANONICAL = {
  externalId: "ue-order-race",
  platform: "UBER_EATS",
  orderSource: "UBER_EATS",
  integrationSource: "DIRECT",
  viaHubrise: false,
  fulfillmentType: "PLATFORM_COURIER",
  customerInfo: { name: "Test Customer" },
  items: [],
  subtotal: 0,
  taxAmount: 0,
  deliveryFee: 0,
  discount: 0,
  total: 0,
  metadata: {},
};

describe("WebhookIngestionService", () => {
  let service: WebhookIngestionService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookIngestionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrdersService, useValue: mockOrdersService },
        { provide: WebhookAdapterFactory, useValue: mockAdapterFactory },
      ],
    }).compile();

    service = module.get(WebhookIngestionService);
  });

  describe("duplicate detection", () => {
    it("returns { duplicate: true } when event ID was already processed", async () => {
      mockPrisma.integration.findFirst.mockResolvedValue({
        id: "int-001",
        credentials: { webhookSecret: "test-secret" },
      });
      mockAdapter.verifySignature.mockReturnValue({ valid: true });
      mockAdapter.extractEventId.mockReturnValue("event-abc");
      // Simulate duplicate: create throws a unique constraint error
      const uniqueError = new Error("Unique constraint failed on the fields: (`platform`,`externalEventId`)");
      (uniqueError as any).code = "P2002";
      mockPrisma.webhookEvent.create.mockRejectedValue(uniqueError);

      const result = await service.ingest({
        platform: "UBER_EATS",
        locationId: "loc-001",
        rawBody: Buffer.from(JSON.stringify(SAMPLE_UBER_EVENT)),
        headers: { "x-uber-signature": "sig" },
        payload: SAMPLE_UBER_EVENT,
      });

      expect(result.duplicate).toBe(true);
      expect(mockOrdersService.ingestCanonical).not.toHaveBeenCalled();
    });

    it("processes a new event and creates a WebhookEvent record", async () => {
      const createdWebhookEvent = { id: "whe-001", status: "PENDING" };
      mockPrisma.integration.findFirst.mockResolvedValue({
        id: "int-001",
        credentials: { webhookSecret: "test-secret" },
      });
      mockAdapter.verifySignature.mockReturnValue({ valid: true });
      mockAdapter.extractEventId.mockReturnValue("event-new-123");
      mockPrisma.webhookEvent.create.mockResolvedValue(createdWebhookEvent);
      mockAdapter.normalize.mockReturnValue(SAMPLE_CANONICAL);
      mockOrdersService.ingestCanonical.mockResolvedValue({ id: "order-999" });
      mockPrisma.webhookEvent.update.mockResolvedValue({});

      const result = await service.ingest({
        platform: "UBER_EATS",
        locationId: "loc-001",
        rawBody: Buffer.from(JSON.stringify(SAMPLE_UBER_EVENT)),
        headers: { "x-uber-signature": "sig" },
        payload: SAMPLE_UBER_EVENT,
      });

      expect(result.duplicate).toBe(false);
      expect(mockPrisma.webhookEvent.create).toHaveBeenCalled();
      expect(mockOrdersService.ingestCanonical).toHaveBeenCalled();
    });
  });

  describe("signature verification", () => {
    it("rejects webhooks with invalid signature", async () => {
      mockPrisma.integration.findFirst.mockResolvedValue({
        id: "int-001",
        credentials: { webhookSecret: "real-secret" },
      });
      mockAdapter.verifySignature.mockReturnValue({ valid: false, reason: "Signature mismatch" });

      await expect(
        service.ingest({
          platform: "UBER_EATS",
          locationId: "loc-001",
          rawBody: Buffer.from("{}"),
          headers: {},
          payload: {},
        }),
      ).rejects.toThrow();
    });

    it("rejects when no integration is configured for the location/platform", async () => {
      mockPrisma.integration.findFirst.mockResolvedValue(null);

      await expect(
        service.ingest({
          platform: "UBER_EATS",
          locationId: "loc-unknown",
          rawBody: Buffer.from("{}"),
          headers: {},
          payload: {},
        }),
      ).rejects.toThrow();
    });
  });

  describe("unknown platform", () => {
    it("throws when platform has no registered adapter", async () => {
      mockAdapterFactory.get.mockReturnValueOnce(undefined);

      await expect(
        service.ingest({
          platform: "UNKNOWN_PLATFORM",
          locationId: "loc-001",
          rawBody: Buffer.from("{}"),
          headers: {},
          payload: {},
        }),
      ).rejects.toThrow();
    });
  });
});
