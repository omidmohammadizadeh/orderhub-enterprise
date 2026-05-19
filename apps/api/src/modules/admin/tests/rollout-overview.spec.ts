import { AdminService } from "../admin.service";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNow() {
  return new Date();
}

function makeLocation(overrides: Partial<{
  id: string;
  name: string;
  goLiveStatus: string;
  tenantId: string;
  printers: any[];
  integrations: any[];
}> = {}) {
  return {
    id: overrides.id ?? "loc-001",
    name: overrides.name ?? "Spice Garden",
    goLiveStatus: overrides.goLiveStatus ?? "LIVE",
    brand: { tenantId: overrides.tenantId ?? "tenant-a", name: "Brand A" },
    printers: overrides.printers ?? [
      {
        isOnline: true,
        metadata: { lastHeartbeatAt: new Date().toISOString() },
      },
    ],
    integrations: overrides.integrations ?? [
      { platform: "UBER_EATS", status: "ACTIVE", lastErrorAt: null, lastSyncAt: new Date() },
    ],
  };
}

function makePrismaMock(locations: any[] = [makeLocation()]) {
  return {
    location: {
      findMany: jest.fn().mockResolvedValue(locations),
    },
    order: {
      findFirst: jest.fn().mockResolvedValue({ createdAt: makeNow() }),
    },
    printJob: {
      findFirst: jest.fn().mockResolvedValue({ updatedAt: makeNow() }),
      count: jest.fn().mockResolvedValue(0),
    },
    outboxEvent: {
      count: jest.fn().mockResolvedValue(0),
    },
  };
}

function makeService(prismaMock: ReturnType<typeof makePrismaMock>): AdminService {
  return new (AdminService as any)(prismaMock, null, null, null);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AdminService.getRolloutOverview", () => {
  it("returns a location entry for each rollout location", async () => {
    const prisma = makePrismaMock([makeLocation({ id: "loc-1" }), makeLocation({ id: "loc-2" })]);
    const service = makeService(prisma);

    const result = await service.getRolloutOverview();

    expect(result.locationCount).toBe(2);
    expect(result.locations).toHaveLength(2);
  });

  it("does not expose credentials, tokens, or secrets in the response", async () => {
    const prisma = makePrismaMock([
      makeLocation({
        integrations: [
          {
            platform: "UBER_EATS",
            status: "ACTIVE",
            lastErrorAt: null,
            lastSyncAt: new Date(),
            // Simulate a DB row that has credentials — must NOT appear in output
            credentials: { accessToken: "secret-token", clientSecret: "very-secret" },
          },
        ],
      }),
    ]);
    const service = makeService(prisma);

    const result = await service.getRolloutOverview();
    const json = JSON.stringify(result);

    expect(json).not.toContain("accessToken");
    expect(json).not.toContain("clientSecret");
    expect(json).not.toContain("secret-token");
    expect(json).not.toContain("very-secret");
    expect(json).not.toContain("webhookSecret");
  });

  it("maps ACTIVE integration with no recent error to 'connected'", async () => {
    const prisma = makePrismaMock([
      makeLocation({
        integrations: [
          { platform: "DELIVEROO", status: "ACTIVE", lastErrorAt: null, lastSyncAt: new Date() },
        ],
      }),
    ]);
    const service = makeService(prisma);

    const result = await service.getRolloutOverview();

    expect(result.locations[0].providerStatuses.DELIVEROO).toBe("connected");
  });

  it("maps INACTIVE integration to 'disconnected'", async () => {
    const prisma = makePrismaMock([
      makeLocation({
        integrations: [
          { platform: "JUST_EAT", status: "INACTIVE", lastErrorAt: null, lastSyncAt: null },
        ],
      }),
    ]);
    const service = makeService(prisma);

    const result = await service.getRolloutOverview();

    expect(result.locations[0].providerStatuses.JUST_EAT).toBe("disconnected");
  });

  it("maps ACTIVE integration with recent error (< 1h) to 'error'", async () => {
    const recentErrorAt = new Date(Date.now() - 5 * 60_000); // 5 minutes ago
    const prisma = makePrismaMock([
      makeLocation({
        integrations: [
          { platform: "UBER_EATS", status: "ACTIVE", lastErrorAt: recentErrorAt, lastSyncAt: null },
        ],
      }),
    ]);
    const service = makeService(prisma);

    const result = await service.getRolloutOverview();

    expect(result.locations[0].providerStatuses.UBER_EATS).toBe("error");
  });

  it("reports printerStatus:online for fresh heartbeat", async () => {
    const prisma = makePrismaMock([
      makeLocation({
        printers: [
          { isOnline: true, metadata: { lastHeartbeatAt: new Date().toISOString() } },
        ],
      }),
    ]);
    const service = makeService(prisma);

    const result = await service.getRolloutOverview();

    expect(result.locations[0].printerStatus).toBe("online");
  });

  it("reports printerStatus:offline for stale heartbeat (> 90s)", async () => {
    const staleTime = new Date(Date.now() - 120_000).toISOString();
    const prisma = makePrismaMock([
      makeLocation({
        printers: [{ isOnline: true, metadata: { lastHeartbeatAt: staleTime } }],
      }),
    ]);
    const service = makeService(prisma);

    const result = await service.getRolloutOverview();

    expect(result.locations[0].printerStatus).toBe("offline");
  });

  it("reports printerStatus:unknown when no active printer", async () => {
    const prisma = makePrismaMock([makeLocation({ printers: [] })]);
    const service = makeService(prisma);

    const result = await service.getRolloutOverview();

    expect(result.locations[0].printerStatus).toBe("unknown");
  });

  it("sets paused:true for PAUSED locations", async () => {
    const prisma = makePrismaMock([makeLocation({ goLiveStatus: "PAUSED" })]);
    const service = makeService(prisma);

    const result = await service.getRolloutOverview();

    expect(result.locations[0].paused).toBe(true);
  });

  it("sets paused:false for LIVE locations", async () => {
    const prisma = makePrismaMock([makeLocation({ goLiveStatus: "LIVE" })]);
    const service = makeService(prisma);

    const result = await service.getRolloutOverview();

    expect(result.locations[0].paused).toBe(false);
  });

  it("includes failedPrintJobsLastHour and deadOutboxEvents counts", async () => {
    const prisma = makePrismaMock([makeLocation()]);
    prisma.printJob.count.mockResolvedValue(2);
    prisma.outboxEvent.count.mockResolvedValue(1);
    const service = makeService(prisma);

    const result = await service.getRolloutOverview();

    expect(result.locations[0].failedPrintJobsLastHour).toBe(2);
    expect(result.locations[0].deadOutboxEvents).toBe(1);
  });

  it("returns empty locations array when no rollout locations exist", async () => {
    const prisma = makePrismaMock([]);
    const service = makeService(prisma);

    const result = await service.getRolloutOverview();

    expect(result.locationCount).toBe(0);
    expect(result.locations).toHaveLength(0);
  });
});
