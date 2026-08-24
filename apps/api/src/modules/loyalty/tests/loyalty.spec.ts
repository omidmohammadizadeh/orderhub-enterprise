import { LoyaltyService } from "../loyalty.service";

// A stamp card is small but it is money, and the two ways it goes wrong are
// both silent: minting two stamps for one order, and rewriting what a customer
// was already promised. Both are covered here.

const svc = (over: Record<string, any> = {}) => {
  const prisma: any = {
    order: { findUnique: jest.fn() },
    loyaltyCard: { findUnique: jest.fn(), upsert: jest.fn() },
    loyaltyStamp: { create: jest.fn().mockResolvedValue({}), count: jest.fn().mockResolvedValue(0) },
    loyaltyReward: {
      create: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    location: { findFirst: jest.fn().mockResolvedValue({ id: "loc-1" }) },
    brand: { findMany: jest.fn().mockResolvedValue([{ id: "brand-1" }]) },
    menuItem: { findFirst: jest.fn().mockResolvedValue({ id: "item-1" }) },
    ...over,
  };
  return { s: new LoyaltyService(prisma), prisma };
};

const ACTIVE = {
  id: "card-1",
  tenantId: "t1",
  isActive: true,
  stampsRequired: 6,
  minimumSpend: null,
  rewardLabel: "Free regular chips",
  rewardItemId: "item-1",
  rewardExpiryDays: null,
};

const order = (over: Record<string, any> = {}) => ({
  id: "order-1",
  tenantId: "t1",
  locationId: "loc-1",
  customerAccountId: "cust-1",
  subtotal: 12,
  total: 15,
  status: "COMPLETED",
  ...over,
});

describe("earning a stamp", () => {
  it("stamps a completed order from a signed-in customer", async () => {
    const { s, prisma } = svc();
    prisma.order.findUnique.mockResolvedValue(order());
    prisma.loyaltyCard.findUnique.mockResolvedValue(ACTIVE);
    expect(await s.awardForOrder("order-1")).toEqual({
      stamped: true,
      earnedReward: false,
    });
  });

  it("gives nothing for a guest checkout", async () => {
    // There is nobody to give it to.
    const { s, prisma } = svc();
    prisma.order.findUnique.mockResolvedValue(order({ customerAccountId: null }));
    expect((await s.awardForOrder("order-1")).stamped).toBe(false);
  });

  it("gives nothing for an order that is not completed", async () => {
    // A stamp at payment is a stamp that has to be taken back when the order
    // is cancelled five minutes later.
    const { s, prisma } = svc();
    prisma.order.findUnique.mockResolvedValue(order({ status: "PENDING" }));
    expect((await s.awardForOrder("order-1")).stamped).toBe(false);
  });

  it("gives nothing when the card is switched off", async () => {
    const { s, prisma } = svc();
    prisma.order.findUnique.mockResolvedValue(order());
    prisma.loyaltyCard.findUnique.mockResolvedValue({ ...ACTIVE, isActive: false });
    expect((await s.awardForOrder("order-1")).stamped).toBe(false);
  });

  it("honours the minimum spend", async () => {
    const { s, prisma } = svc();
    prisma.order.findUnique.mockResolvedValue(order({ subtotal: 4 }));
    prisma.loyaltyCard.findUnique.mockResolvedValue({ ...ACTIVE, minimumSpend: 7 });
    expect((await s.awardForOrder("order-1")).stamped).toBe(false);
  });

  it("measures the minimum against the SUBTOTAL, not the total", async () => {
    // A delivery fee is not the customer spending money with the shop, and
    // counting it would let fees buy stamps.
    const { s, prisma } = svc();
    prisma.order.findUnique.mockResolvedValue(order({ subtotal: 6, total: 12 }));
    prisma.loyaltyCard.findUnique.mockResolvedValue({ ...ACTIVE, minimumSpend: 7 });
    expect((await s.awardForOrder("order-1")).stamped).toBe(false);
  });

  it("does not mint a second stamp for the same order", async () => {
    // A webhook replay, a retry, an operator re-completing an order. The
    // unique constraint is what stops it; this is the handling of that.
    const { s, prisma } = svc();
    prisma.order.findUnique.mockResolvedValue(order());
    prisma.loyaltyCard.findUnique.mockResolvedValue(ACTIVE);
    prisma.loyaltyStamp.create.mockRejectedValue({ code: "P2002" });
    expect(await s.awardForOrder("order-1")).toEqual({
      stamped: false,
      earnedReward: false,
    });
  });
});

describe("earning a reward", () => {
  it("mints one on the sixth stamp", async () => {
    const { s, prisma } = svc();
    prisma.order.findUnique.mockResolvedValue(order());
    prisma.loyaltyCard.findUnique.mockResolvedValue(ACTIVE);
    prisma.loyaltyStamp.count.mockResolvedValue(6);
    prisma.loyaltyReward.count.mockResolvedValue(0);
    expect((await s.awardForOrder("order-1")).earnedReward).toBe(true);
  });

  it("does not mint a second one on the seventh", async () => {
    const { s, prisma } = svc();
    prisma.order.findUnique.mockResolvedValue(order());
    prisma.loyaltyCard.findUnique.mockResolvedValue(ACTIVE);
    prisma.loyaltyStamp.count.mockResolvedValue(7);
    prisma.loyaltyReward.count.mockResolvedValue(1);
    expect((await s.awardForOrder("order-1")).earnedReward).toBe(false);
  });

  it("mints the second one on the twelfth", async () => {
    // Counted against rewards already earned rather than a counter that gets
    // reset, so a customer mid-way through their second card keeps progress.
    const { s, prisma } = svc();
    prisma.order.findUnique.mockResolvedValue(order());
    prisma.loyaltyCard.findUnique.mockResolvedValue(ACTIVE);
    prisma.loyaltyStamp.count.mockResolvedValue(12);
    prisma.loyaltyReward.count.mockResolvedValue(1);
    expect((await s.awardForOrder("order-1")).earnedReward).toBe(true);
  });

  it("freezes the reward's wording at the moment it is earned", async () => {
    // The operator can change next month's offer. What this customer was
    // already promised does not change with it.
    const { s, prisma } = svc();
    prisma.order.findUnique.mockResolvedValue(order());
    prisma.loyaltyCard.findUnique.mockResolvedValue(ACTIVE);
    prisma.loyaltyStamp.count.mockResolvedValue(6);
    await s.awardForOrder("order-1");
    expect(prisma.loyaltyReward.create.mock.calls[0][0].data).toMatchObject({
      label: "Free regular chips",
      rewardItemId: "item-1",
    });
  });
});

describe("the customer's view of their card", () => {
  it("counts stamps on the CURRENT card, not for ever", async () => {
    // Eight lifetime stamps on a six card is two towards the next one — that
    // is the number the row of stamps has to draw.
    const { s, prisma } = svc();
    prisma.loyaltyCard.findUnique.mockResolvedValue({ ...ACTIVE, rewardItem: null });
    prisma.loyaltyStamp.count.mockResolvedValue(8);
    const card = await s.cardFor("cust-1", "loc-1");
    expect(card).toMatchObject({ active: true, stamps: 2, lifetimeStamps: 8 });
  });

  it("says nothing at all when the shop runs no card", async () => {
    const { s, prisma } = svc();
    prisma.loyaltyCard.findUnique.mockResolvedValue(null);
    expect(await s.cardFor("cust-1", "loc-1")).toEqual({ active: false });
  });

  it("hides an expired reward", async () => {
    const { s, prisma } = svc();
    prisma.loyaltyCard.findUnique.mockResolvedValue({ ...ACTIVE, rewardItem: null });
    prisma.loyaltyStamp.count.mockResolvedValue(6);
    prisma.loyaltyReward.findMany.mockResolvedValue([
      { id: "r1", label: "Free chips", earnedAt: new Date(), expiresAt: new Date(Date.now() - 1000) },
    ]);
    expect((await s.cardFor("cust-1", "loc-1") as any).rewards).toHaveLength(0);
  });
});

describe("configuring the card", () => {
  it("refuses to switch on a card with no reward", async () => {
    // Otherwise every customer's card carries an empty promise.
    const { s } = svc();
    await expect(
      s.upsertCard("t1", "loc-1", { isActive: true, rewardLabel: "  ", rewardItemId: null }),
    ).rejects.toThrow(/Choose a reward/);
  });

  it("clamps a nonsense stamp count", async () => {
    // One stamp is a discount, not a loyalty scheme.
    const { s, prisma } = svc();
    await s.upsertCard("t1", "loc-1", { stampsRequired: 1 });
    expect(prisma.loyaltyCard.upsert.mock.calls[0][0].create.stampsRequired).toBe(2);
  });

  it("refuses a reward item from another tenant", async () => {
    const { s, prisma } = svc();
    prisma.menuItem.findFirst.mockResolvedValue(null);
    await expect(
      s.upsertCard("t1", "loc-1", { rewardItemId: "someone-elses" }),
    ).rejects.toThrow(/Reward item not found/);
  });
});

// The listener reads a field off an event somebody else emits, and getting the
// NAME wrong fails silently — every transition returns on the first line and
// no stamp is ever awarded, with nothing in the logs to say so. That is
// exactly what happened, so the shape is pinned here.
describe("the order.status_changed listener", () => {
  const listen = () => {
    const { s, prisma } = svc();
    prisma.order.findUnique.mockResolvedValue({
      id: "order-1",
      tenantId: "t1",
      locationId: "loc-1",
      customerAccountId: "cust-1",
      subtotal: 20,
      total: 20,
      status: "COMPLETED",
    });
    prisma.loyaltyCard.findUnique.mockResolvedValue(ACTIVE);
    return { s, prisma };
  };

  it("acts on the field OrdersService actually emits — toStatus", async () => {
    const { s, prisma } = listen();
    await s.onOrderStatusChanged({ orderId: "order-1", toStatus: "COMPLETED" });
    expect(prisma.loyaltyStamp.create).toHaveBeenCalled();
  });

  it("ignores every other transition", async () => {
    const { s, prisma } = listen();
    await s.onOrderStatusChanged({ orderId: "order-1", toStatus: "ACCEPTED" });
    expect(prisma.loyaltyStamp.create).not.toHaveBeenCalled();
  });

  it("never throws into the transition that raised it", async () => {
    // A loyalty scheme failing must not roll back a kitchen state staff can
    // already see on the board.
    const { s, prisma } = listen();
    prisma.order.findUnique.mockRejectedValue(new Error("database is on fire"));
    await expect(
      s.onOrderStatusChanged({ orderId: "order-1", toStatus: "COMPLETED" }),
    ).resolves.toBeUndefined();
  });
});
