import { BadRequestException } from "@nestjs/common";
import { OrderingService } from "../ordering.service";

// Hiding an item on the storefront is not the same as refusing it.
//
// The basket survives a switch from collection to delivery, a tab left open
// keeps yesterday's menu, and the checkout payload is client-supplied. If a
// shop says a 20" sharing pizza does not go on a moped, this is where that has
// to actually hold.

const svc = (items: Array<Record<string, unknown>>) => {
  const prisma = { menuItem: { findMany: jest.fn().mockResolvedValue(items) } };
  const s = Object.create(OrderingService.prototype) as OrderingService;
  (s as unknown as { prisma: unknown }).prisma = prisma;
  return {
    assert: (ids: string[], ft: string | null) =>
      (
        s as unknown as {
          assertItemsAllowFulfillment: (
            ids: string[],
            ft: string | null,
          ) => Promise<void>;
        }
      ).assertItemsAllowFulfillment(ids, ft),
    prisma,
  };
};

describe("checkout — service-mode enforcement", () => {
  it("lets an ordinary basket through", async () => {
    const { assert } = svc([
      { id: "a", name: "Margherita", availableDelivery: true },
    ]);
    await expect(assert(["a"], "DELIVERY")).resolves.toBeUndefined();
  });

  it("refuses a no-delivery item on a delivery order", async () => {
    const { assert } = svc([
      {
        id: "a",
        name: '20" Sharing Pizza',
        availableCollection: true,
        availableDelivery: false,
        availableDineIn: true,
      },
    ]);
    await expect(assert(["a"], "DELIVERY")).rejects.toThrow(BadRequestException);
  });

  it("names the item, so the customer knows what to remove", async () => {
    // "Your order could not be placed" at the payment step is the worst
    // possible moment to be vague.
    const { assert } = svc([
      { id: "a", name: '20" Sharing Pizza', availableDelivery: false },
    ]);
    await expect(assert(["a"], "DELIVERY")).rejects.toThrow(
      /20" Sharing Pizza isn't available for delivery/,
    );
  });

  it("lists every offending item, not just the first", async () => {
    const { assert } = svc([
      { id: "a", name: "Sharing Platter", availableDelivery: false },
      { id: "b", name: "Ice Cream Sundae", availableDelivery: false },
    ]);
    await expect(assert(["a", "b"], "DELIVERY")).rejects.toThrow(
      /Sharing Platter, Ice Cream Sundae/,
    );
  });

  it("allows the same item on collection", async () => {
    const { assert } = svc([
      {
        id: "a",
        name: '20" Sharing Pizza',
        availableCollection: true,
        availableDelivery: false,
      },
    ]);
    await expect(assert(["a"], "PICKUP")).resolves.toBeUndefined();
  });

  it("blocks it on a courier order too", async () => {
    const { assert } = svc([
      { id: "a", name: "Sharing Platter", availableDelivery: false },
    ]);
    await expect(assert(["a"], "PLATFORM_COURIER")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("says dine-in when the order is dine-in", async () => {
    const { assert } = svc([
      { id: "a", name: "Meal Deal", availableDineIn: false },
    ]);
    await expect(assert(["a"], "DINE_IN")).rejects.toThrow(/for dine-in/);
  });

  it("passes an item saved before the feature existed", async () => {
    // No flags on the row at all. Absent means sold everywhere.
    const { assert } = svc([{ id: "a", name: "Old Item" }]);
    await expect(assert(["a"], "DELIVERY")).resolves.toBeUndefined();
  });

  it("does not query at all for an empty basket", async () => {
    const { assert, prisma } = svc([]);
    await assert([], "DELIVERY");
    expect(prisma.menuItem.findMany).not.toHaveBeenCalled();
  });

  it("looks each item up once however many lines it has", async () => {
    const { assert, prisma } = svc([
      { id: "a", name: "Chips", availableDelivery: true },
    ]);
    await assert(["a", "a", "a"], "DELIVERY");
    expect(prisma.menuItem.findMany.mock.calls[0]![0].where.id.in).toEqual(["a"]);
  });
});

// A loyalty reward is food leaving the kitchen for nothing, so the rules
// around it are about money: the client says WHICH reward, never what it is
// worth, and a reward can only ever be spent once.
describe("checkout — spending a loyalty reward", () => {
  const build = (reward: unknown, item: unknown = { id: "i1", name: "Regular Chips", plu: "12" }) => {
    const prisma = {
      loyaltyReward: { findFirst: jest.fn().mockResolvedValue(reward) },
      menuItem: { findUnique: jest.fn().mockResolvedValue(item) },
    };
    const s = Object.create(OrderingService.prototype) as OrderingService;
    (s as unknown as { prisma: unknown }).prisma = prisma;
    (s as unknown as { logger: unknown }).logger = { warn: jest.fn(), error: jest.fn() };
    return {
      build: (rewardId?: string, custId?: string, locId = "loc-1") =>
        (
          s as unknown as {
            buildLoyaltyLine: (a?: string, b?: string, c?: string) => Promise<any>;
          }
        ).buildLoyaltyLine(rewardId, custId, locId),
      prisma,
    };
  };

  const REWARD = { id: "r1", label: "Free regular chips", rewardItemId: "i1" };

  it("adds the free item as a real line at zero", async () => {
    // A line, not a discount. "-£3.50" on a ticket tells a kitchen nothing
    // about what to put in the bag.
    const { build: b } = build(REWARD);
    const line = await b("r1", "cust-1");
    expect(line).toMatchObject({
      menuItemId: "i1",
      name: "Regular Chips",
      quantity: 1,
      unitPrice: 0,
      totalPrice: 0,
    });
  });

  it("says on the line why it is free, where every ticket already prints", async () => {
    const { build: b } = build(REWARD);
    expect((await b("r1", "cust-1")).notes).toMatch(/LOYALTY REWARD/);
  });

  it("takes the item from the REWARD, never from the basket", async () => {
    const { build: b, prisma } = build(REWARD);
    await b("r1", "cust-1");
    expect(prisma.menuItem.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "i1" } }),
    );
  });

  it("only looks for an unclaimed reward, at THIS location, unexpired", async () => {
    const { build: b, prisma } = build(REWARD);
    await b("r1", "cust-1", "loc-9");
    const where = prisma.loyaltyReward.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      id: "r1",
      customerAccountId: "cust-1",
      claimedAt: null,
      // locationId sits on the reward itself now — a referral reward comes
      // from no card, so a card can no longer be what scopes it to a shop.
      locationId: "loc-9",
    });
    expect(where.OR).toBeTruthy();
  });

  it("adds nothing for a guest", async () => {
    const { build: b } = build(REWARD);
    expect(await b("r1", undefined)).toBeNull();
  });

  it("charges the order rather than failing it when the reward is gone", async () => {
    // The customer is at the payment step. Refusing the whole order because a
    // stamp card is in a state they cannot see is worse than charging them and
    // leaving the reward for next time.
    const { build: b } = build(null);
    expect(await b("r1", "cust-1")).toBeNull();
  });

  it("still honours a reward whose item was deleted", async () => {
    // The label was frozen when it was earned. The paper card would have been
    // honoured on the wording alone, and so is this.
    const { build: b } = build(REWARD, null);
    const line = await b("r1", "cust-1");
    expect(line).toMatchObject({ name: "Free regular chips", totalPrice: 0 });
  });
});
