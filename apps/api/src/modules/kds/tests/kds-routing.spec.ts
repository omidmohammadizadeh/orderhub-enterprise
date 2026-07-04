import { KdsService } from "../kds.service";

// Station routing + bump progression are the load-bearing logic of the new
// KDS: an order must split correctly per screen rules, and bumps must drive
// the order lifecycle (PREPARING on first activity, READY when the kitchen
// is done) exactly once.

function makePrisma(overrides: Record<string, any> = {}) {
  return {
    kdsScreen: { findMany: jest.fn(async () => []), findFirst: jest.fn(), findUnique: jest.fn() },
    kdsTicket: {
      upsert: jest.fn(async (args: any) => ({ id: "t1", ...args.create })),
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    order: { findUnique: jest.fn() },
    menuItemOnCategory: { findMany: jest.fn(async () => []) },
    location: { findFirst: jest.fn() },
    ...overrides,
  } as any;
}

const socket = { emitToLocation: jest.fn() } as any;

const ORDER = {
  id: "o1",
  orderSource: "UBER_EATS",
  items: [
    { id: "line-pizza", menuItemId: "mi-pizza" },
    { id: "line-fries", menuItemId: "mi-fries" },
    { id: "line-cola", menuItemId: null },
  ],
};

const CATEGORY_LINKS = [
  { itemId: "mi-pizza", categoryId: "cat-pizza" },
  { itemId: "mi-fries", categoryId: "cat-sides" },
];

function screen(id: string, settings: Record<string, unknown>) {
  return { id, locationId: "loc1", isActive: true, settings };
}

describe("KdsService.dispatchOrderToScreens", () => {
  beforeEach(() => jest.clearAllMocks());

  it("routes items by category, skips stations with no match, expo sees all", async () => {
    const prisma = makePrisma();
    prisma.kdsScreen.findMany.mockResolvedValue([
      screen("s-pizza", { stationType: "STATION", categoryIds: ["cat-pizza"] }),
      screen("s-grill", { stationType: "STATION", categoryIds: ["cat-grill"] }),
      screen("s-expo", { stationType: "EXPO" }),
      screen("s-all", {}), // no rules → whole order
    ]);
    prisma.order.findUnique.mockResolvedValue(ORDER);
    prisma.menuItemOnCategory.findMany.mockResolvedValue(CATEGORY_LINKS);

    const svc = new KdsService(prisma, socket);
    const res = await svc.dispatchOrderToScreens("o1", "loc1");

    expect(res.created).toBe(3); // pizza station + expo + rule-less
    const upserts = prisma.kdsTicket.upsert.mock.calls.map((c: any) => c[0]);
    const byScreen = new Map(
      upserts.map((u: any) => [u.create.kdsScreenId, u.create]),
    );
    expect(byScreen.has("s-grill")).toBe(false); // nothing routed there
    expect((byScreen.get("s-pizza") as any).metadata.itemIds).toEqual([
      "line-pizza",
    ]);
    expect((byScreen.get("s-expo") as any).metadata.itemIds).toEqual([]);
    expect((byScreen.get("s-all") as any).metadata.itemIds).toEqual([]);
  });

  it("applies the channel filter per screen", async () => {
    const prisma = makePrisma();
    prisma.kdsScreen.findMany.mockResolvedValue([
      screen("s-pos-only", { channels: ["POS"] }),
      screen("s-uber", { channels: ["UBER_EATS", "DELIVEROO"] }),
    ]);
    prisma.order.findUnique.mockResolvedValue(ORDER);

    const svc = new KdsService(prisma, socket);
    const res = await svc.dispatchOrderToScreens("o1", "loc1");
    expect(res.created).toBe(1);
    expect(prisma.kdsTicket.upsert.mock.calls[0][0].create.kdsScreenId).toBe(
      "s-uber",
    );
  });

  it("routes by explicit item ids regardless of category", async () => {
    const prisma = makePrisma();
    prisma.kdsScreen.findMany.mockResolvedValue([
      screen("s-special", { stationType: "STATION", itemIds: ["mi-fries"] }),
    ]);
    prisma.order.findUnique.mockResolvedValue(ORDER);
    prisma.menuItemOnCategory.findMany.mockResolvedValue(CATEGORY_LINKS);

    const svc = new KdsService(prisma, socket);
    await svc.dispatchOrderToScreens("o1", "loc1");
    expect(
      prisma.kdsTicket.upsert.mock.calls[0][0].create.metadata.itemIds,
    ).toEqual(["line-fries"]);
  });
});

describe("KdsService bump progression", () => {
  beforeEach(() => jest.clearAllMocks());

  function makeService(prisma: any) {
    const svc = new KdsService(prisma, socket);
    const progress: Array<[string, string]> = [];
    svc.onOrderProgress = async (orderId, status) => {
      progress.push([orderId, status]);
    };
    return { svc, progress };
  }

  it("station bump: PREPARING first, READY when all stations done (no expo)", async () => {
    const prisma = makePrisma();
    prisma.kdsScreen.findFirst.mockResolvedValue(
      screen("s-pizza", { stationType: "STATION", categoryIds: ["cat-pizza"] }),
    );
    prisma.kdsTicket.update.mockResolvedValue({ bumpedAt: new Date() });
    prisma.order.findUnique.mockResolvedValue({ status: "ACCEPTED" });
    prisma.kdsTicket.findMany.mockResolvedValue([
      {
        bumpedAt: new Date(),
        screen: { settings: { stationType: "STATION" }, isActive: true },
      },
      {
        bumpedAt: new Date(),
        screen: { settings: { stationType: "STATION" }, isActive: true },
      },
    ]);

    const { svc, progress } = makeService(prisma);
    await svc.bumpTicket("s-pizza", "o1", "t1");
    expect(progress).toEqual([
      ["o1", "PREPARING"],
      ["o1", "READY"],
    ]);
  });

  it("station bump does NOT set READY while another station is open or expo exists", async () => {
    const prisma = makePrisma();
    prisma.kdsScreen.findFirst.mockResolvedValue(
      screen("s-pizza", { stationType: "STATION" }),
    );
    prisma.kdsTicket.update.mockResolvedValue({ bumpedAt: new Date() });
    prisma.order.findUnique.mockResolvedValue({ status: "PREPARING" });
    // all stations bumped BUT an expo ticket exists → expo makes the call
    prisma.kdsTicket.findMany.mockResolvedValue([
      {
        bumpedAt: new Date(),
        screen: { settings: { stationType: "STATION" }, isActive: true },
      },
      {
        bumpedAt: null,
        screen: { settings: { stationType: "EXPO" }, isActive: true },
      },
    ]);

    const { svc, progress } = makeService(prisma);
    await svc.bumpTicket("s-pizza", "o1", "t1");
    expect(progress).toEqual([]); // already PREPARING, expo owns READY
  });

  it("expo bump serves the order: bumps stragglers + READY", async () => {
    const prisma = makePrisma();
    prisma.kdsScreen.findFirst.mockResolvedValue(
      screen("s-expo", { stationType: "EXPO" }),
    );
    prisma.kdsTicket.update.mockResolvedValue({ bumpedAt: new Date() });
    prisma.kdsTicket.findMany.mockResolvedValue([
      {
        id: "t-open",
        bumpedAt: null,
        screen: { id: "s-grill", locationId: "loc1" },
      },
    ]);

    const { svc, progress } = makeService(prisma);
    await svc.bumpTicket("s-expo", "o1", "t1");
    expect(prisma.kdsTicket.updateMany).toHaveBeenCalled();
    expect(progress).toEqual([["o1", "READY"]]);
  });
});
