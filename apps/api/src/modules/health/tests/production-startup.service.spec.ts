import { Test, TestingModule } from "@nestjs/testing";
import * as crypto from "crypto";
import { ProductionStartupService } from "../production-startup.service";
import { PrismaService } from "../../../infrastructure/database/prisma.service";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeValidKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

const makePrismaMock = () => ({
  $queryRaw: jest.fn().mockResolvedValue([{ "?column?": 1 }]),
});

const makeQueueMock = () => ({
  client: {
    ping: jest.fn().mockResolvedValue("PONG"),
  },
});

async function buildService(
  prismaMock: ReturnType<typeof makePrismaMock>,
  queueMock: ReturnType<typeof makeQueueMock>,
): Promise<ProductionStartupService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ProductionStartupService,
      { provide: PrismaService, useValue: prismaMock },
      { provide: "BullQueue_order-processing", useValue: queueMock },
    ],
  }).compile();

  return module.get<ProductionStartupService>(ProductionStartupService);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ProductionStartupService", () => {
  let prismaMock: ReturnType<typeof makePrismaMock>;
  let queueMock: ReturnType<typeof makeQueueMock>;
  let exitSpy: jest.SpyInstance;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    prismaMock = makePrismaMock();
    queueMock = makeQueueMock();
    originalEnv = { ...process.env };
    exitSpy = jest.spyOn(process, "exit").mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    exitSpy.mockRestore();
    jest.clearAllMocks();
  });

  // ── Non-production: no checks run ────────────────────────────────────────

  it("does nothing when NODE_ENV is not production", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT;

    const service = await buildService(prismaMock, queueMock);
    await service.onModuleInit();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ── Encryption key checks ─────────────────────────────────────────────────

  it("exits when production and no encryption key is set", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT;
    process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
    process.env.APP_URL = "https://app.orderhub.io";

    const service = await buildService(prismaMock, queueMock);
    await service.onModuleInit();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when encryption key is not 32 bytes (64 hex chars)", async () => {
    process.env.NODE_ENV = "production";
    process.env.CREDENTIAL_ENCRYPTION_KEY = "deadbeef"; // too short
    process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
    process.env.APP_URL = "https://app.orderhub.io";

    const service = await buildService(prismaMock, queueMock);
    await service.onModuleInit();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("passes when a valid CREDENTIAL_ENCRYPTION_KEY is set", async () => {
    process.env.NODE_ENV = "production";
    process.env.CREDENTIAL_ENCRYPTION_KEY = makeValidKey();
    process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
    process.env.APP_URL = "https://app.orderhub.io";

    const service = await buildService(prismaMock, queueMock);
    await service.onModuleInit();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("passes when CREDENTIAL_ENCRYPTION_KEY_CURRENT is used instead", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT = makeValidKey();
    process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
    process.env.APP_URL = "https://app.orderhub.io";

    const service = await buildService(prismaMock, queueMock);
    await service.onModuleInit();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ── JWT secret checks ─────────────────────────────────────────────────────

  it("exits when JWT_SECRET contains insecure default 'change-me'", async () => {
    process.env.NODE_ENV = "production";
    process.env.CREDENTIAL_ENCRYPTION_KEY = makeValidKey();
    process.env.JWT_SECRET = "change-me-please-this-is-32-chars";
    process.env.APP_URL = "https://app.orderhub.io";

    const service = await buildService(prismaMock, queueMock);
    await service.onModuleInit();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when JWT_SECRET is too short (< 32 chars)", async () => {
    process.env.NODE_ENV = "production";
    process.env.CREDENTIAL_ENCRYPTION_KEY = makeValidKey();
    process.env.JWT_SECRET = "tooshort";
    process.env.APP_URL = "https://app.orderhub.io";

    const service = await buildService(prismaMock, queueMock);
    await service.onModuleInit();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ── Database check ────────────────────────────────────────────────────────

  it("exits when database connection fails", async () => {
    process.env.NODE_ENV = "production";
    process.env.CREDENTIAL_ENCRYPTION_KEY = makeValidKey();
    process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
    process.env.APP_URL = "https://app.orderhub.io";

    prismaMock.$queryRaw.mockRejectedValue(new Error("Connection refused"));

    const service = await buildService(prismaMock, queueMock);
    await service.onModuleInit();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ── Redis check ───────────────────────────────────────────────────────────

  it("exits when Redis connection fails", async () => {
    process.env.NODE_ENV = "production";
    process.env.CREDENTIAL_ENCRYPTION_KEY = makeValidKey();
    process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
    process.env.APP_URL = "https://app.orderhub.io";

    queueMock.client.ping.mockRejectedValue(new Error("Redis ECONNREFUSED"));

    const service = await buildService(prismaMock, queueMock);
    await service.onModuleInit();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ── All checks pass ───────────────────────────────────────────────────────

  it("does not exit when all production checks pass", async () => {
    process.env.NODE_ENV = "production";
    process.env.CREDENTIAL_ENCRYPTION_KEY = makeValidKey();
    process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
    process.env.APP_URL = "https://app.orderhub.io";

    const service = await buildService(prismaMock, queueMock);
    await service.onModuleInit();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(prismaMock.$queryRaw).toHaveBeenCalled();
    expect(queueMock.client.ping).toHaveBeenCalled();
  });
});
