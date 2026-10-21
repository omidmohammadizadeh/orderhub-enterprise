import { OrderingService } from "../ordering.service";
import { normaliseBrandColour } from "../../brands/brands.service";

// The storefront wears its brand's colour. It is per brand, not per tenant —
// one kitchen trades as several virtual brands — so `?brand=` has to swap the
// colour along with the name and logo, and a pinned brand with no colour of
// its own must NOT borrow the kitchen brand's.

function harness(override: Record<string, any> | null) {
  const svc = Object.create(OrderingService.prototype) as any;
  svc.prisma = {
    location: {
      findFirst: jest.fn().mockResolvedValue({
        id: "loc1",
        brandId: "kitchen",
        isActive: true,
        deletedAt: null,
        name: "Kitchen",
        timezone: "Europe/London",
        brand: { id: "kitchen", name: "Kitchen", tenantId: "t1", primaryColor: "#2563eb" },
      }),
    },
    brand: { findUnique: jest.fn().mockResolvedValue(override) },
    menu: { findFirst: jest.fn().mockResolvedValue(null) },
    menuCategory: { findMany: jest.fn().mockResolvedValue([]) },
    directOrderingConfig: { findUnique: jest.fn().mockResolvedValue(null) },
    deliveryZone: { findMany: jest.fn().mockResolvedValue([]) },
    marketingCampaign: { findMany: jest.fn().mockResolvedValue([]) },
    menuItem: { findMany: jest.fn().mockResolvedValue([]) },
    review: { aggregate: jest.fn().mockResolvedValue({ _avg: {}, _count: {} }) },
  };
  svc.variantResolver = { forBrandChannel: jest.fn().mockResolvedValue(null) };
  svc.menuAssignments = { resolveAssignedMenuId: jest.fn().mockResolvedValue(null) };
  svc.menuAvailability = {
    getSnoozedItemIdsForChannel: jest.fn().mockResolvedValue(new Set<string>()),
  };
  svc.pauses = { isPaused: jest.fn().mockResolvedValue({ paused: false }) };
  // No promotions running: every resolver answers "none".
  svc.marketing = {
    resolveActiveForBrandChannel: jest.fn().mockResolvedValue([]),
    resolveItemPromos: jest.fn().mockResolvedValue([]),
    resolveBogo: jest.fn().mockResolvedValue(null),
    resolveFreeDelivery: jest.fn().mockResolvedValue(null),
    resolveMultiBuys: jest.fn().mockResolvedValue([]),
    resolveFreeItem: jest.fn().mockResolvedValue(null),
  };
  svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  return svc;
}

const pinned = (primaryColor: string | null) => ({
  id: "burgers",
  name: "Monster Burgerz",
  primaryLocationId: "loc1",
  locations: [],
  primaryColor,
});

describe("storefront brand colour", () => {
  it("carries the location's brand colour", async () => {
    const store = await harness(null).getStorefrontBySlug("loc1");
    expect(store.brand.primaryColor).toBe("#2563eb");
  });

  it("swaps to the pinned brand's colour on ?brand=", async () => {
    const store = await harness(pinned("#e11d48")).getStorefrontBySlug("loc1", "burgers");
    expect(store.brand.id).toBe("burgers");
    expect(store.brand.primaryColor).toBe("#e11d48");
  });

  it("never borrows the kitchen brand's colour for a pinned brand without one", async () => {
    const store = await harness(pinned(null)).getStorefrontBySlug("loc1", "burgers");
    expect(store.brand.primaryColor).toBeNull();
  });

  it("asks the database for the colour on both brand reads", async () => {
    const svc = harness(pinned("#e11d48"));
    await svc.getStorefrontBySlug("loc1", "burgers");
    const include = svc.prisma.location.findFirst.mock.calls[0][0].include;
    expect(include.brand.select.primaryColor).toBe(true);
    const select = svc.prisma.brand.findUnique.mock.calls[0][0].select;
    expect(select.primaryColor).toBe(true);
  });
});

describe("normaliseBrandColour", () => {
  it("stores lowercase #rrggbb", () => {
    expect(normaliseBrandColour("#E11D48")).toBe("#e11d48");
    expect(normaliseBrandColour("e11d48")).toBe("#e11d48");
    expect(normaliseBrandColour(" #f80 ")).toBe("#ff8800");
  });

  it("clears on empty", () => {
    expect(normaliseBrandColour("")).toBeNull();
    expect(normaliseBrandColour(null)).toBeNull();
  });

  it("refuses anything that is not a hex colour", () => {
    expect(() => normaliseBrandColour("red")).toThrow();
    expect(() => normaliseBrandColour("#12345")).toThrow();
    expect(() => normaliseBrandColour("url(x)")).toThrow();
  });
});
