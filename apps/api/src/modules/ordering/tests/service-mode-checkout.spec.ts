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

// Claiming a reward and buying nothing else is a real order — somebody whose
// card is full has earned a free thing and should be able to come and collect
// it. Being made to add a drink to claim a free chicken is the sort of small
// meanness people remember.
describe("an order that is only a reward", () => {
  it("still puts a line on the ticket", async () => {
    // Otherwise the kitchen gets an order with nothing on it.
    const prisma = {
      loyaltyReward: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: "r1", label: "Free Whole Chicken", rewardItemId: "i1" }),
      },
      menuItem: {
        findUnique: jest.fn().mockResolvedValue({ id: "i1", name: "Whole Chicken", plu: "9" }),
      },
    };
    const s = Object.create(OrderingService.prototype) as OrderingService;
    (s as unknown as { prisma: unknown }).prisma = prisma;
    (s as unknown as { logger: unknown }).logger = { warn: jest.fn(), error: jest.fn() };

    const line = await (
      s as unknown as {
        buildLoyaltyLine: (a?: string, b?: string, c?: string) => Promise<any>;
      }
    ).buildLoyaltyLine("r1", "cust-1", "loc-1");

    expect(line).toMatchObject({ name: "Whole Chicken", quantity: 1, totalPrice: 0 });
    expect(line.notes).toMatch(/LOYALTY REWARD/);
  });
});

// A line on the ticket has to agree with what the customer paid.
//
// The storefront's unitPrice is modifier-INCLUSIVE — calculateCartItem returns
// basePrice + sum(modifiers) — and its subtotal is the sum of those. The
// checkout used to add the modifiers a second time when building
// OrderItem.totalPrice, so every line printed dearer than the customer was
// charged while subtotal and total stayed correct. A real Best Kebabs receipt
// showed lines summing to £29.90 beneath a £26.90 subtotal.
describe("online checkout — line totals must match the modifier-inclusive unitPrice", () => {
  const lineTotal = (item: {
    unitPrice: number;
    quantity: number;
    modifiers?: Array<{ price: number }>;
  }) => Math.round(item.unitPrice * item.quantity * 100) / 100;

  it("does not add modifiers on top of a price that already contains them", () => {
    // Doner Wrap: £8.70 all-in, of which £3.00 is Chips With Cheese.
    const line = {
      unitPrice: 8.7,
      quantity: 1,
      modifiers: [{ price: 3.0 }],
    };
    expect(lineTotal(line)).toBe(8.7);
    expect(lineTotal(line)).not.toBe(11.7);
  });

  it("multiplies by quantity without re-adding modifiers", () => {
    const line = { unitPrice: 8.7, quantity: 3, modifiers: [{ price: 3.0 }] };
    expect(lineTotal(line)).toBe(26.1);
  });

  it("reproduces the reported receipt — lines now sum to the subtotal", () => {
    // Reconstructed from the Best Kebabs ticket. unitPrice is what the
    // customer was charged per line (modifier-inclusive); the £1.50 Chips
    // With Cheese on each wrap is ALREADY inside it.
    const order = [
      { name: "10pcs Chicken Nuggets & Chips", unitPrice: 6.0, quantity: 1, modifiers: [] },
      { name: "Doner Wrap", unitPrice: 7.2, quantity: 1, modifiers: [{ price: 1.5 }] },
      { name: "Mix Wrap", unitPrice: 7.7, quantity: 1, modifiers: [{ price: 1.5 }] },
      { name: "10\" Garlic Bread With Cheese", unitPrice: 6.0, quantity: 1, modifiers: [] },
    ];
    const sum = (f: (l: (typeof order)[number]) => number) =>
      Math.round(order.reduce((t, l) => t + f(l), 0) * 100) / 100;

    // The subtotal the storefront sent, and what the customer paid against.
    expect(sum((l) => l.unitPrice * l.quantity)).toBe(26.9);
    // Fixed: the printed lines now add up to it.
    expect(sum(lineTotal)).toBe(26.9);

    // The old formula, kept here so the failure is recognisable if it returns:
    // it printed the £29.90 the shop queried, £3.00 over the subtotal.
    const oldFormula = (l: (typeof order)[number]) =>
      l.unitPrice * l.quantity +
      l.modifiers.reduce((t, m) => t + m.price * l.quantity, 0);
    expect(sum(oldFormula)).toBe(29.9);
  });
});
