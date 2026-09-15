import { OrderingService } from "../ordering.service";

// Which brand an ONLINE order gets tagged to is not cosmetic: it picks the
// brand's Stripe Connect account, the receipt header, and the Orders board
// column. `?brand=` on the checkout call is client-supplied — a printed QR, an
// SMS link or a typed URL — so it has to be checked against the shop, not just
// against the tenant.
//
// Tenant alone is not enough. A group with ten shops under one tenant would
// happily take money for shop A's brand on shop B's till.

const svc = (brandRow: Record<string, unknown> | null) => {
  const prisma = {
    brand: { findUnique: jest.fn().mockResolvedValue(brandRow) },
  };
  const s = Object.create(OrderingService.prototype) as OrderingService;
  (s as unknown as { prisma: unknown }).prisma = prisma;
  (s as unknown as { logger: unknown }).logger = {
    warn: jest.fn(),
    log: jest.fn(),
  };
  return (location: Record<string, unknown>, override?: string) =>
    (
      s as unknown as {
        resolvePinnedBrand: (
          location: unknown,
          override?: string,
        ) => Promise<{ brandId: string | null; hours: unknown }>;
      }
    ).resolvePinnedBrand(location, override);
};

const SHOP = {
  id: "loc_bestkebab",
  brandId: "brand_bestkebab",
  brand: { tenantId: "tenant_1" },
};

describe("checkout — the pinned brand must trade at this shop", () => {
  it("pins the shop's own brand", async () => {
    const resolve = svc({
      id: "brand_bestkebab",
      tenantId: "tenant_1",
      isSuspended: false,
      openingHours: { mon: "open" },
      primaryLocationId: null,
      locations: [],
    });
    await expect(resolve(SHOP, "brand_bestkebab")).resolves.toEqual({
      brandId: "brand_bestkebab",
      hours: { mon: "open" },
    });
  });

  it("pins a virtual brand that lists this shop", async () => {
    const resolve = svc({
      id: "brand_wings",
      tenantId: "tenant_1",
      isSuspended: false,
      openingHours: {},
      primaryLocationId: null,
      locations: [{ id: "loc_bestkebab" }],
    });
    await expect(resolve(SHOP, "brand_wings")).resolves.toEqual({
      brandId: "brand_wings",
      hours: {},
    });
  });

  it("REFUSES a sibling shop's brand inside the same tenant", async () => {
    const resolve = svc({
      id: "brand_othershop",
      tenantId: "tenant_1",
      isSuspended: false,
      openingHours: { mon: "closed" },
      primaryLocationId: "loc_othershop",
      locations: [{ id: "loc_othershop" }],
    });
    await expect(resolve(SHOP, "brand_othershop")).resolves.toEqual({
      brandId: null,
      hours: null,
    });
  });

  it("REFUSES a tenant-wide brand linked to no shop at all", async () => {
    // The "Order Hub" placeholder that put China Chef's menu on a Best Kebab
    // receipt. It must not reach the money path either.
    const resolve = svc({
      id: "brand_placeholder",
      tenantId: "tenant_1",
      isSuspended: false,
      openingHours: {},
      primaryLocationId: null,
      locations: [],
    });
    await expect(resolve(SHOP, "brand_placeholder")).resolves.toEqual({
      brandId: null,
      hours: null,
    });
  });

  it("still refuses a suspended brand", async () => {
    const resolve = svc({
      id: "brand_bestkebab",
      tenantId: "tenant_1",
      isSuspended: true,
      openingHours: {},
      primaryLocationId: null,
      locations: [],
    });
    await expect(resolve(SHOP, "brand_bestkebab")).resolves.toEqual({
      brandId: null,
      hours: null,
    });
  });

  it("pins nothing when no brand was asked for", async () => {
    const resolve = svc(null);
    await expect(resolve(SHOP, undefined)).resolves.toEqual({
      brandId: null,
      hours: null,
    });
  });
});
