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

  it("explains itself when the account is one we don't manage", async () => {
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
