import { LoyaltyService } from "../loyalty.service";

// Stamps given on the Scan loyalty card page, with no sale behind them. The
// requestKey is the only thing standing between a double tap and a free
// coffee, so it is what most of this checks — against a small in-memory
// store, because the behaviour lives in how stamps and rewards add up.

type Stamp = { id: string; cardId: string; memberId?: string; source: string; requestKey: string; createdAt: Date };
type Reward = { id: string; cardId: string; memberId?: string; claimedAt: Date | null; earnedAt: Date };

const CARD = {
  id: "card-1",
  tenantId: "t1",
  locationId: "loc-1",
  stampsRequired: 6,
  rewardLabel: "Free coffee",
  rewardItemId: null,
  rewardExpiryDays: null,
};

function setup() {
  const stamps: Stamp[] = [];
  const rewards: Reward[] = [];
  let n = 0;
  const match = (row: Record<string, any>, where: Record<string, any>) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && !(v instanceof Date)) {
        if ("in" in v) return v.in.includes(row[k]);
        if ("gte" in v) return row[k] >= v.gte;
      }
      return row[k] === v;
    });
  const prisma: any = {
    loyaltyMember: { findUnique: jest.fn().mockResolvedValue({ customerAccountId: null }) },
    loyaltyStamp: {
      createMany: jest.fn(async ({ data }: { data: any[] }) => {
        for (const d of data) {
          if (stamps.some((s) => s.requestKey === d.requestKey)) continue;
          stamps.push({ ...d, id: `s${++n}`, createdAt: new Date() });
        }
      }),
      findMany: jest.fn(async ({ where }: any) => stamps.filter((s) => match(s, where))),
      count: jest.fn(async ({ where }: any) => stamps.filter((s) => match(s, where)).length),
      deleteMany: jest.fn(async ({ where }: any) => {
        const gone = stamps.filter((s) => match(s, where));
        for (const g of gone) stamps.splice(stamps.indexOf(g), 1);
        return { count: gone.length };
      }),
    },
    loyaltyReward: {
      count: jest.fn(async ({ where }: any) => rewards.filter((r) => match(r, where)).length),
      create: jest.fn(async ({ data }: any) => {
        rewards.push({ ...data, id: `r${++n}`, claimedAt: null, earnedAt: new Date() });
      }),
      findFirst: jest.fn(async ({ where }: any) => [...rewards].reverse().find((r) => match(r, where)) ?? null),
      delete: jest.fn(async ({ where }: any) => {
        rewards.splice(rewards.findIndex((r) => r.id === where.id), 1);
      }),
    },
  };
  const events = { emit: jest.fn() };
  return { s: new LoyaltyService(prisma, events as any), stamps, rewards, events };
}

const give = (s: LoyaltyService, count: number, requestKey = "tap-00000001") =>
  s.stampWithoutSale({ card: CARD, memberId: "m1", count, requestKey, staffUserId: "u1" });

describe("stamping without a sale", () => {
  it("adds a MANUAL stamp with no order and refreshes the wallet pass", async () => {
    const { s, stamps, events } = setup();
    const res = await give(s, 1);
    expect(res.stampIds).toHaveLength(1);
    expect(stamps[0]).toMatchObject({ source: "MANUAL", memberId: "m1" });
    expect(stamps[0]).not.toHaveProperty("orderId");
    expect(events.emit).toHaveBeenCalledWith("loyalty.member_changed", { memberId: "m1" });
  });

  it("a double tap with the same request key adds nothing", async () => {
    const { s, stamps } = setup();
    await give(s, 2);
    const again = await give(s, 2);
    expect(stamps).toHaveLength(2);
    // The replay still answers with the stamps it made, so Undo works.
    expect(again.stampIds).toHaveLength(2);
  });

  it("completes the card and mints the reward", async () => {
    const { s, rewards } = setup();
    await give(s, 5, "tap-00000001");
    expect(rewards).toHaveLength(0);
    const res = await give(s, 1, "tap-00000002");
    expect(res.rewardsEarned).toBe(1);
    expect(rewards).toHaveLength(1);
  });

  it("several stamps at once can complete two cards", async () => {
    const { s, rewards } = setup();
    await give(s, 5, "tap-00000001");
    const res = await give(s, 7, "tap-00000002");
    expect(res.rewardsEarned).toBe(2);
    expect(rewards).toHaveLength(2);
  });
});

describe("undoing a stamp given by mistake", () => {
  it("removes the stamps and the unspent reward they completed", async () => {
    const { s, stamps, rewards } = setup();
    await give(s, 5, "tap-00000001");
    const last = await give(s, 1, "tap-00000002");
    expect(rewards).toHaveLength(1);
    const undone = await s.undoStampsWithoutSale(CARD, "m1", last.stampIds, new Date(Date.now() - 60_000));
    expect(undone).toBe(1);
    expect(stamps).toHaveLength(5);
    expect(rewards).toHaveLength(0);
  });

  it("leaves a reward alone once it has been handed over", async () => {
    const { s, rewards } = setup();
    await give(s, 5, "tap-00000001");
    const last = await give(s, 1, "tap-00000002");
    rewards[0]!.claimedAt = new Date();
    await s.undoStampsWithoutSale(CARD, "m1", last.stampIds, new Date(Date.now() - 60_000));
    expect(rewards).toHaveLength(1);
  });

  it("never touches stamps an order earned", async () => {
    const { s, stamps } = setup();
    stamps.push({ id: "order-stamp", cardId: "card-1", memberId: "m1", source: "ORDER", requestKey: "", createdAt: new Date() });
    expect(await s.undoStampsWithoutSale(CARD, "m1", ["order-stamp"], new Date(0))).toBe(0);
    expect(stamps).toHaveLength(1);
  });

  it("is refused once the undo window has passed", async () => {
    const { s, stamps } = setup();
    const res = await give(s, 1);
    expect(await s.undoStampsWithoutSale(CARD, "m1", res.stampIds, new Date(Date.now() + 1000))).toBe(0);
    expect(stamps).toHaveLength(1);
  });
});
