import { WalkInLoyaltyService } from "../walk-in-loyalty.service";

// The online Rewards page links the customer's account to the shop's wallet
// card, so online orders and till visits fill ONE card and ONE pass.

const CARD = {
  id: "card-1",
  tenantId: "t1",
  locationId: "loc-1",
  isActive: true,
  walkInEnabled: false,
  stampsRequired: 6,
  location: { id: "loc-1", name: "Grill Stop", logoUrl: null, currency: "GBP", brand: { logoUrl: null } },
};

function setup(over: { linked?: any; byEmail?: any } = {}) {
  const prisma: any = {
    loyaltyCard: { findUnique: jest.fn().mockResolvedValue(CARD) },
    customerAccount: { findUnique: jest.fn().mockResolvedValue({ email: "Kat@Example.com", firstName: "Khatereh" }) },
    loyaltyMember: {
      findUnique: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(where.cardId_customerAccountId ? (over.linked ?? null) : (over.byEmail ?? null)),
      ),
      update: jest.fn().mockResolvedValue({ id: "mem-1", publicToken: "tok-1" }),
      create: jest.fn().mockResolvedValue({ id: "mem-new", publicToken: "tok-new" }),
    },
    loyaltyStamp: { updateMany: jest.fn() },
    loyaltyReward: { updateMany: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const loyalty: any = { settleRewards: jest.fn() };
  const events: any = { emit: jest.fn() };
  const svc = new WalkInLoyaltyService(prisma, loyalty, {} as any, {} as any, {} as any, events, {} as any);
  return { svc, prisma, loyalty, events };
}

describe("linking an online account to the wallet card", () => {
  it("returns the already-linked card straight away", async () => {
    const { svc, prisma } = setup({ linked: { id: "mem-1", publicToken: "tok-linked" } });
    await expect(svc.linkAccount("acct-1", "loc-1")).resolves.toEqual({ token: "tok-linked" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("adopts the in-store card with the same email and joins both histories", async () => {
    const { svc, prisma, loyalty, events } = setup({ byEmail: { id: "mem-1", publicToken: "tok-1", customerAccountId: null } });
    await expect(svc.linkAccount("acct-1", "loc-1")).resolves.toEqual({ token: "tok-1" });
    expect(prisma.loyaltyMember.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cardId_email: { cardId: "card-1", email: "kat@example.com" } } }),
    );
    expect(prisma.loyaltyMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { customerAccountId: "acct-1" } }),
    );
    expect(prisma.loyaltyStamp.updateMany).toHaveBeenCalledWith({
      where: { cardId: "card-1", customerAccountId: "acct-1", memberId: null },
      data: { memberId: "mem-1" },
    });
    expect(loyalty.settleRewards).toHaveBeenCalledWith("card-1", { memberId: "mem-1" });
    expect(events.emit).toHaveBeenCalledWith("loyalty.member_changed", { memberId: "mem-1" });
  });

  it("makes a new card carrying the account when there is none", async () => {
    const { svc, prisma } = setup();
    await expect(svc.linkAccount("acct-1", "loc-1")).resolves.toEqual({ token: "tok-new" });
    expect(prisma.loyaltyMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customerAccountId: "acct-1", email: "kat@example.com", source: "ONLINE" }),
      }),
    );
  });
});
