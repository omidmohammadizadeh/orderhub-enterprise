// @nestjs/event-emitter isn't installed in the local worktree test env (it is
// in the deployed build). PaymentsService imports it at module load; stub it.
jest.mock(
  "@nestjs/event-emitter",
  () => ({ EventEmitter2: class {}, OnEvent: () => () => undefined }),
  { virtual: true },
);

import { TerminalService } from "../terminal.service";

// Stripe Terminal (S700 / WisePad 3 / Tap to Pay) charge flow — card-present
// PaymentIntent created as a DIRECT charge on the connected account (the
// {stripeAccount} request option, not on_behalf_of/transfer_data), with the
// platform application fee, pushed to the reader, then settled to PAID.
// Direct charges mean Stripe's own processing fee is paid by the restaurant,
// same as online orders — see terminal.service.ts's file-header comment.

function makeService(opts: {
  order?: any;
  location?: any;
  connect?: any;
  feePence?: number;
  testKey?: boolean;
  withTestKey?: boolean;
  paidParts?: Array<{ amount: number }>;
  payment?: any;
}) {
  const order = opts.order ?? {
    id: "ord-1",
    tenantId: "t-1",
    locationId: "loc-1",
    brandId: "brand-1",
    total: 24.5,
    paymentStatus: "PENDING",
  };
  const location = opts.location ?? {
    id: "loc-1",
    name: "Pizza Uno",
    address: { line1: "1 High St", city: "London", postcode: "SW1A 1AA", country: "GB" },
    settings: {
      terminal: {
        stripeLocationId: "tml_1",
        readers: [
          { id: "tmr_sim", label: "Sim", deviceType: "simulated_wisepos_e", simulated: true, addedAt: "x" },
          {
            id: "tmr_real",
            label: "Counter",
            deviceType: "stripe_s700",
            simulated: false,
            addedAt: "x",
            // Direct charges: the reader is fixed to the account it was
            // registered on — chargeOrder reads THIS, not resolveConnectAccount.
            stripeAccountId: "acct_shop",
          },
        ],
      },
    },
  };

  const paymentCreate = jest.fn().mockResolvedValue({ id: "pay-1" });
  // Split bills read back the parts already banked to work out what's
  // still owed; default to "nothing paid yet".
  const paymentFindMany = jest
    .fn()
    .mockResolvedValue(opts.paidParts ?? []);
  const paymentFindFirst = jest.fn().mockResolvedValue(opts.payment ?? null);
  const prisma = {
    order: { findFirst: jest.fn().mockResolvedValue(order) },
    location: {
      findFirst: jest.fn().mockResolvedValue(location),
      update: jest.fn().mockResolvedValue({}),
    },
    payment: { create: paymentCreate, findMany: paymentFindMany, findFirst: paymentFindFirst },
  } as any;

  const config = {
    get: (k: string) => {
      if (k === "STRIPE_SECRET_KEY") return opts.testKey === false ? "sk_live_x" : "sk_test_x";
      if (k === "STRIPE_TEST_SECRET_KEY") return opts.withTestKey ? "sk_test_y" : undefined;
      return undefined;
    },
  } as any;

  const payments = {
    resolveConnectAccount: jest
      .fn()
      .mockResolvedValue("connect" in opts ? opts.connect : { id: null, stripeAccountId: "acct_shop" }),
    applicationFeePenceForBasket: jest.fn().mockResolvedValue(opts.feePence ?? 75),
    settleTerminalPi: jest.fn().mockResolvedValue(undefined),
    stripeAccountForPayment: jest.fn().mockResolvedValue(opts.payment ? "acct_shop" : null),
  } as any;

  const svc = new TerminalService(config, prisma, payments);

  const stripe = {
    paymentIntents: {
      create: jest.fn().mockResolvedValue({ id: "pi_1", status: "requires_payment_method" }),
      retrieve: jest.fn(),
    },
    terminal: {
      readers: {
        processPaymentIntent: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({
          id: "tmr_new",
          label: "Simulated reader",
          device_type: "simulated_wisepos_e",
        }),
      },
      locations: { create: jest.fn().mockResolvedValue({ id: "tml_test" }) },
      connectionTokens: { create: jest.fn().mockResolvedValue({ secret: "ct_secret_1" }) },
    },
    testHelpers: { terminal: { readers: { presentPaymentMethod: jest.fn().mockResolvedValue({}) } } },
  };
  (svc as any).stripe = stripe;
  // stripeTest aliases the main client at construction; re-point it at the
  // mock too (unless the scenario wants it absent — live key, no test key).
  if ((svc as any).stripeTest) (svc as any).stripeTest = stripe;
  return { svc, stripe, prisma, payments, paymentCreate };
}

describe("TerminalService.chargeOrder", () => {
  it("creates a card_present PI as a DIRECT charge on the reader's own account + application fee, and pushes it to the reader", async () => {
    const { svc, stripe, paymentCreate } = makeService({});
    const out = await svc.chargeOrder({ tenantId: "t-1", orderId: "ord-1", readerId: "tmr_real" });

    const call = stripe.paymentIntents.create.mock.calls[0];
    const pi = call[0];
    expect(pi).toMatchObject({
      amount: 2450,
      currency: "gbp",
      payment_method_types: ["card_present"],
      capture_method: "automatic",
      application_fee_amount: 75,
    });
    // Direct charge: stripeAccount is a REQUEST OPTION, not on_behalf_of/transfer_data.
    expect(pi.on_behalf_of).toBeUndefined();
    expect(pi.transfer_data).toBeUndefined();
    expect(call[1]).toEqual({ stripeAccount: "acct_shop" });
    expect(pi.metadata).toMatchObject({ orderId: "ord-1", source: "terminal" });

    expect(stripe.terminal.readers.processPaymentIntent).toHaveBeenCalledWith(
      "tmr_real",
      { payment_intent: "pi_1" },
      { stripeAccount: "acct_shop" },
    );
    expect(paymentCreate).toHaveBeenCalled();
    expect(out).toMatchObject({ paymentIntentId: "pi_1", readerId: "tmr_real", simulated: false });
  });

  it("charges without Connect routing when the reader has no stored account", async () => {
    // A reader registered before any Connect account existed for the
    // location — chargeOrder reads the READER's own account, not
    // resolveConnectAccount, so this is what actually gates routing.
    const location = {
      id: "loc-1",
      name: "Pizza Uno",
      address: { line1: "1 High St", city: "London", postcode: "SW1A 1AA", country: "GB" },
      settings: {
        terminal: {
          stripeLocationId: "tml_1",
          readers: [
            { id: "tmr_real", label: "Counter", deviceType: "stripe_s700", simulated: false, addedAt: "x" },
          ],
        },
      },
    };
    const { svc, stripe } = makeService({ location });
    await svc.chargeOrder({ tenantId: "t-1", orderId: "ord-1", readerId: "tmr_real" });
    const call = stripe.paymentIntents.create.mock.calls[0];
    expect(call[0].application_fee_amount).toBeUndefined();
    expect(call[1]).toBeUndefined();
  });

  it("simulated reader (test drive): charges on the TEST client, SKIPS Connect routing, tags testDrive", async () => {
    // Live connected accounts don't exist in Stripe test mode, so routing a
    // simulated charge to one would throw "No such account".
    const { svc, stripe, payments } = makeService({});
    const out = await svc.chargeOrder({ tenantId: "t-1", orderId: "ord-1", readerId: "tmr_sim" });
    const call = stripe.paymentIntents.create.mock.calls[0];
    expect(call[0].application_fee_amount).toBeUndefined();
    expect(call[1]).toBeUndefined();
    expect(call[0].metadata.testDrive).toBe("1");
    expect(payments.resolveConnectAccount).not.toHaveBeenCalled();
    expect(out).toMatchObject({ readerId: "tmr_sim", simulated: true });
  });

  it("rejects an already-paid order", async () => {
    const { svc } = makeService({ order: { id: "o", tenantId: "t-1", locationId: "loc-1", brandId: null, total: 5, paymentStatus: "PAID" } });
    await expect(
      svc.chargeOrder({ tenantId: "t-1", orderId: "o", readerId: "tmr_sim" }),
    ).rejects.toThrow(/already paid/i);
  });

  it("rejects a reader not registered at the order's location", async () => {
    const { svc } = makeService({});
    await expect(
      svc.chargeOrder({ tenantId: "t-1", orderId: "ord-1", readerId: "tmr_other" }),
    ).rejects.toThrow(/not registered/i);
  });
});

// Regression: a Stripe Terminal Location created BEFORE the direct-charge
// migration lives on the platform account. If ensureStripeLocation kept
// reusing that cached id once a connected account exists, the SDK would be
// handed a Location on a DIFFERENT account than its connection token and
// PaymentIntent — which is exactly the "No such payment_intent" failure
// this pins against (self-heals with no manual data cleanup required).
describe("TerminalService.createConnectionToken — stale pre-migration Location", () => {
  it("creates a FRESH Location on the connected account instead of reusing a platform-scoped one", async () => {
    // The default mock location has stripeLocationId: "tml_1" with NO
    // stripeLocationAccountId — exactly what a pre-migration config looks
    // like (the field didn't exist yet, so it reads back as null/platform).
    const { svc, stripe, prisma } = makeService({});
    const out = await svc.createConnectionToken("t-1", "loc-1", false);

    // A NEW location was created on the connected account — "tml_1" was NOT reused.
    expect(stripe.terminal.locations.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { orderhubLocationId: "loc-1" } }),
      { stripeAccount: "acct_shop" },
    );
    expect(out.stripeLocationId).toBe("tml_test"); // the mock's created-location id, not "tml_1"

    // The connection token itself is also scoped to the connected account.
    expect(stripe.terminal.connectionTokens.create).toHaveBeenCalledWith(
      {},
      { stripeAccount: "acct_shop" },
    );

    // The new Location's owning account is persisted, so a LATER call with
    // the SAME account correctly reuses it instead of creating yet another one.
    const saved = prisma.location.update.mock.calls[0][0].data.settings.terminal;
    expect(saved.stripeLocationId).toBe("tml_test");
    expect(saved.stripeLocationAccountId).toBe("acct_shop");
  });

  it("reuses the stored Location once its recorded account matches what's resolved now", async () => {
    const location = {
      id: "loc-1",
      name: "Pizza Uno",
      address: { line1: "1 High St", city: "London", postcode: "SW1A 1AA", country: "GB" },
      settings: {
        terminal: {
          stripeLocationId: "tml_migrated",
          stripeLocationAccountId: "acct_shop", // already migrated
          readers: [],
        },
      },
    };
    const { svc, stripe } = makeService({ location });
    const out = await svc.createConnectionToken("t-1", "loc-1", false);
    expect(stripe.terminal.locations.create).not.toHaveBeenCalled();
    expect(out.stripeLocationId).toBe("tml_migrated");
  });
});

// Regression: the connection token the SDK actually uses (fetched via
// createConnectionToken, incl. the SDK's OWN internal refetches — see
// terminal.ts's fetchConnectionToken) must resolve the SAME account as the
// PaymentIntent createMobileCharge creates for that SAME order, or the SDK
// session and the PI it confirms end up on two different connected accounts
// — a real payment landed on the wrong restaurant's Stripe account before
// this was pinned.
describe("TerminalService.createConnectionToken — brandId resolution via orderId", () => {
  it("looks up the order and resolves the connect account WITH its brandId", async () => {
    const { svc, prisma, payments } = makeService({});
    await svc.createConnectionToken("t-1", "loc-1", false, "ord-1");
    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: { id: "ord-1", tenantId: "t-1" },
      select: { brandId: true },
    });
    // The default mock order has brandId: "brand-1".
    expect(payments.resolveConnectAccount).toHaveBeenCalledWith("t-1", "loc-1", "brand-1");
  });

  it("falls back to location-only resolution when no orderId is given (S700 reader registration)", async () => {
    const { svc, payments } = makeService({});
    await svc.createConnectionToken("t-1", "loc-1", false);
    expect(payments.resolveConnectAccount).toHaveBeenCalledWith("t-1", "loc-1", undefined);
  });

  // Regression: the CLIENT needs to know which account the session is being
  // opened against, so the native SDK can tell an already-paired session
  // apart from one bound to a DIFFERENT account. Pairing from the Card
  // Readers settings page (no order → location-level account) and then
  // charging an order whose brand has its own acct_… reused the wrong
  // session and failed with "No such payment_intent" — the reader looked
  // connected but could not see the PaymentIntent. See kindOf() in
  // apps/mobile/src/services/terminal.ts.
  it("returns the resolved connected account so the client can fingerprint the session", async () => {
    const { svc } = makeService({});
    const out = await svc.createConnectionToken("t-1", "loc-1", false, "ord-1");
    expect(out.stripeAccountId).toBe("acct_shop");
  });

  it("returns a null account for a simulated session (test mode has no connected account)", async () => {
    const { svc } = makeService({});
    const out = await svc.createConnectionToken("t-1", "loc-1", true);
    expect(out.stripeAccountId).toBeNull();
  });
});

// WisePad 3 / Tap to Pay — SDK-driven. A fresh SDK session is opened PER
// ORDER by the POS modal (unlike the S700's persistent physical reader), so
// the connect account is resolved WITH that order's brandId — same as an
// online order — and createConnectionToken (below) resolves identically for
// the SAME orderId, or the SDK session and the PaymentIntent it confirms
// would land on two different accounts (the exact "No such payment_intent" /
// wrong-connected-account regression this pins against).
describe("TerminalService.createMobileCharge", () => {
  it("creates a card_present PI as a DIRECT charge, resolved WITH the order's brandId, + application fee", async () => {
    const { svc, stripe, payments, paymentCreate } = makeService({});
    const out = await svc.createMobileCharge({ tenantId: "t-1", orderId: "ord-1" });

    expect(payments.resolveConnectAccount).toHaveBeenCalledWith("t-1", "loc-1", "brand-1");

    const call = stripe.paymentIntents.create.mock.calls[0];
    const pi = call[0];
    expect(pi).toMatchObject({
      amount: 2450,
      currency: "gbp",
      payment_method_types: ["card_present"],
      capture_method: "automatic",
      application_fee_amount: 75,
    });
    expect(pi.on_behalf_of).toBeUndefined();
    expect(pi.transfer_data).toBeUndefined();
    expect(call[1]).toEqual({ stripeAccount: "acct_shop" });
    expect(pi.metadata).toMatchObject({ orderId: "ord-1", source: "terminal", channel: "mobile_reader" });

    const row = paymentCreate.mock.calls[0][0].data;
    expect(row.platformFee).toBe(0.75);
    expect(row.netAmount).toBe(23.75); // 24.5 - 0.75
    expect(out).toMatchObject({ paymentIntentId: "pi_1", simulated: false });
  });

  it("charges without Connect routing when the location isn't connected", async () => {
    const { svc, stripe } = makeService({ connect: null });
    await svc.createMobileCharge({ tenantId: "t-1", orderId: "ord-1" });
    const call = stripe.paymentIntents.create.mock.calls[0];
    expect(call[0].application_fee_amount).toBeUndefined();
    expect(call[1]).toBeUndefined();
  });

  it("simulated charge: runs on the TEST client, SKIPS Connect routing entirely, tags testDrive", async () => {
    const { svc, stripe, payments } = makeService({});
    const out = await svc.createMobileCharge({ tenantId: "t-1", orderId: "ord-1", simulated: true });
    const call = stripe.paymentIntents.create.mock.calls[0];
    expect(call[0].application_fee_amount).toBeUndefined();
    expect(call[1]).toBeUndefined();
    expect(call[0].metadata.testDrive).toBe("1");
    expect(payments.resolveConnectAccount).not.toHaveBeenCalled();
    expect(out.simulated).toBe(true);
  });

  it("rejects an already-paid order", async () => {
    const { svc } = makeService({
      order: { id: "o", tenantId: "t-1", locationId: "loc-1", brandId: null, total: 5, paymentStatus: "PAID" },
    });
    await expect(
      svc.createMobileCharge({ tenantId: "t-1", orderId: "o" }),
    ).rejects.toThrow(/already paid/i);
  });
});

describe("TerminalService.status", () => {
  it("settles the order when the PI has succeeded, retrieving on the direct-charge account", async () => {
    // A Payment row exists for this PI (created at charge time) — status()
    // must resolve its stripeAccount via PaymentsService.stripeAccountForPayment
    // and retrieve the PI with that {stripeAccount}, or a direct-charge PI
    // 404s against the platform account.
    const { svc, stripe, payments } = makeService({ payment: { id: "pay-1", orderId: "ord-1" } });
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "succeeded", metadata: { tenantId: "t-1" } });
    const out = await svc.status("t-1", "pi_1");
    expect(payments.stripeAccountForPayment).toHaveBeenCalled();
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledWith("pi_1", {}, { stripeAccount: "acct_shop" });
    expect(payments.settleTerminalPi).toHaveBeenCalled();
    expect(out).toMatchObject({ status: "succeeded", paid: true });
  });

  it("does not settle while still processing", async () => {
    const { svc, stripe, payments } = makeService({ payment: { id: "pay-1", orderId: "ord-1" } });
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "processing", metadata: { tenantId: "t-1" } });
    const out = await svc.status("t-1", "pi_1");
    expect(payments.settleTerminalPi).not.toHaveBeenCalled();
    expect(out.paid).toBe(false);
  });

  it("retrieves without a stripeAccount when no local Payment row is found", async () => {
    const { svc, stripe } = makeService({}); // payment: null by default
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "processing", metadata: { tenantId: "t-1" } });
    await svc.status("t-1", "pi_1");
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledWith("pi_1", {}, undefined);
  });
});

describe("TerminalService simulated reader guard", () => {
  it("blocks simulated reader registration on a live key without a test-drive key", async () => {
    const { svc } = makeService({ testKey: false });
    await expect(svc.registerSimulatedReader("t-1", "loc-1")).rejects.toThrow(/test/i);
  });

  it("allows the test drive on a live key when STRIPE_TEST_SECRET_KEY is set", async () => {
    const { svc, stripe } = makeService({ testKey: false, withTestKey: true });
    const reader = await svc.registerSimulatedReader("t-1", "loc-1");
    expect(reader).toMatchObject({ id: "tmr_new", simulated: true });
    // Registered against a TEST-mode terminal location, not the live one —
    // and with no {stripeAccount} request option (simulated readers skip
    // Connect routing entirely; live connected accounts don't exist in test mode).
    expect(stripe.terminal.readers.create).toHaveBeenCalledWith(
      expect.objectContaining({ location: "tml_test", registration_code: "simulated-wpe" }),
      undefined,
    );
    expect((svc as any).isTestMode).toBe(true);
  });
});

// ── Split bills on a card reader ─────────────────────────────────────
//
// A part-payment must charge ONLY its own amount and must never let the
// order be settled early. The ceiling is what's still OWED, not the
// order total, so two part-charges can't each pass a naive check and
// together overcharge the table.
describe("TerminalService.chargeOrder — split bill", () => {
  it("charges only the requested part, not the order total", async () => {
    const { svc, stripe, paymentCreate } = makeService({});
    const out = await svc.chargeOrder({
      tenantId: "t-1",
      orderId: "ord-1",
      readerId: "tmr_real",
      amount: 10,
    });

    const pi = stripe.paymentIntents.create.mock.calls[0][0];
    expect(pi.amount).toBe(1000); // £10, NOT the £24.50 order total
    expect(pi.metadata).toMatchObject({ split: "1" });
    expect(out.amount).toBe(10);

    // The Payment row records the part, because paymentSummary() sums
    // these rows to decide when the bill is clear.
    const row = paymentCreate.mock.calls[0][0].data;
    expect(Number(row.amount)).toBe(10);
    expect(row.metadata).toMatchObject({ split: true });
  });

  it("caps the part at what is still owed, not the order total", async () => {
    // £20 of the £24.50 already banked → only £4.50 left.
    const { svc } = makeService({ paidParts: [{ amount: 20 }] });
    await expect(
      svc.chargeOrder({
        tenantId: "t-1",
        orderId: "ord-1",
        readerId: "tmr_real",
        amount: 10,
      }),
    ).rejects.toThrow(/more than the £4.50 still owed/);
  });

  it("allows the exact remaining balance", async () => {
    const { svc, stripe } = makeService({ paidParts: [{ amount: 20 }] });
    await svc.chargeOrder({
      tenantId: "t-1",
      orderId: "ord-1",
      readerId: "tmr_real",
      amount: 4.5,
    });
    expect(stripe.paymentIntents.create.mock.calls[0][0].amount).toBe(450);
  });

  it("refuses a part on an already-covered bill", async () => {
    const { svc } = makeService({ paidParts: [{ amount: 24.5 }] });
    await expect(
      svc.chargeOrder({
        tenantId: "t-1",
        orderId: "ord-1",
        readerId: "tmr_real",
        amount: 5,
      }),
    ).rejects.toThrow(/already fully paid/);
  });

  it("rejects a zero or negative part", async () => {
    const { svc } = makeService({});
    await expect(
      svc.chargeOrder({ tenantId: "t-1", orderId: "ord-1", readerId: "tmr_real", amount: 0 }),
    ).rejects.toThrow(/greater than zero/);
  });

  it("still charges the whole total when no amount is given", async () => {
    const { svc, stripe } = makeService({ paidParts: [{ amount: 20 }] });
    await svc.chargeOrder({ tenantId: "t-1", orderId: "ord-1", readerId: "tmr_real" });
    // No `amount` = the original whole-order behaviour, untouched.
    const pi = stripe.paymentIntents.create.mock.calls[0][0];
    expect(pi.amount).toBe(2450);
    expect(pi.metadata.split).toBeUndefined();
  });
});
