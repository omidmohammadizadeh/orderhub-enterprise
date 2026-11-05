import { clawbackPence, dueWeekStart, fullSharePence, settle, sharePence } from "../efl-settlement-rules";
import { EflSettlementService } from "../efl-settlement.service";
import { londonDateKey } from "../efl-ads-rules";

// £23.50 paid, £20 food at 8% (£1.60) plus £3 ads taken back = £4.60 ours.
const order = { total: 23.5, subtotal: 20, discount: 0, eflCommissionPercent: 8, eflAdRecovered: 3 };

describe("Thursday payout arithmetic", () => {
  it("gives the shop what the customer paid less what we keep", () => {
    expect(fullSharePence(order)).toBe(1890);
    expect(sharePence({ ...order, paymentStatus: "PAID" })).toBe(1890);
  });

  it("shares a refund out as each side earned it", () => {
    expect(sharePence({ ...order, paymentStatus: "REFUNDED" })).toBe(0);
    // Half the money back: half the shop's share goes too.
    expect(sharePence({ ...order, paymentStatus: "PARTIALLY_REFUNDED", refundedPence: 1175 })).toBe(945);
  });

  it("takes a later refund back once, whatever happened before", () => {
    expect(clawbackPence({ toShopPence: 1890, clawedBackPence: 0 }, 945)).toBe(945);
    expect(clawbackPence({ toShopPence: 1890, clawedBackPence: 945 }, 0)).toBe(945);
    expect(clawbackPence({ toShopPence: 1890, clawedBackPence: 1890 }, 0)).toBe(0);
  });

  it("pays a positive week and carries a negative one on", () => {
    expect(settle({ cardPence: 5000, cashCommissionPence: 800, refundsPence: 200, carriedInPence: 0 })).toEqual({
      amountPence: 4000,
      carriedOutPence: 0,
    });
    expect(settle({ cardPence: 300, cashCommissionPence: 900, refundsPence: 0, carriedInPence: 100 })).toEqual({
      amountPence: 0,
      carriedOutPence: 700,
    });
  });

  it("pays last week from Thursday, and the week before until then", () => {
    // Wed 4 Nov 2026: last week (26 Oct) isn't due until tomorrow.
    expect(londonDateKey(dueWeekStart(new Date("2026-11-04T12:00:00Z")))).toBe("2026-10-19");
    expect(londonDateKey(dueWeekStart(new Date("2026-11-05T10:00:00Z")))).toBe("2026-10-26");
    expect(londonDateKey(dueWeekStart(new Date("2026-11-08T23:00:00Z")))).toBe("2026-10-26");
  });
});

function makePrisma(opts: {
  cardOrders?: any[];
  cashOrders?: any[];
  earlierLines?: any[];
  refundedNow?: any[];
  previous?: any;
}) {
  const created: any[] = [];
  const lineUpdates: any[] = [];
  const prisma: any = {
    eflListing: { findMany: jest.fn().mockResolvedValue([{ id: "L1", locationId: "loc" }]) },
    order: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where.paymentMethod === "CASH") return opts.cashOrders ?? [];
        if (where.id) return opts.refundedNow ?? [];
        return opts.cardOrders ?? [];
      }),
    },
    eflPayoutLine: {
      findMany: jest.fn(async ({ where }: any) => (where.payout ? opts.earlierLines ?? [] : [])),
      update: jest.fn((args: any) => lineUpdates.push(args)),
    },
    eflPayout: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(opts.previous ?? null),
      create: jest.fn((args: any) => created.push(args.data)),
    },
    $transaction: jest.fn(async (ops: any[]) => ops),
  };
  return { prisma, created, lineUpdates };
}

const svcWith = (prisma: any, stripe: any = {}) =>
  new EflSettlementService(prisma, { eflStripeClient: () => stripe } as any, { get: () => undefined } as any);

const week = new Date("2026-10-25T23:00:00Z"); // Mon 26 Oct, UK

describe("EflSettlementService.prepareWeek", () => {
  it("nets card orders against cash-order commission and what was owed", async () => {
    const { prisma, created } = makePrisma({
      cardOrders: [{ id: "o1", ...order, paymentStatus: "PAID", payments: [{ metadata: { flow: "settle" } }] }],
      // A £10 cash order at 8%: 80p ours, which the shop kept in cash.
      cashOrders: [{ subtotal: 10, discount: 0, eflCommissionPercent: 8, eflAdRecovered: 0 }],
      previous: { carriedOutPence: 100 },
    });
    await expect(svcWith(prisma).prepareWeek(week)).resolves.toBe(1);
    expect(created[0]).toMatchObject({
      listingId: "L1",
      status: "PENDING",
      cardPence: 1890,
      cashCommissionPence: 80,
      carriedInPence: 100,
      amountPence: 1710,
      carriedOutPence: 0,
      lines: { create: [{ orderId: "o1", toShopPence: 1890 }] },
    });
  });

  it("takes back a refund on an order paid out in an earlier week", async () => {
    const { prisma, created, lineUpdates } = makePrisma({
      earlierLines: [{ id: "line1", orderId: "old", toShopPence: 1890, clawedBackPence: 0 }],
      refundedNow: [{ id: "old", ...order, paymentStatus: "REFUNDED", payments: [] }],
    });
    await svcWith(prisma).prepareWeek(week);
    expect(created[0]).toMatchObject({ refundsPence: 1890, amountPence: 0, carriedOutPence: 1890, status: "NOTHING_DUE" });
    expect(lineUpdates[0]).toEqual({ where: { id: "line1" }, data: { clawedBackPence: { increment: 1890 } } });
  });

  it("writes nothing for a shop with a quiet week", async () => {
    const { prisma, created } = makePrisma({});
    await expect(svcWith(prisma).prepareWeek(week)).resolves.toBe(0);
    expect(created).toEqual([]);
  });
});

describe("EflSettlementService.payOutstanding", () => {
  const row = (extra: any = {}) => ({
    id: "P1",
    listingId: "L1",
    weekStart: week,
    amountPence: 1710,
    stripeTransferId: null,
    listing: { stripeAccountId: "acct_shop", stripePayoutsEnabled: true, location: { name: "Pizza Uno" } },
    ...extra,
  });

  it("sends the money to the shop's account, then on to its bank, once", async () => {
    const updates: any[] = [];
    const prisma: any = {
      eflPayout: {
        findMany: jest.fn().mockResolvedValue([row()]),
        update: jest.fn((a: any) => updates.push(a.data)),
      },
    };
    const stripe = {
      transfers: { create: jest.fn().mockResolvedValue({ id: "tr_1" }) },
      accounts: { update: jest.fn() },
      payouts: { create: jest.fn().mockResolvedValue({ id: "po_1" }) },
    };
    await expect(svcWith(prisma, stripe).payOutstanding()).resolves.toEqual({ paid: 1, failed: [] });

    const [t, tOpts] = stripe.transfers.create.mock.calls[0];
    expect(t).toMatchObject({ amount: 1710, currency: "gbp", destination: "acct_shop" });
    expect(tOpts).toEqual({ idempotencyKey: "efl-payout-P1" });
    expect(stripe.accounts.update).toHaveBeenCalledWith("acct_shop", { settings: { payouts: { schedule: { interval: "manual" } } } });
    const [p, pOpts] = stripe.payouts.create.mock.calls[0];
    expect(p).toMatchObject({ amount: 1710, currency: "gbp" });
    expect(pOpts).toEqual({ stripeAccount: "acct_shop", idempotencyKey: "efl-bank-P1" });
    expect(updates.map((u) => u.status)).toEqual(["TRANSFERRED", "PAID"]);
  });

  it("only makes the bank payout on a retry once the transfer went", async () => {
    const prisma: any = {
      eflPayout: { findMany: jest.fn().mockResolvedValue([row({ stripeTransferId: "tr_1" })]), update: jest.fn() },
    };
    const stripe = {
      transfers: { create: jest.fn() },
      accounts: { update: jest.fn() },
      payouts: { create: jest.fn().mockResolvedValue({ id: "po_1" }) },
    };
    await svcWith(prisma, stripe).payOutstanding();
    expect(stripe.transfers.create).not.toHaveBeenCalled();
    expect(stripe.payouts.create).toHaveBeenCalledTimes(1);
  });

  it("marks a refused transfer FAILED and reports it", async () => {
    const updates: any[] = [];
    const prisma: any = {
      eflPayout: {
        findMany: jest.fn().mockResolvedValue([row()]),
        findUnique: jest.fn().mockResolvedValue({ stripeTransferId: null }),
        update: jest.fn((a: any) => updates.push(a.data)),
      },
    };
    const stripe = { transfers: { create: jest.fn().mockRejectedValue(new Error("Insufficient funds")) } };
    const out = await svcWith(prisma, stripe).payOutstanding();
    expect(out.failed).toEqual([{ shop: "Pizza Uno", error: "Insufficient funds" }]);
    expect(updates[0]).toMatchObject({ status: "FAILED", error: "Insufficient funds" });
  });
});

describe("EflSettlementService.payPlatform", () => {
  it("pays Eat For Less only what isn't owed to a shop", async () => {
    const prisma: any = {
      order: {
        findMany: jest.fn().mockResolvedValue([
          { id: "settled", ...order, paymentStatus: "PAID", payments: [] },
          { id: "owed", ...order, paymentStatus: "PAID", payments: [] },
        ]),
      },
      eflPayoutLine: { findMany: jest.fn().mockResolvedValue([{ orderId: "settled" }]) },
      eflPayout: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountPence: 1000 } }) },
    };
    const stripe = {
      balance: { retrieve: jest.fn().mockResolvedValue({ available: [{ currency: "gbp", amount: 5000 }] }) },
      payouts: { create: jest.fn() },
    };
    // £50 available − £18.90 for the unpaid order − £10 payout not yet sent.
    await expect(svcWith(prisma, stripe).payPlatform()).resolves.toBe(2110);
    expect(stripe.payouts.create.mock.calls[0][0]).toMatchObject({ amount: 2110, currency: "gbp" });
  });

  it("leaves the balance alone when it's all the shops'", async () => {
    const prisma: any = {
      order: { findMany: jest.fn().mockResolvedValue([{ id: "owed", ...order, paymentStatus: "PAID", payments: [] }]) },
      eflPayoutLine: { findMany: jest.fn().mockResolvedValue([]) },
      eflPayout: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountPence: null } }) },
    };
    const stripe = {
      balance: { retrieve: jest.fn().mockResolvedValue({ available: [{ currency: "gbp", amount: 1890 }] }) },
      payouts: { create: jest.fn() },
    };
    await expect(svcWith(prisma, stripe).payPlatform()).resolves.toBe(0);
    expect(stripe.payouts.create).not.toHaveBeenCalled();
  });
});
