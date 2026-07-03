// @nestjs/event-emitter isn't installed in the local worktree test env (it is
// in the deployed build). PaymentsService imports it at module load; stub it.
jest.mock(
  "@nestjs/event-emitter",
  () => ({ EventEmitter2: class {}, OnEvent: () => () => undefined }),
  { virtual: true },
);

import { TerminalService } from "../terminal.service";

// Stripe Terminal (S700) charge flow — card-present PaymentIntent routed
// through the location's Connect account with the platform application fee,
// pushed to the reader, then settled to PAID.

function makeService(opts: {
  order?: any;
  location?: any;
  connect?: any;
  feePence?: number;
  testKey?: boolean;
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
        ],
      },
    },
  };

  const paymentCreate = jest.fn().mockResolvedValue({ id: "pay-1" });
  const prisma = {
    order: { findFirst: jest.fn().mockResolvedValue(order) },
    location: {
      findFirst: jest.fn().mockResolvedValue(location),
      update: jest.fn().mockResolvedValue({}),
    },
    payment: { create: paymentCreate },
  } as any;

  const config = {
    get: (k: string) => (k === "STRIPE_SECRET_KEY" ? (opts.testKey === false ? "sk_live_x" : "sk_test_x") : undefined),
  } as any;

  const payments = {
    resolveConnectAccount: jest
      .fn()
      .mockResolvedValue("connect" in opts ? opts.connect : { id: null, stripeAccountId: "acct_shop" }),
    applicationFeePenceForBasket: jest.fn().mockResolvedValue(opts.feePence ?? 75),
    settleTerminalPi: jest.fn().mockResolvedValue(undefined),
  } as any;

  const svc = new TerminalService(config, prisma, payments);

  const stripe = {
    paymentIntents: {
      create: jest.fn().mockResolvedValue({ id: "pi_1", status: "requires_payment_method" }),
      retrieve: jest.fn(),
    },
    terminal: {
      readers: { processPaymentIntent: jest.fn().mockResolvedValue({}) },
      locations: { create: jest.fn() },
    },
    testHelpers: { terminal: { readers: { presentPaymentMethod: jest.fn().mockResolvedValue({}) } } },
  };
  (svc as any).stripe = stripe;
  return { svc, stripe, prisma, payments, paymentCreate };
}

describe("TerminalService.chargeOrder", () => {
  it("creates a card_present PI with Connect destination + application fee and pushes it to the reader", async () => {
    const { svc, stripe, paymentCreate } = makeService({});
    const out = await svc.chargeOrder({ tenantId: "t-1", orderId: "ord-1", readerId: "tmr_sim" });

    const pi = stripe.paymentIntents.create.mock.calls[0][0];
    expect(pi).toMatchObject({
      amount: 2450,
      currency: "gbp",
      payment_method_types: ["card_present"],
      capture_method: "automatic",
      on_behalf_of: "acct_shop",
      transfer_data: { destination: "acct_shop" },
      application_fee_amount: 75,
    });
    expect(pi.metadata).toMatchObject({ orderId: "ord-1", source: "terminal" });

    expect(stripe.terminal.readers.processPaymentIntent).toHaveBeenCalledWith("tmr_sim", {
      payment_intent: "pi_1",
    });
    expect(paymentCreate).toHaveBeenCalled();
    expect(out).toMatchObject({ paymentIntentId: "pi_1", readerId: "tmr_sim", simulated: true });
  });

  it("charges without Connect routing when the location isn't connected", async () => {
    const { svc, stripe } = makeService({ connect: null });
    await svc.chargeOrder({ tenantId: "t-1", orderId: "ord-1", readerId: "tmr_sim" });
    const pi = stripe.paymentIntents.create.mock.calls[0][0];
    expect(pi.transfer_data).toBeUndefined();
    expect(pi.application_fee_amount).toBeUndefined();
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

describe("TerminalService.status", () => {
  it("settles the order when the PI has succeeded", async () => {
    const { svc, stripe, payments } = makeService({});
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "succeeded", metadata: { tenantId: "t-1" } });
    const out = await svc.status("t-1", "pi_1");
    expect(payments.settleTerminalPi).toHaveBeenCalled();
    expect(out).toMatchObject({ status: "succeeded", paid: true });
  });

  it("does not settle while still processing", async () => {
    const { svc, stripe, payments } = makeService({});
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "processing", metadata: { tenantId: "t-1" } });
    const out = await svc.status("t-1", "pi_1");
    expect(payments.settleTerminalPi).not.toHaveBeenCalled();
    expect(out.paid).toBe(false);
  });
});

describe("TerminalService simulated reader guard", () => {
  it("blocks simulated reader registration on a live key", async () => {
    const { svc } = makeService({ testKey: false });
    await expect(svc.registerSimulatedReader("t-1", "loc-1")).rejects.toThrow(/test/i);
  });
});
