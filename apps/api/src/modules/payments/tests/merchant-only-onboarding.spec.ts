import { PaymentsService } from "../payments.service";

// New Connect accounts are MERCHANT-ONLY (Stripe "standard": Stripe carries
// the losses, the shop pays Stripe's fees). Stripe gave the two accounts made
// that way by hand — Pizza Uno Pelton and ali shaverdi — a 3-day payout hold
// from day one, while every Express account we created got 7 (2026-10-27).
// Stripe's sandbox confirmed: v1 refuses card_payments without transfers, so
// the merchant-only create must request NO capabilities; a standard account
// onboards through a hosted account link.

function build(opts: {
  env?: Record<string, string>;
  existingAcct?: string | null;
  retrieved?: any;
}) {
  const created: any[] = [];
  const rows: any[] = [];
  const prisma: any = {
    brand: {
      findFirst: async () => ({
        id: "b1",
        name: "Pizza Test",
        phone: null,
        country: "GB",
        stripeConnectedAccountId: opts.existingAcct ?? null,
      }),
      update: async () => ({}),
    },
    user: {
      findUnique: async () => ({ email: "admin@orderhub.test" }),
      findFirst: async () => ({ email: "owner@shop.test" }),
    },
    stripeConnectAccount: {
      findFirst: async () => null,
      create: async ({ data }: any) => {
        rows.push(data);
        return { id: "row1", ...data };
      },
    },
  };
  const config: any = { get: (k: string) => opts.env?.[k] };
  const svc = new PaymentsService(prisma, {} as any, config, {} as any, {} as any, {} as any);
  const stripe = {
    accounts: {
      create: async (params: any) => {
        created.push(params);
        return { id: "acct_new" };
      },
      retrieve: async () => opts.retrieved ?? { type: "standard" },
    },
    accountLinks: {
      create: async () => ({ url: "https://connect.stripe.com/setup/s/acct_new/x" }),
    },
    accountSessions: { create: async () => ({ client_secret: "cs_embedded" }) },
  };
  (svc as any).stripe = stripe;
  return { svc, created, rows };
}

describe("merchant-only Connect onboarding", () => {
  it("creates a standard-style account with no capabilities and no prefilled login email", async () => {
    const { svc, created, rows } = build({});
    await svc.createBrandOnboardingSession("t1", "b1", "u-admin");
    expect(created).toHaveLength(1);
    expect(created[0].type).toBeUndefined();
    expect(created[0].capabilities).toBeUndefined();
    expect(created[0].controller).toEqual({
      stripe_dashboard: { type: "full" },
      fees: { payer: "account" },
      losses: { payments: "stripe" },
      requirement_collection: "stripe",
    });
    // An admin onboarding for the shop must not become the shop's Stripe login.
    expect(created[0].email).toBeUndefined();
    expect(rows[0].accountType).toBe("STANDARD");
  });

  it("sends a merchant-only account to Stripe's hosted signup instead of the embedded form", async () => {
    const { svc } = build({});
    const res: any = await svc.createBrandOnboardingSession("t1", "b1");
    expect(res.url).toContain("connect.stripe.com");
    expect(res.clientSecret).toBeUndefined();
  });

  it("points Manage payouts at the shop's own Stripe login", async () => {
    const { svc } = build({});
    const res: any = await svc.createBrandManagementSession("t1", "b1");
    expect(res.url).toBe("https://dashboard.stripe.com/settings/payouts");
  });

  it("keeps the embedded form for an existing Express account", async () => {
    const { svc, created } = build({
      existingAcct: "acct_express",
      retrieved: { type: "express", controller: { stripe_dashboard: { type: "express" } } },
    });
    const res: any = await svc.createBrandOnboardingSession("t1", "b1");
    expect(created).toHaveLength(0);
    expect(res.clientSecret).toBe("cs_embedded");
  });

  it("STRIPE_CONNECT_NEW_ACCOUNT_TYPE=express restores the old Express setup", async () => {
    const { svc, created, rows } = build({
      env: { STRIPE_CONNECT_NEW_ACCOUNT_TYPE: "express" },
      retrieved: { type: "express" },
    });
    await svc.createBrandOnboardingSession("t1", "b1", "u-admin");
    expect(created[0].type).toBe("express");
    expect(created[0].capabilities).toEqual({
      card_payments: { requested: true },
      transfers: { requested: true },
    });
    expect(created[0].email).toBe("admin@orderhub.test");
    expect(rows[0].accountType).toBe("EXPRESS");
  });
});
