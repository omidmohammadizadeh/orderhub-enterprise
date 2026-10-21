import { describeLoyaltyReward, loyaltyRewardDiscount, loyaltyRewardKind } from "@orderhub/shared";
import { LoyaltyService } from "../loyalty.service";

// A percentage-off reward is money, so its arithmetic is pinned here: the
// online checkout, the till and salon checkout all call the same function.

const gbp = (n: number) => `£${Number.isInteger(n) ? n : n.toFixed(2)}`;

describe("what a reward is worth", () => {
  it("knows the three kinds", () => {
    expect(loyaltyRewardKind({})).toBe("FREE_ITEM");
    expect(loyaltyRewardKind({ percentOff: 10 })).toBe("PERCENT_OFF");
    expect(loyaltyRewardKind({ amountOff: "5.00" })).toBe("AMOUNT_OFF");
  });

  it("takes the percentage off the order", () => {
    expect(loyaltyRewardDiscount({ percentOff: 10 }, 23.5)).toEqual({ amount: 2.35, short: 0 });
  });

  it("never takes more than the cap", () => {
    expect(loyaltyRewardDiscount({ percentOff: 50, maxDiscount: 5 }, 40)).toEqual({ amount: 5, short: 0 });
  });

  it("gives nothing under the minimum order, and says how much more is needed", () => {
    expect(loyaltyRewardDiscount({ percentOff: 20, minOrder: 15 }, 12.5)).toEqual({ amount: 0, short: 2.5 });
    expect(loyaltyRewardDiscount({ percentOff: 20, minOrder: 15 }, 15)).toEqual({ amount: 3, short: 0 });
  });

  it("money off never goes below zero", () => {
    expect(loyaltyRewardDiscount({ amountOff: 5 }, 3)).toEqual({ amount: 3, short: 0 });
  });

  it("reads Prisma decimals as numbers", () => {
    const dec = { toString: () => "4.50" };
    expect(loyaltyRewardDiscount({ percentOff: 100, maxDiscount: dec }, 10).amount).toBe(4.5);
  });

  it("a free-item reward is worth nothing as a discount", () => {
    expect(loyaltyRewardDiscount({ percentOff: null }, 30)).toEqual({ amount: 0, short: 0 });
  });

  it("describes itself for the card", () => {
    expect(describeLoyaltyReward({ percentOff: 10 }, gbp)).toBe("10% off your order");
    expect(describeLoyaltyReward({ percentOff: 15, maxDiscount: 5, minOrder: 20 }, gbp)).toBe(
      "15% off your order (up to £5, on orders of £20 or more)",
    );
  });
});

describe("saving a percentage card", () => {
  const setup = () => {
    const prisma: any = {
      location: { findFirst: jest.fn().mockResolvedValue({ id: "loc-1" }) },
      brand: { findMany: jest.fn().mockResolvedValue([{ id: "b1" }]) },
      menuItem: { findFirst: jest.fn() },
      loyaltyCard: { upsert: jest.fn(async ({ create }: any) => create) },
    };
    return { s: new LoyaltyService(prisma), prisma };
  };

  it("stores the percentage, cap and minimum, and drops any reward item", async () => {
    const { s } = setup();
    const saved: any = await s.upsertCard("t1", "loc-1", {
      isActive: true,
      rewardType: "PERCENT_OFF",
      rewardPercent: 15,
      rewardMaxDiscount: 5,
      rewardMinOrder: 20,
      rewardItemId: "item-1",
      rewardLabel: "",
    });
    expect(saved).toMatchObject({
      rewardType: "PERCENT_OFF",
      rewardPercent: 15,
      rewardMaxDiscount: 5,
      rewardMinOrder: 20,
      rewardItemId: null,
      rewardLabel: "15% off your order",
    });
  });

  it("refuses a percentage outside 1-100", async () => {
    const { s } = setup();
    await expect(s.upsertCard("t1", "loc-1", { rewardType: "PERCENT_OFF", rewardPercent: 0 })).rejects.toThrow(
      "between 1 and 100",
    );
    await expect(s.upsertCard("t1", "loc-1", { rewardType: "PERCENT_OFF", rewardPercent: 120 })).rejects.toThrow();
  });

  it("a free-item card keeps no percentage terms", async () => {
    const { s } = setup();
    const saved: any = await s.upsertCard("t1", "loc-1", {
      rewardType: "FREE_ITEM",
      rewardPercent: 15,
      rewardLabel: "Free chips",
    });
    expect(saved).toMatchObject({ rewardType: "FREE_ITEM", rewardPercent: null, rewardMaxDiscount: null });
  });
});

describe("earning a percentage reward", () => {
  it("freezes the percentage, cap and minimum onto the reward", async () => {
    const created: any[] = [];
    const prisma: any = {
      loyaltyMember: { findUnique: jest.fn().mockResolvedValue({ customerAccountId: null }) },
      loyaltyStamp: {
        createMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([{ id: "s1" }]),
        count: jest.fn().mockResolvedValue(6),
      },
      loyaltyReward: {
        count: jest.fn().mockImplementation(async () => created.length),
        create: jest.fn(async ({ data }: any) => created.push(data)),
      },
    };
    const s = new LoyaltyService(prisma);
    await s.stampWithoutSale({
      card: {
        id: "card-1",
        tenantId: "t1",
        locationId: "loc-1",
        stampsRequired: 6,
        rewardLabel: "15% off your order",
        rewardItemId: "stale-item",
        rewardExpiryDays: null,
        rewardType: "PERCENT_OFF",
        rewardPercent: 15,
        rewardMaxDiscount: { toString: () => "5.00" },
        rewardMinOrder: null,
      },
      memberId: "m1",
      count: 1,
      requestKey: "tap-00000001",
      staffUserId: "u1",
    });
    expect(created[0]).toMatchObject({
      percentOff: 15,
      maxDiscount: 5,
      minOrder: null,
      rewardItemId: null,
      label: "15% off your order",
    });
  });
});
