import { OrderingService } from "../ordering.service";

// Retail R3 — a shop's basket must pass checks a restaurant's never had:
// nothing in it has sold out since it was added, and the delivery minimum is
// met. Both are server-side because the basket is client-supplied and can be
// minutes stale.

const svc = (opts: { soldOut?: string[]; minOrderForDelivery?: number | null }) => {
  const prisma = {
    productVariant: {
      // soldOutItemIds: one counted variant per item; sold-out ones at 0.
      findMany: jest.fn(async ({ where }: any) =>
        (where.menuItemId.in as string[]).map((id) => ({
          menuItemId: id,
          stockLevels: [{ quantity: opts.soldOut?.includes(id) ? 0 : 5 }],
        })),
      ),
    },
    directOrderingConfig: {
      findUnique: jest.fn(async () =>
        opts.minOrderForDelivery === undefined ? null : { minOrderForDelivery: opts.minOrderForDelivery },
      ),
    },
  };
  const s = Object.create(OrderingService.prototype) as any;
  s.prisma = prisma;
  return (dto: any) => s.assertShopBasket({ id: "loc", brandId: "b" }, dto);
};

const line = (menuItemId: string, name: string, unitPrice: number, quantity = 1) => ({
  menuItemId,
  name,
  unitPrice,
  quantity,
});

describe("checkout — shop basket rules", () => {
  it("lets an in-stock basket over the minimum through", async () => {
    const check = svc({ minOrderForDelivery: 10 });
    await expect(
      check({ fulfillmentType: "DELIVERY", items: [line("a", "Milk", 1.55, 7)] }),
    ).resolves.toBeUndefined();
  });

  it("refuses items that sold out while they sat in the basket, naming them", async () => {
    const check = svc({ soldOut: ["b", "c"] });
    await expect(
      check({
        fulfillmentType: "PICKUP",
        items: [line("a", "Milk", 1.55), line("b", "Eggs", 2.1), line("c", "Bread", 1.2)],
      }),
    ).rejects.toThrow("Eggs, Bread have just sold out");
  });

  it("enforces the delivery minimum and says how much more to add", async () => {
    const check = svc({ minOrderForDelivery: 15 });
    await expect(
      check({ fulfillmentType: "DELIVERY", items: [line("a", "Milk", 1.55, 2)] }),
    ).rejects.toThrow("add 11.90 more, or choose collection");
  });

  it("has no minimum for collection", async () => {
    const check = svc({ minOrderForDelivery: 15 });
    await expect(
      check({ fulfillmentType: "PICKUP", items: [line("a", "Milk", 1.55)] }),
    ).resolves.toBeUndefined();
  });
});
