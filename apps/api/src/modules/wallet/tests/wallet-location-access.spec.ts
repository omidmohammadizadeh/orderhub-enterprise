import { ForbiddenException } from "@nestjs/common";
import { WalletService } from "../wallet.service";

// Guards that one location's finance user can never view, fund, or spend
// another location's SMS credits (the isolation the operator asked to verify).
function makeService(
  userLocations: string[],
  userBrands: string[] = [],
  brandRows: any[] = [],
) {
  const prisma: any = {
    userLocation: {
      findMany: jest
        .fn()
        .mockResolvedValue(userLocations.map((locationId) => ({ locationId }))),
    },
    userBrand: {
      findMany: jest
        .fn()
        .mockResolvedValue(userBrands.map((brandId) => ({ brandId }))),
    },
    brand: { findMany: jest.fn().mockResolvedValue(brandRows) },
  };
  const config: any = { get: () => undefined };
  return new WalletService(prisma, config);
}

describe("WalletService.assertLocationAccess", () => {
  it("lets tenant-wide roles touch any location (incl. the tenant-wide wallet)", async () => {
    const svc = makeService([]);
    await expect(
      svc.assertLocationAccess("t1", "L2", "u1", "TENANT_OWNER"),
    ).resolves.toBeUndefined();
    await expect(
      svc.assertLocationAccess("t1", null, "u1", "PLATFORM_ADMIN"),
    ).resolves.toBeUndefined();
  });

  it("lets a scoped user access ONLY their own location", async () => {
    const svc = makeService(["L1"]);
    await expect(
      svc.assertLocationAccess("t1", "L1", "u1", "OWNER"),
    ).resolves.toBeUndefined();
  });

  it("blocks a scoped user from another location's wallet", async () => {
    const svc = makeService(["L1"]);
    await expect(
      svc.assertLocationAccess("t1", "L2", "u1", "OWNER"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("blocks a scoped user from the tenant-wide (null) wallet", async () => {
    const svc = makeService(["L1"]);
    await expect(
      svc.assertLocationAccess("t1", null, "u1", "FINANCIAL_AGENT"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("unlocks a brand's locations for a brand-assigned user, but nothing else", async () => {
    const svc = makeService([], ["b1"], [
      { primaryLocationId: "L3", locations: [{ id: "L4" }] },
    ]);
    await expect(
      svc.assertLocationAccess("t1", "L4", "u1", "OWNER"),
    ).resolves.toBeUndefined();
    await expect(
      svc.assertLocationAccess("t1", "L9", "u1", "OWNER"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
