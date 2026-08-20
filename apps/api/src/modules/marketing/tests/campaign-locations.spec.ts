import { MarketingService } from "../marketing.service";

// "Which location is this offer running for?"
//
// A campaign is scoped to a BRAND, never to a location, so the answer has to be
// resolved through the brand — and the brand model has two halves that both
// have to be read:
//
//   • VIRTUAL brand (ghost kitchen)   → Brand.primaryLocationId, a bare column
//                                       with NO relation, and `Brand.locations`
//                                       is typically EMPTY.
//   • FRANCHISE parent                → Location.brandId, surfaced as
//                                       `Brand.locations`, primaryLocationId null.
//
// Reading only one half leaves the column blank for half the tenants — and this
// platform leans on the virtual-brand shape, which is the half an `include`
// alone cannot reach.

function makeService(opts: {
  campaigns: any[];
  locations?: Array<{ id: string; name: string }>;
}) {
  const locationFindMany = jest.fn(async ({ where }: any) => {
    const ids: string[] = where.id.in;
    return (opts.locations ?? []).filter((l) => ids.includes(l.id));
  });
  const prisma = {
    marketingCampaign: { findMany: jest.fn(async () => opts.campaigns) },
    location: { findMany: locationFindMany },
    userBrand: { findMany: jest.fn(async () => []) },
    userLocation: { findMany: jest.fn(async () => []) },
    brand: { findMany: jest.fn(async () => []) },
  } as any;
  const service = new MarketingService(prisma) as any;
  return { service, prisma, locationFindMany };
}

const ADMIN = { userId: "u1", tenantId: "t1", role: "TENANT_OWNER" };

const campaign = (over: any = {}) => ({
  id: "c1",
  tenantId: "t1",
  brandId: "b1",
  name: "Amount off order",
  status: "ACTIVE",
  channels: ["ONLINE"],
  ...over,
});

describe("MarketingService.list — location resolution", () => {
  it("resolves a VIRTUAL brand's location from primaryLocationId", async () => {
    // The relation is empty here, which is the normal shape for a virtual
    // brand: Location.brandId points at the franchise parent, not at this one.
    const { service } = makeService({
      campaigns: [
        campaign({
          brand: { id: "b1", name: "Grill Stop", primaryLocationId: "l1", locations: [] },
        }),
      ],
      locations: [{ id: "l1", name: "South Street" }],
    });
    const [row] = await service.list({ tenantId: "t1", user: ADMIN });
    expect(row.locations).toEqual([{ id: "l1", name: "South Street" }]);
    expect(row.brandName).toBe("Grill Stop");
  });

  it("resolves a FRANCHISE parent's locations from the relation", async () => {
    const { service } = makeService({
      campaigns: [
        campaign({
          brand: {
            id: "b1",
            name: "Monster Burgerz",
            primaryLocationId: null,
            locations: [
              { id: "l1", name: "Clifton" },
              { id: "l2", name: "Pelton" },
            ],
          },
        }),
      ],
    });
    const [row] = await service.list({ tenantId: "t1", user: ADMIN });
    expect(row.locations.map((l: any) => l.name)).toEqual(["Clifton", "Pelton"]);
  });

  it("puts the primary location FIRST and never duplicates it", async () => {
    // The UI shows "<first> +N", so which one leads is what the operator reads.
    const { service } = makeService({
      campaigns: [
        campaign({
          brand: {
            id: "b1",
            name: "Greek Gyros",
            primaryLocationId: "l2",
            locations: [
              { id: "l1", name: "Clifton" },
              { id: "l2", name: "Pelton" },
            ],
          },
        }),
      ],
      locations: [{ id: "l2", name: "Pelton" }],
    });
    const [row] = await service.list({ tenantId: "t1", user: ADMIN });
    expect(row.locations.map((l: any) => l.name)).toEqual(["Pelton", "Clifton"]);
    expect(row.locations).toHaveLength(2);
  });

  it("returns an empty list when the brand has no location at all", async () => {
    // Rendered as "No location" rather than a blank cell — it means the offer
    // will not apply anywhere, which the operator should notice.
    const { service } = makeService({
      campaigns: [
        campaign({
          brand: { id: "b1", name: "Orphan", primaryLocationId: null, locations: [] },
        }),
      ],
    });
    const [row] = await service.list({ tenantId: "t1", user: ADMIN });
    expect(row.locations).toEqual([]);
    expect(row.brandName).toBe("Orphan");
  });

  it("drops a primaryLocationId pointing at a deleted location", async () => {
    const { service } = makeService({
      campaigns: [
        campaign({
          brand: { id: "b1", name: "Stale", primaryLocationId: "gone", locations: [] },
        }),
      ],
      locations: [], // the lookup filters deletedAt: null, so it returns nothing
    });
    const [row] = await service.list({ tenantId: "t1", user: ADMIN });
    expect(row.locations).toEqual([]);
  });

  it("looks the primary locations up ONCE for the whole page", async () => {
    // One query per row would be eight round-trips on the screenshot's table.
    const { service, locationFindMany } = makeService({
      campaigns: [
        campaign({ id: "c1", brand: { id: "b1", name: "A", primaryLocationId: "l1", locations: [] } }),
        campaign({ id: "c2", brand: { id: "b2", name: "B", primaryLocationId: "l2", locations: [] } }),
        campaign({ id: "c3", brand: { id: "b1", name: "A", primaryLocationId: "l1", locations: [] } }),
      ],
      locations: [
        { id: "l1", name: "Clifton" },
        { id: "l2", name: "Pelton" },
      ],
    });
    const rows = await service.list({ tenantId: "t1", user: ADMIN });

    expect(locationFindMany).toHaveBeenCalledTimes(1);
    // Deduped — l1 appears on two campaigns but is asked for once.
    expect(locationFindMany.mock.calls[0]![0].where.id.in.sort()).toEqual(["l1", "l2"]);
    expect(rows.map((r: any) => r.locations[0]?.name)).toEqual([
      "Clifton",
      "Pelton",
      "Clifton",
    ]);
  });

  it("skips the lookup entirely when no campaign has a primary location", async () => {
    const { service, locationFindMany } = makeService({
      campaigns: [
        campaign({
          brand: { id: "b1", name: "A", primaryLocationId: null, locations: [{ id: "l1", name: "Clifton" }] },
        }),
      ],
    });
    await service.list({ tenantId: "t1", user: ADMIN });
    expect(locationFindMany).not.toHaveBeenCalled();
  });

  it("keeps the flat campaign shape existing consumers already read", async () => {
    // The nested `brand` relation is stripped: the endpoint's response shape
    // gains two fields rather than changing.
    const { service } = makeService({
      campaigns: [
        campaign({
          brand: { id: "b1", name: "A", primaryLocationId: "l1", locations: [] },
        }),
      ],
      locations: [{ id: "l1", name: "Clifton" }],
    });
    const [row] = await service.list({ tenantId: "t1", user: ADMIN });
    expect(row.brand).toBeUndefined();
    expect(row.id).toBe("c1");
    expect(row.brandId).toBe("b1");
    expect(row.status).toBe("ACTIVE");
  });
});
