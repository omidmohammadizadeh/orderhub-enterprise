import { ReferralService, normalisePhone } from "../referral.service";

// The only hard part of a referral scheme is what counts as "new". Everything
// else is bookkeeping; this is where the money goes.

describe("normalisePhone", () => {
  it("sees one person behind three ways of writing a number", () => {
    // Numbers are stored however they were typed. A SQL equality on the raw
    // string would treat these as three different people.
    expect(normalisePhone("07700 900123")).toBe("447700900123");
    expect(normalisePhone("+44 7700 900123")).toBe("447700900123");
    expect(normalisePhone("447700900123")).toBe("447700900123");
  });

  it("has nothing to say about a missing number", () => {
    expect(normalisePhone(null)).toBeNull();
    expect(normalisePhone("")).toBeNull();
    expect(normalisePhone("   ")).toBeNull();
  });
});

const PROGRAM = {
  id: "prog-1",
  tenantId: "t1",
  locationId: "loc-1",
  isActive: true,
  referrerAmount: 5,
  friendAmount: 5,
  minimumSpend: null,
  maxPerCustomer: 10,
  rewardExpiryDays: null,
};

const svc = (over: Record<string, any> = {}) => {
  const prisma: any = {
    referralProgram: { findUnique: jest.fn().mockResolvedValue(PROGRAM), upsert: jest.fn() },
    referralCode: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn(),
      create: jest.fn(async ({ data }: any) => ({ id: "code-1", ...data })),
    },
    referral: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    customerAccount: { findUnique: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
    order: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    loyaltyReward: { create: jest.fn().mockResolvedValue({}) },
    location: { findFirst: jest.fn().mockResolvedValue({ id: "loc-1" }) },
    $transaction: jest.fn().mockResolvedValue([]),
    ...over,
  };
  return { s: new ReferralService(prisma), prisma };
};

describe("claiming someone's code", () => {
  const CODE = { id: "code-1", programId: "prog-1", customerAccountId: "referrer-1" };

  const setup = (over: Record<string, any> = {}) => {
    const { s, prisma } = svc();
    prisma.referralCode.findFirst.mockResolvedValue(CODE);
    prisma.customerAccount.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === "referrer-1"
        ? { id: "referrer-1", phone: "07111 111111" }
        : { id: "friend-1", phone: "07700 900123" },
    );
    Object.assign(prisma, over);
    return { s, prisma };
  };

  it("records a genuine new friend", async () => {
    const { s, prisma } = setup();
    await expect(
      s.claimCode({ customerAccountId: "friend-1", locationId: "loc-1", code: "ABC123" }),
    ).resolves.toMatchObject({ ok: true });
    expect(prisma.referral.create).toHaveBeenCalled();
  });

  it("refuses your own code", async () => {
    const { s } = setup();
    await expect(
      s.claimCode({ customerAccountId: "referrer-1", locationId: "loc-1", code: "ABC123" }),
    ).rejects.toThrow(/your own code/i);
  });

  it("refuses the same phone on both sides", async () => {
    // One person, two email addresses — the whole reason phone is checked.
    const { s, prisma } = setup();
    prisma.customerAccount.findUnique.mockImplementation(async () => ({
      id: "x",
      phone: "+44 7700 900123",
    }));
    await expect(
      s.claimCode({ customerAccountId: "friend-1", locationId: "loc-1", code: "ABC123" }),
    ).rejects.toThrow(/your own account/i);
  });

  it("refuses a phone already on another account", async () => {
    const { s, prisma } = setup();
    prisma.customerAccount.findFirst.mockResolvedValue({
      id: "someone-else",
      phone: "07700900123",
    });
    await expect(
      s.claimCode({ customerAccountId: "friend-1", locationId: "loc-1", code: "ABC123" }),
    ).rejects.toThrow(/already on an account/i);
  });

  it("refuses someone who has ordered here as a guest", async () => {
    // Two years of guest orders is not a new customer, whatever the email says.
    const { s, prisma } = setup();
    prisma.order.findMany.mockResolvedValue([
      { id: "o1", customerAccountId: null, customer: { phone: "+447700900123" } },
    ]);
    await expect(
      s.claimCode({ customerAccountId: "friend-1", locationId: "loc-1", code: "ABC123" }),
    ).rejects.toThrow(/first time/i);
  });

  it("refuses when the referrer has hit their cap", async () => {
    const { s, prisma } = setup();
    prisma.referral.count.mockResolvedValue(10);
    await expect(
      s.claimCode({ customerAccountId: "friend-1", locationId: "loc-1", code: "ABC123" }),
    ).rejects.toThrow(/referral limit/i);
  });

  it("refuses a second referral for the same person", async () => {
    // friendAccountId is unique — whoever's code reached them first wins.
    const { s, prisma } = setup();
    prisma.referral.create.mockRejectedValue({ code: "P2002" });
    await expect(
      s.claimCode({ customerAccountId: "friend-1", locationId: "loc-1", code: "ABC123" }),
    ).rejects.toThrow(/already been referred/i);
  });

  it("refuses a code at a shop running no programme", async () => {
    const { s, prisma } = setup();
    prisma.referralProgram.findUnique.mockResolvedValue({ ...PROGRAM, isActive: false });
    await expect(
      s.claimCode({ customerAccountId: "friend-1", locationId: "loc-1", code: "ABC123" }),
    ).rejects.toThrow(/isn't running referrals/i);
  });
});

describe("paying out", () => {
  const order = (over: Record<string, any> = {}) => ({
    id: "order-1",
    tenantId: "t1",
    locationId: "loc-1",
    customerAccountId: "friend-1",
    subtotal: 20,
    total: 24,
    status: "COMPLETED",
    createdAt: new Date(),
    ...over,
  });

  const pending = {
    id: "ref-1",
    programId: "prog-1",
    referrerAccountId: "referrer-1",
    friendAccountId: "friend-1",
    friendPhone: "447700900123",
    status: "PENDING",
    program: PROGRAM,
  };

  const setup = () => {
    const { s, prisma } = svc();
    prisma.order.findUnique.mockResolvedValue(order());
    prisma.referral.findFirst.mockResolvedValue(pending);
    prisma.customerAccount.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === "referrer-1"
        ? { id: "referrer-1", phone: "07111 111111" }
        : { id: "friend-1", phone: "07700 900123" },
    );
    return { s, prisma };
  };

  it("pays both sides on the friend's first completed order", async () => {
    const { s, prisma } = setup();
    expect(await s.qualifyForOrder("order-1")).toBe(true);
    // Both rewards and the status move in ONE transaction — paying one side
    // only leaves somebody owed money nobody can see.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(3);
  });

  it("pays nothing until the order is finished", async () => {
    const { s, prisma } = setup();
    prisma.order.findUnique.mockResolvedValue(order({ status: "PENDING" }));
    expect(await s.qualifyForOrder("order-1")).toBe(false);
  });

  it("pays nothing below the minimum spend", async () => {
    // A bag of chips must not trigger two payouts worth more than the order.
    const { s, prisma } = setup();
    prisma.order.findUnique.mockResolvedValue(order({ subtotal: 4 }));
    prisma.referral.findFirst.mockResolvedValue({
      ...pending,
      program: { ...PROGRAM, minimumSpend: 15 },
    });
    expect(await s.qualifyForOrder("order-1")).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("leaves a below-minimum referral PENDING, not rejected", async () => {
    // They may well order properly next time.
    const { s, prisma } = setup();
    prisma.order.findUnique.mockResolvedValue(order({ subtotal: 4 }));
    prisma.referral.findFirst.mockResolvedValue({
      ...pending,
      program: { ...PROGRAM, minimumSpend: 15 },
    });
    await s.qualifyForOrder("order-1");
    expect(prisma.referral.update).not.toHaveBeenCalled();
  });

  it("re-checks eligibility at payout, not just at signup", async () => {
    // An account's phone can be edited between claiming a code and ordering,
    // and that gap is exactly where someone would try.
    const { s, prisma } = setup();
    prisma.customerAccount.findFirst.mockResolvedValue({
      id: "someone-else",
      phone: "07700900123",
    });
    expect(await s.qualifyForOrder("order-1")).toBe(false);
    expect(prisma.referral.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REJECTED" }),
      }),
    );
  });

  it("does not count the qualifying order itself as a prior order", async () => {
    // It is the friend's FIRST order. Counting it would reject every referral.
    const { s, prisma } = setup();
    await s.qualifyForOrder("order-1");
    expect(prisma.order.findMany.mock.calls[0][0].where.id).toEqual({ not: "order-1" });
  });

  it("pays only the side with an amount set", async () => {
    const { s, prisma } = setup();
    prisma.referral.findFirst.mockResolvedValue({
      ...pending,
      program: { ...PROGRAM, referrerAmount: 5, friendAmount: 0 },
    });
    await s.qualifyForOrder("order-1");
    // Status + one reward, not two.
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2);
  });

  it("ignores an order from someone with no pending referral", async () => {
    const { s, prisma } = setup();
    prisma.referral.findFirst.mockResolvedValue(null);
    expect(await s.qualifyForOrder("order-1")).toBe(false);
  });
});

describe("configuring the programme", () => {
  it("refuses to go live paying nobody anything", async () => {
    const { s } = svc();
    await expect(
      s.upsertProgram("t1", "loc-1", { isActive: true, referrerAmount: 0, friendAmount: 0 }),
    ).rejects.toThrow(/at least one side/i);
  });

  it("will not accept an uncapped referrer", async () => {
    // One person with a group chat is otherwise an unbounded liability.
    const { s, prisma } = svc();
    await s.upsertProgram("t1", "loc-1", { maxPerCustomer: 0 });
    expect(prisma.referralProgram.upsert.mock.calls[0][0].create.maxPerCustomer).toBe(1);
  });
});
