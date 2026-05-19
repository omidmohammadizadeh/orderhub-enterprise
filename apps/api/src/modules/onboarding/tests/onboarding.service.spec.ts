import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { OnboardingService } from "../onboarding.service";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { AuditLogService } from "../../auth/services/audit-log.service";
import { CredentialEncryptionService } from "../../integrations/credential-encryption.service";

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockLocation = (overrides: Record<string, unknown> = {}) => ({
  id: "loc-1",
  name: "Test Kitchen",
  isActive: true,
  shopCode: "SHOP001",
  goLiveStatus: "CONFIGURING",
  lastTestOrderAt: null,
  lastTestPrintAt: null,
  brand: { tenantId: "tenant-1", name: "Test Brand" },
  integrations: [
    {
      id: "int-1",
      platform: "UBER_EATS",
      status: "ACTIVE",
      credentials: { v: 1, alg: "aes-256-gcm", iv: "aabbcc", tag: "ddeeff", ct: "001122", kid: "v1" },
      webhookUrl: "https://api.example.com/webhooks/uber",
      lastSyncAt: new Date("2026-05-18T10:00:00Z"),
    },
  ],
  printers: [
    { id: "printer-1", name: "Kitchen Printer", isActive: true, isOnline: true, connectionType: "LAN" },
  ],
  ...overrides,
});

const mockTenant = (overrides: Record<string, unknown> = {}) => ({
  id: "tenant-1",
  status: "ACTIVE",
  name: "Test Tenant",
  ...overrides,
});

// ── Mock factories ────────────────────────────────────────────────────────────

const makePrismaMock = (overrides: Record<string, unknown> = {}) => ({
  location: {
    findFirst: jest.fn().mockResolvedValue(mockLocation()),
    findMany: jest.fn().mockResolvedValue([mockLocation()]),
    update: jest.fn().mockResolvedValue({}),
  },
  tenant: {
    findUnique: jest.fn().mockResolvedValue(mockTenant()),
  },
  outboxEvent: {
    count: jest.fn().mockResolvedValue(0),
  },
  order: {
    findFirst: jest.fn().mockResolvedValue(null),
  },
  printJob: {
    findFirst: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
  },
  user: {
    count: jest.fn().mockResolvedValue(1),
  },
  menuItem: {
    count: jest.fn().mockResolvedValue(5),
  },
  webhookEvent: {
    findFirst: jest.fn().mockResolvedValue(null),
  },
  ...overrides,
});

const makeEncryptionMock = (keyId = "v1") => ({
  keyId,
  isEncrypted: jest.fn().mockReturnValue(true),
  decrypt: jest.fn().mockImplementation((c: unknown) => c),
  isEncryptedWithCurrentKey: jest.fn().mockReturnValue(true),
});

const makeAuditMock = () => ({
  log: jest.fn().mockResolvedValue(undefined),
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("OnboardingService", () => {
  let service: OnboardingService;
  let prismaMock: ReturnType<typeof makePrismaMock>;
  let encryptionMock: ReturnType<typeof makeEncryptionMock>;
  let auditMock: ReturnType<typeof makeAuditMock>;

  async function buildModule(
    prismaOverrides: Record<string, unknown> = {},
    encryptionKeyId = "v1",
  ) {
    prismaMock = makePrismaMock(prismaOverrides);
    encryptionMock = makeEncryptionMock(encryptionKeyId);
    auditMock = makeAuditMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardingService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditLogService, useValue: auditMock },
        { provide: CredentialEncryptionService, useValue: encryptionMock },
      ],
    }).compile();

    service = module.get<OnboardingService>(OnboardingService);
  }

  beforeEach(() => {
    jest.resetAllMocks();
  });

  // ── getLocationReadiness ─────────────────────────────────────────────────

  describe("getLocationReadiness", () => {
    it("returns a readiness object with score and checks", async () => {
      await buildModule();
      const result = await service.getLocationReadiness("loc-1", "tenant-1");

      expect(result.locationId).toBe("loc-1");
      expect(result.locationName).toBe("Test Kitchen");
      expect(result.goLiveStatus).toBe("CONFIGURING");
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.allChecks.length).toBeGreaterThan(0);
      expect(result.lastUpdated).toBeInstanceOf(Date);
    });

    it("throws NotFoundException for unknown location", async () => {
      await buildModule();
      prismaMock.location.findFirst.mockResolvedValue(null);

      await expect(
        service.getLocationReadiness("nonexistent", "tenant-1"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException for unknown tenant", async () => {
      await buildModule();
      prismaMock.tenant.findUnique.mockResolvedValue(null);

      await expect(
        service.getLocationReadiness("loc-1", "tenant-1"),
      ).rejects.toThrow(NotFoundException);
    });

    it("encryption.key_set check fails when no key is configured", async () => {
      await buildModule({}, "");
      encryptionMock.keyId = "";

      const result = await service.getLocationReadiness("loc-1", "tenant-1");
      const check = result.allChecks.find((c) => c.key === "encryption.key_set")!;

      expect(check.status).toBe("fail");
      expect(check.critical).toBe(true);
      expect(check.adminOverridable).toBe(false);
      expect(result.blockers).toContainEqual(expect.objectContaining({ key: "encryption.key_set" }));
    });

    it("encryption.no_plaintext_credentials check fails when credentials are not encrypted", async () => {
      await buildModule();
      encryptionMock.isEncrypted.mockReturnValue(false);

      const result = await service.getLocationReadiness("loc-1", "tenant-1");
      const check = result.allChecks.find((c) => c.key === "encryption.no_plaintext_credentials")!;

      expect(check.status).toBe("fail");
      expect(check.critical).toBe(true);
      expect(check.adminOverridable).toBe(false);
    });

    it("tenant.active check fails when tenant is suspended", async () => {
      await buildModule();
      prismaMock.tenant.findUnique.mockResolvedValue(mockTenant({ status: "SUSPENDED" }));

      const result = await service.getLocationReadiness("loc-1", "tenant-1");
      const check = result.allChecks.find((c) => c.key === "tenant.active")!;

      expect(check.status).toBe("fail");
      expect(check.critical).toBe(true);
      expect(check.adminOverridable).toBe(false);
    });

    it("outbox.no_dead_events check fails when there are dead events", async () => {
      await buildModule();
      prismaMock.outboxEvent.count.mockResolvedValue(3);

      const result = await service.getLocationReadiness("loc-1", "tenant-1");
      const check = result.allChecks.find((c) => c.key === "outbox.no_dead_events")!;

      expect(check.status).toBe("fail");
      expect(check.critical).toBe(true);
      expect(check.adminOverridable).toBe(true);
    });

    it("score decreases with blockers and warnings", async () => {
      await buildModule();
      encryptionMock.keyId = "";
      prismaMock.outboxEvent.count.mockResolvedValue(5);
      prismaMock.menuItem.count.mockResolvedValue(0);

      const result = await service.getLocationReadiness("loc-1", "tenant-1");
      expect(result.score).toBeLessThan(100);
      expect(result.blockers.length).toBeGreaterThan(0);
    });

    it("includes provider and printer readiness in result", async () => {
      await buildModule();
      const result = await service.getLocationReadiness("loc-1", "tenant-1");

      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].platform).toBe("UBER_EATS");
      expect(result.providers[0].connected).toBe(true);
      expect(result.printers).toHaveLength(1);
      expect(result.printers[0].printerName).toBe("Kitchen Printer");
    });

    it("test order check uses lastTestOrderAt when set", async () => {
      const testDate = new Date("2026-05-18T09:00:00Z");
      await buildModule();
      prismaMock.location.findFirst.mockResolvedValue(
        mockLocation({ lastTestOrderAt: testDate }),
      );

      const result = await service.getLocationReadiness("loc-1", "tenant-1");
      const check = result.allChecks.find((c) => c.key === "orders.test_order_completed")!;
      expect(check.status).toBe("pass");
      expect(check.detail).toContain("2026-05-18");
    });

    it("test order check falls back to last sandbox order query", async () => {
      await buildModule();
      prismaMock.order.findFirst.mockResolvedValue({ createdAt: new Date("2026-05-18T08:00:00Z") });

      const result = await service.getLocationReadiness("loc-1", "tenant-1");
      const check = result.allChecks.find((c) => c.key === "orders.test_order_completed")!;
      expect(check.status).toBe("pass");
    });
  });

  // ── transitionGoLiveStatus ────────────────────────────────────────────────

  describe("transitionGoLiveStatus", () => {
    it("allows a valid transition CONFIGURING → TESTING", async () => {
      await buildModule();
      const result = await service.transitionGoLiveStatus(
        "loc-1",
        "tenant-1",
        "user-1",
        "TESTING",
      );

      expect(result.status).toBe("TESTING");
      expect(prismaMock.location.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { goLiveStatus: "TESTING" } }),
      );
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: "location.go_live_status_changed" }),
      );
    });

    it("rejects an invalid transition", async () => {
      await buildModule();
      await expect(
        service.transitionGoLiveStatus("loc-1", "tenant-1", "user-1", "LIVE"),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException when location is not found", async () => {
      await buildModule();
      prismaMock.location.findFirst
        .mockResolvedValueOnce(null);

      await expect(
        service.transitionGoLiveStatus("loc-1", "tenant-1", "user-1", "TESTING"),
      ).rejects.toThrow(NotFoundException);
    });

    it("blocks LIVE transition when critical checks fail", async () => {
      await buildModule();
      prismaMock.location.findFirst
        // first call: transition check (finds location)
        .mockResolvedValueOnce(mockLocation({ goLiveStatus: "READY_FOR_GO_LIVE" }))
        // second call: getLocationReadiness (findFirst for location)
        .mockResolvedValueOnce(mockLocation({ goLiveStatus: "READY_FOR_GO_LIVE" }));
      encryptionMock.isEncrypted.mockReturnValue(false);

      await expect(
        service.transitionGoLiveStatus("loc-1", "tenant-1", "user-1", "LIVE"),
      ).rejects.toThrow(BadRequestException);
    });

    it("writes audit log with reason", async () => {
      await buildModule();
      await service.transitionGoLiveStatus(
        "loc-1",
        "tenant-1",
        "user-1",
        "TESTING",
        "Moving to testing phase",
      );

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          meta: expect.objectContaining({ reason: "Moving to testing phase" }),
        }),
      );
    });
  });

  // ── adminOverride ─────────────────────────────────────────────────────────

  describe("adminOverride", () => {
    it("allows override with a valid reason", async () => {
      await buildModule();
      const result = await service.adminOverride(
        "loc-1",
        "tenant-1",
        "admin-user-1",
        "TESTING",
        "Manual setup complete — advancing for pilot",
      );

      expect(result.status).toBe("TESTING");
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "location.admin_override",
          meta: expect.objectContaining({ adminOverride: true }),
        }),
      );
    });

    it("throws BadRequestException when reason is empty", async () => {
      await buildModule();
      await expect(
        service.adminOverride("loc-1", "tenant-1", "admin-1", "TESTING", ""),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when reason is whitespace only", async () => {
      await buildModule();
      await expect(
        service.adminOverride("loc-1", "tenant-1", "admin-1", "TESTING", "   "),
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses to override to LIVE when encryption key is missing", async () => {
      await buildModule();
      const saved = process.env.CREDENTIAL_ENCRYPTION_KEY;
      const savedCurrent = process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT;
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT;

      try {
        await expect(
          service.adminOverride("loc-1", "tenant-1", "admin-1", "LIVE", "Force live"),
        ).rejects.toThrow(ForbiddenException);
      } finally {
        if (saved) process.env.CREDENTIAL_ENCRYPTION_KEY = saved;
        if (savedCurrent) process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT = savedCurrent;
      }
    });

    it("refuses to override to LIVE when tenant is not ACTIVE", async () => {
      await buildModule();
      process.env.CREDENTIAL_ENCRYPTION_KEY = "deadbeef".repeat(8);
      prismaMock.tenant.findUnique.mockResolvedValue(mockTenant({ status: "SUSPENDED" }));

      try {
        await expect(
          service.adminOverride("loc-1", "tenant-1", "admin-1", "LIVE", "Force live"),
        ).rejects.toThrow(ForbiddenException);
      } finally {
        delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      }
    });

    it("throws NotFoundException when location not found", async () => {
      await buildModule();
      prismaMock.location.findFirst.mockResolvedValue(null);

      await expect(
        service.adminOverride("loc-1", "tenant-1", "admin-1", "TESTING", "Setup complete"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── recordTestOrder / recordTestPrint ─────────────────────────────────────

  describe("recordTestOrder", () => {
    it("updates lastTestOrderAt and writes audit log", async () => {
      await buildModule();
      await service.recordTestOrder("loc-1", "tenant-1", "user-1");

      expect(prismaMock.location.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lastTestOrderAt: expect.any(Date) }),
        }),
      );
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: "location.test_order_completed" }),
      );
    });

    it("throws NotFoundException when location not found", async () => {
      await buildModule();
      prismaMock.location.findFirst.mockResolvedValue(null);

      await expect(service.recordTestOrder("loc-1", "tenant-1", "user-1")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("recordTestPrint", () => {
    it("updates lastTestPrintAt and writes audit log", async () => {
      await buildModule();
      await service.recordTestPrint("loc-1", "tenant-1", "user-1");

      expect(prismaMock.location.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lastTestPrintAt: expect.any(Date) }),
        }),
      );
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: "location.test_print_completed" }),
      );
    });
  });

  // ── listLocationsWithStatus ───────────────────────────────────────────────

  describe("listLocationsWithStatus", () => {
    it("returns location list with go-live status", async () => {
      await buildModule();
      prismaMock.location.findMany.mockResolvedValue([
        {
          id: "loc-1",
          name: "Test Kitchen",
          isActive: true,
          goLiveStatus: "CONFIGURING",
          brand: { tenantId: "tenant-1", name: "Test Brand" },
          createdAt: new Date(),
          _count: { integrations: 1, printers: 1 },
        },
      ]);

      const result = await service.listLocationsWithStatus("tenant-1");

      expect(result).toHaveLength(1);
      expect(result[0].locationId).toBe("loc-1");
      expect(result[0].goLiveStatus).toBe("CONFIGURING");
      expect(result[0].score).toBeNull();
    });

    it("returns all locations when no tenantId filter given", async () => {
      await buildModule();
      prismaMock.location.findMany.mockResolvedValue([]);

      await service.listLocationsWithStatus();

      expect(prismaMock.location.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.not.objectContaining({ brand: expect.anything() }),
        }),
      );
    });
  });

  // ── Emergency controls ────────────────────────────────────────────────────

  describe("pauseProvider", () => {
    const mockIntegration = {
      id: "int-1",
      platform: "UBER_EATS",
      status: "ACTIVE",
    };

    beforeEach(() => {
      // integration.findFirst and update
      (makePrismaMock() as any); // reset handled in buildModule()
    });

    it("sets integration status to INACTIVE and writes audit log", async () => {
      await buildModule();
      prismaMock.integration = {
        findFirst: jest.fn().mockResolvedValue(mockIntegration),
        update: jest.fn().mockResolvedValue({}),
      };

      const result = await service.pauseProvider("loc-1", "tenant-1", "int-1", "user-1", "Deliveroo sync issue");

      expect(result.status).toBe("INACTIVE");
      expect(prismaMock.integration.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "INACTIVE" } }),
      );
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: "location.provider_paused" }),
      );
    });

    it("throws BadRequestException when reason is empty", async () => {
      await buildModule();
      await expect(
        service.pauseProvider("loc-1", "tenant-1", "int-1", "user-1", ""),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException when integration not found", async () => {
      await buildModule();
      prismaMock.integration = {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      };

      await expect(
        service.pauseProvider("loc-1", "tenant-1", "int-1", "user-1", "Emergency"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("resumeProvider", () => {
    it("sets integration status to ACTIVE and writes audit log", async () => {
      await buildModule();
      prismaMock.integration = {
        findFirst: jest.fn().mockResolvedValue({ id: "int-1", platform: "UBER_EATS", status: "INACTIVE" }),
        update: jest.fn().mockResolvedValue({}),
      };

      const result = await service.resumeProvider("loc-1", "tenant-1", "int-1", "user-1", "Issue resolved");

      expect(result.status).toBe("ACTIVE");
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: "location.provider_resumed" }),
      );
    });

    it("throws BadRequestException when reason is empty", async () => {
      await buildModule();
      await expect(
        service.resumeProvider("loc-1", "tenant-1", "int-1", "user-1", "  "),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("pausePrinter", () => {
    it("sets printer isActive to false and writes audit log", async () => {
      await buildModule();
      prismaMock.printer = {
        findFirst: jest.fn().mockResolvedValue({ id: "printer-1", name: "Kitchen Printer", isActive: true }),
        update: jest.fn().mockResolvedValue({}),
      };

      const result = await service.pausePrinter("loc-1", "tenant-1", "printer-1", "user-1", "Printer offline");

      expect(result.isActive).toBe(false);
      expect(prismaMock.printer.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isActive: false } }),
      );
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: "location.printer_paused" }),
      );
    });

    it("throws BadRequestException when reason is empty", async () => {
      await buildModule();
      await expect(
        service.pausePrinter("loc-1", "tenant-1", "printer-1", "user-1", ""),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException when printer not found", async () => {
      await buildModule();
      prismaMock.printer = {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      };

      await expect(
        service.pausePrinter("loc-1", "tenant-1", "printer-1", "user-1", "Emergency"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("resumePrinter", () => {
    it("sets printer isActive to true and writes audit log", async () => {
      await buildModule();
      prismaMock.printer = {
        findFirst: jest.fn().mockResolvedValue({ id: "printer-1", name: "Kitchen Printer", isActive: false }),
        update: jest.fn().mockResolvedValue({}),
      };

      const result = await service.resumePrinter("loc-1", "tenant-1", "printer-1", "user-1", "Printer fixed");

      expect(result.isActive).toBe(true);
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: "location.printer_resumed" }),
      );
    });
  });
});
