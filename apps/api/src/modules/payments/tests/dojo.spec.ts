// @nestjs/event-emitter isn't installed in the local worktree test env (it is
// in the deployed build). PaymentsService imports it at module load; stub it.
jest.mock(
  "@nestjs/event-emitter",
  () => ({ EventEmitter2: class {}, OnEvent: () => () => undefined }),
  { virtual: true },
);

import { CredentialEncryptionService } from "../../integrations/credential-encryption.service";
import { DojoApiClient, DojoApiError, dojoKeyEnvironment } from "../dojo/dojo-api.client";
import { DojoEposService, EposError, areaIdOf } from "../dojo/dojo-epos.service";
import { activeDojoLock } from "../dojo/dojo-lock";
import { DojoService, findPaymentIntentId, hashSecret } from "../dojo/dojo.service";

// Dojo card machines + Pay at Table. The money rule under test throughout:
// nothing settles unless Dojo itself, asked with the shop's own key, says
// the intent is Captured for exactly our amount.

const crypto = new CredentialEncryptionService(); // no env key → passthrough in tests

function fakeClient(over: Partial<Record<keyof DojoApiClient, jest.Mock>> = {}) {
  return {
    listTerminals: jest.fn().mockResolvedValue([
      { id: "tm_1", properties: { tid: "TID1" }, status: "Available" },
    ]),
    createPaymentIntent: jest.fn().mockResolvedValue({ id: "pi_new", status: "Created" }),
    createSaleSession: jest.fn().mockResolvedValue({ id: "ts_1", status: "InitiateRequested", terminalId: "tm_1" }),
    getTerminalSession: jest.fn().mockResolvedValue({ id: "ts_1", status: "Captured", terminalId: "tm_1" }),
    cancelTerminalSession: jest.fn().mockResolvedValue({}),
    respondToSignature: jest.fn().mockResolvedValue({}),
    getPaymentIntent: jest.fn().mockResolvedValue({
      id: "pi_new",
      status: "Captured",
      amount: { value: 2450, currencyCode: "GBP" },
    }),
    cancelPaymentIntent: jest.fn().mockResolvedValue({}),
    refundPaymentIntent: jest.fn().mockResolvedValue({ refundId: "rfnd_1" }),
    registerRestIntegration: jest.fn().mockResolvedValue([]),
    listWebhookEventTypes: jest.fn().mockResolvedValue([
      { model: "PaymentIntent", events: ["payment_intent.created", "payment_intent.status_updated"] },
      { model: "Order", events: ["order.created"] },
    ]),
    subscribeWebhook: jest.fn().mockResolvedValue({ id: "ws_1" }),
    deleteWebhook: jest.fn().mockResolvedValue({}),
    ...over,
  } as any;
}

function dojoSettings(extra: Record<string, unknown> = {}) {
  return {
    dojo: {
      credentials: crypto.encrypt({ apiKey: "sk_sandbox_abcd1234" }),
      keyHint: "…1234",
      environment: "sandbox",
      connectedAt: "2026-09-19T00:00:00Z",
      terminals: [{ id: "tm_1", label: "Bar" }],
      ...extra,
    },
  };
}

function makeDojo(opts: { client?: any; order?: any; location?: any; payment?: any; paidParts?: any[] } = {}) {
  const client = opts.client ?? fakeClient();
  const location = opts.location ?? {
    id: "loc-1",
    name: "Pizza Uno",
    country: "GB",
    settings: dojoSettings(),
    brand: { tenantId: "t-1" },
  };
  const prisma = {
    $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
    refund: { create: jest.fn().mockResolvedValue({ id: "r1" }) },
    order: {
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(
        opts.order ?? { id: "ord-1", tenantId: "t-1", locationId: "loc-1", displayId: "A12", total: 24.5, paymentStatus: "PENDING" },
      ),
    },
    location: {
      findFirst: jest.fn().mockResolvedValue(location),
      findUnique: jest.fn().mockResolvedValue({ settings: location.settings }),
      update: jest.fn().mockResolvedValue({}),
    },
    payment: {
      create: jest.fn().mockResolvedValue({ id: "pay-1" }),
      findMany: jest.fn().mockResolvedValue(opts.paidParts ?? []),
      findFirst: jest.fn().mockResolvedValue(opts.payment ?? null),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
  const payments = { settleCardPresentPayment: jest.fn().mockResolvedValue(undefined) } as any;
  const config = { get: (k: string) => (k === "DOJO_SOFTWARE_HOUSE_ID" ? "sh_orderhub" : undefined) } as any;
  class TestDojo extends DojoService {
    protected makeClient() {
      return client;
    }
  }
  const svc = new TestDojo(config, prisma, payments, crypto);
  return { svc, prisma, payments, client };
}

// ── The HTTP client ───────────────────────────────────────────────────────────

describe("DojoApiClient", () => {
  function recorder(status = 200, body: unknown = []) {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = jest.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: status < 400, status, statusText: "x", text: async () => JSON.stringify(body) } as any;
    });
    return { calls, fetchImpl };
  }

  it("sends the raw key as Basic auth, the version, and the partner ids on EVERY call", async () => {
    const { calls, fetchImpl } = recorder(200, { id: "pi_1" });
    const c = new DojoApiClient("sk_prod_x", { softwareHouseId: "sh", resellerId: "rs" }, fetchImpl as any);
    await c.listTerminals();
    await c.getPaymentIntent("pi_1");
    expect(calls[0].url).toBe("https://api.dojo.tech/terminals");
    // Dojo's spec asks for the partner ids on terminal calls; our partner
    // manager asked for them on payment intents too, so both carry them.
    for (const call of calls) {
      expect(call.init.headers).toMatchObject({
        Authorization: "Basic sk_prod_x",
        version: "2026-02-27",
        "software-house-id": "sh",
        "reseller-id": "rs",
      });
    }
  });

  it("names the offending fields from a validation 400", async () => {
    const { fetchImpl } = recorder(400, {
      title: "One or more validation errors occurred.",
      errors: { Events: ["The Events field is required."], Url: ["Not a valid URL."] },
    });
    const c = new DojoApiClient("sk_prod_x", {}, fetchImpl as any);
    await expect(c.subscribeWebhook("https://x/y", [])).rejects.toThrow(
      /Events: The Events field is required.; Url: Not a valid URL./,
    );
  });

  it("surfaces Dojo's problem-details message on failure", async () => {
    const { fetchImpl } = recorder(409, { title: "terminal unavailable", detail: "the terminal is either offline or currently in use" });
    const c = new DojoApiClient("sk_prod_x", {}, fetchImpl as any);
    await expect(c.createSaleSession("tm_1", "pi_1")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("offline or currently in use"),
    });
  });

  it("tells sandbox from production by the key prefix only", () => {
    expect(dojoKeyEnvironment("sk_sandbox_1")).toBe("sandbox");
    expect(dojoKeyEnvironment("sk_prod_1")).toBe("production");
    expect(dojoKeyEnvironment("pk_prod_1")).toBeNull();
  });
});

// ── Connecting ────────────────────────────────────────────────────────────────

describe("DojoService.connect", () => {
  it("refuses something that isn't a secret key without calling Dojo", async () => {
    const { svc, client } = makeDojo();
    await expect(svc.connect("t-1", "loc-1", "hello")).rejects.toThrow(/sk_prod_/);
    expect(client.listTerminals).not.toHaveBeenCalled();
  });

  it("proves the key against /terminals, then saves it (never the raw key in the hint)", async () => {
    const { svc, prisma, client } = makeDojo({
      location: { id: "loc-1", name: "X", country: "GB", settings: {}, brand: { tenantId: "t-1" } },
    });
    await svc.connect("t-1", "loc-1", "sk_prod_supersecret99");
    const saved = prisma.location.update.mock.calls[0][0].data.settings.dojo;
    expect(saved.environment).toBe("production");
    expect(saved.keyHint).toBe("…et99");
    expect(saved.terminals).toEqual([{ id: "tm_1", label: "Dojo TID1" }]);
    expect(saved.webhookSubscriptionId).toBe("ws_1");
    // Event names come from Dojo's own catalogue, never guessed.
    expect(client.subscribeWebhook).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/payments/dojo/webhook/loc-1"),
      ["payment_intent.created", "payment_intent.status_updated"],
    );
  });

  it("turns a 401 from Dojo into a plain-English refusal", async () => {
    const client = fakeClient({ listTerminals: jest.fn().mockRejectedValue(new DojoApiError("x", 401, null)) });
    const { svc, prisma } = makeDojo({ client });
    await expect(svc.connect("t-1", "loc-1", "sk_prod_bad")).rejects.toThrow(/refused that key/);
    expect(prisma.location.update).not.toHaveBeenCalled();
  });
});

// ── Charging at the counter ──────────────────────────────────────────────────

describe("DojoService.chargeOrder", () => {
  it("creates an intent in pence, starts a Sale session and records a DOJO payment row", async () => {
    const { svc, client, prisma } = makeDojo();
    const res = await svc.chargeOrder({ tenantId: "t-1", orderId: "ord-1", terminalId: "tm_1" });
    expect(client.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinor: 2450, currencyCode: "GBP", reference: "Order A12" }),
    );
    expect(client.createSaleSession).toHaveBeenCalledWith("tm_1", "pi_new");
    const row = prisma.payment.create.mock.calls[0][0].data;
    expect(row).toMatchObject({
      provider: "DOJO",
      providerChargeId: "pi_new",
      amount: 24.5,
      status: "PROCESSING",
      method: "CARD",
      platformFee: 0,
    });
    expect(row.metadata).toMatchObject({ terminalSessionId: "ts_1", sandbox: true });
    expect(row.metadata.split).toBeUndefined();
    expect(res.paymentIntentId).toBe("pi_new");
  });

  it("caps a split share at what's still owed", async () => {
    const { svc } = makeDojo({ paidParts: [{ amount: 20 }] });
    await expect(
      svc.chargeOrder({ tenantId: "t-1", orderId: "ord-1", terminalId: "tm_1", amount: 10 }),
    ).rejects.toThrow(/4.50 still owed/);
  });

  it("marks a split share as split so it can't settle the whole bill", async () => {
    const { svc, prisma } = makeDojo({ paidParts: [{ amount: 10 }] });
    await svc.chargeOrder({ tenantId: "t-1", orderId: "ord-1", terminalId: "tm_1", amount: 10 });
    expect(prisma.payment.create.mock.calls[0][0].data).toMatchObject({ amount: 10, metadata: { split: true } });
  });

  it("cancels the intent and explains when the machine is busy", async () => {
    const client = fakeClient({ createSaleSession: jest.fn().mockRejectedValue(new DojoApiError("busy", 409, null)) });
    const { svc, prisma } = makeDojo({ client });
    await expect(svc.chargeOrder({ tenantId: "t-1", orderId: "ord-1", terminalId: "tm_1" })).rejects.toThrow(
      /busy with another payment, or offline/,
    );
    expect(client.cancelPaymentIntent).toHaveBeenCalledWith("pi_new");
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it("refuses an already-paid order", async () => {
    const { svc } = makeDojo({ order: { id: "ord-1", tenantId: "t-1", locationId: "loc-1", total: 5, paymentStatus: "PAID" } });
    await expect(svc.chargeOrder({ tenantId: "t-1", orderId: "ord-1", terminalId: "tm_1" })).rejects.toThrow(/already paid/);
  });
});

describe("DojoService.chargeStatus", () => {
  const processing = {
    id: "pay-1",
    orderId: "ord-1",
    providerChargeId: "pi_new",
    amount: 24.5,
    status: "PROCESSING",
    metadata: { terminalSessionId: "ts_1" },
    order: { id: "ord-1", locationId: "loc-1" },
  };

  it("settles when Dojo confirms Captured for our amount", async () => {
    const { svc, payments } = makeDojo({ payment: processing });
    const s = await svc.chargeStatus("t-1", "pi_new");
    expect(s.paid).toBe(true);
    expect(payments.settleCardPresentPayment).toHaveBeenCalledWith(processing, "pi_new");
  });

  it("does NOT settle when the captured amount differs from ours", async () => {
    const client = fakeClient({
      getPaymentIntent: jest.fn().mockResolvedValue({ id: "pi_new", status: "Captured", amount: { value: 100, currencyCode: "GBP" } }),
    });
    const { svc, payments } = makeDojo({ client, payment: processing });
    const s = await svc.chargeStatus("t-1", "pi_new");
    expect(s.paid).toBe(false);
    expect(payments.settleCardPresentPayment).not.toHaveBeenCalled();
  });

  it("reports a decline and marks the row FAILED", async () => {
    const client = fakeClient({ getTerminalSession: jest.fn().mockResolvedValue({ id: "ts_1", status: "Declined" }) });
    const { svc, prisma, payments } = makeDojo({ client, payment: processing });
    const s = await svc.chargeStatus("t-1", "pi_new");
    expect(s).toMatchObject({ paid: false, failed: true, message: expect.stringMatching(/declined/i) });
    expect(prisma.payment.update).toHaveBeenCalledWith({ where: { id: "pay-1" }, data: { status: "FAILED" } });
    expect(payments.settleCardPresentPayment).not.toHaveBeenCalled();
  });

  it("asks staff to check the signature", async () => {
    const client = fakeClient({
      getTerminalSession: jest.fn().mockResolvedValue({ id: "ts_1", status: "SignatureVerificationRequired" }),
    });
    const { svc } = makeDojo({ client, payment: processing });
    expect((await svc.chargeStatus("t-1", "pi_new")).needsSignature).toBe(true);
  });
});

describe("DojoService.intentCovers", () => {
  const { svc } = makeDojo();
  it("accepts Captured at the exact amount, or total minus tips", () => {
    expect(svc.intentCovers({ id: "p", status: "Captured", amount: { value: 500, currencyCode: "GBP" } }, 500, false)).toBe(true);
    expect(
      svc.intentCovers(
        { id: "p", status: "Captured", totalAmount: { value: 600, currencyCode: "GBP" }, tipsAmount: { value: 100, currencyCode: "GBP" } },
        500,
        false,
      ),
    ).toBe(true);
  });
  it("rejects Authorized unless allowed, and anything Created/Canceled", () => {
    const auth = { id: "p", status: "Authorized" as const, amount: { value: 500, currencyCode: "GBP" } };
    expect(svc.intentCovers(auth, 500, false)).toBe(false);
    expect(svc.intentCovers(auth, 500, true)).toBe(true);
    expect(svc.intentCovers({ ...auth, status: "Created" }, 500, true)).toBe(false);
  });
});

describe("findPaymentIntentId", () => {
  it("finds a pi_ id wherever the webhook put it", () => {
    expect(findPaymentIntentId({ data: { object: { paymentIntentId: "pi_sandbox_Ab-1" } } })).toBe("pi_sandbox_Ab-1");
    expect(findPaymentIntentId({ id: "evt_1", nothing: ["x"] })).toBeNull();
  });
});

// ── Pay at Table ──────────────────────────────────────────────────────────────

describe("DojoService.checkEposAuth", () => {
  const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
  const withPat = (enabled: boolean) => ({
    id: "loc-1",
    name: "X",
    country: "GB",
    settings: dojoSettings({
      payAtTable: { enabled, username: "orderhub-loc-1", passwordHash: hashSecret("s3cret"), registeredAt: "x" },
    }),
    brand: { tenantId: "t-1" },
  });

  it("lets Dojo in with the registered credentials", async () => {
    const { svc } = makeDojo({ location: withPat(true) });
    const ctx = await svc.checkEposAuth("loc-1", basic("orderhub-loc-1", "s3cret"));
    expect(ctx?.tenantId).toBe("t-1");
  });

  it("refuses a wrong password, a wrong user, no header, and a disabled integration", async () => {
    const { svc } = makeDojo({ location: withPat(true) });
    expect(await svc.checkEposAuth("loc-1", basic("orderhub-loc-1", "nope"))).toBeNull();
    expect(await svc.checkEposAuth("loc-1", basic("someone", "s3cret"))).toBeNull();
    expect(await svc.checkEposAuth("loc-1", undefined)).toBeNull();
    const off = makeDojo({ location: withPat(false) });
    expect(await off.svc.checkEposAuth("loc-1", basic("orderhub-loc-1", "s3cret"))).toBeNull();
  });
});

function makeEpos(opts: { order?: any; existingPayment?: any; paid?: number; client?: any; table?: any } = {}) {
  const order = opts.order ?? {
    id: "ord-1",
    tenantId: "t-1",
    locationId: "loc-1",
    tableId: "tbl-1",
    displayId: "T7",
    status: "ACCEPTED",
    paymentStatus: "PENDING",
    total: 30,
    discount: 0,
    taxAmount: 0,
    serviceCharge: 0,
    createdAt: new Date("2026-09-19T12:00:00Z"),
    updatedAt: new Date("2026-09-19T12:05:00Z"),
    metadata: {},
    items: [
      {
        id: "it-1",
        menuItemId: "mi-burger",
        name: "Burger",
        quantity: 2,
        unitPrice: 12,
        totalPrice: 24,
        modifiers: [{ name: "Cheese", price: 1 }],
      },
      { id: "it-2", menuItemId: null, name: "Cola", quantity: 1, unitPrice: 6, totalPrice: 6, modifiers: [] },
    ],
    payments: opts.paid ? [{ id: "p0", amount: opts.paid, tipAmount: 0, providerChargeId: "pi_old" }] : [],
  };
  const created: any[] = [];
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    order: { findUnique: jest.fn().mockResolvedValue({ total: order.total, status: order.status, paymentStatus: order.paymentStatus }) },
    payment: {
      findMany: jest.fn().mockResolvedValue(opts.paid ? [{ amount: opts.paid }] : []),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: "pay-new", ...data };
        created.push(row);
        return row;
      }),
    },
  };
  const prisma = {
    order: {
      findFirst: jest.fn().mockResolvedValue(order),
      findMany: jest.fn().mockResolvedValue([order]),
      findUnique: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockResolvedValue({}),
    },
    table: {
      findUnique: jest.fn().mockResolvedValue(opts.table ?? { name: "7", serverId: null }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    payment: { findFirst: jest.fn().mockResolvedValue(opts.existingPayment ?? null) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  } as any;
  const client =
    opts.client ??
    fakeClient({
      getPaymentIntent: jest.fn().mockResolvedValue({ id: "pi_pat", status: "Captured", amount: { value: 1500, currencyCode: "GBP" } }),
    });
  const dojo = { clientFor: () => client, intentCovers: DojoService.prototype.intentCovers } as any;
  const payments = { settleCardPresentPayment: jest.fn().mockResolvedValue(undefined) } as any;
  const epos = new DojoEposService(prisma, dojo, payments);
  const ctx = {
    loc: { id: "loc-1", name: "Pizza Uno", country: "GB", address: { line1: "1 High St", postcode: "SW1A 1AA" }, phone: null },
    cfg: { environment: "production" } as any,
    tenantId: "t-1",
  };
  return { epos, prisma, payments, client, ctx, created, tx };
}

describe("DojoEposService — order mapping", () => {
  it("lists base price before modifiers, and the order total/paid in minor units", async () => {
    const { epos, ctx } = makeEpos({ paid: 10 });
    const o = await epos.getOrder(ctx, "ord-1");
    expect(o.items[0]).toMatchObject({
      name: "Burger",
      plu: "mi-burger",
      quantity: 2,
      amountPerItem: { value: 1100, currencyCode: "GBP" }, // £12 each incl. £1 cheese
      modifiers: [{ name: "Cheese", amountPerModifier: { value: 100 } }],
    });
    expect(o.totalAmount).toEqual({ value: 3000, currencyCode: "GBP" });
    expect(o.paidAmount).toEqual({ value: 1000, currencyCode: "GBP" });
    expect(o.payable).toBe(true);
    expect(o.details).toEqual({ orderType: "DineIn", dineIn: { tableId: "tbl-1" } });
    expect(o.displayName).toBe("Table 7");
  });

  it("gives stable URL-safe area ids", () => {
    expect(areaIdOf("Patio")).toBe(areaIdOf(" patio "));
    expect(areaIdOf(null)).toBe("area-main");
  });
});

describe("DojoEposService — locks", () => {
  it("refuses a second machine while a live lock is held", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const { epos, ctx, prisma } = makeEpos();
    const base = await prisma.order.findFirst();
    prisma.order.findFirst.mockResolvedValue({ ...base, metadata: { dojoLock: { lockId: "L1", expiry: future } } });
    await expect(epos.createLock(ctx, "ord-1", { lockId: "L2", expiry: future })).rejects.toBeInstanceOf(EposError);
    // The same machine re-locking is fine.
    await expect(epos.createLock(ctx, "ord-1", { lockId: "L1", expiry: future })).resolves.toMatchObject({ id: "ord-1" });
  });

  it("treats an expired lock as no lock", () => {
    expect(activeDojoLock({ dojoLock: { lockId: "L1", expiry: "2000-01-01T00:00:00Z" } })).toBeNull();
    expect(activeDojoLock({ dojoLock: { lockId: "L1", expiry: "2999-01-01T00:00:00Z" } })?.lockId).toBe("L1");
  });
});

describe("DojoEposService.recordPayment", () => {
  const body = { paymentIntentId: "pi_pat", paidAmount: { value: 1500, currencyCode: "GBP" } };

  it("verifies with Dojo, records a DOJO part-payment and settles through the shared path", async () => {
    const { epos, ctx, created, payments, client } = makeEpos();
    await epos.recordPayment(ctx, "ord-1", { ...body, tipsAmount: { value: 200, currencyCode: "GBP" } }, { waiterId: "w1" });
    expect(client.getPaymentIntent).toHaveBeenCalledWith("pi_pat");
    expect(created[0]).toMatchObject({
      provider: "DOJO",
      providerChargeId: "pi_pat",
      amount: 15,
      tipAmount: 2,
      status: "PROCESSING",
      metadata: { source: "dojo_pay_at_table", split: true, waiterId: "w1" },
    });
    expect(payments.settleCardPresentPayment).toHaveBeenCalledWith(created[0], "pi_pat");
  });

  it("refuses (so Dojo reverses) when Dojo's intent doesn't match the claimed amount", async () => {
    const client = fakeClient({
      getPaymentIntent: jest.fn().mockResolvedValue({ id: "pi_pat", status: "Captured", amount: { value: 1, currencyCode: "GBP" } }),
    });
    const { epos, ctx, created } = makeEpos({ client });
    await expect(epos.recordPayment(ctx, "ord-1", body, {})).rejects.toMatchObject({
      response: { errorType: "Conflict" },
    });
    expect(created).toHaveLength(0);
  });

  it("refuses paying more than is still owed", async () => {
    const { epos, ctx, created } = makeEpos({ paid: 20 }); // £10 left of £30
    await expect(epos.recordPayment(ctx, "ord-1", body, {})).rejects.toMatchObject({
      response: { errorType: "Conflict", debugMessage: expect.stringContaining("10.00") },
    });
    expect(created).toHaveLength(0);
  });

  it("is idempotent for a retried payment on the same order", async () => {
    const { epos, ctx, created, client } = makeEpos({ existingPayment: { orderId: "ord-1" } });
    await epos.recordPayment(ctx, "ord-1", body, {});
    expect(created).toHaveLength(0);
    expect(client.getPaymentIntent).not.toHaveBeenCalled();
  });

  it("refuses an intent already recorded against a different order", async () => {
    const { epos, ctx } = makeEpos({ existingPayment: { orderId: "ord-OTHER" } });
    await expect(epos.recordPayment(ctx, "ord-1", body, {})).rejects.toMatchObject({ response: { errorType: "Conflict" } });
  });

  it("refuses when Dojo can't be reached to verify", async () => {
    const client = fakeClient({ getPaymentIntent: jest.fn().mockRejectedValue(new Error("timeout")) });
    const { epos, ctx, created } = makeEpos({ client });
    await expect(epos.recordPayment(ctx, "ord-1", body, {})).rejects.toMatchObject({
      response: { errorType: "UnexpectedError" },
    });
    expect(created).toHaveLength(0);
  });
});


// ── Go-live checklist behaviours (docs.dojo.tech … pay-at-counter/go-live-checklist-f2f) ──

describe("Dojo go-live checklist", () => {
  const processing = {
    id: "pay-1",
    tenantId: "t-1",
    orderId: "ord-1",
    providerChargeId: "pi_new",
    amount: 24.5,
    tipAmount: 0,
    status: "PROCESSING",
    metadata: { terminalSessionId: "ts_1", source: "dojo_terminal" },
    order: { id: "ord-1", locationId: "loc-1" },
  };

  it("re-uses the payment intent when a declined charge is retried", async () => {
    const client = fakeClient({
      getPaymentIntent: jest.fn().mockResolvedValue({ id: "pi_old", status: "Created" }),
    });
    const { svc, prisma } = makeDojo({ client });
    prisma.payment.findMany.mockImplementation(async (q: any) =>
      q.where.status === "FAILED"
        ? [{ id: "pay-old", amount: 24.5, providerChargeId: "pi_old", metadata: { source: "dojo_terminal" } }]
        : [],
    );
    const res = await svc.chargeOrder({ tenantId: "t-1", orderId: "ord-1", terminalId: "tm_1" });
    expect(client.createPaymentIntent).not.toHaveBeenCalled();
    expect(client.createSaleSession).toHaveBeenCalledWith("tm_1", "pi_old");
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pay-old" }, data: expect.objectContaining({ status: "PROCESSING" }) }),
    );
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(res.paymentIntentId).toBe("pi_old");
  });

  it("explains a switched-off machine (404) in plain English", async () => {
    const client = fakeClient({ createSaleSession: jest.fn().mockRejectedValue(new DojoApiError("x", 404, null)) });
    const { svc } = makeDojo({ client });
    await expect(svc.chargeOrder({ tenantId: "t-1", orderId: "ord-1", terminalId: "tm_1" })).rejects.toThrow(
      /switched on and connected/,
    );
  });

  it("treats an Expired session as unconfirmed, not declined — and still settles if Dojo captured it", async () => {
    const expired = fakeClient({
      getTerminalSession: jest.fn().mockResolvedValue({ id: "ts_1", status: "Expired" }),
      getPaymentIntent: jest.fn().mockResolvedValue({ id: "pi_new", status: "Created" }),
    });
    const a = makeDojo({ client: expired, payment: { ...processing } });
    const s1 = await a.svc.chargeStatus("t-1", "pi_new");
    expect(s1).toMatchObject({ paid: false, failed: true, unconfirmed: true, message: expect.stringMatching(/record the payment manually/) });

    const capturedAnyway = fakeClient({
      getTerminalSession: jest.fn().mockResolvedValue({ id: "ts_1", status: "Expired" }),
    });
    const b = makeDojo({ client: capturedAnyway, payment: { ...processing } });
    expect((await b.svc.chargeStatus("t-1", "pi_new")).paid).toBe(true);
    expect(b.payments.settleCardPresentPayment).toHaveBeenCalled();
  });

  it("passes the card machine's current prompt to the till", async () => {
    const client = fakeClient({
      getTerminalSession: jest.fn().mockResolvedValue({
        id: "ts_1",
        status: "Initiated",
        notificationEvents: [
          { notificationType: "PresentCard", createdAt: "a" },
          { notificationType: "EnterPin", createdAt: "b" },
        ],
      }),
    });
    const { svc } = makeDojo({ client, payment: { ...processing } });
    expect((await svc.chargeStatus("t-1", "pi_new")).prompt).toBe("EnterPin");
  });

  it("records a tip added on the machine before settling", async () => {
    const client = fakeClient({
      getPaymentIntent: jest.fn().mockResolvedValue({
        id: "pi_new",
        status: "Captured",
        amount: { value: 2450, currencyCode: "GBP" },
        tipsAmount: { value: 300, currencyCode: "GBP" },
      }),
    });
    const { svc, prisma } = makeDojo({ client, payment: { ...processing } });
    await svc.chargeStatus("t-1", "pi_new");
    expect(prisma.payment.update).toHaveBeenCalledWith({ where: { id: "pay-1" }, data: { tipAmount: 3 } });
  });

  describe("refunds", () => {
    const paid = { ...processing, status: "SUCCEEDED" };

    it("refunds in full and marks the payment and order refunded", async () => {
      const { svc, client, prisma } = makeDojo({ payment: { ...paid } });
      prisma.payment.findMany.mockResolvedValue([{ amount: 24.5, status: "REFUNDED", metadata: {} }]);
      const r = await svc.refundPayment({ tenantId: "t-1", paymentIntentId: "pi_new" });
      expect(client.refundPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ paymentIntentId: "pi_new", amountMinor: 2450 }),
      );
      expect(r).toMatchObject({ full: true, amount: 24.5, leftToRefund: 0 });
      expect(prisma.order.update).toHaveBeenCalledWith({ where: { id: "ord-1" }, data: { paymentStatus: "REFUNDED" } });
    });

    it("refunds part and leaves the rest refundable", async () => {
      const { svc, prisma } = makeDojo({ payment: { ...paid } });
      prisma.payment.findMany.mockResolvedValue([{ amount: 24.5, status: "SUCCEEDED", metadata: { refundedMinor: 1000 } }]);
      const r = await svc.refundPayment({ tenantId: "t-1", paymentIntentId: "pi_new", amount: 10 });
      expect(r).toMatchObject({ full: false, amount: 10, leftToRefund: 14.5 });
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: "ord-1" },
        data: { paymentStatus: "PARTIALLY_REFUNDED" },
      });
    });

    it("never refunds more than is left", async () => {
      const { svc, client } = makeDojo({ payment: { ...paid, metadata: { ...paid.metadata, refundedMinor: 2000 } } });
      await expect(svc.refundPayment({ tenantId: "t-1", paymentIntentId: "pi_new", amount: 10 })).rejects.toThrow(
        /Only 4.50 is left/,
      );
      expect(client.refundPaymentIntent).not.toHaveBeenCalled();
    });
  });
});
