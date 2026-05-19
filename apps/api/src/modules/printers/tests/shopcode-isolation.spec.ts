/**
 * shopCode isolation tests — verifies that the Flutter printer app polling
 * endpoint returns print jobs only for the location whose shopCode matches
 * the request, and never leaks jobs from a different location.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { PrintersController } from "../printers.controller";
import { PrintersService } from "../printers.service";
import { PrintQueueService } from "../print-queue.service";
import { PrismaService } from "../../../infrastructure/database/prisma.service";

const LOCATION_A_ID = "loc-shop01";
const LOCATION_B_ID = "loc-shop02";
const SHOP_CODE_A = "SHOP01";
const SHOP_CODE_B = "SHOP02";

const JOB_A = {
  id: "job-a-1",
  type: "RECEIPT",
  status: "QUEUED",
  payload: { type: "RECEIPT", orderId: "order-1" },
  orderId: "order-1",
  printerId: "printer-a",
  createdAt: new Date(),
};

const JOB_B = {
  id: "job-b-1",
  type: "RECEIPT",
  status: "QUEUED",
  payload: { type: "RECEIPT", orderId: "order-2" },
  orderId: "order-2",
  printerId: "printer-b",
  createdAt: new Date(),
};

function makePrismaMock(shopCodeLocationMap: Record<string, string>, jobsPerLocation: Record<string, any[]>) {
  return {
    location: {
      findFirst: jest.fn(({ where }: any) => {
        const code = where?.OR?.[0]?.shopCode ?? where?.OR?.[1]?.id;
        const id = shopCodeLocationMap[code];
        return Promise.resolve(id ? { id } : null);
      }),
    },
    printJob: {
      findMany: jest.fn(({ where }: any) => {
        const locationId = where?.locationId;
        return Promise.resolve(jobsPerLocation[locationId] ?? []);
      }),
    },
    printer: { findFirst: jest.fn().mockResolvedValue(null) },
    printJob_create: jest.fn(),
  };
}

async function buildController(prismaMock: any) {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [PrintersController],
    providers: [
      { provide: PrismaService, useValue: prismaMock },
      { provide: PrintersService, useValue: {} },
      { provide: PrintQueueService, useValue: {} },
    ],
  }).compile();

  return module.get<PrintersController>(PrintersController);
}

describe("PrintersController — shopCode isolation", () => {
  const shopCodeMap = {
    [SHOP_CODE_A]: LOCATION_A_ID,
    [SHOP_CODE_B]: LOCATION_B_ID,
  };

  const jobMap = {
    [LOCATION_A_ID]: [JOB_A],
    [LOCATION_B_ID]: [JOB_B],
  };

  let prismaMock: ReturnType<typeof makePrismaMock>;
  let controller: PrintersController;

  beforeEach(async () => {
    prismaMock = makePrismaMock(shopCodeMap, jobMap);
    controller = await buildController(prismaMock);
  });

  afterEach(() => jest.clearAllMocks());

  it("returns only jobs for the location that matches shopCode SHOP01", async () => {
    const result = await controller.getPrintJobsForFlutter(SHOP_CODE_A);

    expect(result).toHaveLength(1);
    expect((result as any[])[0].id).toBe(JOB_A.id);
  });

  it("returns only jobs for the location that matches shopCode SHOP02", async () => {
    const result = await controller.getPrintJobsForFlutter(SHOP_CODE_B);

    expect(result).toHaveLength(1);
    expect((result as any[])[0].id).toBe(JOB_B.id);
  });

  it("does not return Shop B jobs when querying with Shop A shopCode", async () => {
    const result = await controller.getPrintJobsForFlutter(SHOP_CODE_A);

    const ids = (result as any[]).map((j) => j.id);
    expect(ids).not.toContain(JOB_B.id);
  });

  it("returns empty array for unknown shopCode", async () => {
    const result = await controller.getPrintJobsForFlutter("UNKNOWN99");

    expect(result).toEqual([]);
  });

  it("returns empty array when shopCode is missing", async () => {
    const result = await controller.getPrintJobsForFlutter("");

    expect(result).toEqual([]);
  });

  it("does not expose tenantId or credential fields in the Flutter response", async () => {
    const result = await controller.getPrintJobsForFlutter(SHOP_CODE_A);

    const json = JSON.stringify(result);
    expect(json).not.toContain("tenantId");
    expect(json).not.toContain("accessToken");
    expect(json).not.toContain("clientSecret");
    expect(json).not.toContain("webhookSecret");
  });
});
