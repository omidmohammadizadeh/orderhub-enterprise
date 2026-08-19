// Opening Inventory and Printers to the shop floor is only safe if "my
// locations" is enforced on the server.
//
// Both took `locationId` straight from the client and checked nothing but the
// tenant. While only owners could reach those screens that was survivable; the
// moment a staff member at one shop can open the tab, it means they can read
// and adjust another shop's stock, and register printers at another shop, by
// changing an id in the request.
//
// These tests pin the enforcement, not the nav — hiding a tab is not access
// control.

import { ForbiddenException } from "@nestjs/common";
import { LocationAccessService } from "../../../common/access/location-access.service";
import { InventoryController } from "../inventory.controller";

const staffAtPelton = {
  userId: "u_staff",
  tenantId: "t1",
  role: "STAFF",
} as any;

const owner = {
  userId: "u_owner",
  tenantId: "t1",
  role: "TENANT_OWNER",
} as any;

/** Pelton is theirs; Clifton is not. */
function accessService(opts: { locations?: string[]; brands?: string[] } = {}) {
  const prisma: any = {
    userLocation: {
      findMany: async () => (opts.locations ?? ["loc_pelton"]).map((locationId) => ({ locationId })),
    },
    userBrand: {
      findMany: async () => (opts.brands ?? []).map((brandId) => ({ brandId })),
    },
    brand: {
      findMany: async () => [
        { primaryLocationId: "loc_brandhome", locations: [{ id: "loc_brandsite" }] },
      ],
    },
    location: {
      findMany: async () => [{ id: "loc_pelton" }, { id: "loc_clifton" }],
    },
  };
  return new LocationAccessService(prisma);
}

describe("LocationAccessService", () => {
  it("lets a staff member reach the location they're assigned to", async () => {
    await expect(
      accessService().assertAccess(staffAtPelton, "loc_pelton"),
    ).resolves.toBeUndefined();
  });

  it("refuses a staff member a location they're not assigned to", async () => {
    await expect(
      accessService().assertAccess(staffAtPelton, "loc_clifton"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("includes the locations of a brand the user is assigned to", async () => {
    // A brand manager gets every shop their brand trades at, without needing a
    // UserLocation row per site.
    const access = accessService({ locations: [], brands: ["brand_a"] });
    await expect(access.assertAccess(staffAtPelton, "loc_brandsite")).resolves.toBeUndefined();
    await expect(access.assertAccess(staffAtPelton, "loc_brandhome")).resolves.toBeUndefined();
    await expect(access.assertAccess(staffAtPelton, "loc_clifton")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("lets tenant-wide roles through without a per-location lookup", async () => {
    // TENANT_OWNER and PLATFORM_ADMIN see the whole business; scopeFilter
    // returns null so their queries carry no IN(...) at all.
    const access = accessService({ locations: [] });
    await expect(access.assertAccess(owner, "loc_clifton")).resolves.toBeUndefined();
    expect(await access.scopeFilter(owner)).toBeNull();
  });

  it("gives a scoped role an allowlist to filter by", async () => {
    expect(await accessService().scopeFilter(staffAtPelton)).toEqual(["loc_pelton"]);
  });
});

describe("InventoryController location scoping", () => {
  function controller() {
    const calls: any[] = [];
    const inventory: any = new Proxy(
      {},
      {
        get:
          (_t, method: string) =>
          async (...args: any[]) => {
            calls.push({ method, args });
            return { ok: true };
          },
      },
    );
    return { ctl: new InventoryController(inventory, accessService()), calls };
  }

  it("refuses to list another shop's ingredients", async () => {
    const { ctl, calls } = controller();
    await expect(
      (ctl as any).listIngredients(staffAtPelton, "loc_clifton", undefined),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(calls).toHaveLength(0);
  });

  it("allows the shop the staff member works at", async () => {
    const { ctl, calls } = controller();
    await (ctl as any).listIngredients(staffAtPelton, "loc_pelton", undefined);
    expect(calls[0].method).toBe("listIngredients");
  });

  it("refuses a stock adjustment aimed at another shop", async () => {
    // The most damaging one: stock adjustments feed the 86 sync, so a write
    // here takes items off a live storefront.
    const { ctl, calls } = controller();
    await expect(
      (ctl as any).adjustStock("ing_1", { locationId: "loc_clifton", quantity: 5 }, staffAtPelton),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(calls).toHaveLength(0);
  });

  it("passes the allowlist to id-addressed routes so the row lookup misses", async () => {
    // updateIngredient names no location, so the guard can't run in the
    // controller — the allowlist has to reach the query instead.
    const { ctl, calls } = controller();
    await (ctl as any).updateIngredient("ing_1", { name: "Beef" }, staffAtPelton);
    expect(calls[0].method).toBe("updateIngredient");
    expect(calls[0].args[3]).toEqual(["loc_pelton"]);
  });

  it("passes null for a tenant-wide role rather than an allowlist", async () => {
    const { ctl, calls } = controller();
    await (ctl as any).updateIngredient("ing_1", { name: "Beef" }, owner);
    expect(calls[0].args[3]).toBeNull();
  });
});
