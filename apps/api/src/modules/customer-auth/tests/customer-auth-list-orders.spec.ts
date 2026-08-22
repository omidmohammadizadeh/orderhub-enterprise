import { CustomerAuthService } from "../customer-auth.service";

// Storefront scoping for the customer "My Orders" endpoint. We host many
// independent shops; a customer browsing shop A's storefront (or custom
// domain) must never see their order history from shop B. listOrders scopes
// by storeSlug → locationId (fail-closed on unknown slugs) and optionally by
// brandId for multi-brand kitchens.

const CUSTOMER_ID = "cust-1";
const LOCATION_ID = "loc-abc";

function makeService() {
  const calls: {
    locationWhere: any[];
    orderWheres: any[];
  } = { locationWhere: [], orderWheres: [] };

  const prisma = {
    location: {
      findFirst: jest.fn(async (args: any) => {
        calls.locationWhere.push(args.where);
        // Only the known slug resolves.
        const ors = args.where.OR ?? [];
        const hit = ors.some(
          (c: any) =>
            c.onlineOrderingSlug === "pizza-uno" ||
            c.slug === "pizza-uno" ||
            c.id === "pizza-uno",
        );
        return hit ? { id: LOCATION_ID } : null;
      }),
    },
    order: {
      findMany: jest.fn(async (args: any) => {
        calls.orderWheres.push(args.where);
        return [];
      }),
    },
  } as any;

  const svc = new CustomerAuthService(
    prisma,
    {} as any, // password
    {} as any, // jwt
    {} as any, // email
    { get: () => "" } as any, // config
  );
  return { svc, prisma, calls };
}

describe("CustomerAuthService.listOrders storefront scoping", () => {
  it("scopes both queries to the slug's location", async () => {
    const { svc, calls } = makeService();
    await svc.listOrders(CUSTOMER_ID, { storeSlug: "pizza-uno" });
    expect(calls.orderWheres).toHaveLength(2);
    for (const where of calls.orderWheres) {
      expect(where.customerAccountId).toBe(CUSTOMER_ID);
      expect(where.locationId).toBe(LOCATION_ID);
    }
  });

  it("fails CLOSED (empty, no order query) when the slug resolves to nothing", async () => {
    const { svc, prisma } = makeService();
    const res = await svc.listOrders(CUSTOMER_ID, { storeSlug: "not-a-shop" });
    // The point of this test is that it fails CLOSED — no orders, and no order
    // query at all. currency rides along on the same shape (null here, since
    // there is no location to take it from) and does not change that.
    expect(res.active).toEqual([]);
    expect(res.history).toEqual([]);
    expect(res.currency).toBeNull();
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });

  it("applies brandId on top of the location scope", async () => {
    const { svc, calls } = makeService();
    await svc.listOrders(CUSTOMER_ID, {
      storeSlug: "pizza-uno",
      brandId: "brand-9",
    });
    for (const where of calls.orderWheres) {
      expect(where.locationId).toBe(LOCATION_ID);
      expect(where.brandId).toBe("brand-9");
    }
  });

  it("keeps legacy unscoped behaviour when no params are given", async () => {
    const { svc, prisma, calls } = makeService();
    await svc.listOrders(CUSTOMER_ID);
    expect(prisma.location.findFirst).not.toHaveBeenCalled();
    for (const where of calls.orderWheres) {
      expect(where.locationId).toBeUndefined();
      expect(where.brandId).toBeUndefined();
    }
  });
});
