import { PromoCodesService } from "../promo-codes.service";

const owner = { userId: "u1", role: "OWNER" };
const admin = { userId: "u0", role: "TENANT_OWNER" };

function make(codes: any[] = [], scoped: string[] | null = ["L1"]) {
  const prisma: any = {
    promoCode: {
      findMany: jest.fn().mockResolvedValue(codes),
      findFirst: jest.fn().mockImplementation(({ where }: any) => codes.find((c) => c.id === where.id) ?? null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    $queryRawUnsafe: jest.fn(),
  };
  const wallet: any = {
    accessibleLocationIds: jest.fn(async (_t: string, _u: string, role: string) =>
      ["PLATFORM_ADMIN", "TENANT_OWNER"].includes(role) ? null : scoped,
    ),
  };
  return { svc: new PromoCodesService(prisma, wallet), prisma };
}

const code = (over: any = {}) => ({
  id: "p1", code: "WEEKEND20", type: "PERCENTAGE", value: 20, minOrderValue: null, maxUses: null,
  maxUsesPerCustomer: 1, usedCount: 0, startAt: null, expiresAt: null, isActive: true, locationIds: ["L1"],
  showOnPos: false, description: null, createdAt: new Date(), ...over,
});

describe("who may manage a code", () => {
  it("a shop owner manages their own shop's codes", async () => {
    const { svc, prisma } = make([code()]);
    await svc.updateFor("t1", owner, "p1", { isActive: false });
    expect(prisma.promoCode.update).toHaveBeenCalled();
  });

  it("but not another shop's, nor a code valid at every shop", async () => {
    const { svc } = make([code({ locationIds: ["L2"] }), code({ id: "p2", locationIds: [] })]);
    await expect(svc.updateFor("t1", owner, "p1", { isActive: false })).rejects.toThrow("your own shops");
    await expect(svc.removeFor("t1", owner, "p2")).rejects.toThrow("every shop");
    await expect(
      svc.createFor("t1", owner, { code: "ALL10", type: "PERCENTAGE" as any, value: 10, locationIds: [] }),
    ).rejects.toThrow("every shop");
  });

  it("an account owner manages everything", async () => {
    const { svc, prisma } = make([code({ locationIds: [] })]);
    await svc.removeFor("t1", admin, "p1");
    expect(prisma.promoCode.delete).toHaveBeenCalled();
  });

  it("refuses more than 100% off", async () => {
    const { svc } = make([], null);
    await expect(
      svc.createFor("t1", admin, { code: "HUGE", type: "PERCENTAGE" as any, value: 150, locationIds: [] }),
    ).rejects.toThrow("over 100");
  });
});

describe("the promo codes page", () => {
  it("works out each code's status and results, and where it's used", async () => {
    const past = new Date(Date.now() - 86400_000);
    const future = new Date(Date.now() + 86400_000);
    const codes = [
      code(),
      code({ id: "p2", code: "OLD", expiresAt: past }),
      code({ id: "p3", code: "OFF", isActive: false }),
      code({ id: "p4", code: "FULL", maxUses: 5, usedCount: 5 }),
      code({ id: "p5", code: "SOON", startAt: future }),
    ];
    const { svc, prisma } = make(codes, null);
    prisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ code: "WEEKEND20", orders: 3, revenue: 75, discount: 15, last_at: new Date() }])
      .mockResolvedValueOnce([{ code: "WEEKEND20", kind: "campaign", id: "c1", name: "Weekend offer", status: "SENT" }]);
    const out = await svc.overview("t1", admin, "L1");
    expect(out.map((c) => c.status)).toEqual(["ACTIVE", "EXPIRED", "PAUSED", "USED_UP", "SCHEDULED"]);
    expect(out[0]!.results).toEqual(expect.objectContaining({ orders: 3, revenue: 75, discount: 15 }));
    expect(out[0]!.usedIn).toEqual([{ kind: "campaign", id: "c1", name: "Weekend offer", status: "SENT" }]);
    // results only count real orders, matched case-insensitively
    expect(prisma.$queryRawUnsafe.mock.calls[0][0]).toContain("upper(trim(metadata->>'promoCode'))");
    expect(prisma.$queryRawUnsafe.mock.calls[0][0]).toContain("'CANCELLED','REJECTED','FAILED'");
  });

  it("a shop owner only sees codes for their shops (plus every-shop codes, read-only)", async () => {
    const { svc, prisma } = make([code({ locationIds: [] })], ["L1"]);
    prisma.$queryRawUnsafe.mockResolvedValue([]);
    const out = await svc.overview("t1", owner, null);
    expect(prisma.promoCode.findMany.mock.calls[0][0].where.OR).toEqual([
      { locationIds: { isEmpty: true } },
      { locationIds: { hasSome: ["L1"] } },
    ]);
    expect(out[0]!.canManage).toBe(false);
  });
});
