import { PromoCodesService } from "../promo-codes.service";
import { pickForLocation, scopesOverlap } from "../promo-scope";

// "20OFF" at Clifton and "20OFF" at Kingston are two codes. The same text at
// the SAME shop is still refused — checkout couldn't tell them apart.

function make(existing: any[]) {
  const prisma: any = {
    promoCode: {
      findMany: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(existing.filter((c) => c.code === where.code && (!where.id?.not || c.id !== where.id.not))),
      ),
      findFirst: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(existing.find((c) => c.id === where.id) ?? null)),
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: "new", ...data })),
      update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve(data)),
    },
    location: {
      findMany: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(where.id.in.map((id: string) => ({ name: id === "clifton" ? "Clifton" : id }))),
      ),
    },
    $executeRawUnsafe: jest.fn(),
  };
  prisma.$transaction = (fn: any) => fn(prisma);
  return { svc: new PromoCodesService(prisma), prisma };
}

const promo = (over: any) => ({
  id: "p1", tenantId: "t1", code: "20OFF", type: "FIXED_AMOUNT", value: 3, minOrderValue: null, maxUses: null,
  maxUsesPerCustomer: null, usedCount: 0, startAt: null, expiresAt: null, isActive: true, locationIds: ["clifton"],
  ...over,
});
const dto = (locationIds: string[]) => ({ code: "20off", type: "FIXED_AMOUNT" as any, value: 3, locationIds });

describe("promo code text is unique per shop", () => {
  it("lets another shop create a code with the same text", async () => {
    const { svc, prisma } = make([promo({})]);
    await expect(svc.create("t1", dto(["kingston"]))).resolves.toMatchObject({ code: "20OFF" });
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("pg_advisory_xact_lock"), "promo:t1:20OFF");
  });

  it("refuses the same text at the same shop, naming it", async () => {
    const { svc } = make([promo({})]);
    await expect(svc.create("t1", dto(["clifton", "kingston"]))).rejects.toThrow('"20OFF" already exists at Clifton');
  });

  it("an every-shop code clashes with any shop's code, both ways", async () => {
    await expect(make([promo({ locationIds: [] })]).svc.create("t1", dto(["kingston"]))).rejects.toThrow("for every shop");
    await expect(make([promo({})]).svc.create("t1", dto([]))).rejects.toThrow("already exists");
  });

  it("checks a widened shop list on update, but not against itself", async () => {
    const { svc } = make([promo({}), promo({ id: "p2", locationIds: ["kingston"] })]);
    await expect(svc.update("t1", "p2", { locationIds: ["kingston"] })).resolves.toBeTruthy();
    await expect(svc.update("t1", "p2", { locationIds: ["kingston", "clifton"] })).rejects.toThrow("already exists");
  });

  it("checkout applies the code made for the shop being ordered from", async () => {
    const { svc } = make([promo({ value: 3 }), promo({ id: "p2", value: 5, locationIds: ["kingston"] })]);
    const r = await svc.validate("t1", { code: "20OFF", locationId: "kingston", subtotal: 30 });
    expect(r).toMatchObject({ valid: true, promoId: "p2", discountAmount: 5 });
    const elsewhere = await svc.validate("t1", { code: "20OFF", locationId: "soho", subtotal: 30 });
    expect(elsewhere).toMatchObject({ valid: false, reason: "Promo code not valid at this location" });
  });
});

describe("scope helpers", () => {
  it("overlap", () => {
    expect(scopesOverlap(["a"], ["b"])).toBe(false);
    expect(scopesOverlap(["a", "b"], ["b"])).toBe(true);
    expect(scopesOverlap([], ["b"])).toBe(true);
  });
  it("pick", () => {
    const rows = [{ id: "x", locationIds: ["a"] }, { id: "y", locationIds: ["b"] }];
    expect(pickForLocation(rows, "b")?.id).toBe("y");
    expect(pickForLocation(rows, "c")).toBeNull();
    expect(pickForLocation([{ id: "z", locationIds: [] }], "c")?.id).toBe("z");
  });
});
