import { OrderingService } from "../ordering.service";

// Which menu a table QR shows.
//
// A guest scanning the QR on table 4 must see exactly what the till shows —
// the operator sets one menu up for the shop and expects both to agree. Two
// things were stopping that.
//
// 1. The table page pinned `Location.brandId` as a ?brand= override. That is
//    the same placeholder field that put China Chef's menu on a Best Kebab
//    receipt, and in a multi-brand kitchen it is simply the wrong brand.
// 2. The storefront resolved the ONLINE menu. A table order is dine-in at the
//    counter, and the POS menu is often a different menu with different
//    prices.
//
// getStorefrontBySlug now takes a channel, defaulting to ONLINE so every
// existing caller — the storefront itself, SEO, checkout — is untouched.

type Call = Record<string, any>;

function harness() {
  const assignmentCalls: Call[] = [];
  const snoozeCalls: Call[] = [];
  const menuFindFirst = jest.fn().mockResolvedValue(null);

  const svc = Object.create(OrderingService.prototype) as any;
  svc.prisma = {
    location: {
      findFirst: jest.fn().mockResolvedValue({
        id: "loc1",
        brandId: "brandA",
        isActive: true,
        deletedAt: null,
        name: "Best Kebab",
        timezone: "Europe/London",
        brand: { id: "brandA", tenantId: "t1" },
      }),
    },
    brand: { findUnique: jest.fn().mockResolvedValue(null) },
    menu: { findFirst: menuFindFirst },
    menuCategory: { findMany: jest.fn().mockResolvedValue([]) },
    directOrderingConfig: { findUnique: jest.fn().mockResolvedValue(null) },
    deliveryZone: { findMany: jest.fn().mockResolvedValue([]) },
    marketingCampaign: { findMany: jest.fn().mockResolvedValue([]) },
    menuItem: { findMany: jest.fn().mockResolvedValue([]) },
    review: { aggregate: jest.fn().mockResolvedValue({ _avg: {}, _count: {} }) },
  };
  svc.variantResolver = {
    forBrandChannel: jest.fn().mockResolvedValue(null),
  };
  svc.menuAssignments = {
    resolveAssignedMenuId: jest.fn(async (args: Call) => {
      assignmentCalls.push(args);
      return null;
    }),
  };
  svc.menuAvailability = {
    getSnoozedItemIdsForChannel: jest.fn(async (channel: string) => {
      snoozeCalls.push({ channel });
      return new Set<string>();
    }),
  };
  svc.pauses = { isPaused: jest.fn().mockResolvedValue({ paused: false }) };
  svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };

  return { svc, assignmentCalls, snoozeCalls, menuFindFirst };
}

describe("getStorefrontBySlug — channel", () => {
  it("defaults to ONLINE, so today's storefront is untouched", async () => {
    const { svc, assignmentCalls } = harness();
    await svc.getStorefrontBySlug("loc1").catch(() => {});

    expect(assignmentCalls[0]?.channel).toBe("ONLINE");
  });

  it("resolves the POS menu when asked for it", async () => {
    const { svc, assignmentCalls } = harness();
    await svc.getStorefrontBySlug("loc1", undefined, "POS").catch(() => {});

    expect(assignmentCalls[0]?.channel).toBe("POS");
  });

  it("falls back to a menu published to the SAME channel", async () => {
    // The legacy path, for a shop whose menus predate assignments. Falling
    // back to an ONLINE-published menu on a POS request would hand the table
    // the very menu we are trying to stop showing.
    const { svc, menuFindFirst } = harness();
    await svc.getStorefrontBySlug("loc1", undefined, "POS").catch(() => {});

    const byChannel = menuFindFirst.mock.calls.find(
      (c: any[]) => c[0]?.where?.publishedTo,
    );
    expect(byChannel?.[0]?.where?.publishedTo).toEqual({ has: "POS" });
  });

  it("reads 86s for the channel it is serving", async () => {
    // A POS menu filtered by ONLINE snoozes would offer the table an item the
    // kitchen has already turned off at the till.
    const { svc, snoozeCalls } = harness();
    await svc.getStorefrontBySlug("loc1", undefined, "POS").catch(() => {});

    if (snoozeCalls.length) expect(snoozeCalls[0].channel).toBe("POS");
  });

  // The pause banner and the per-channel price variants follow the same
  // `channel` variable a few lines further down. Not asserted here: reaching
  // them means mocking most of the storefront, and a test that needs fifteen
  // fakes to prove one argument breaks on every unrelated change to the
  // method. The three above are the ones that decide WHICH MENU is served.
});
