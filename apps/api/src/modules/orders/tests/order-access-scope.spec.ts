import { OrdersService } from "../orders.service";

// Orders must be scoped to the user's assigned locations AND brands
// (Phase AR team roles). These tests exercise the access-where builder
// directly with a mocked prisma — the client-supplied locationId can only
// NARROW within the allowlist, never widen past it, and "all locations"
// (no locationId) constrains to the user's assignments.

function makeService(data: {
  userLocations?: string[];
  userBrands?: string[];
  brandLocations?: Record<string, string[]>; // brandId → locationIds
}) {
  const prisma = {
    userLocation: {
      findMany: jest.fn(async () =>
        (data.userLocations ?? []).map((locationId) => ({ locationId })),
      ),
    },
    userBrand: {
      findMany: jest.fn(async () =>
        (data.userBrands ?? []).map((brandId) => ({ brandId })),
      ),
    },
    brand: {
      findMany: jest.fn(async () =>
        (data.userBrands ?? []).map((id) => ({
          primaryLocationId: (data.brandLocations?.[id] ?? [])[0] ?? null,
          locations: (data.brandLocations?.[id] ?? []).map((lid) => ({
            id: lid,
          })),
        })),
      ),
    },
  } as any;
  // 10 injected deps — only prisma is exercised here.
  return new OrdersService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
}

const user = (role: string, extra: Partial<any> = {}) => ({
  userId: "u1",
  tenantId: "t1",
  role,
  permissions: [],
  ...extra,
});

const build = (svc: any, u: any, loc?: string) =>
  svc.resolveOrderAccessWhere(u, loc);

describe("OrdersService order access scoping", () => {
  it("admin roles see the whole tenant (no location/brand restriction)", async () => {
    const svc = makeService({});
    const where = await build(svc, user("TENANT_OWNER"));
    expect(where).toEqual({ tenantId: "t1" });
  });

  it("admin honours an explicit location filter", async () => {
    const svc = makeService({});
    const where = await build(svc, user("PLATFORM_ADMIN"), "locZ");
    expect(where).toEqual({ tenantId: "t1", locationId: "locZ" });
  });

  it("non-admin with no assignments → null (sees nothing, no tenant leak)", async () => {
    const svc = makeService({ userLocations: [], userBrands: [] });
    expect(await build(svc, user("MANAGER"))).toBeNull();
  });

  it("'all locations' constrains a manager to their assigned locations", async () => {
    const svc = makeService({ userLocations: ["l1", "l2"] });
    const where = await build(svc, user("MANAGER"));
    expect(where).toEqual({ tenantId: "t1", locationId: { in: ["l1", "l2"] } });
  });

  it("a location the user is NOT assigned to is rejected (null)", async () => {
    const svc = makeService({ userLocations: ["l1"] });
    expect(await build(svc, user("MANAGER"), "l2")).toBeNull();
  });

  it("brand-scoped user only sees their brand's orders at the location", async () => {
    // Assigned to brand A (which lives at l1); location comes via the brand.
    const svc = makeService({
      userBrands: ["brandA"],
      brandLocations: { brandA: ["l1"] },
    });
    const where = await build(svc, user("MANAGER"));
    expect(where).toEqual({
      tenantId: "t1",
      locationId: { in: ["l1"] },
      brandId: { in: ["brandA"] },
    });
  });

  it("brand filter still applies when a single location is selected", async () => {
    const svc = makeService({
      userLocations: ["l1"],
      userBrands: ["brandA"],
      brandLocations: { brandA: ["l1"] },
    });
    const where = await build(svc, user("MANAGER"), "l1");
    expect(where).toEqual({
      tenantId: "t1",
      locationId: "l1",
      brandId: { in: ["brandA"] },
    });
  });

  it("no UserBrand rows → no brand restriction (all brands at the location)", async () => {
    const svc = makeService({ userLocations: ["l1"] });
    const where = await build(svc, user("MANAGER"), "l1");
    expect(where).toEqual({ tenantId: "t1", locationId: "l1" });
    expect((where as any).brandId).toBeUndefined();
  });
});
