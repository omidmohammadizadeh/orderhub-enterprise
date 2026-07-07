import { OrderingService } from "../ordering.service";

// Item-based promos (BOGO / free-item / per-item %) store the MenuItem ids
// picked when the campaign was built. If the storefront later serves a
// different menu row (a republish, or a per-location assignment), those ids
// don't exist in the served menu and the client can't match them. The
// anchor helper re-maps stored ids onto the served menu by a stable key
// (externalId, then normalised name) so promos survive menu changes.

function makeService(menuItemRows: any[]) {
  const prisma = {
    menuItem: { findMany: jest.fn(async () => menuItemRows) },
  } as any;
  return new OrderingService(
    prisma,
    {} as any, // ordersService
    {} as any, // promoCodes
    {} as any, // payments
    {} as any, // menuAvailability
    {} as any, // menuAssignments
    {} as any, // pauses
    {} as any, // marketing
  );
}

// Served menu: item A (externalId E1, "Fries"), item B (externalId E2, "Coke").
const servedMenu = {
  categories: [
    {
      items: [
        { item: { id: "served-A", externalId: "E1", name: "Fries" } },
        { item: { id: "served-B", externalId: "E2", name: "Coke " } },
      ],
    },
  ],
};

const anchor = (svc: any, menu: any, ids: string[]) =>
  svc.anchorPromoItemsToServedMenu(menu, ids);

describe("OrderingService.anchorPromoItemsToServedMenu", () => {
  it("re-anchors a stale id to the served item with the same externalId", async () => {
    // Campaign referenced old-menu id "old-A", which shares externalId E1.
    const svc = makeService([{ id: "old-A", name: "Fries", externalId: "E1" }]);
    const map = await anchor(svc, servedMenu, ["old-A"]);
    expect(map.get("old-A")).toBe("served-A");
  });

  it("falls back to a normalised-name match when externalId differs", async () => {
    // Different externalId, but same name (whitespace/case-insensitive).
    const svc = makeService([{ id: "old-B", name: "coke", externalId: "ZZZ" }]);
    const map = await anchor(svc, servedMenu, ["old-B"]);
    expect(map.get("old-B")).toBe("served-B");
  });

  it("maps ids that already exist in the served menu to themselves (no lookup)", async () => {
    const findMany = jest.fn(async () => []);
    const prisma = { menuItem: { findMany } } as any;
    const svc = new OrderingService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const map = await (svc as any).anchorPromoItemsToServedMenu(servedMenu, [
      "served-A",
    ]);
    expect(map.get("served-A")).toBe("served-A");
    expect(findMany).not.toHaveBeenCalled(); // nothing stale → no DB hit
  });

  it("omits ids with no equivalent on the served menu", async () => {
    const svc = makeService([
      { id: "ghost", name: "Not On This Menu", externalId: "NOPE" },
    ]);
    const map = await anchor(svc, servedMenu, ["ghost"]);
    expect(map.has("ghost")).toBe(false);
  });

  it("returns an empty map for no referenced ids (no query)", async () => {
    const findMany = jest.fn();
    const prisma = { menuItem: { findMany } } as any;
    const svc = new OrderingService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const map = await (svc as any).anchorPromoItemsToServedMenu(servedMenu, []);
    expect(map.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
