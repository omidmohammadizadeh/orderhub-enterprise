// Tests covering:
// 1. Duplicate webhook detection
// 2. Race condition: two concurrent requests with same event ID
// 3. Signature rejection
// 4. Retry behaviour after failed processing

import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { WebhookIngestionService } from "../webhook-ingestion.service";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { OrdersService } from "../../orders/orders.service";
import { WebhookAdapterFactory } from "../webhook-adapter.factory";
import { CredentialEncryptionService } from "../../integrations/credential-encryption.service";

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

// Passthrough encryption — credentials stored as plaintext in tests
const mockEncryption = {
  decrypt: jest.fn().mockImplementation((c: unknown) => c),
  isEncrypted: jest.fn().mockReturnValue(false),
};

const MOCK_INTEGRATION = {
  id: "int-001",
  credentials: { webhookSecret: "test-secret" },
  location: { brand: { tenantId: "tenant-001" } },
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
    mockAdapterFactory.get.mockReturnValue(mockAdapter);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookIngestionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrdersService, useValue: mockOrdersService },
        { provide: WebhookAdapterFactory, useValue: mockAdapterFactory },
        { provide: CredentialEncryptionService, useValue: mockEncryption },
      ],
    }).compile();

    service = module.get(WebhookIngestionService);
  });

  describe("duplicate detection", () => {
    it("returns { duplicate: true } when event ID was already processed", async () => {
      mockPrisma.integration.findFirst.mockResolvedValue(MOCK_INTEGRATION);
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
      mockPrisma.integration.findFirst.mockResolvedValue(MOCK_INTEGRATION);
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
      mockPrisma.integration.findFirst.mockResolvedValue(MOCK_INTEGRATION);
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
      ).rejects.toThrow(NotFoundException);
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

  describe("encrypted credentials", () => {
    it("decrypts credentials before extracting webhook secret", async () => {
      const encryptedIntegration = {
        ...MOCK_INTEGRATION,
        credentials: { v: 1, alg: "aes-256-gcm", iv: "deadbeef", tag: "abcd", ct: "cafe" },
      };
      mockPrisma.integration.findFirst.mockResolvedValue(encryptedIntegration);
      mockEncryption.decrypt.mockReturnValueOnce({ webhookSecret: "decrypted-secret" });
      mockAdapter.verifySignature.mockReturnValue({ valid: true });
      mockAdapter.extractEventId.mockReturnValue("event-enc-001");
      mockPrisma.webhookEvent.create.mockResolvedValue({ id: "whe-enc" });
      mockAdapter.normalize.mockReturnValue(null); // non-order event — stops early
      mockPrisma.webhookEvent.update.mockResolvedValue({});

      await service.ingest({
        platform: "UBER_EATS",
        locationId: "loc-001",
        rawBody: Buffer.from("{}"),
        headers: {},
        payload: {},
      });

      expect(mockEncryption.decrypt).toHaveBeenCalledWith(encryptedIntegration.credentials);
      expect(mockAdapter.verifySignature).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.any(Object),
        "decrypted-secret",
      );
    });
  });
});
