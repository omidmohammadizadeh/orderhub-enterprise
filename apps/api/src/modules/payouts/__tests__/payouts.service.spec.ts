import { NotFoundException, BadRequestException } from "@nestjs/common";
import { PayoutsService } from "../payouts.service";

// What matters here is not that the list renders — it's that one shop's owner
// can never see another shop's takings, and that a location-scoped user never
// sees the tenant-wide account (which is every shop's money under a label that
// doesn't say so).

const TENANT = "t1";
const LOC_A = "loc-pelton";
const LOC_B = "loc-chester";

function makeService(overrides: { prisma?: any; stripe?: any } = {}) {
  const svc: any = Object.create(PayoutsService.prototype);
  svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  svc.prisma = overrides.prisma;
  svc.stripe = overrides.stripe ?? null;
  svc.config = { get: () => "https://www.orderhubsolutions.com" };
  return svc as PayoutsService & any;
}

/** Two per-location accounts plus one tenant-wide pot. */
function prismaWith({
  userLocations = [] as string[],
  userBrands = [] as string[],
  payouts = [] as any[],
  onboardingComplete = true,
} = {}) {
  return {
    stripeConnectAccount: {
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([
        {
          id: "acc-a",
          stripeAccountId: "acct_A",
          locationId: LOC_A,
          brandId: null,
          payoutsEnabled: true,
          chargesEnabled: true,
          onboardingComplete,
        },
        {
          id: "acc-b",
          stripeAccountId: "acct_B",
          locationId: LOC_B,
          brandId: null,
          payoutsEnabled: true,
          chargesEnabled: true,
          onboardingComplete: true,
        },
        {
          id: "acc-tenant",
          stripeAccountId: "acct_T",
          locationId: null,
          brandId: null,
          payoutsEnabled: true,
          chargesEnabled: true,
          onboardingComplete: true,
        },
      ]),
    },
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
    location: {
      findMany: jest.fn().mockResolvedValue([
        { id: LOC_A, name: "Pizza Uno Pelton" },
        { id: LOC_B, name: "Pizza Uno Chester" },
      ]),
    },
    brand: { findMany: jest.fn().mockResolvedValue([]) },
    payment: { findMany: jest.fn().mockResolvedValue([]) },
    payout: { findMany: jest.fn().mockResolvedValue(payouts) },
  };
}

describe("PayoutsService — access scope", () => {
  it("shows a location-scoped owner only their own shop", async () => {
    const prisma = prismaWith({ userLocations: [LOC_A] });
    const svc = makeService({ prisma });

    const accounts = await svc.listAccounts(TENANT, "u1", "OWNER");

    expect(accounts.map((a: any) => a.label)).toEqual(["Pizza Uno Pelton"]);
  });

  it("hides the tenant-wide account from a location-scoped user", async () => {
    // This is the subtle one: a tenant-level account holds EVERY shop's money.
    // Showing it to someone assigned to a single location leaks the lot under
    // a label that doesn't even name the other shops.
    const prisma = prismaWith({ userLocations: [LOC_A] });
    const svc = makeService({ prisma });

    const accounts = await svc.listAccounts(TENANT, "u1", "OWNER");

    expect(accounts.some((a: any) => a.scope === "TENANT")).toBe(false);
  });

  it("gives a platform admin every account including the tenant pot", async () => {
    const prisma = prismaWith({});
    const svc = makeService({ prisma });

    const accounts = await svc.listAccounts(TENANT, "admin", "PLATFORM_ADMIN");

    expect(accounts).toHaveLength(3);
    expect(prisma.userLocation.findMany).not.toHaveBeenCalled();
  });

  it("returns nothing when the caller can't be identified", async () => {
    const prisma = prismaWith({ userLocations: [LOC_A] });
    const svc = makeService({ prisma });

    const accounts = await svc.listAccounts(TENANT, undefined, undefined);

    expect(accounts).toEqual([]);
  });
});

describe("PayoutsService — history", () => {
  it("queries only the accounts in scope, never the whole tenant", async () => {
    const prisma = prismaWith({ userLocations: [LOC_A] });
    const svc = makeService({ prisma });

    await svc.list(TENANT, "u1", "OWNER", {});

    expect(prisma.payout.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.payout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT, connectAccountId: "acc-a" },
      }),
    );
  });

  it("refuses an account the caller isn't scoped to", async () => {
    const prisma = prismaWith({ userLocations: [LOC_A] });
    const svc = makeService({ prisma });

    await expect(
      svc.list(TENANT, "u1", "OWNER", { accountId: "acc-b" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.payout.findMany).not.toHaveBeenCalled();
  });

  it("labels each payout with the shop it belongs to", async () => {
    const prisma = prismaWith({
      userLocations: [LOC_A, LOC_B],
      payouts: [
        {
          id: "p1",
          stripePayoutId: "po_1",
          amount: "420.00",
          currency: "gbp",
          status: "PAID",
          arrivalDate: null,
          description: null,
          createdAt: new Date(),
          connectAccountId: "acc-b",
        },
      ],
    });
    const svc = makeService({ prisma });

    const { payouts } = await svc.list(TENANT, "u1", "OWNER", { accountId: "acc-b" });

    expect(payouts[0].accountLabel).toBe("Pizza Uno Chester");
  });

  it("caps the page size so a huge limit can't be used to dump the table", async () => {
    const prisma = prismaWith({ userLocations: [LOC_A] });
    const svc = makeService({ prisma });

    await svc.list(TENANT, "u1", "OWNER", { limit: 100_000 });

    expect(prisma.payout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });
});

describe("PayoutsService — Stripe dashboard link", () => {
  const retrieveOk = (details_submitted = true) =>
    jest.fn().mockResolvedValue({
      details_submitted,
      charges_enabled: true,
      payouts_enabled: true,
    });

  it("mints a login link for the caller's own account", async () => {
    const createLoginLink = jest
      .fn()
      .mockResolvedValue({ url: "https://connect.stripe.com/express/xyz" });
    const svc = makeService({
      prisma: prismaWith({ userLocations: [LOC_A] }),
      stripe: { accounts: { retrieve: retrieveOk(), createLoginLink } },
    });

    const { url, kind } = await svc.dashboardLink(TENANT, "u1", "OWNER");

    expect(createLoginLink).toHaveBeenCalledWith("acct_A");
    expect(kind).toBe("DASHBOARD");
    expect(url).toContain("connect.stripe.com");
  });

  it("opens the dashboard when OUR onboarding flag is stale but Stripe says done", async () => {
    // The live bug: onboardingComplete is only written by account.updated and
    // the brand-connect status call, so accounts onboarded before either
    // existed sat at false forever — and the button told owners to finish
    // setup they had finished months earlier.
    const prisma = prismaWith({ userLocations: [LOC_A], onboardingComplete: false });
    const createLoginLink = jest
      .fn()
      .mockResolvedValue({ url: "https://connect.stripe.com/express/xyz" });
    const accountLinksCreate = jest.fn();
    const svc = makeService({
      prisma,
      stripe: {
        accounts: { retrieve: retrieveOk(true), createLoginLink },
        accountLinks: { create: accountLinksCreate },
      },
    });

    const { kind } = await svc.dashboardLink(TENANT, "u1", "OWNER");

    expect(kind).toBe("DASHBOARD");
    expect(accountLinksCreate).not.toHaveBeenCalled();
    // ...and the stale row is repaired on the way past, so every other screen
    // reading this flag stops lying too.
    expect(prisma.stripeConnectAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "acc-a" },
        data: expect.objectContaining({ onboardingComplete: true }),
      }),
    );
  });

  it("sends a genuinely unfinished account to onboarding instead of refusing", async () => {
    const svc = makeService({
      prisma: prismaWith({ userLocations: [LOC_A], onboardingComplete: false }),
      stripe: {
        accounts: { retrieve: retrieveOk(false), createLoginLink: jest.fn() },
        accountLinks: {
          create: jest
            .fn()
            .mockResolvedValue({ url: "https://connect.stripe.com/setup/abc" }),
        },
      },
    });

    const { kind, url } = await svc.dashboardLink(TENANT, "u1", "OWNER");

    expect(kind).toBe("ONBOARDING");
    expect(url).toContain("/setup/");
  });

  it("won't mint a link into another shop's Stripe account", async () => {
    const createLoginLink = jest.fn();
    const svc = makeService({
      prisma: prismaWith({ userLocations: [LOC_A] }),
      stripe: { accounts: { retrieve: jest.fn(), createLoginLink } },
    });

    await expect(
      svc.dashboardLink(TENANT, "u1", "OWNER", "acc-b"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(createLoginLink).not.toHaveBeenCalled();
  });

  it("opens the hosted update form for an account with no Stripe dashboard", async () => {
    // Accounts built for embedded components have no dashboard to log into,
    // but they DO have a Stripe-hosted form that edits bank details — which is
    // the whole reason the owner pressed the button. Refusing them was wrong.
    const createLoginLink = jest.fn();
    const accountLinksCreate = jest
      .fn()
      .mockResolvedValue({ url: "https://connect.stripe.com/setup/upd" });
    const svc = makeService({
      prisma: prismaWith({ userLocations: [LOC_A] }),
      stripe: {
        accounts: {
          retrieve: jest.fn().mockResolvedValue({
            details_submitted: true,
            charges_enabled: true,
            payouts_enabled: true,
            controller: { stripe_dashboard: { type: "none" } },
          }),
          createLoginLink,
        },
        accountLinks: { create: accountLinksCreate },
      },
    });

    const { kind } = await svc.dashboardLink(TENANT, "u1", "OWNER");

    expect(kind).toBe("ACCOUNT_UPDATE");
    expect(createLoginLink).not.toHaveBeenCalled();
    expect(accountLinksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ type: "account_update" }),
    );
  });

  it("treats the merchant's own Stripe account as normal, not an error", async () => {
    // Stripe won't let a platform mint a link into a Standard account, and
    // shouldn't. That's permanent and correct, so it must not surface as a red
    // failure the operator will try to fix.
    const prisma = prismaWith({ userLocations: [LOC_A] });
    const svc = makeService({
      prisma,
      stripe: {
        accounts: {
          retrieve: jest.fn().mockResolvedValue({
            details_submitted: true,
            charges_enabled: true,
            payouts_enabled: true,
            type: "standard",
            controller: { stripe_dashboard: { type: "full" } },
          }),
          createLoginLink: jest.fn(),
        },
      },
    });

    const res = await svc.dashboardLink(TENANT, "u1", "OWNER");

    expect(res.kind).toBe("EXTERNAL");
    expect(res.url).toContain("dashboard.stripe.com");
    expect(res.message).toMatch(/Pizza Uno Pelton is connected through its own Stripe account/);
  });

  it("remembers the dashboard type so the button can stop over-promising", async () => {
    const prisma = prismaWith({ userLocations: [LOC_A] });
    const svc = makeService({
      prisma,
      stripe: {
        accounts: {
          retrieve: jest.fn().mockResolvedValue({
            details_submitted: true,
            charges_enabled: true,
            payouts_enabled: true,
            controller: { stripe_dashboard: { type: "full" } },
          }),
          createLoginLink: jest.fn(),
        },
      },
    });

    await svc.dashboardLink(TENANT, "u1", "OWNER");

    expect(prisma.stripeConnectAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ dashboardType: "full" }),
        }),
      }),
    );
  });

  it("falls back to the update form when a login link unexpectedly fails", async () => {
    // A pasted-in acct_… belongs to the merchant's own Stripe login; Stripe
    // rejects login links for it. The owner needs to be told where to go, not
    // shown a raw Stripe error.
    const svc = makeService({
      prisma: prismaWith({ userLocations: [LOC_A] }),
      stripe: {
        accounts: {
          retrieve: jest.fn().mockResolvedValue({
            details_submitted: true,
            charges_enabled: true,
            payouts_enabled: true,
          }),
          createLoginLink: jest
            .fn()
            .mockRejectedValue(new Error("Only Express accounts have login links")),
        },
        accountLinks: {
          create: jest
            .fn()
            .mockResolvedValue({ url: "https://connect.stripe.com/setup/upd" }),
        },
      },
    });

    const { kind } = await svc.dashboardLink(TENANT, "u1", "OWNER");
    expect(kind).toBe("ACCOUNT_UPDATE");
  });

  it("only gives up when even the update form can't be created", async () => {
    const svc = makeService({
      prisma: prismaWith({ userLocations: [LOC_A] }),
      stripe: {
        accounts: {
          retrieve: jest.fn().mockResolvedValue({
            details_submitted: true,
            charges_enabled: true,
            payouts_enabled: true,
          }),
          createLoginLink: jest.fn().mockRejectedValue(new Error("nope")),
        },
        accountLinks: { create: jest.fn().mockRejectedValue(new Error("nope")) },
      },
    });

    await expect(svc.dashboardLink(TENANT, "u1", "OWNER")).rejects.toThrow(
      /dashboard\.stripe\.com/,
    );
  });
});

describe("PayoutsService — balance", () => {
  it("degrades to a reason instead of failing the page when Stripe is down", async () => {
    const svc = makeService({
      prisma: prismaWith({ userLocations: [LOC_A] }),
      stripe: {
        balance: { retrieve: jest.fn().mockRejectedValue(new Error("timeout")) },
        payouts: { list: jest.fn().mockResolvedValue({ data: [] }) },
      },
    });

    const res = await svc.balance(TENANT, "u1", "OWNER");

    expect(res.available).toBeNull();
    expect(res.unavailableReason).toBe("timeout");
  });

  const secs = (d: Date) => Math.floor(d.getTime() / 1000);
  const daysFromNow = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d;
  };

  const balanceStripe = (payoutRows: any[]) => ({
    balance: {
      retrieve: jest.fn().mockResolvedValue({
        available: [{ amount: 12_500, currency: "gbp" }],
        pending: [{ amount: 3_000, currency: "gbp" }],
      }),
    },
    payouts: { list: jest.fn().mockResolvedValue({ data: payoutRows }) },
  });

  it("reports in-transit money and when it lands", async () => {
    const arrival = secs(daysFromNow(2));
    const svc = makeService({
      prisma: prismaWith({ userLocations: [LOC_A] }),
      stripe: balanceStripe([
        { amount: 42_000, arrival_date: arrival, status: "in_transit" },
      ]),
    });

    const res = await svc.balance(TENANT, "u1", "OWNER");

    expect(res.available).toBe(125);
    expect(res.pending).toBe(30);
    expect(res.inTransit).toBe(420);
    expect(res.nextPayout?.amount).toBe(420);
  });

  it("does NOT count payouts that already landed as on their way", async () => {
    // The live bug, in miniature. Asking Stripe for status:"in_transit" came
    // back as every recent payout, so a shop with settled July payouts was
    // told the lot was arriving today. Only the genuinely open one counts.
    const svc = makeService({
      prisma: prismaWith({ userLocations: [LOC_A] }),
      stripe: balanceStripe([
        { amount: 5_462, arrival_date: secs(daysFromNow(1)), status: "in_transit" },
        { amount: 157, arrival_date: secs(daysFromNow(-1)), status: "paid" },
        { amount: 70_680, arrival_date: secs(daysFromNow(-30)), status: "paid" },
      ]),
    });

    const res = await svc.balance(TENANT, "u1", "OWNER");

    expect(res.inTransit).toBe(54.62);
  });

  it("ignores a stale in_transit status once the arrival date has passed", async () => {
    // Belt and braces: even if Stripe still says in_transit, a payout dated a
    // month ago is not "on its way to your bank".
    const svc = makeService({
      prisma: prismaWith({ userLocations: [LOC_A] }),
      stripe: balanceStripe([
        { amount: 58_745, arrival_date: secs(daysFromNow(-30)), status: "in_transit" },
      ]),
    });

    const res = await svc.balance(TENANT, "u1", "OWNER");

    expect(res.inTransit).toBe(0);
    expect(res.nextPayout).toBeNull();
  });

  it("names the SOONEST arrival as the next payout, not the newest row", async () => {
    const svc = makeService({
      prisma: prismaWith({ userLocations: [LOC_A] }),
      stripe: balanceStripe([
        { amount: 10_000, arrival_date: secs(daysFromNow(6)), status: "in_transit" },
        { amount: 2_500, arrival_date: secs(daysFromNow(1)), status: "in_transit" },
      ]),
    });

    const res = await svc.balance(TENANT, "u1", "OWNER");

    expect(res.inTransit).toBe(125);
    expect(res.nextPayout?.amount).toBe(25);
  });
});

describe("PayoutsService — history reads Stripe", () => {
  it("shows Stripe's payouts even when our webhook table is empty", async () => {
    // Merchants had a year of payouts at Stripe and an empty table here,
    // because webhooks only started recording last week.
    const prisma = prismaWith({ userLocations: [LOC_A], payouts: [] });
    const svc = makeService({
      prisma,
      stripe: {
        payouts: {
          list: jest.fn().mockResolvedValue({
            data: [
              {
                id: "po_1",
                amount: 70_680,
                currency: "gbp",
                status: "paid",
                created: 1_754_000_000,
                arrival_date: 1_754_100_000,
              },
            ],
          }),
        },
      },
    });

    const { payouts } = await svc.list(TENANT, "u1", "OWNER", {});

    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({
      amount: "706.80",
      status: "PAID",
      accountLabel: "Pizza Uno Pelton",
    });
    expect(prisma.payout.findMany).not.toHaveBeenCalled();
  });

  it("falls back to our own records when Stripe can't be reached", async () => {
    const prisma = prismaWith({
      userLocations: [LOC_A],
      payouts: [
        {
          id: "p1",
          stripePayoutId: "po_db",
          amount: "12.00",
          currency: "gbp",
          status: "PAID",
          arrivalDate: new Date(),
          description: null,
          createdAt: new Date(),
          connectAccountId: "acc-a",
        },
      ],
    });
    const svc = makeService({
      prisma,
      stripe: {
        payouts: { list: jest.fn().mockRejectedValue(new Error("network")) },
      },
    });

    const { payouts } = await svc.list(TENANT, "u1", "OWNER", {});

    expect(payouts[0].stripePayoutId).toBe("po_db");
  });
});

describe("PayoutsService — breakdown", () => {
  // A real-shaped payout: two sales, a refund, Stripe's cut, our commission.
  const TXNS = [
    {
      id: "txn_1",
      type: "charge",
      amount: 2_000,
      fee: 50,
      net: 1_950,
      currency: "gbp",
      created: 1_754_000_000,
      source: { id: "ch_1", payment_intent: "pi_1" },
    },
    {
      id: "txn_2",
      type: "charge",
      amount: 3_000,
      fee: 74,
      net: 2_926,
      currency: "gbp",
      created: 1_754_000_100,
      source: { id: "ch_2", payment_intent: "pi_2" },
    },
    {
      id: "txn_3",
      type: "refund",
      amount: -500,
      fee: 0,
      net: -500,
      currency: "gbp",
      created: 1_754_000_200,
      source: { id: "re_1" },
    },
    {
      id: "txn_4",
      type: "application_fee",
      amount: -200,
      fee: 0,
      net: -200,
      currency: "gbp",
      created: 1_754_000_300,
      source: { id: "fee_1" },
    },
    // Stripe returns the payout debit alongside what funded it. It is the
    // answer, not a part — counting it nets everything to zero.
    {
      id: "txn_payout",
      type: "payout",
      amount: -4_176,
      fee: 0,
      net: -4_176,
      currency: "gbp",
      created: 1_754_000_400,
      source: { id: "po_1" },
    },
  ];

  function svcWith(txns = TXNS, payments: any[] = []) {
    const prisma = prismaWith({ userLocations: [LOC_A] });
    prisma.payment.findMany = jest.fn().mockResolvedValue(payments);
    return {
      prisma,
      svc: makeService({
        prisma,
        stripe: {
          balanceTransactions: {
            list: jest.fn().mockResolvedValue({ data: txns }),
          },
        },
      }),
    };
  }

  it("totals to what actually hit the bank", async () => {
    // The whole point: the parts must add up to the payout, or the merchant
    // is worse off than before they opened it.
    const { svc } = svcWith();

    const b = await svc.breakdown(TENANT, "u1", "OWNER", "po_1");

    expect(b.sales).toBe(50);
    expect(b.refunds).toBe(-5);
    expect(b.stripeFees).toBe(-1.24);
    expect(b.commission).toBe(-2);
    expect(b.total).toBe(41.76);
    expect(b.other).toBe(0);
    expect(b.sales + b.refunds + b.stripeFees + b.commission).toBeCloseTo(
      b.total,
      2,
    );
  });

  it("never lists the payout itself as one of its own parts", async () => {
    // The live bug: the payout debit landed in "Other adjustments" and
    // cancelled the sales that funded it, so every payout read £0.00.
    const { svc } = svcWith();

    const b = await svc.breakdown(TENANT, "u1", "OWNER", "po_1");

    expect(b.lines.some((l: any) => l.type.startsWith("payout"))).toBe(false);
    expect(b.total).not.toBe(0);
  });

  it("falls back to summing the parts when Stripe omits the payout row", async () => {
    const { svc } = svcWith(TXNS.filter((t) => t.type !== "payout"));

    const b = await svc.breakdown(TENANT, "u1", "OWNER", "po_1");

    expect(b.total).toBe(41.76);
  });

  it("names the orders behind the charges", async () => {
    // Stripe says ch_3ReF…; the owner thinks in order numbers.
    const { svc } = svcWith(TXNS, [
      {
        stripeChargeId: "ch_1",
        stripePaymentIntentId: "pi_1",
        order: {
          id: "o1",
          displayId: "JWDBH",
          orderNumber: 42,
          customerName: "Sam",
          total: "20.00",
          createdAt: new Date(),
        },
      },
    ]);

    const b = await svc.breakdown(TENANT, "u1", "OWNER", "po_1");

    expect(b.orderCount).toBe(1);
    expect(b.lines.find((l: any) => l.id === "txn_1").order.reference).toBe("JWDBH");
    expect(b.lines.find((l: any) => l.id === "txn_2").order).toBeNull();
  });

  it("matches a destination charge by its payment intent, not just the charge id", async () => {
    const { svc } = svcWith(TXNS, [
      {
        stripeChargeId: null,
        stripePaymentIntentId: "pi_2",
        order: {
          id: "o2",
          displayId: null,
          orderNumber: 7,
          customerName: null,
          total: "30.00",
          createdAt: new Date(),
        },
      },
    ]);

    const b = await svc.breakdown(TENANT, "u1", "OWNER", "po_1");

    expect(b.lines.find((l: any) => l.id === "txn_2").order.reference).toBe("#7");
  });

  it("flags when Stripe's page limit hides transactions", async () => {
    // A short list that doesn't add up reads as a wrong total, so say so.
    const many = Array.from({ length: 100 }, (_, i) => ({
      ...TXNS[0],
      id: `txn_${i}`,
      source: { id: `ch_${i}` },
    }));
    const { svc } = svcWith(many);

    const b = await svc.breakdown(TENANT, "u1", "OWNER", "po_1");

    expect(b.truncated).toBe(true);
  });

  it("refuses a payout on an account outside the caller's scope", async () => {
    const { svc } = svcWith();

    await expect(
      svc.breakdown(TENANT, "u1", "OWNER", "po_1", "acc-b"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("scopes the order lookup to the tenant", async () => {
    const { prisma, svc } = svcWith();

    await svc.breakdown(TENANT, "u1", "OWNER", "po_1");

    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT }),
      }),
    );
  });
});
