import { SubscriptionsService } from "../subscriptions.service";

// Billing scoping. A tenant owner used to see every subscription in the
// tenant — monthly fee, card status, invoices — including locations belonging
// to other operators sharing that tenant. These are the cases that broke.

const LOCS = {
  mine: "loc-mine",
  theirs: "loc-theirs",
};

function makeService(opts: {
  userLocations?: string[];
  userBrands?: string[];
  brandLocations?: Record<string, string[]>;
}) {
  const subs = [
    { id: "s1", locationId: LOCS.mine, location: { id: LOCS.mine, name: "Mine" } },
    { id: "s2", locationId: LOCS.theirs, location: { id: LOCS.theirs, name: "Theirs" } },
  ];
  const prisma: any = {
    userLocation: {
      findMany: async () =>
        (opts.userLocations ?? []).map((locationId) => ({ locationId })),
    },
    userBrand: {
      findMany: async () => (opts.userBrands ?? []).map((brandId) => ({ brandId })),
    },
    brand: {
      findMany: async ({ where }: any) =>
        (where.id.in as string[]).map((id) => ({
          primaryLocationId: null,
          locations: (opts.brandLocations?.[id] ?? []).map((l) => ({ id: l })),
        })),
    },
    merchantSubscription: {
      findMany: async ({ where }: any) => {
        if (!where.locationId) return subs;
        return subs.filter((s) => where.locationId.in.includes(s.locationId));
      },
    },
  };
  return new SubscriptionsService(prisma, { get: () => undefined } as any, {} as any);
}

describe("SubscriptionsService access scope", () => {
  it("gives PLATFORM_ADMIN the whole tenant", async () => {
    const svc = makeService({});
    const out = await svc.listForTenant("t1", "u1", "PLATFORM_ADMIN");
    expect(out.map((s: any) => s.locationId).sort()).toEqual(
      [LOCS.mine, LOCS.theirs].sort(),
    );
  });

  it("scopes TENANT_OWNER to assigned locations — the leak this fixes", async () => {
    const svc = makeService({ userLocations: [LOCS.mine] });
    const out = await svc.listForTenant("t1", "u1", "TENANT_OWNER");
    expect(out.map((s: any) => s.locationId)).toEqual([LOCS.mine]);
  });

  it("scopes OWNER to assigned locations", async () => {
    const svc = makeService({ userLocations: [LOCS.mine] });
    const out = await svc.listForTenant("t1", "u2", "OWNER");
    expect(out.map((s: any) => s.locationId)).toEqual([LOCS.mine]);
  });

  it("scopes FINANCIAL_AGENT too — billing access is not tenant-wide access", async () => {
    const svc = makeService({ userLocations: [LOCS.mine] });
    const out = await svc.listForTenant("t1", "u-fin", "FINANCIAL_AGENT");
    expect(out.map((s: any) => s.locationId)).toEqual([LOCS.mine]);
  });

  it("includes locations reached through a brand assignment", async () => {
    const svc = makeService({
      userBrands: ["b1"],
      brandLocations: { b1: [LOCS.theirs] },
    });
    const out = await svc.listForTenant("t1", "u3", "OWNER");
    expect(out.map((s: any) => s.locationId)).toEqual([LOCS.theirs]);
  });

  it("returns nothing for an owner with no assignments, never everything", async () => {
    const svc = makeService({});
    const out = await svc.listForTenant("t1", "u4", "OWNER");
    expect(out).toEqual([]);
  });

  it("fails closed when the caller has no resolved identity", async () => {
    const svc = makeService({});
    // Previously this fell through to "see everything".
    expect(await svc.listForTenant("t1", undefined, undefined)).toEqual([]);
    expect(await svc.listForTenant("t1", "u5", undefined)).toEqual([]);
    expect(await svc.listForTenant("t1", undefined, "OWNER")).toEqual([]);
  });

  it("refuses per-location reads outside the allowlist", async () => {
    const svc = makeService({ userLocations: [LOCS.mine] });
    await expect(
      svc.getForLocation("t1", LOCS.theirs, "u1", "TENANT_OWNER"),
    ).rejects.toThrow(/not found/i);
  });
});
