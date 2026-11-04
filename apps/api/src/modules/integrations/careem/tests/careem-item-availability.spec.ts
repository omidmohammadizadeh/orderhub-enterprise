import { CareemItemAvailabilityService } from "../careem-item-availability.service";

// Telling Careem an item is off. Without this a snoozed item stays on sale on
// the SuperApp and the customer only finds out when the kitchen rejects the
// order — which Careem count against the partner.

const location = { id: "loc-1", brandId: "brand-1" };

const build = (
  over: { location?: unknown; request?: jest.Mock; connections?: unknown[] } = {},
) => {
  const request = over.request ?? jest.fn().mockResolvedValue({});
  const prisma = {
    brandPlatformConnection: {
      findMany: jest.fn().mockResolvedValue(over.connections ?? []),
    },
    menuItem: {
      findMany: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.id
            ? where.id.in.map((id: string) => ({ id, name: "Fries", brandId: "brand-2" }))
            : [{ id: "twin-of-item" }],
        ),
      ),
    },
    location: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          over.location === undefined ? location : over.location,
        ),
    },
  };
  const client = { configured: () => true, request };
  return {
    svc: new CareemItemAvailabilityService(prisma as never, client as never),
    request,
    prisma,
  };
};

describe("CareemItemAvailabilityService", () => {
  const branch = (brandId: string, itemIds: string[]) => ({
    externalStoreId: `branch-${brandId}`,
    brandId,
    metadata: { careemCatalog: { itemIds } },
  });

  it("sends a brand's item only to the branch it was published on", async () => {
    const { svc, request, prisma } = build({
      connections: [branch("brand-2", ["item-1"]), branch("brand-3", ["other"])],
    });
    await svc.pushItemAvailability({
      tenantId: "t",
      itemId: "item-1",
      locationId: "loc-1",
      available: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "/catalogs/branch-brand-2/items",
      expect.objectContaining({ brandId: "brand-2", branchId: "branch-brand-2" }),
    );
    expect(prisma.location.findFirst).not.toHaveBeenCalled();
  });

  it("finds an item published from a same-named row of the brand", async () => {
    const { svc, request } = build({
      connections: [branch("brand-2", ["twin-of-item"])],
    });
    await svc.pushItemAvailability({
      tenantId: "t",
      itemId: "item-1",
      locationId: "loc-1",
      available: true,
    });
    expect(request.mock.calls[0]![1].body.items).toEqual([
      { id: "twin-of-item", status: "active" },
    ]);
  });

  it("sends nothing to a branch with no published menu", async () => {
    const { svc, request } = build({
      connections: [{ externalStoreId: "b", brandId: "brand-2", metadata: {} }],
    });
    await svc.pushItemAvailability({
      tenantId: "t",
      itemId: "item-1",
      locationId: "loc-1",
      available: false,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("sends inactive for a snoozed item", async () => {
    const { svc, request } = build();
    await svc.pushItemAvailability({
      tenantId: "t1",
      itemId: "item-1",
      locationId: "loc-1",
      available: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
    const [path, init] = request.mock.calls[0]!;
    expect(path).toBe("/catalogs/loc-1/items");
    expect(init.method).toBe("PATCH");
    expect(init.body.items).toEqual([{ id: "item-1", status: "inactive" }]);
  });

  it("sends active to put it back", async () => {
    const { svc, request } = build();
    await svc.pushItemAvailability({
      tenantId: "t1",
      itemId: "item-1",
      locationId: "loc-1",
      available: true,
    });
    expect(request.mock.calls[0]![1].body.items[0].status).toBe("active");
  });

  it("carries the Brand-Id and Branch-Id their endpoint needs", async () => {
    const { svc, request } = build();
    await svc.pushItemAvailability({
      tenantId: "t1",
      itemId: "item-1",
      locationId: "loc-1",
      available: false,
    });
    const init = request.mock.calls[0]![1];
    expect(init.brandId).toBe("brand-1");
    expect(init.branchId).toBe("loc-1");
  });

  it("chunks at their limit of 40 rather than failing", async () => {
    // A caller 86ing a whole category should not have to know Careem's
    // per-call ceiling.
    const { svc, request } = build();
    const items = Array.from({ length: 95 }, (_, i) => ({
      id: `i${i}`,
      active: false,
    }));
    await svc.pushMany({ tenantId: "t1", locationId: "loc-1", items });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0]![1].body.items).toHaveLength(40);
    expect(request.mock.calls[2]![1].body.items).toHaveLength(15);
  });

  it("does nothing when the snooze names no location", async () => {
    // The operator was on "all locations". There is no safe guess — pushing to
    // whichever shop came first would 86 an item at a branch nobody touched.
    const { svc, request } = build();
    await svc.pushItemAvailability({
      tenantId: "t1",
      itemId: "item-1",
      locationId: null,
      available: false,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("does nothing for a shop outside Careem's three countries", async () => {
    const { svc, request } = build({ location: null });
    await svc.pushItemAvailability({
      tenantId: "t1",
      itemId: "item-1",
      locationId: "uk-shop",
      available: false,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("only looks at Careem's countries", async () => {
    const { svc, prisma } = build();
    await svc.pushItemAvailability({
      tenantId: "t1",
      itemId: "item-1",
      locationId: "loc-1",
      available: false,
    });
    expect(prisma.location.findFirst.mock.calls[0]![0].where.country).toEqual({
      in: ["AE", "JO", "SA"],
    });
  });

  it("swallows a Careem failure rather than failing the snooze", async () => {
    // The item is off on the till either way. A marketplace being down must
    // not stop a kitchen marking something unavailable.
    const { svc } = build({
      request: jest.fn().mockRejectedValue(new Error("Careem is down")),
    });
    await expect(
      svc.pushItemAvailability({
        tenantId: "t1",
        itemId: "item-1",
        locationId: "loc-1",
        available: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps going after one chunk fails", async () => {
    const request = jest
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue({});
    const { svc } = build({ request });
    const items = Array.from({ length: 45 }, (_, i) => ({
      id: `i${i}`,
      active: false,
    }));
    await svc.pushMany({ tenantId: "t1", locationId: "loc-1", items });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
