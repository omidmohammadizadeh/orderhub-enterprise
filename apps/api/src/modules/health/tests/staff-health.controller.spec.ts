import { NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { StaffHealthController } from "../staff-health.controller";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TENANT_ID = "tenant-spgrd";
const LOCATION_ID = "loc-spgrd01";

const staffUser = (): AuthenticatedUser => ({
  userId: "user-staff-1",
  tenantId: TENANT_ID,
  role: "STAFF" as any,
  permissions: [],
});

const managerUser = (): AuthenticatedUser => ({
  userId: "user-mgr-1",
  tenantId: TENANT_ID,
  role: "MANAGER" as any,
  permissions: [],
});

function makePrismaMock() {
  return {
    location: {
      findFirst: jest.fn().mockResolvedValue({ id: LOCATION_ID }),
    },
    printer: {
      findFirst: jest.fn().mockResolvedValue({
        isOnline: true,
        metadata: { lastHeartbeatAt: new Date().toISOString() },
      }),
    },
    printJob: {
      findFirst: jest.fn().mockResolvedValue({ updatedAt: new Date() }),
      count: jest.fn().mockResolvedValue(0),
    },
    integration: {
      findMany: jest.fn().mockResolvedValue([
        { platform: "UBER_EATS", status: "ACTIVE" },
        { platform: "DELIVEROO", status: "ACTIVE" },
      ]),
    },
    order: {
      findFirst: jest.fn().mockResolvedValue({ createdAt: new Date() }),
    },
  };
}

async function buildController(prismaMock: ReturnType<typeof makePrismaMock>) {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [StaffHealthController],
    providers: [{ provide: PrismaService, useValue: prismaMock }],
  }).compile();

  return module.get<StaffHealthController>(StaffHealthController);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("StaffHealthController.staffStatus", () => {
  let prismaMock: ReturnType<typeof makePrismaMock>;
  let controller: StaffHealthController;

  beforeEach(async () => {
    prismaMock = makePrismaMock();
    controller = await buildController(prismaMock);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Tenant isolation ──────────────────────────────────────────────────────

  it("queries location with tenantId from JWT, not from query params", async () => {
    await controller.staffStatus(LOCATION_ID, staffUser());

    expect(prismaMock.location.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: LOCATION_ID,
          brand: { tenantId: TENANT_ID },
        }),
      }),
    );
  });

  it("throws NotFoundException when location does not belong to user's tenant", async () => {
    prismaMock.location.findFirst.mockResolvedValue(null);

    await expect(
      controller.staffStatus(LOCATION_ID, staffUser()),
    ).rejects.toThrow(NotFoundException);
  });

  it("does not expose data from a different tenant even if locationId is valid", async () => {
    const otherTenantUser: AuthenticatedUser = { ...staffUser(), tenantId: "tenant-other" };
    prismaMock.location.findFirst.mockResolvedValue(null);

    await expect(
      controller.staffStatus(LOCATION_ID, otherTenantUser),
    ).rejects.toThrow(NotFoundException);
  });

  // ── Response shape — no sensitive data ───────────────────────────────────

  it("returns expected safe fields and no credentials or tokens", async () => {
    const result = await controller.staffStatus(LOCATION_ID, staffUser());

    expect(result).toHaveProperty("systemStatus");
    expect(result).toHaveProperty("printerStatus");
    expect(result).toHaveProperty("lastHeartbeatAt");
    expect(result).toHaveProperty("lastPrintAt");
    expect(result).toHaveProperty("failedPrintJobsLastHour");
    expect(result).toHaveProperty("providerStatuses");
    expect(result).toHaveProperty("lastOrderAt");
    expect(result).toHaveProperty("actionRequired");

    // Must NOT contain sensitive internals
    const json = JSON.stringify(result);
    expect(json).not.toContain("accessToken");
    expect(json).not.toContain("clientSecret");
    expect(json).not.toContain("webhookSecret");
    expect(json).not.toContain("credentials");
    expect(json).not.toContain("outbox");
    expect(json).not.toContain("stack");
  });

  it("maps ACTIVE integration status to 'connected'", async () => {
    const result = await controller.staffStatus(LOCATION_ID, staffUser());

    expect(result.providerStatuses.UBER_EATS).toBe("connected");
    expect(result.providerStatuses.DELIVEROO).toBe("connected");
  });

  it("maps non-ACTIVE integration status to 'disconnected'", async () => {
    prismaMock.integration.findMany.mockResolvedValue([
      { platform: "UBER_EATS", status: "INACTIVE" },
    ]);

    const result = await controller.staffStatus(LOCATION_ID, staffUser());

    expect(result.providerStatuses.UBER_EATS).toBe("disconnected");
  });

  // ── Printer status logic ──────────────────────────────────────────────────

  it("returns printerStatus:online when printer is online and heartbeat is fresh", async () => {
    prismaMock.printer.findFirst.mockResolvedValue({
      isOnline: true,
      metadata: { lastHeartbeatAt: new Date().toISOString() },
    });

    const result = await controller.staffStatus(LOCATION_ID, staffUser());

    expect(result.printerStatus).toBe("online");
    expect(result.actionRequired).toBe("none");
  });

  it("returns printerStatus:offline and actionRequired:check_printer when printer is offline", async () => {
    prismaMock.printer.findFirst.mockResolvedValue({
      isOnline: false,
      metadata: {},
    });

    const result = await controller.staffStatus(LOCATION_ID, staffUser());

    expect(result.printerStatus).toBe("offline");
    expect(result.actionRequired).toBe("check_printer");
  });

  it("returns printerStatus:offline when lastHeartbeatAt is stale (> 90s ago)", async () => {
    const staleTime = new Date(Date.now() - 120_000).toISOString(); // 2 minutes ago
    prismaMock.printer.findFirst.mockResolvedValue({
      isOnline: true,
      metadata: { lastHeartbeatAt: staleTime },
    });

    const result = await controller.staffStatus(LOCATION_ID, staffUser());

    expect(result.printerStatus).toBe("offline");
    expect(result.actionRequired).toBe("check_printer");
  });

  it("returns printerStatus:unknown when no active printer is configured", async () => {
    prismaMock.printer.findFirst.mockResolvedValue(null);

    const result = await controller.staffStatus(LOCATION_ID, staffUser());

    expect(result.printerStatus).toBe("unknown");
  });

  // ── Escalation thresholds ─────────────────────────────────────────────────

  it("returns actionRequired:contact_support when >= 3 failed print jobs in last hour", async () => {
    prismaMock.printJob.count.mockResolvedValue(3);

    const result = await controller.staffStatus(LOCATION_ID, staffUser());

    expect(result.actionRequired).toBe("contact_support");
  });

  it("returns actionRequired:none when fewer than 3 failed print jobs", async () => {
    prismaMock.printJob.count.mockResolvedValue(2);

    const result = await controller.staffStatus(LOCATION_ID, staffUser());

    expect(result.actionRequired).toBe("none");
  });

  // ── Works for both STAFF and MANAGER roles ───────────────────────────────

  it("returns the same response shape for a MANAGER user", async () => {
    const result = await controller.staffStatus(LOCATION_ID, managerUser());

    expect(result).toHaveProperty("systemStatus");
    expect(result).toHaveProperty("providerStatuses");
  });
});
