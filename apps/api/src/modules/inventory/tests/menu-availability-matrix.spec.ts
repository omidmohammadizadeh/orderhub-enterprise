import { MenuAvailabilityService } from "../menu-availability.service";

// The 86 board scopes to the brand's most-recently-published menu (any
// channel), falling back to brand-tagged items only before the first publish.

function makeService(overrides: {
  lastPublished?: any;
  categories?: any[];
  taggedItems?: any[];
  items: any[];
}) {
  const prisma = {
    brand: { findFirst: jest.fn().mockResolvedValue({ id: "b1" }) },
    menu: { findFirst: jest.fn().mockResolvedValue(overrides.lastPublished ?? null) },
    menuCategory: {
      findMany: jest.fn().mockResolvedValue(overrides.categories ?? []),
    },
    menuItem: {
      findMany: jest
        .fn()
        // First call = brand-tagged fallback (when used); also the items fetch.
        .mockImplementation(({ where }: any) => {
          // items fetch keys off id: { in: [...] }
          if (where?.id?.in) return Promise.resolve(overrides.items);
          return Promise.resolve(overrides.taggedItems ?? []);
        }),
    },
    menuItemChannelAvailability: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
  return new MenuAvailabilityService(prisma, {} as any, {} as any);
}

const item = (id: string, name: string) => ({
  id,
  name,
  plu: null,
  imageUrl: null,
  basePrice: 5,
  hasMultipleSkus: false,
  productSkus: [],
  isAvailable: true,
});

describe("MenuAvailabilityService.getBrandMatrix", () => {
  it("lists the last-published menu's items and reports the source menu", async () => {
    const svc = makeService({
      lastPublished: { id: "menuA", name: "Summer Menu" },
      categories: [
        { items: [{ itemId: "i1" }, { itemId: "i2" }] },
        { items: [{ itemId: "i2" }] }, // dup across categories
      ],
      items: [item("i1", "Burger"), item("i2", "Fries")],
    });

    const res = await svc.getBrandMatrix("b1", "t1");
    expect(res.sourceMenu).toEqual({ id: "menuA", name: "Summer Menu" });
    expect(res.items.map((i) => i.id).sort()).toEqual(["i1", "i2"]);
  });

  it("falls back to brand-tagged items when the brand has no published menu", async () => {
    const svc = makeService({
      lastPublished: null,
      taggedItems: [{ id: "i9" }],
      items: [item("i9", "Legacy Item")],
    });
    const res = await svc.getBrandMatrix("b1", "t1");
    expect(res.sourceMenu).toBeNull();
    expect(res.items.map((i) => i.id)).toEqual(["i9"]);
  });
});
