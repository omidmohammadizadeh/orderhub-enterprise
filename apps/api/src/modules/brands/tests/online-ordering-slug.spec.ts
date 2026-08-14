import { ConflictException } from "@nestjs/common";
import { BrandsService } from "../brands.service";

// The storefront link is a globally unique column, and the generator used to
// probe it with a `deletedAt: null` filter the database doesn't apply. Deleting
// a brand and recreating it — the commonest reason to delete one — then blew up
// on the unique index. These tests pin the rule that the probe must match what
// the database actually enforces.

const TENANT = "t1";

function makeService(brand: any, brands: any[] = []) {
  const svc: any = Object.create(BrandsService.prototype);
  svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  svc.assertAccess = jest.fn().mockResolvedValue(brand);
  svc.prisma = {
    brand: {
      // Mirrors the DB: matches on slug regardless of deletedAt, and honours
      // a NOT id filter. Tests that lie about this would pass while production
      // 500s, which is the whole bug.
      findFirst: jest.fn(async ({ where }: any) => {
        const notId = where?.NOT?.id;
        const hit = brands.find(
          (b) =>
            b.onlineOrderingSlug === where.onlineOrderingSlug &&
            b.id !== notId &&
            (where.deletedAt !== null || b.deletedAt === null),
        );
        return hit ? { id: hit.id, deletedAt: hit.deletedAt ?? null } : null;
      }),
      update: jest.fn(async ({ data }: any) => ({ ...brand, ...data })),
    },
  };
  return svc as BrandsService & any;
}

describe("BrandsService — online ordering slug", () => {
  it("skips a slug held by a DELETED brand instead of colliding", async () => {
    // The live report: brand created under the wrong location, deleted,
    // recreated under the right one. The dead row still held "pizza-planet".
    const brand = { id: "new", name: "Pizza Planet" };
    const svc = makeService(brand, [
      { id: "old", onlineOrderingSlug: "pizza-planet", deletedAt: new Date() },
    ]);

    const res = await svc.setSlug("new", TENANT, undefined);

    expect(res.onlineOrderingSlug).toBe("pizza-planet-2");
  });

  it("takes the clean slug once nothing holds it", async () => {
    const brand = { id: "new", name: "Pizza Planet" };
    const svc = makeService(brand, []);

    const res = await svc.setSlug("new", TENANT, undefined);

    expect(res.onlineOrderingSlug).toBe("pizza-planet");
    expect(res.directOrderingEnabled).toBe(true);
  });

  it("still avoids a slug held by a LIVE brand", async () => {
    const brand = { id: "new", name: "Pizza Planet" };
    const svc = makeService(brand, [
      { id: "live", onlineOrderingSlug: "pizza-planet", deletedAt: null },
      { id: "live2", onlineOrderingSlug: "pizza-planet-2", deletedAt: null },
    ]);

    const res = await svc.setSlug("new", TENANT, undefined);

    expect(res.onlineOrderingSlug).toBe("pizza-planet-3");
  });

  it("explains itself when a requested slug belongs to a deleted brand", async () => {
    // A 500 told the operator nothing. They need to know the name is spoken
    // for and why they can't see the brand holding it.
    const brand = { id: "new", name: "Pizza Planet" };
    const svc = makeService(brand, [
      { id: "old", onlineOrderingSlug: "pizza-planet", deletedAt: new Date() },
    ]);

    await expect(
      svc.setSlug("new", TENANT, "Pizza Planet"),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.setSlug("new", TENANT, "Pizza Planet")).rejects.toThrow(
      /since been deleted/,
    );
  });

  it("rejects a requested slug held by a live brand", async () => {
    const brand = { id: "new", name: "Other" };
    const svc = makeService(brand, [
      { id: "live", onlineOrderingSlug: "taken", deletedAt: null },
    ]);

    await expect(svc.setSlug("new", TENANT, "taken")).rejects.toThrow(
      /already taken/,
    );
  });

  it("retries when the slug is claimed between the probe and the write", async () => {
    // The probe and the update aren't atomic. Two operators minting a link at
    // the same moment shouldn't produce a 500 for the loser.
    const brand = { id: "new", name: "Pizza Planet" };
    const svc = makeService(brand, []);
    let first = true;
    svc.prisma.brand.update = jest.fn(async ({ data }: any) => {
      if (first) {
        first = false;
        const e: any = new Error("Unique constraint failed");
        e.code = "P2002";
        throw e;
      }
      return { ...brand, ...data };
    });

    const res = await svc.setSlug("new", TENANT, undefined);

    expect(res.onlineOrderingSlug).toBe("pizza-planet");
    expect(svc.prisma.brand.update).toHaveBeenCalledTimes(2);
  });

  it("rethrows anything that isn't a unique violation", async () => {
    const brand = { id: "new", name: "Pizza Planet" };
    const svc = makeService(brand, []);
    svc.prisma.brand.update = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error("db down"), { code: "P1001" }));

    await expect(svc.setSlug("new", TENANT, undefined)).rejects.toThrow("db down");
  });

  it("falls back to a usable base when the name slugifies to nothing", async () => {
    const brand = { id: "new", name: "!!!" };
    const svc = makeService(brand, []);

    const res = await svc.setSlug("new", TENANT, undefined);

    expect(res.onlineOrderingSlug).toBe("brand");
  });
});
