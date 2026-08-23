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
