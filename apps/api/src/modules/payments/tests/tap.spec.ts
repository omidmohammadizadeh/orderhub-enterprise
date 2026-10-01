import { createHmac } from "crypto";
import {
  TapService,
  tapHashString,
  signaturesMatch,
  commissionDestinations,
  onboardingSignature,
  merchantIdFromSignup,
  tapPlatformFromEnv,
  tapPlatformProblem,
} from "../tap.service";
import {
  paymentProviderForCountry,
  usesTap,
  toMinorUnits,
  fromMinorUnits,
  roundToCurrency,
} from "@orderhub/shared";

const KEY = "sk_test_pretend_key";

describe("paymentProviderForCountry", () => {
  it("keeps the UK and Ireland on Stripe", () => {
    expect(paymentProviderForCountry("GB")).toBe("STRIPE");
    expect(paymentProviderForCountry("IE")).toBe("STRIPE");
  });

  it("routes the six countries Tap actually serves to Tap", () => {
    for (const c of ["AE", "SA", "KW", "QA", "BH", "OM"]) {
      expect(usesTap(c)).toBe(true);
    }
  });

  it("does not route Egypt or Jordan to Tap", () => {
    // Both were in this list, taken from Tap's MENA marketing copy. Asked
    // directly, Tap said "Egypt is currently not supported" — they have a
    // Cairo office, which is what made the copy read the other way. A shop in
    // either was being sent to a provider that cannot onboard it.
    expect(usesTap("EG")).toBe(false);
    expect(usesTap("JO")).toBe(false);
  });

  it("falls back to Stripe for anywhere unlisted, including no country at all", () => {
    // Stripe is the proven path — a shop in an unlisted country getting it can
    // at least be onboarded by hand, whereas defaulting to Tap would hand it a
    // provider that cannot settle its currency.
    expect(paymentProviderForCountry("FR")).toBe("STRIPE");
    expect(paymentProviderForCountry(null)).toBe("STRIPE");
    expect(paymentProviderForCountry("")).toBe("STRIPE");
  });

  it("is case- and whitespace-insensitive, because country comes from a form", () => {
    expect(usesTap(" ae ")).toBe(true);
  });
});

describe("minor units", () => {
  it("handles the two-decimal currencies the old * 100 assumed", () => {
    expect(toMinorUnits(19.99, "GBP")).toBe(1999);
    expect(toMinorUnits(15, "AED")).toBe(1500);
  });

  it("gives the Gulf dinars their thousandths", () => {
    // The bug the helper exists for: 1.250 KWD is 1250 fils, not 125.
    expect(toMinorUnits(1.25, "KWD")).toBe(1250);
    expect(toMinorUnits(2.125, "OMR")).toBe(2125);
    expect(toMinorUnits(0.5, "BHD")).toBe(500);
  });

  it("rounds rather than truncating a float", () => {
    // 19.99 * 100 is 1998.9999999999998 in IEEE 754 — truncating loses a penny
    // on every single order.
    expect(toMinorUnits(19.99, "GBP")).not.toBe(1998);
    expect(fromMinorUnits(toMinorUnits(19.99, "GBP"), "GBP")).toBe(19.99);
  });

  it("rounds an amount to the places its currency actually has", () => {
    expect(roundToCurrency(10.005, "AED")).toBe(10.01);
    expect(roundToCurrency(1.2345, "KWD")).toBe(1.235);
  });
});

describe("tapHashString", () => {
  const charge = {
    id: "chg_TS123",
    amount: 15,
    currency: "AED",
    reference: { gateway: "gw_1", payment: "pay_1" },
    status: "CAPTURED",
    created: 1690000000000,
  };

  it("builds Tap's exact concatenation, with no separator between pairs", () => {
    expect(tapHashString(charge)).toBe(
      "x_idchg_TS123x_amount15.00x_currencyAEDx_gateway_referencegw_1x_payment_referencepay_1x_statusCAPTUREDx_created1690000000000",
    );
  });

  it("formats the amount to the currency's decimals, not to two", () => {
    // Tap signs "1.250" for a Kuwaiti dinar. Signing "1.25" doesn't mis-parse
    // — it just fails the comparison, so it reads as a rejected webhook rather
    // than as a formatting bug, which is why this is pinned.
    expect(tapHashString({ ...charge, amount: 1.25, currency: "KWD" })).toContain(
      "x_amount1.250",
    );
    expect(tapHashString({ ...charge, amount: 15, currency: "AED" })).toContain(
      "x_amount15.00",
    );
  });

  it("renders missing references as empty rather than as 'undefined'", () => {
    const out = tapHashString({ id: "chg_1", amount: 5, currency: "AED", status: "CAPTURED", created: 1 });
    expect(out).toContain("x_gateway_referencex_payment_reference");
    expect(out).not.toContain("undefined");
  });
});

describe("signaturesMatch", () => {
  it("accepts an identical signature and rejects a different one", () => {
    expect(signaturesMatch("abc123", "abc123")).toBe(true);
    expect(signaturesMatch("abc123", "abc124")).toBe(false);
  });

  it("rejects mismatched lengths without throwing", () => {
    // timingSafeEqual throws on unequal lengths; an exception here would be a
    // 500 on a public endpoint that anyone can post to.
    expect(() => signaturesMatch("abc", "abcdef")).not.toThrow();
    expect(signaturesMatch("abc", "abcdef")).toBe(false);
  });

  it("rejects empty signatures", () => {
    expect(signaturesMatch("", "")).toBe(false);
    expect(signaturesMatch("abc", "")).toBe(false);
  });
});

const PLATFORM_ENV = {
  TAP_COMMERCE_SECRET_KEY: KEY,
  TAP_COMMERCE_PLATFORM_ID: "commerce_platform_1",
  TAP_BILLING_SECRET_KEY: "sk_test_billing",
  TAP_BILLING_PLATFORM_ID: "billing_platform_1",
};
const WALLET = "wallet_ours";
const setEnv = (extra: Record<string, string> = {}) => {
  Object.assign(process.env, PLATFORM_ENV, { TAP_COMMISSION_DESTINATION_ID: WALLET }, extra);
};
const clearEnv = () => {
  for (const k of [
    ...Object.keys(PLATFORM_ENV),
    "TAP_COMMISSION_DESTINATION_ID",
    "TAP_APP_SECRET_KEY",
    "TAP_APP_PLATFORM_ID",
    "TAP_SECRET_KEY",
    "TAP_ONBOARDING_SECRET",
    "API_URL",
  ]) {
    delete process.env[k];
  }
};

describe("tapPlatformFromEnv", () => {
  it("needs BOTH the id and the key — half a platform is no platform", () => {
    expect(tapPlatformFromEnv("COMMERCE", { TAP_COMMERCE_SECRET_KEY: "k" } as any)).toBeNull();
    expect(tapPlatformFromEnv("COMMERCE", { TAP_COMMERCE_PLATFORM_ID: "p" } as any)).toBeNull();
    expect(
      tapPlatformFromEnv("COMMERCE", {
        TAP_COMMERCE_SECRET_KEY: " sk_test_k ",
        TAP_COMMERCE_PLATFORM_ID: " p ",
      } as any),
    ).toEqual({ kind: "COMMERCE", id: "p", secretKey: "sk_test_k" });
  });

  it("does not treat the old marketplace TAP_SECRET_KEY as the commerce platform", () => {
    // That key belonged to a different account type; charging with it would
    // route money as if we were the merchant.
    expect(tapPlatformFromEnv("COMMERCE", { TAP_SECRET_KEY: "sk_old" } as any)).toBeNull();
  });
});

describe("tapPlatformProblem", () => {
  // The 2026-10-01 outage: a key pasted from a masked display made fetch()
  // throw "Cannot convert argument to a ByteString" — a nameless 500.
  it("names a key copied from a masked display, and refuses to use it", () => {
    const env = { TAP_APP_SECRET_KEY: "sk_test_NLE•••gOPfvy", TAP_APP_PLATFORM_ID: "app_platform_1" } as any;
    expect(tapPlatformProblem("APP", env)).toMatch(/TAP_APP_SECRET_KEY.*masked/);
    expect(tapPlatformFromEnv("APP", env)).toBeNull();
  });

  it("names a half-configured platform and a key that isn't a Tap key", () => {
    expect(tapPlatformProblem("BILLING", { TAP_BILLING_SECRET_KEY: "sk_test_a" } as any)).toMatch(/TAP_BILLING_PLATFORM_ID is missing/);
    expect(tapPlatformProblem("BILLING", { TAP_BILLING_SECRET_KEY: "pk_test_a", TAP_BILLING_PLATFORM_ID: "b" } as any)).toMatch(/sk_test_/);
  });

  it("is quiet for an unset platform and a good one", () => {
    expect(tapPlatformProblem("APP", {} as any)).toBeNull();
    expect(tapPlatformProblem("APP", { TAP_APP_SECRET_KEY: "sk_test_Ab1", TAP_APP_PLATFORM_ID: "app_platform_1" } as any)).toBeNull();
  });
});

describe("TapService.status", () => {
  afterEach(clearEnv);
  it("reports each platform and the wallet without exposing a secret", () => {
    setEnv({ TAP_APP_SECRET_KEY: "sk_test_x•y", TAP_APP_PLATFORM_ID: "app_platform_1" });
    const out = new TapService({} as any, {} as any).status();
    expect(out.ready).toBe(true);
    expect(out.commissionWallet).toBe(true);
    expect(out.platforms.find((p) => p.kind === "COMMERCE")).toMatchObject({ configured: true, mode: "test", problem: null });
    expect(out.platforms.find((p) => p.kind === "APP")).toMatchObject({ configured: false });
    expect(out.platforms.find((p) => p.kind === "APP")!.problem).toMatch(/masked/);
    expect(JSON.stringify(out)).not.toContain("sk_test");
  });
});

describe("commissionDestinations", () => {
  it("pays OUR fee into our wallet; the rest stays with the brand's merchant", () => {
    // The Platform model inverts the Aug marketplace build: the charge lands on
    // the restaurant's merchant, and our commission is the destination.
    expect(
      commissionDestinations({ totalAmount: 102, platformFee: 9.75, currency: "AED", walletId: "w" }),
    ).toEqual([{ id: "w", amount: 9.75, currency: "AED" }]);
  });

  it("sends nothing when there is no fee, no wallet, or a fee that eats the order", () => {
    expect(commissionDestinations({ totalAmount: 40, platformFee: 0, currency: "AED", walletId: "w" })).toEqual([]);
    expect(commissionDestinations({ totalAmount: 40, platformFee: 4, currency: "AED", walletId: null })).toEqual([]);
    expect(commissionDestinations({ totalAmount: 5, platformFee: 5, currency: "AED", walletId: "w" })).toEqual([]);
    expect(commissionDestinations({ totalAmount: 5, platformFee: -1, currency: "AED", walletId: "w" })).toEqual([]);
  });

  it("rounds the fee to the currency's own decimals", () => {
    const [d] = commissionDestinations({ totalAmount: 10, platformFee: 1.2345, currency: "KWD", walletId: "w" });
    expect(d!.amount).toBe(1.235);
  });
});

describe("TapService.verifyWebhook", () => {
  const build = () => new TapService({} as any, {} as any);
  const charge = {
    id: "chg_1",
    amount: 15,
    currency: "AED",
    reference: { gateway: "g", payment: "p" },
    status: "CAPTURED",
    created: 123,
  };
  const sign = (o: any, key = KEY) =>
    createHmac("sha256", key).update(tapHashString(o)).digest("hex");

  beforeEach(() => setEnv());
  afterEach(clearEnv);

  it("accepts a body signed with any of our platform keys", () => {
    // Tap signs with the PLATFORM key, and the body doesn't say which platform.
    expect(build().verifyWebhook(charge, sign(charge))).toBe(true);
    expect(build().verifyWebhook(charge, sign(charge, "sk_test_billing"))).toBe(true);
  });

  it("rejects a body whose amount was tampered with after signing", () => {
    const signature = sign(charge);
    expect(build().verifyWebhook({ ...charge, amount: 1500 }, signature)).toBe(false);
  });

  it("rejects a signature from a key that isn't ours", () => {
    expect(build().verifyWebhook(charge, sign(charge, "sk_test_someone_else"))).toBe(false);
  });

  it("rejects a missing header outright", () => {
    expect(build().verifyWebhook(charge, undefined)).toBe(false);
  });

  it("rejects everything when no platform is configured", () => {
    clearEnv();
    expect(build().verifyWebhook(charge, sign(charge))).toBe(false);
  });
});

describe("TapService.settleCharge", () => {
  const build = (payment: any) => {
    const prisma = {
      payment: {
        findFirst: jest.fn().mockResolvedValue(payment),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as any;
    const payments = { confirmPaymentRow: jest.fn().mockResolvedValue({}) } as any;
    return { svc: new TapService(prisma, payments), prisma, payments };
  };
  const row = { id: "pay_1", tenantId: "t1", orderId: "o1", status: "PENDING" };

  it("settles a CAPTURED charge through the shared confirm path", () => {
    // Not a private reimplementation: the ledger writes, the PAID flip, the
    // board broadcast and auto-accept all have to happen identically to
    // Stripe's, or a paid Gulf order never reaches the kitchen.
    const { svc, payments } = build(row);
    return svc.settleCharge({ id: "chg_1", status: "CAPTURED" } as any).then(() => {
      expect(payments.confirmPaymentRow).toHaveBeenCalledWith("t1", row, "chg_1");
    });
  });

  it("does not re-settle a payment that already succeeded", async () => {
    // Tap retries its webhook on any non-2xx, so this runs more than once for
    // the same money.
    const { svc, payments } = build({ ...row, status: "SUCCEEDED" });
    await svc.settleCharge({ id: "chg_1", status: "CAPTURED" } as any);
    // confirmPaymentRow is itself idempotent, and is still the right call —
    // what must not happen is a second, provider-local ledger write here.
    expect(payments.confirmPaymentRow).toHaveBeenCalledTimes(1);
  });

  it.each(["FAILED", "DECLINED", "CANCELLED", "ABANDONED", "TIMEDOUT"])(
    "marks the payment failed on %s without touching the order",
    async (status) => {
      const { svc, prisma, payments } = build(row);
      await svc.settleCharge({ id: "chg_1", status } as any);
      expect(payments.confirmPaymentRow).not.toHaveBeenCalled();
      expect(prisma.payment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "FAILED" } }),
      );
    },
  );

  it("never downgrades a payment that already succeeded", async () => {
    // A late FAILED webhook after a CAPTURED one must not un-pay the order.
    const { svc, prisma } = build(row);
    await svc.settleCharge({ id: "chg_1", status: "FAILED" } as any);
    expect(prisma.payment.updateMany.mock.calls[0][0].where).toMatchObject({
      status: { not: "SUCCEEDED" },
    });
  });

  it("does nothing at all while the customer is still mid-payment", async () => {
    const { svc, prisma, payments } = build(row);
    await svc.settleCharge({ id: "chg_1", status: "IN_PROGRESS" } as any);
    expect(payments.confirmPaymentRow).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it("ignores a charge it has no payment row for", async () => {
    const { svc, payments } = build(null);
    await expect(
      svc.settleCharge({ id: "chg_unknown", status: "CAPTURED" } as any),
    ).resolves.toBeUndefined();
    expect(payments.confirmPaymentRow).not.toHaveBeenCalled();
  });
});

describe("TapService.createCharge", () => {
  const order = (brand: any) => ({
    id: "o1",
    displayId: "AB12",
    total: 100,
    locationId: "loc1",
    location: { id: "loc1", name: "Shawarma Co", country: "AE", currency: "AED" },
    brand,
  });
  const build = (brand: any) => {
    const prisma = {
      order: { findFirst: jest.fn().mockResolvedValue(order(brand)) },
      payment: { create: jest.fn().mockResolvedValue({}) },
    } as any;
    return { svc: new TapService(prisma, {} as any), prisma };
  };
  const tapReturns = (charge: any) =>
    jest.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(charge),
    } as any);
  const sent = (fetchMock: jest.SpyInstance) =>
    JSON.parse((fetchMock.mock.calls[0]![1] as any).body);

  beforeEach(() => setEnv());
  afterEach(() => {
    clearEnv();
    jest.restoreAllMocks();
  });

  const args = {
    tenantId: "t1",
    orderId: "o1",
    redirectUrl: "https://shop.example/confirm",
    webhookUrl: "https://api.example/v1/payments/tap/webhook",
    customer: { firstName: "Omar", email: "o@example.com" },
  };
  const feeBrand = {
    id: "b1",
    name: "Shawarma Co",
    tapMerchantId: "merchant_9",
    applicationFeeMode: "fixed_and_percentage",
    applicationFeePercentage: 7.75,
    applicationFeeFixedAmount: 2,
  };

  it("refuses to charge a brand with no Tap merchant", async () => {
    const { svc } = build({ id: "b1", name: "Shawarma Co", tapMerchantId: null });
    await expect(svc.createCharge(args)).rejects.toThrow(/Tap onboarding/i);
  });

  it("charges ON the brand's merchant, under our commerce platform, with the platform key", async () => {
    const { svc } = build(feeBrand);
    const fetchMock = tapReturns({ id: "chg_1", status: "INITIATED", transaction: { url: "u" } });
    await svc.createCharge(args);
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("https://api.tap.company/v2/charges");
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    const body = sent(fetchMock);
    expect(body.platform).toEqual({ id: "commerce_platform_1" });
    expect(body.merchant).toEqual({ id: "merchant_9" });
  });

  it("adds the FIXED fee to the bill and sends our whole cut to our wallet", async () => {
    // 7.75% + AED 2 on a 100 basket → customer charged 102, our wallet gets
    // 9.75, the restaurant's merchant keeps 92.25 — same rule as the UK.
    const { svc, prisma } = build(feeBrand);
    const fetchMock = tapReturns({ id: "chg_s", status: "INITIATED", transaction: { url: "u" } });
    const out = await svc.createCharge(args);
    const body = sent(fetchMock);
    expect(body.amount).toBe(102);
    expect(body.destinations.destination).toEqual([{ id: WALLET, amount: 9.75, currency: "AED" }]);
    expect(body.description).toContain("2.00 service charge");
    expect(out.amount).toBe(102);
    const row = prisma.payment.create.mock.calls[0][0].data;
    expect(row).toMatchObject({ amount: 102, platformFee: 9.75, netAmount: 92.25, provider: "TAP" });
    expect(row.metadata).toMatchObject({ tapMerchantId: "merchant_9", tapPlatform: "COMMERCE" });
  });

  it("adds nothing to the bill in percentage_only mode", async () => {
    const { svc } = build({ ...feeBrand, applicationFeeMode: "percentage_only" });
    const fetchMock = tapReturns({ id: "chg_p", status: "INITIATED", transaction: { url: "u" } });
    await svc.createCharge(args);
    const body = sent(fetchMock);
    expect(body.amount).toBe(100);
    expect(body.destinations.destination[0].amount).toBe(7.75);
    expect(body.description).not.toContain("service charge");
  });

  it("takes no fee at all — not even the surcharge — when our wallet isn't configured", async () => {
    // Without a wallet the fee has nowhere to go. Surcharging the customer
    // anyway would hand the restaurant money the customer was told was ours.
    delete process.env.TAP_COMMISSION_DESTINATION_ID;
    const { svc, prisma } = build(feeBrand);
    const fetchMock = tapReturns({ id: "chg_n", status: "INITIATED", transaction: { url: "u" } });
    await svc.createCharge(args);
    const body = sent(fetchMock);
    expect(body.amount).toBe(100);
    expect(body.destinations).toBeUndefined();
    expect(prisma.payment.create.mock.calls[0][0].data.platformFee).toBe(0);
  });

  it("refuses when the commerce platform isn't configured", async () => {
    clearEnv();
    const { svc } = build(feeBrand);
    await expect(svc.createCharge(args)).rejects.toThrow(/aren't configured/i);
  });

  it("sends the currency, the order's own reference and the webhook", async () => {
    const { svc } = build({ ...feeBrand, applicationFeeMode: "none" });
    const fetchMock = tapReturns({
      id: "chg_1",
      status: "INITIATED",
      transaction: { url: "https://checkout.tap.company/chg_1" },
    });
    const out = await svc.createCharge(args);
    expect(out).toMatchObject({ chargeId: "chg_1", redirectUrl: "https://checkout.tap.company/chg_1", currency: "AED" });
    const body = sent(fetchMock);
    expect(body.currency).toBe("AED");
    expect(body.reference.idempotent).toBe("ord_o1");
    expect(body.post.url).toBe(args.webhookUrl);
    expect(body.threeDSecure).toBe(true);
  });

  it("fails loudly when Tap returns a charge with no hosted URL", async () => {
    const { svc } = build({ ...feeBrand, applicationFeeMode: "none" });
    tapReturns({ id: "chg_3", status: "INITIATED" });
    await expect(svc.createCharge(args)).rejects.toThrow(/couldn't be started/i);
  });

  it("surfaces Tap's own error description rather than a generic failure", async () => {
    const { svc } = build({ ...feeBrand, applicationFeeMode: "none" });
    jest.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ errors: [{ code: "2107", description: "Invalid merchant" }] }),
    } as any);
    await expect(svc.createCharge(args)).rejects.toThrow("Invalid merchant");
  });
});

describe("TapService.refundOrder", () => {
  beforeEach(() => setEnv());
  afterEach(() => {
    clearEnv();
    jest.restoreAllMocks();
  });

  it("refunds with the platform key the charge was taken with, and keeps our commission", async () => {
    // Same as a UK Stripe refund (no refund_application_fee): the merchant
    // funds it, so no destination goes out.
    const payment = {
      id: "p1",
      providerChargeId: "chg_1",
      amount: 102,
      currency: "aed",
      metadata: { tapPlatform: "BILLING" },
    };
    const prisma = {
      payment: { findFirst: jest.fn().mockResolvedValue(payment), update: jest.fn() },
      order: { update: jest.fn() },
    } as any;
    const fetchMock = jest.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "re_1", status: "REFUNDED" }),
    } as any);
    await new TapService(prisma, {} as any).refundOrder("o1");
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("https://api.tap.company/v2/refunds");
    expect(init.headers.Authorization).toBe("Bearer sk_test_billing");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ charge_id: "chg_1", amount: 102, currency: "AED" });
    expect(body.destinations).toBeUndefined();
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { paymentStatus: "REFUNDED" } }),
    );
  });
});

describe("Tap onboarding", () => {
  beforeEach(() => setEnv({ API_URL: "https://api.example" }));
  afterEach(() => {
    clearEnv();
    jest.restoreAllMocks();
  });

  it("signs the webhook URL per brand, so one brand's URL can't set another's merchant", () => {
    const svc = new TapService({} as any, {} as any);
    const url = svc.onboardingWebhookUrl("brand_a");
    const sig = url.split("/").pop()!;
    expect(url).toBe(`https://api.example/v1/payments/tap/onboarding/brand_a/${sig}`);
    expect(svc.verifyOnboardingSignature("brand_a", sig)).toBe(true);
    expect(svc.verifyOnboardingSignature("brand_b", sig)).toBe(false);
    expect(svc.verifyOnboardingSignature("brand_a", "nope")).toBe(false);
    expect(sig).toBe(onboardingSignature("brand_a", KEY));
  });

  it("reads the merchant id from either documented webhook shape, and nothing else", () => {
    expect(merchantIdFromSignup({ id: "merchant_rERh10", object: "merchant" })).toBe("merchant_rERh10");
    expect(merchantIdFromSignup({ merchant: { id: "merchant_x1" }, board: {} })).toBe("merchant_x1");
    expect(merchantIdFromSignup({ id: "led_123" })).toBeNull();
    expect(merchantIdFromSignup({ id: "merchant_x; drop" })).toBeNull();
    expect(merchantIdFromSignup(null)).toBeNull();
  });

  const brandRow = (over: any = {}) => ({
    id: "b1",
    tenantId: "t1",
    name: "Shawarma Co",
    country: "AE",
    tapMerchantId: null,
    tapLeadId: null,
    ...over,
  });

  it("creates a lead listing every platform, then a Connect link, and saves both", async () => {
    const prisma = {
      brand: {
        findFirst: jest.fn().mockResolvedValue(brandRow()),
        update: jest.fn().mockResolvedValue({}),
      },
    } as any;
    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ id: "led_1" }) } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ connect: { url: "https://connect.tap/x" } }),
      } as any);

    const out = await new TapService(prisma, {} as any).startOnboarding("t1", "b1");
    expect(out).toEqual({ connectUrl: "https://connect.tap/x", leadId: "led_1", status: "link_sent" });

    const [leadUrl, leadInit] = fetchMock.mock.calls[0] as any;
    expect(leadUrl).toBe("https://api.tap.company/v3/lead");
    const lead = JSON.parse(leadInit.body);
    expect(lead.country).toBe("AE");
    expect(lead.merchant.platforms).toEqual([{ id: "commerce_platform_1" }, { id: "billing_platform_1" }]);
    expect(lead.metadata).toEqual({ brandId: "b1", tenantId: "t1" });

    const [connUrl, connInit] = fetchMock.mock.calls[1] as any;
    expect(connUrl).toBe("https://api.tap.company/v3/connect");
    const conn = JSON.parse(connInit.body);
    expect(conn.lead).toEqual({ id: "led_1" });
    expect(conn.post.url).toMatch(/^https:\/\/api\.example\/v1\/payments\/tap\/onboarding\/b1\/[0-9a-f]{64}$/);

    expect(prisma.brand.update).toHaveBeenCalledWith({
      where: { id: "b1" },
      data: { tapLeadId: "led_1", tapConnectUrl: "https://connect.tap/x", tapOnboardingStatus: "link_sent" },
    });
  });

  it("falls through to another platform's key when one is refused", async () => {
    // Seen in the sandbox: the same lead call refused by one platform key
    // (2109 Api_key_unauthorised) and accepted by another.
    const prisma = {
      brand: { findFirst: jest.fn().mockResolvedValue(brandRow()), update: jest.fn() },
    } as any;
    const fetchMock = jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ errors: [{ code: "2109", description: "Api key is unauthorized" }] }),
      } as any)
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ id: "led_2" }) } as any)
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ connect: { url: "c" } }) } as any);
    const out = await new TapService(prisma, {} as any).startOnboarding("t1", "b1");
    expect(out.leadId).toBe("led_2");
    expect((fetchMock.mock.calls[1] as any)[1].headers.Authorization).toBe("Bearer sk_test_billing");
  });

  it("refuses by variable name when a platform key is broken, instead of a nameless 500", async () => {
    process.env.TAP_APP_SECRET_KEY = "sk_test_NLE•••x";
    process.env.TAP_APP_PLATFORM_ID = "app_platform_1";
    const prisma = { brand: { findFirst: jest.fn().mockResolvedValue(brandRow()), update: jest.fn() } } as any;
    const fetchMock = jest.spyOn(global, "fetch" as any);
    await expect(new TapService(prisma, {} as any).startOnboarding("t1", "b1")).rejects.toThrow(/TAP_APP_SECRET_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns a fetch that never reached Tap into a readable error", async () => {
    const prisma = { brand: { findFirst: jest.fn().mockResolvedValue(brandRow()), update: jest.fn() } } as any;
    jest.spyOn(global, "fetch" as any).mockRejectedValue(new TypeError("fetch failed"));
    await expect(new TapService(prisma, {} as any).startOnboarding("t1", "b1")).rejects.toThrow(/Couldn't reach Tap/);
  });

  it("won't start onboarding for a brand that already has a merchant", async () => {
    const prisma = { brand: { findFirst: jest.fn().mockResolvedValue(brandRow({ tapMerchantId: "merchant_1" })) } } as any;
    await expect(new TapService(prisma, {} as any).startOnboarding("t1", "b1")).rejects.toThrow(/already has/i);
  });

  it("completes onboarding with the merchant id and never stores Tap's API credentials", async () => {
    const prisma = {
      brand: { findFirst: jest.fn().mockResolvedValue(brandRow()), update: jest.fn() },
    } as any;
    const ok = await new TapService(prisma, {} as any).completeOnboarding("b1", {
      id: "merchant_new1",
      object: "merchant",
      operator: { api_credentials: { live: { secret: "sk_live_theirs" } } },
    });
    expect(ok).toBe(true);
    const data = prisma.brand.update.mock.calls[0][0].data;
    expect(data).toEqual({ tapMerchantId: "merchant_new1", tapOnboardingStatus: "completed" });
    expect(JSON.stringify(data)).not.toContain("sk_live");
  });

  it("never moves a trading brand to a different merchant", async () => {
    const prisma = {
      brand: { findFirst: jest.fn().mockResolvedValue(brandRow({ tapMerchantId: "merchant_old" })), update: jest.fn() },
    } as any;
    const ok = await new TapService(prisma, {} as any).completeOnboarding("b1", { id: "merchant_other" });
    expect(ok).toBe(false);
    expect(prisma.brand.update).not.toHaveBeenCalled();
  });

  it("refuses a post whose echoed metadata names a different brand", async () => {
    const prisma = { brand: { findFirst: jest.fn(), update: jest.fn() } } as any;
    const ok = await new TapService(prisma, {} as any).completeOnboarding("b1", {
      id: "merchant_x",
      metadata: { brandId: "b2" },
    });
    expect(ok).toBe(false);
    expect(prisma.brand.update).not.toHaveBeenCalled();
  });

  it("rejects a hand-typed id that isn't a merchant id", async () => {
    const prisma = { brand: { findFirst: jest.fn().mockResolvedValue(brandRow()), update: jest.fn() } } as any;
    await expect(
      new TapService(prisma, {} as any).setMerchantId("t1", "b1", "led_123"),
    ).rejects.toThrow(/merchant_/);
    await expect(
      new TapService(prisma, {} as any).setMerchantId("t1", "b1", " merchant_ok1 "),
    ).resolves.toEqual({ tapMerchantId: "merchant_ok1", tapOnboardingStatus: "completed" });
  });
});
