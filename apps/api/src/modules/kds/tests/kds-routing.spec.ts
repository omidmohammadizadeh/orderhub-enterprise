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
    { id: "line-pizza", menuItemId: "mi-pizza", modifiers: [] },
    { id: "line-fries", menuItemId: "mi-fries", modifiers: [] },
    {
      id: "line-wrap",
      menuItemId: "mi-wrap",
      modifiers: [{ name: "Extra Halloumi fries" }, { name: "No Lettuce" }],
    },
    { id: "line-cola", menuItemId: null, modifiers: [] },
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

  it("routes items by modifier name regardless of their category", async () => {
    const prisma = makePrisma();
    prisma.kdsScreen.findMany.mockResolvedValue([
      screen("s-fryer", {
        stationType: "STATION",
        modifierNames: ["extra halloumi fries"],
      }),
    ]);
    prisma.order.findUnique.mockResolvedValue(ORDER);
    prisma.menuItemOnCategory.findMany.mockResolvedValue(CATEGORY_LINKS);

    const svc = new KdsService(prisma, socket);
    await svc.dispatchOrderToScreens("o1", "loc1");
    expect(
      prisma.kdsTicket.upsert.mock.calls[0][0].create.metadata.itemIds,
    ).toEqual(["line-wrap"]);
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

// A voice order that reached the kitchen must stay there. The settings page
// shipped without an "AI Voice" checkbox, so a screen with every OFFERED
// channel ticked held a list that excluded VOICE — and the next amend read
// that list and deleted the ticket. The food was on no screen at all.
describe("KdsService channel filter", () => {
  beforeEach(() => jest.clearAllMocks());

  const VOICE_ORDER = {
    id: "o-voice",
    locationId: "loc1",
    orderSource: "VOICE",
    items: [
      { id: "line-chips", name: "CHIPS", menuItemId: "mi-fries", modifiers: [] },
    ],
  };

  it("warns when every screen filters the order's channel out", async () => {
    const prisma = makePrisma();
    prisma.kdsScreen.findMany.mockResolvedValue([
      screen("s-wrap", {
        channels: ["ONLINE", "POS", "UBER_EATS", "DELIVEROO", "JUST_EAT"],
      }),
      screen("s-grill", {
        channels: ["ONLINE", "POS", "UBER_EATS", "DELIVEROO", "JUST_EAT"],
      }),
    ]);
    prisma.order.findUnique.mockResolvedValue(VOICE_ORDER);

    const svc = new KdsService(prisma, socket);
    const warn = jest
      .spyOn((svc as any).logger, "warn")
      .mockImplementation(() => {});
    const res = await svc.dispatchOrderToScreens("o-voice", "loc1");

    expect(res.created).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("reached NO screen");
    expect(warn.mock.calls[0][0]).toContain("VOICE");
  });

  it("keeps a ticket the screen already holds when its channel list no longer matches", async () => {
    const prisma = makePrisma({
      kdsTicket: {
        upsert: jest.fn(),
        findMany: jest.fn(async () => [
          {
            id: "t-wrap",
            kdsScreenId: "s-wrap",
            orderId: "o-voice",
            metadata: { itemIds: [], itemStates: {}, seenItemIds: ["line-chips"] },
            screen: {
              id: "s-wrap",
              name: "wrapping section",
              locationId: "loc1",
              settings: { channels: ["ONLINE", "POS"] },
            },
          },
        ]),
        update: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
        delete: jest.fn(),
      },
    });
    prisma.kdsScreen.findMany.mockResolvedValue([
      screen("s-wrap", { channels: ["ONLINE", "POS"] }),
    ]);
    prisma.order.findUnique.mockResolvedValue(VOICE_ORDER);

    const svc = new KdsService(prisma, socket);
    await svc.resyncOrderTickets("o-voice", "loc1");

    expect(prisma.kdsTicket.delete).not.toHaveBeenCalled();
    expect(prisma.kdsTicket.update).toHaveBeenCalled();
  });

  it("still drops a ticket whose items all left the station", async () => {
    const prisma = makePrisma({
      kdsTicket: {
        upsert: jest.fn(),
        findMany: jest.fn(async () => [
          {
            id: "t-pizza",
            kdsScreenId: "s-pizza",
            orderId: "o-voice",
            metadata: { itemIds: ["gone"], itemStates: {}, seenItemIds: ["gone"] },
            screen: {
              id: "s-pizza",
              name: "pizza",
              locationId: "loc1",
              settings: { categoryIds: ["cat-pizza"] },
            },
          },
        ]),
        update: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
        delete: jest.fn(),
      },
    });
    prisma.kdsScreen.findMany.mockResolvedValue([
      screen("s-pizza", { stationType: "STATION", categoryIds: ["cat-pizza"] }),
    ]);
    prisma.order.findUnique.mockResolvedValue(VOICE_ORDER);
    prisma.menuItemOnCategory.findMany.mockResolvedValue(CATEGORY_LINKS);

    const svc = new KdsService(prisma, socket);
    await svc.resyncOrderTickets("o-voice", "loc1");

    expect(prisma.kdsTicket.delete).toHaveBeenCalledWith({
      where: { id: "t-pizza" },
    });
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
