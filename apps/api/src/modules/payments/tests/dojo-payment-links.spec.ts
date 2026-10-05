// Pay by link, hosted by Dojo instead of Stripe — per location, off by default.
//
// The money rule under test: Stripe is what every existing shop uses and the
// only thing that may change that is an operator switching THAT shop over. A
// Dojo failure must never silently fall back to Stripe either, because the two
// pay into different accounts.

// No stub for @nestjs/event-emitter here, unlike dojo.spec.ts: the container
// test below builds the real Nest injector, and a stubbed EventEmitter2 is a
// DIFFERENT class from the one PaymentsService was compiled against, so Nest
// can't match the token ("argument EventEmitter at index [3]").
import { CredentialEncryptionService } from "../../integrations/credential-encryption.service";
import { DojoService } from "../dojo/dojo.service";
import { PaymentsService } from "../payments.service";

// ── The seam in PaymentsService ──────────────────────────────────────────────

function makeLinkService(dojoLinks?: { paymentLinkForOrder: jest.Mock }) {
  const sessions = {
    create: jest.fn().mockResolvedValue({ id: "cs_1", url: "https://pay.stripe.test/cs_1", payment_intent: "pi_1" }),
  };
  const svc = Object.create(PaymentsService.prototype) as any;
  svc.prisma = {
    order: {
      findFirst: jest.fn().mockResolvedValue({
        id: "ord-1",
        locationId: "loc-1",
        brandId: "brand-1",
        total: 20,
        deliveryFee: 0,
        taxAmount: 0,
        tipAmount: 0,
        paymentStatus: "PENDING",
        paymentMethod: "PAYMENT_LINK",
        items: [{ name: "Pizza", unitPrice: 20, quantity: 1 }],
        location: { onlineOrderingSlug: "pizza-uno" },
        brand: null,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    payment: { create: jest.fn().mockResolvedValue({ id: "pay-1" }) },
  };
  svc.stripe = { checkout: { sessions } };
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.resolveConnectAccount = jest.fn().mockResolvedValue({ id: "ca-1", stripeAccountId: "acct_brand" });
  svc.dojoLinks = dojoLinks;
  return { svc, sessions };
}

describe("PaymentsService.createOrderPaymentLink — which provider hosts it", () => {
  it("uses Stripe when no location has ever been switched over", async () => {
    const { svc, sessions } = makeLinkService();
    const r = await svc.createOrderPaymentLink("t-1", "ord-1");
    expect(r.url).toBe("https://pay.stripe.test/cs_1");
    expect(sessions.create).toHaveBeenCalledTimes(1);
  });

  it("uses Stripe when Dojo says this location isn't on Dojo links", async () => {
    const port = { paymentLinkForOrder: jest.fn().mockResolvedValue(null) };
    const { svc, sessions } = makeLinkService(port);
    const r = await svc.createOrderPaymentLink("t-1", "ord-1");
    expect(port.paymentLinkForOrder).toHaveBeenCalledWith("t-1", "ord-1");
    expect(r.url).toBe("https://pay.stripe.test/cs_1");
    expect(sessions.create).toHaveBeenCalledTimes(1);
  });

  it("uses the Dojo link when the location was switched, and doesn't touch Stripe", async () => {
    const port = { paymentLinkForOrder: jest.fn().mockResolvedValue({ url: "https://pay.dojo.tech/checkout/pi_1" }) };
    const { svc, sessions } = makeLinkService(port);
    expect(await svc.createOrderPaymentLink("t-1", "ord-1")).toEqual({
      url: "https://pay.dojo.tech/checkout/pi_1",
    });
    expect(sessions.create).not.toHaveBeenCalled();
  });

  // Falling back would take the customer's money into the wrong account.
  it("fails loudly rather than quietly charging through Stripe instead", async () => {
    const port = { paymentLinkForOrder: jest.fn().mockRejectedValue(new Error("Dojo is down")) };
    const { svc, sessions } = makeLinkService(port);
    await expect(svc.createOrderPaymentLink("t-1", "ord-1")).rejects.toThrow(/Dojo is down/);
    expect(sessions.create).not.toHaveBeenCalled();
  });
});

// ── Minting the link in DojoService ──────────────────────────────────────────

const crypto = new CredentialEncryptionService();

function dojoSettings(extra: Record<string, unknown> = {}) {
  return {
    dojo: {
      credentials: crypto.encrypt({ apiKey: "sk_sandbox_abcd1234" }),
      keyHint: "…1234",
      environment: "sandbox",
      connectedAt: "2026-09-30T00:00:00Z",
      terminals: [{ id: "tm_1", label: "Bar" }],
      webhookSubscriptionId: "ws_1",
      ...extra,
    },
  };
}

function makeDojo(opts: { settings?: any; order?: any; rows?: any[]; intent?: any } = {}) {
  const client = {
    createPaymentIntent: jest.fn().mockResolvedValue({ id: "pi_sandbox_abc", status: "Created" }),
    getPaymentIntent: jest.fn().mockResolvedValue(opts.intent ?? { id: "pi_sandbox_abc", status: "Created" }),
    listTerminals: jest.fn().mockResolvedValue([]),
    registerRestIntegration: jest.fn(),
  } as any;
  const order = opts.order ?? {
    id: "ord-1",
    tenantId: "t-1",
    locationId: "loc-1",
    displayId: "A12",
    total: 24.5,
    paymentStatus: "PENDING",
    tipAmount: 0,
    serviceCharge: 0,
    items: [{ id: "i1", name: "Pizza", quantity: 1, totalPrice: 24.5, modifiers: [], menuItemId: "m1" }],
  };
  // The settings JSON is written and read back in the same call (saveConfig
  // re-reads before writing, and status() reads after), so the fake has to
  // remember what it was told rather than replay the fixture.
  let settings = opts.settings ?? dojoSettings({ paymentLinks: { enabled: true, enabledAt: "x" } });
  const loc = () => ({ id: "loc-1", name: "Pizza Uno", country: "GB", settings });
  const prisma = {
    order: { findFirst: jest.fn().mockResolvedValue(order), update: jest.fn().mockResolvedValue({}) },
    location: {
      findUnique: jest.fn(async () => loc()),
      findFirst: jest.fn(async () => ({ ...loc(), brand: { tenantId: "t-1" } })),
      update: jest.fn(async ({ data }: any) => {
        settings = data.settings;
        return loc();
      }),
    },
    payment: {
      findMany: jest.fn().mockResolvedValue(opts.rows ?? []),
      create: jest.fn().mockResolvedValue({ id: "pay-1" }),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
  const payments = { settleCardPresentPayment: jest.fn().mockResolvedValue(true) } as any;
  const config = { get: () => undefined } as any;
  class TestDojo extends DojoService {
    protected makeClient() {
      return client;
    }
  }
  return { svc: new TestDojo(config, prisma, payments, crypto), prisma, client };
}

describe("DojoService.paymentLinkForOrder", () => {
  it("stays out of the way unless this location was switched to Dojo", async () => {
    const { svc, client } = makeDojo({ settings: dojoSettings() }); // connected, links off
    expect(await svc.paymentLinkForOrder("t-1", "ord-1")).toBeNull();
    expect(client.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("mints the intent and hands back Dojo's hosted page", async () => {
    const { svc, prisma, client } = makeDojo();
    const r = await svc.paymentLinkForOrder("t-1", "ord-1");
    expect(r).toEqual({ url: "https://pay.dojo.tech/checkout/pi_sandbox_abc" });
    expect(client.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinor: 2450, currencyCode: "GBP", reference: "Order A12" }),
    );
    // A row to settle against when Dojo's webhook arrives.
    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: "DOJO",
          providerChargeId: "pi_sandbox_abc",
          amount: 24.5,
          status: "PROCESSING",
          platformFee: 0,
          metadata: expect.objectContaining({ source: "dojo_payment_link" }),
        }),
      }),
    );
  });

  // A Dojo link is single-use: re-opening the QR must not replace the one the
  // customer is already looking at.
  it("re-uses the link that's still unpaid instead of minting another", async () => {
    const { svc, prisma, client } = makeDojo({
      rows: [{ id: "pay-1", amount: 24.5, providerChargeId: "pi_sandbox_abc", metadata: { source: "dojo_payment_link" } }],
    });
    expect(await svc.paymentLinkForOrder("t-1", "ord-1")).toEqual({
      url: "https://pay.dojo.tech/checkout/pi_sandbox_abc",
    });
    expect(client.createPaymentIntent).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it("refuses a second link for money the customer has already paid", async () => {
    const { svc, client } = makeDojo({
      rows: [{ id: "pay-1", amount: 24.5, providerChargeId: "pi_sandbox_abc", metadata: { source: "dojo_payment_link" } }],
      intent: { id: "pi_sandbox_abc", status: "Captured", amount: { value: 2450, currencyCode: "GBP" } },
    });
    await expect(svc.paymentLinkForOrder("t-1", "ord-1")).rejects.toThrow(/already been paid/i);
    expect(client.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("won't mint a link for an order that's already paid", async () => {
    const { svc } = makeDojo({
      order: { id: "ord-1", tenantId: "t-1", locationId: "loc-1", total: 24.5, paymentStatus: "PAID", items: [] },
    });
    await expect(svc.paymentLinkForOrder("t-1", "ord-1")).rejects.toThrow(/already paid/i);
  });
});

describe("DojoService — switching the provider", () => {
  it("refuses Dojo links with no webhook, because nothing else would settle them", async () => {
    const { svc } = makeDojo({ settings: dojoSettings({ webhookSubscriptionId: null }) });
    await expect(svc.enablePaymentLinks("t-1", "loc-1")).rejects.toThrow(/webhook/i);
  });

  it("switches over, and back to Stripe", async () => {
    const { svc, prisma } = makeDojo({ settings: dojoSettings() });
    const on = await svc.enablePaymentLinks("t-1", "loc-1");
    expect((on as any).paymentLinks.enabled).toBe(true);
    expect(prisma.location.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          settings: expect.objectContaining({ dojo: expect.objectContaining({ paymentLinks: expect.objectContaining({ enabled: true }) }) }),
        }),
      }),
    );

    const back = makeDojo({ settings: dojoSettings({ paymentLinks: { enabled: true, enabledAt: "x" } }) });
    const off = await back.svc.disablePaymentLinks("t-1", "loc-1");
    expect((off as any).paymentLinks.enabled).toBe(false);
  });
});

// ── The wiring itself ────────────────────────────────────────────────────────
//
// DojoService needs PaymentsService and now PaymentsService needs one method of
// DojoService back. Injecting the class either way round is a provider cycle
// that stops the API booting — every shop's payments down — so the token is
// resolved through ModuleRef when a link is actually asked for. This builds the
// real container to prove that it starts and that the call lands.

describe("the DOJO_PAYMENT_LINKS token", () => {
  it("starts with both services in one container, and reaches Dojo on call", async () => {
    const { Test } = require("@nestjs/testing");
    const { ModuleRef } = require("@nestjs/core");
    const { ConfigService } = require("@nestjs/config");
    const { EventEmitter2 } = require("@nestjs/event-emitter");
    const { PrismaService } = require("../../../infrastructure/database/prisma.service");
    const { SocketService } = require("../../../infrastructure/socket/socket.service");
    const { SmsService } = require("../../sms/sms.service");
    const { WalletService } = require("../../wallet/wallet.service");
    const { DOJO_PAYMENT_LINKS: TOKEN } = require("../payments.service");

    const prisma = {
      order: { findFirst: jest.fn().mockResolvedValue(null) },
      location: { findUnique: jest.fn() },
      payment: { findMany: jest.fn(), create: jest.fn() },
    };
    const mod = await Test.createTestingModule({
      providers: [
        PaymentsService,
        DojoService,
        {
          provide: TOKEN,
          useFactory: (ref: any) => ({
            paymentLinkForOrder: (t: string, o: string) =>
              ref.get(DojoService, { strict: false }).paymentLinkForOrder(t, o),
          }),
          inject: [ModuleRef],
        },
        { provide: PrismaService, useValue: prisma },
        { provide: SocketService, useValue: { emitToTenant: jest.fn(), emitNewOrder: jest.fn() } },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: EventEmitter2, useValue: { emit: jest.fn(), emitAsync: jest.fn() } },
        { provide: SmsService, useValue: { isConfigured: () => false, send: jest.fn() } },
        { provide: WalletService, useValue: {} },
        CredentialEncryptionService,
      ],
    }).compile();

    const payments = mod.get(PaymentsService);
    // An order that doesn't exist: proof the call travelled to DojoService
    // (which looks the order up and returns null) rather than failing to wire.
    await expect((payments as any).dojoLinks.paymentLinkForOrder("t-1", "ord-1")).resolves.toBeNull();
    expect(prisma.order.findFirst).toHaveBeenCalled();
    await mod.close();
  });
});
