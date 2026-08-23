import { createHmac } from "crypto";
import {
  TapService,
  tapHashString,
  signaturesMatch,
  splitForDestination,
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

  it("routes the Gulf to Tap", () => {
    for (const c of ["AE", "SA", "KW", "QA", "BH", "OM"]) {
      expect(usesTap(c)).toBe(true);
    }
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

describe("splitForDestination", () => {
  it("pays the merchant total-minus-fee and leaves our cut as the remainder", () => {
    // Tap inverts Stripe: the charge lands on the MARKETPLACE and the
    // destinations name each business's share, with whatever is left over
    // staying with us. Naming our own fee as a second destination would try to
    // pay the marketplace out of its own charge.
    expect(
      splitForDestination({
        totalAmount: 100,
        platformFee: 7.5,
        currency: "AED",
        destinationId: "dst_1",
      }),
    ).toEqual([{ id: "dst_1", amount: 92.5, currency: "AED" }]);
  });

  it("gives the merchant the whole amount when there is no platform fee", () => {
    expect(
      splitForDestination({
        totalAmount: 40,
        platformFee: 0,
        currency: "AED",
        destinationId: "dst_1",
      }),
    ).toEqual([{ id: "dst_1", amount: 40, currency: "AED" }]);
  });

  it("rounds the merchant's share to the currency's own decimals", () => {
    const [split] = splitForDestination({
      totalAmount: 10,
      platformFee: 1.2345,
      currency: "KWD",
      destinationId: "dst_1",
    });
    expect(split!.amount).toBe(8.765);
  });

  it("splits nothing rather than sending a zero or negative destination", () => {
    // A fee that swallows the order is a misconfiguration. Sending 0 would
    // either be rejected by Tap or silently pay the merchant nothing, and
    // mid-checkout is not the place to guess which was meant.
    expect(
      splitForDestination({ totalAmount: 5, platformFee: 5, currency: "AED", destinationId: "d" }),
    ).toEqual([]);
    expect(
      splitForDestination({ totalAmount: 5, platformFee: 9, currency: "AED", destinationId: "d" }),
    ).toEqual([]);
  });

  it("treats a negative fee as zero rather than paying out more than was taken", () => {
    expect(
      splitForDestination({ totalAmount: 20, platformFee: -5, currency: "AED", destinationId: "d" }),
    ).toEqual([{ id: "d", amount: 20, currency: "AED" }]);
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

  beforeEach(() => {
    process.env.TAP_SECRET_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.TAP_SECRET_KEY;
  });

  it("accepts a body signed with our secret key", () => {
    expect(build().verifyWebhook(charge, sign(charge))).toBe(true);
  });

  it("rejects a body whose amount was tampered with after signing", () => {
    // The attack this endpoint is exposed to: it is public, so an unsigned
    // CAPTURED charge posted here would otherwise mark any order paid.
    const signature = sign(charge);
    expect(build().verifyWebhook({ ...charge, amount: 1500 }, signature)).toBe(false);
  });

  it("rejects a signature from the wrong key", () => {
    expect(build().verifyWebhook(charge, sign(charge, "sk_test_someone_else"))).toBe(false);
  });

  it("rejects a missing header outright", () => {
    expect(build().verifyWebhook(charge, undefined)).toBe(false);
  });

  it("rejects everything when no key is configured", () => {
    delete process.env.TAP_SECRET_KEY;
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
    return new TapService(prisma, {} as any);
  };

  beforeEach(() => {
    process.env.TAP_SECRET_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.TAP_SECRET_KEY;
    jest.restoreAllMocks();
  });

  const args = {
    tenantId: "t1",
    orderId: "o1",
    redirectUrl: "https://shop.example/confirm",
    webhookUrl: "https://api.example/v1/payments/tap/webhook",
    customer: { firstName: "Omar", email: "o@example.com" },
  };

  it("refuses to charge a brand with no Tap destination", async () => {
    // The money would otherwise land in the marketplace balance with nothing
    // naming the merchant — we would have taken a customer's payment with no
    // route for the shop ever to be paid it.
    const svc = build({ id: "b1", name: "Shawarma Co", tapDestinationId: null });
    await expect(svc.createCharge(args)).rejects.toThrow(/Tap onboarding/i);
  });

  it("adds the FIXED fee to the customer's bill and takes the percentage from the shop", async () => {
    // The rule the UK already uses (computeFeeBreakdownPence): fixed is a
    // visible surcharge on top, percentage is silent out of the restaurant's
    // share. 7.75% + AED 2 on a 100 basket → customer charged 102, we keep
    // 9.75, shop gets 92.25. Folding the fixed part into the fee WITHOUT
    // adding it to the charge would quietly take it out of the restaurant,
    // which is the opposite of what the setting means.
    const svc = build({
      id: "b1",
      name: "Shawarma Co",
      tapDestinationId: "dst_9",
      applicationFeeMode: "fixed_and_percentage",
      applicationFeePercentage: 7.75,
      applicationFeeFixedAmount: 2,
    });
    const fetchMock = jest.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ id: "chg_s", status: "INITIATED", transaction: { url: "u" } }),
    } as any);

    const out = await svc.createCharge(args);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as any).body);

    expect(body.amount).toBe(102);
    expect(body.destinations.destination).toEqual([
      { id: "dst_9", amount: 92.25, currency: "AED" },
    ]);
    // Our remainder: 102 charged − 92.25 to the shop.
    expect(roundToCurrency(102 - 92.25, "AED")).toBe(9.75);
    expect(out.amount).toBe(102);
    // The customer can only see why they're paying 102 from the description —
    // a charge has no line items the way a Stripe session does.
    expect(body.description).toContain("2.00 service charge");
  });

  it("adds nothing to the bill in percentage_only mode", async () => {
    const svc = build({
      id: "b1",
      name: "S",
      tapDestinationId: "dst_9",
      applicationFeeMode: "percentage_only",
      applicationFeePercentage: 7.75,
      applicationFeeFixedAmount: 2,
    });
    const fetchMock = jest.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ id: "chg_p", status: "INITIATED", transaction: { url: "u" } }),
    } as any);
    await svc.createCharge(args);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as any).body);
    // Fixed amount is set but the mode doesn't use it — the customer pays the
    // basket and the whole fee comes out of the shop.
    expect(body.amount).toBe(100);
    expect(body.destinations.destination[0].amount).toBe(92.25);
    expect(body.description).not.toContain("service charge");
  });

  it("surcharges the whole fee in fixed_only mode", async () => {
    const svc = build({
      id: "b1",
      name: "S",
      tapDestinationId: "dst_9",
      applicationFeeMode: "fixed_only",
      applicationFeeFixedAmount: 2,
      applicationFeePercentage: 7.75,
    });
    const fetchMock = jest.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ id: "chg_f", status: "INITIATED", transaction: { url: "u" } }),
    } as any);
    await svc.createCharge(args);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as any).body);
    // Customer pays 102, shop still gets its full 100 — the fee was entirely
    // the customer's surcharge.
    expect(body.amount).toBe(102);
    expect(body.destinations.destination[0].amount).toBe(100);
  });

  it("sends the split, the currency and the order's own reference", async () => {
    const svc = build({
      id: "b1",
      name: "Shawarma Co",
      tapDestinationId: "dst_9",
      applicationFeeMode: "percentage_only",
      applicationFeePercentage: 10,
    });
    const fetchMock = jest.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: "chg_1",
          status: "INITIATED",
          transaction: { url: "https://checkout.tap.company/chg_1" },
        }),
    } as any);

    const out = await svc.createCharge(args);
    expect(out).toMatchObject({
      chargeId: "chg_1",
      redirectUrl: "https://checkout.tap.company/chg_1",
      currency: "AED",
    });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as any).body);
    expect(body.currency).toBe("AED");
    expect(body.amount).toBe(100);
    // 10% fee → merchant gets 90, we keep the 10 as Tap's automatic remainder.
    expect(body.destinations.destination).toEqual([
      { id: "dst_9", amount: 90, currency: "AED" },
    ]);
    // Idempotency is what stops a double-tapped Pay button becoming two
    // charges — Tap dedupes on it, we don't.
    expect(body.reference.idempotent).toBe("ord_o1");
    expect(body.post.url).toBe(args.webhookUrl);
    expect(body.threeDSecure).toBe(true);
  });

  it("prices in the shop's currency, not sterling", async () => {
    const svc = build({ id: "b1", name: "S", tapDestinationId: "dst_9", applicationFeeMode: "none" });
    const fetchMock = jest.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ id: "chg_2", status: "INITIATED", transaction: { url: "u" } }),
    } as any);
    await svc.createCharge(args);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as any).body);
    expect(body.currency).toBe("AED");
    expect(body.currency).not.toBe("GBP");
  });

  it("fails loudly when Tap returns a charge with no hosted URL", async () => {
    // Redirecting the customer to `undefined` would look to them like the shop
    // is broken and to us like a successful charge.
    const svc = build({ id: "b1", name: "S", tapDestinationId: "dst_9", applicationFeeMode: "none" });
    jest.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "chg_3", status: "INITIATED" }),
    } as any);
    await expect(svc.createCharge(args)).rejects.toThrow(/couldn't be started/i);
  });

  it("surfaces Tap's own error description rather than a generic failure", async () => {
    const svc = build({ id: "b1", name: "S", tapDestinationId: "dst_9", applicationFeeMode: "none" });
    jest.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ errors: [{ code: "2107", description: "Invalid destination id" }] }),
    } as any);
    await expect(svc.createCharge(args)).rejects.toThrow("Invalid destination id");
  });
});
