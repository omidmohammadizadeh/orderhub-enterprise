import { MollieService, apiBase, feeBreakdown } from "../mollie/mollie.service";
import {
  mollieAmount,
  signOAuthState,
  verifyOAuthState,
} from "../mollie/mollie-api.client";

// Passthrough "encryption" — the real envelope is tested on its own.
const crypto = {
  encrypt: (v: any) => ({ plain: v }),
  decrypt: (e: any) => e.plain,
} as any;

const ENV = {
  MOLLIE_CLIENT_ID: "app_test123",
  MOLLIE_CLIENT_SECRET: "secret_abc",
  MOLLIE_PLATFORM_ACCESS_TOKEN: "access_platform",
  MOLLIE_TESTMODE: "true",
  API_URL: "https://api.example",
  WEB_URL: "https://web.example",
};
const setEnv = () => Object.assign(process.env, ENV);
const clearEnv = () => {
  for (const k of Object.keys(ENV)) delete process.env[k];
};

/** fetch that answers each call with the next JSON body in turn. */
const mollieReturns = (...bodies: any[]) => {
  const spy = jest.spyOn(global, "fetch" as any);
  for (const b of bodies) {
    spy.mockResolvedValueOnce({
      ok: b?.__status ? b.__status < 400 : true,
      status: b?.__status ?? 200,
      text: async () => JSON.stringify(b),
    } as any);
  }
  return spy;
};
const callUrl = (spy: jest.SpyInstance, i = 0) => String(spy.mock.calls[i]![0]);
const callInit = (spy: jest.SpyInstance, i = 0) => spy.mock.calls[i]![1] as any;
const callBody = (spy: jest.SpyInstance, i = 0) => JSON.parse(callInit(spy, i).body);

const connected = {
  id: "mc1",
  tenantId: "t1",
  brandId: "b1",
  enabled: true,
  profileId: "pfl_1",
  organizationId: "org_1",
  refreshTokenEnc: { plain: { token: "refresh_1" } },
  accessTokenEnc: { plain: { token: "access_1" } },
  accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000),
};

beforeEach(setEnv);
afterEach(() => {
  clearEnv();
  jest.restoreAllMocks();
});

describe("apiBase", () => {
  it("adds the /api global prefix when API_URL is the bare host, and never doubles it", () => {
    process.env.API_URL = "https://api.example";
    expect(apiBase()).toBe("https://api.example/api");
    process.env.API_URL = "https://api.example/api/";
    expect(apiBase()).toBe("https://api.example/api");
  });

  it("puts the OAuth redirect and the webhook under /api", () => {
    const svc = new MollieService({} as any, crypto, {} as any);
    expect(svc.redirectUri()).toBe("https://api.example/api/v1/payments/mollie/oauth/callback");
    expect(svc.webhookUrl()).toBe("https://api.example/api/v1/payments/mollie/webhook");
  });
});

describe("mollieAmount", () => {
  it("formats with exactly the currency's decimals, as a string", () => {
    expect(mollieAmount(12.5, "gbp")).toEqual({ currency: "GBP", value: "12.50" });
    expect(mollieAmount(0.1 + 0.2, "EUR")).toEqual({ currency: "EUR", value: "0.30" });
    expect(mollieAmount(10, "JPY").value).toBe("10");
  });
});

describe("OAuth state", () => {
  it("round-trips the tenant and brand", () => {
    const s = signOAuthState({ tenantId: "t1", brandId: "b1" }, "k");
    expect(verifyOAuthState(s, "k")).toEqual({ tenantId: "t1", brandId: "b1" });
  });

  it("rejects a state signed with another secret, edited, or expired", () => {
    const s = signOAuthState({ tenantId: "t1", brandId: "b1" }, "k");
    expect(verifyOAuthState(s, "other")).toBeNull();
    const [body, sig] = s.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), b: "b2" }),
    ).toString("base64url");
    expect(verifyOAuthState(`${forged}.${sig}`, "k")).toBeNull();
    expect(verifyOAuthState(signOAuthState({ tenantId: "t1", brandId: "b1" }, "k", -10), "k")).toBeNull();
    expect(verifyOAuthState(undefined, "k")).toBeNull();
  });
});

describe("feeBreakdown", () => {
  it("adds the fixed part to the customer's bill and takes the percentage silently", () => {
    const brand = {
      applicationFeeMode: "fixed_and_percentage",
      applicationFeeFixedAmount: 0.5,
      applicationFeePercentage: 5,
    };
    expect(feeBreakdown(brand, null, 10, "GBP")).toEqual({ platformFee: 1, customerSurcharge: 0.5 });
  });

  it("falls back to the location's config when the brand has none", () => {
    const loc = { applicationFeeMode: "percentage_only", applicationFeePercentage: 3 };
    expect(feeBreakdown({ applicationFeeMode: "none" }, loc, 20, "GBP")).toEqual({
      platformFee: 0.6,
      customerSurcharge: 0,
    });
  });
});

describe("MollieService.activeConnectionForBrand", () => {
  const build = (row: any) =>
    new MollieService(
      { mollieConnection: { findUnique: jest.fn().mockResolvedValue(row) } } as any,
      crypto,
      {} as any,
    );

  it("routes only an enabled, connected brand with a website profile", async () => {
    expect(await build(connected).activeConnectionForBrand("b1")).toBe(connected);
    expect(await build({ ...connected, enabled: false }).activeConnectionForBrand("b1")).toBeNull();
    expect(await build({ ...connected, profileId: null }).activeConnectionForBrand("b1")).toBeNull();
    expect(await build({ ...connected, refreshTokenEnc: null }).activeConnectionForBrand("b1")).toBeNull();
    expect(await build(null).activeConnectionForBrand("b1")).toBeNull();
  });

  it("leaves everyone on Stripe when the platform app isn't configured", async () => {
    delete process.env.MOLLIE_CLIENT_ID;
    expect(await build(connected).activeConnectionForBrand("b1")).toBeNull();
  });
});

describe("MollieService.createPayment", () => {
  const order = {
    id: "o1",
    displayId: "AB12",
    total: 10,
    brandId: "b1",
    locationId: "loc1",
    location: { id: "loc1", name: "Shop", country: "GB", currency: "GBP", brandId: "b1" },
    brand: {
      id: "b1",
      name: "Burger Co",
      applicationFeeMode: "fixed_and_percentage",
      applicationFeeFixedAmount: 0.5,
      applicationFeePercentage: 5,
    },
  };
  const build = () => {
    const prisma = {
      order: { findFirst: jest.fn().mockResolvedValue(order) },
      mollieConnection: { findUnique: jest.fn().mockResolvedValue(connected) },
      payment: { create: jest.fn().mockResolvedValue({}) },
    } as any;
    return { svc: new MollieService(prisma, crypto, {} as any), prisma };
  };
  const args = {
    tenantId: "t1",
    orderId: "o1",
    redirectUrl: "https://web.example/order/shop/confirmation?orderId=o1",
    source: "storefront" as const,
  };

  it("charges on the restaurant's profile with their token, our fee on top, in test mode", async () => {
    const { svc, prisma } = build();
    const spy = mollieReturns({
      id: "tr_1",
      status: "open",
      _links: { checkout: { href: "https://www.mollie.com/checkout/tr_1" } },
    });

    const out = await svc.createPayment(args);

    expect(out.checkoutUrl).toBe("https://www.mollie.com/checkout/tr_1");
    expect(callUrl(spy)).toBe("https://api.mollie.com/v2/payments");
    expect(callInit(spy).headers.Authorization).toBe("Bearer access_1");
    expect(callInit(spy).headers["Idempotency-Key"]).toBe("ord_o1_storefront");
    const body = callBody(spy);
    // £10 basket + 50p visible surcharge; we keep 50p + 5% of £10.
    expect(body.amount).toEqual({ currency: "GBP", value: "10.50" });
    expect(body.applicationFee.amount).toEqual({ currency: "GBP", value: "1.00" });
    expect(body.profileId).toBe("pfl_1");
    expect(body.testmode).toBe(true);
    expect(body.webhookUrl).toBe("https://api.example/api/v1/payments/mollie/webhook");
    expect(body.metadata).toMatchObject({ orderId: "o1", brandId: "b1" });
    // Card (with Google Pay inside it) and Apple Pay only on online ordering.
    expect(body.method).toEqual(["creditcard", "applepay"]);

    const row = prisma.payment.create.mock.calls[0][0].data;
    expect(row).toMatchObject({
      provider: "MOLLIE",
      providerChargeId: "tr_1",
      amount: 10.5,
      platformFee: 1,
      netAmount: 9.5,
      status: "PENDING",
    });
    expect(row.metadata.mollieBrandId).toBe("b1");
  });

  it("leaves POS payment links on whatever methods the restaurant has enabled", async () => {
    const { svc } = build();
    const spy = mollieReturns({ id: "tr_1", status: "open", _links: { checkout: { href: "x" } } });
    await svc.createPayment({ ...args, source: "payment_link" });
    expect(callBody(spy).method).toBeUndefined();
  });

  it("sends no testmode flag once MOLLIE_TESTMODE is false", async () => {
    process.env.MOLLIE_TESTMODE = "false";
    const { svc } = build();
    const spy = mollieReturns({ id: "tr_1", status: "open", _links: { checkout: { href: "x" } } });
    await svc.createPayment(args);
    expect(callBody(spy).testmode).toBeUndefined();
  });

  it("refuses a brand that isn't on Mollie", async () => {
    const { svc, prisma } = build();
    prisma.mollieConnection.findUnique.mockResolvedValue({ ...connected, enabled: false });
    await expect(svc.createPayment(args)).rejects.toThrow(/isn't ready/);
  });
});

describe("MollieService webhook + settle", () => {
  const row = {
    id: "p1",
    tenantId: "t1",
    orderId: "o1",
    provider: "MOLLIE",
    providerChargeId: "tr_1",
    amount: 10.5,
    currency: "gbp",
    status: "PENDING",
    metadata: { mollieBrandId: "b1", mollieTestmode: true },
  };
  const build = (paymentRow: any = row) => {
    const prisma = {
      payment: {
        findFirst: jest.fn().mockResolvedValue(paymentRow),
        updateMany: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      mollieConnection: { findUnique: jest.fn().mockResolvedValue(connected) },
      order: { update: jest.fn().mockResolvedValue({}) },
    } as any;
    const payments = { confirmPaymentRow: jest.fn().mockResolvedValue({}) } as any;
    return { svc: new MollieService(prisma, crypto, payments), prisma, payments };
  };

  it("reads the payment back from Mollie and settles it when paid", async () => {
    const { svc, payments } = build();
    const spy = mollieReturns({ id: "tr_1", status: "paid", amount: { currency: "GBP", value: "10.50" } });
    await svc.handleWebhook("tr_1");
    expect(callUrl(spy)).toBe("https://api.mollie.com/v2/payments/tr_1?testmode=true");
    expect(payments.confirmPaymentRow).toHaveBeenCalledWith("t1", row, "tr_1");
  });

  it("does not settle a paid payment for a different amount", async () => {
    const { svc, payments } = build();
    mollieReturns({ id: "tr_1", status: "paid", amount: { currency: "GBP", value: "0.01" } });
    await svc.handleWebhook("tr_1");
    expect(payments.confirmPaymentRow).not.toHaveBeenCalled();
  });

  it("marks failed / cancelled / expired payments FAILED without touching a paid one", async () => {
    const { svc, prisma, payments } = build();
    mollieReturns({ id: "tr_1", status: "expired", amount: { currency: "GBP", value: "10.50" } });
    await svc.handleWebhook("tr_1");
    expect(payments.confirmPaymentRow).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", status: { notIn: ["SUCCEEDED", "REFUNDED"] } },
      data: { status: "FAILED" },
    });
  });

  it("ignores ids that aren't Mollie payment ids, and ones we never created", async () => {
    const spy = jest.spyOn(global, "fetch" as any);
    const a = build();
    await a.svc.handleWebhook("../../etc");
    await a.svc.handleWebhook(undefined);
    expect(a.prisma.payment.findFirst).not.toHaveBeenCalled();
    const b = build(null);
    await b.svc.handleWebhook("tr_unknown");
    expect(spy).not.toHaveBeenCalled();
  });

  it("refunds in full with the restaurant's token and marks the order refunded", async () => {
    const { svc, prisma } = build({ ...row, status: "SUCCEEDED" });
    const spy = mollieReturns({ id: "re_1", status: "pending" });
    await svc.refundOrder("o1", "Shop closed");
    expect(callUrl(spy)).toBe("https://api.mollie.com/v2/payments/tr_1/refunds");
    expect(callBody(spy)).toEqual({
      amount: { currency: "GBP", value: "10.50" },
      description: "Shop closed",
      testmode: true,
    });
    expect(prisma.payment.update.mock.calls[0][0].data.status).toBe("REFUNDED");
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: "o1" },
      data: { paymentStatus: "REFUNDED" },
    });
  });
});

describe("MollieService access token refresh", () => {
  it("refreshes an expired token, and switches the brand off if Mollie refuses", async () => {
    const expired = { ...connected, accessTokenExpiresAt: new Date(Date.now() - 1000) };
    const prisma = {
      mollieConnection: {
        findFirst: jest.fn().mockResolvedValue(expired),
        update: jest.fn().mockResolvedValue({}),
      },
    } as any;
    const svc = new MollieService(prisma, crypto, {} as any);
    const spy = mollieReturns({ __status: 400, error: "invalid_grant" });
    await expect(svc.refreshStatus("t1", "b1")).rejects.toThrow();
    expect(callUrl(spy)).toBe("https://api.mollie.com/oauth2/tokens");
    expect(callInit(spy).headers.Authorization).toBe(
      `Basic ${Buffer.from("app_test123:secret_abc").toString("base64")}`,
    );
    expect(prisma.mollieConnection.update).toHaveBeenCalledWith({
      where: { id: "mc1" },
      data: expect.objectContaining({ status: "revoked", enabled: false }),
    });
  });
});

describe("MollieService.refreshStatus", () => {
  it("switches on card then Apple Pay on the restaurant's profile and records what Mollie said", async () => {
    const prisma = {
      mollieConnection: {
        findFirst: jest.fn().mockResolvedValue(connected),
        update: jest.fn().mockImplementation(async ({ data }: any) => ({ ...connected, ...data })),
      },
    } as any;
    const svc = new MollieService(prisma, crypto, {} as any);
    const spy = mollieReturns(
      { id: "org_1", name: "Pizza Uno Ltd" },
      { status: "in-review", canReceivePayments: false, canReceiveSettlements: false },
      { _embedded: { profiles: [{ id: "pfl_1", status: "verified" }] } },
      { status: "pending-review" },
      { __status: 422, detail: "Credit card must be enabled first" },
    );
    const out = await svc.refreshStatus("t1", "b1");
    expect(callUrl(spy, 3)).toBe("https://api.mollie.com/v2/profiles/pfl_1/methods/creditcard");
    expect(callUrl(spy, 4)).toBe("https://api.mollie.com/v2/profiles/pfl_1/methods/applepay");
    expect(out.methodStatuses).toEqual({ creditcard: "pending-review", applepay: "not-yet" });
    expect(out.status).toBe("in-review");
  });
});

describe("MollieService test payment", () => {
  it("is always test mode, card/Apple Pay only, with a 10p fee, and needs no order or switch", async () => {
    process.env.MOLLIE_TESTMODE = "false"; // even when live, a test payment stays a test
    const prisma = {
      mollieConnection: {
        findFirst: jest.fn().mockResolvedValue({ ...connected, enabled: false }),
        update: jest.fn().mockResolvedValue({}),
      },
    } as any;
    const svc = new MollieService(prisma, crypto, {} as any);
    const spy = mollieReturns({ id: "tr_t1", status: "open", _links: { checkout: { href: "https://mollie/co" } } });
    const out = await svc.createTestPayment("t1", "b1");
    expect(out).toEqual({ paymentId: "tr_t1", checkoutUrl: "https://mollie/co" });
    const body = callBody(spy);
    expect(body).toMatchObject({
      amount: { currency: "GBP", value: "1.00" },
      testmode: true,
      profileId: "pfl_1",
      method: ["creditcard", "applepay"],
      applicationFee: { amount: { currency: "GBP", value: "0.10" } },
    });
    expect(prisma.mollieConnection.update).toHaveBeenCalledWith({
      where: { id: "mc1" },
      data: { lastTestPaymentId: "tr_t1" },
    });
  });

  it("refunds a paid test payment once, in test mode", async () => {
    const prisma = {
      mollieConnection: { findFirst: jest.fn().mockResolvedValue({ ...connected, lastTestPaymentId: "tr_t1" }) },
    } as any;
    const svc = new MollieService(prisma, crypto, {} as any);
    const paid = { id: "tr_t1", status: "paid", amount: { currency: "GBP", value: "1.00" } };
    const spy = mollieReturns(paid, { id: "re_1", status: "pending" }, { ...paid, amountRefunded: { currency: "GBP", value: "1.00" } });
    const out = await svc.testPaymentStatus("t1", "b1", true);
    expect(callUrl(spy, 1)).toBe("https://api.mollie.com/v2/payments/tr_t1/refunds");
    expect(callBody(spy, 1)).toMatchObject({ testmode: true, amount: { value: "1.00" } });
    expect(out).toMatchObject({ status: "paid", refundStatus: "pending", amountRefunded: { value: "1.00" } });
  });
});

describe("MollieService onboarding", () => {
  it("builds a client link with our app id, a signed state and the scopes", async () => {
    const prisma = {
      brand: { findFirst: jest.fn().mockResolvedValue({ id: "b1", name: "Burger Co" }) },
      mollieConnection: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
    } as any;
    const svc = new MollieService(prisma, crypto, {} as any);
    const spy = mollieReturns({
      id: "cl_1",
      _links: { clientLink: { href: "https://my.mollie.com/dashboard/client-link/cl_1" } },
    });
    const out = await svc.createClientLink("t1", "b1", {
      email: "owner@burger.co",
      givenName: "Sam",
      familyName: "Lee",
      streetAndNumber: "1 High St",
      postalCode: "E1 1AA",
      city: "London",
    });
    expect(callInit(spy).headers.Authorization).toBe("Bearer access_platform");
    expect(callBody(spy)).toMatchObject({
      owner: { email: "owner@burger.co", givenName: "Sam", familyName: "Lee" },
      name: "Burger Co",
      address: { country: "GB", streetAndNumber: "1 High St", postalCode: "E1 1AA", city: "London" },
    });
    const url = new URL(out.url);
    expect(url.origin + url.pathname).toBe("https://my.mollie.com/dashboard/client-link/cl_1");
    expect(url.searchParams.get("client_id")).toBe("app_test123");
    expect(url.searchParams.get("scope")).toContain("payments.write");
    expect(verifyOAuthState(url.searchParams.get("state")!, "secret_abc")).toEqual({
      tenantId: "t1",
      brandId: "b1",
    });
  });

  it("sends a bad state back to the dashboard without exchanging anything", async () => {
    const spy = jest.spyOn(global, "fetch" as any);
    const svc = new MollieService({} as any, crypto, {} as any);
    const to = await svc.handleOAuthCallback({ code: "c", state: "forged.sig" });
    expect(to).toBe("https://web.example/dashboard/payments?mollie=error&reason=bad_state");
    expect(spy).not.toHaveBeenCalled();
  });
});
