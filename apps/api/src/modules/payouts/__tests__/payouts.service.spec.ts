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
  return svc as PayoutsService & any;
}

/** Two per-location accounts plus one tenant-wide pot. */
function prismaWith({
  userLocations = [] as string[],
  userBrands = [] as string[],
  payouts = [] as any[],
} = {}) {
  return {
    stripeConnectAccount: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: "acc-a",
          stripeAccountId: "acct_A",
          locationId: LOC_A,
          brandId: null,
          payoutsEnabled: true,
          chargesEnabled: true,
          onboardingComplete: true,
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

    expect(prisma.payout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT, connectAccountId: { in: ["acc-a"] } },
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

    const { payouts } = await svc.list(TENANT, "u1", "OWNER", {});

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
  it("mints a login link for the caller's own account", async () => {
    const createLoginLink = jest
      .fn()
      .mockResolvedValue({ url: "https://connect.stripe.com/express/xyz" });
    const svc = makeService({
      prisma: prismaWith({ userLocations: [LOC_A] }),
      stripe: { accounts: { createLoginLink } },
    });

    const { url } = await svc.dashboardLink(TENANT, "u1", "OWNER");

    expect(createLoginLink).toHaveBeenCalledWith("acct_A");
    expect(url).toContain("connect.stripe.com");
  });

  it("won't mint a link into another shop's Stripe account", async () => {
    const createLoginLink = jest.fn();
    const svc = makeService({
      prisma: prismaWith({ userLocations: [LOC_A] }),
      stripe: { accounts: { createLoginLink } },
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

  it("reports in-transit money and when it lands", async () => {
    const arrival = Math.floor(Date.UTC(2026, 7, 14) / 1000);
    const svc = makeService({
      prisma: prismaWith({ userLocations: [LOC_A] }),
      stripe: {
        balance: {
          retrieve: jest.fn().mockResolvedValue({
            available: [{ amount: 12_500, currency: "gbp" }],
            pending: [{ amount: 3_000, currency: "gbp" }],
          }),
        },
        payouts: {
          list: jest
            .fn()
            .mockResolvedValue({ data: [{ amount: 42_000, arrival_date: arrival }] }),
        },
      },
    });

    const res = await svc.balance(TENANT, "u1", "OWNER");

    expect(res.available).toBe(125);
    expect(res.pending).toBe(30);
    expect(res.inTransit).toBe(420);
    expect(res.nextPayout?.arrivalDate).toContain("2026-08-14");
  });
});
