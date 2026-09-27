import { KeetaAuthService } from "../keeta-auth.service";
import { KeetaOrderService } from "../keeta-order.service";
import { KeetaOrderSyncService } from "../keeta-order-sync.service";
import { KeetaWebhookController } from "../keeta-webhook.controller";
import { KeetaWebhookLogService } from "../keeta-webhook-log.service";

const conn = {
  id: "conn-1",
  tenantId: "t-1",
  brandId: "brand-1",
  locationId: "loc-1",
  externalStoreId: "611469",
  metadata: { keetaAuthorizationId: "auth-1" },
  location: { country: "AE" },
};

const info = {
  baseOrder: { orderViewId: 756823555555859, payType: "applepay" },
  merchantOrder: { orderViewId: 756823555555859, shopId: 611469, userGetMode: "delivery", seqNoStr: "12" },
  merchantOrderDeliveries: [{ deliveryMode: "1001" }],
  recipientInfo: { name: "ENC_x", phone: "ENC_y", interCode: "+971" },
  feeDtl: { customerFee: { i18n: { currency: "AED" }, productPrice: 3000, payTotal: 3000 } },
  products: [{ name: "Burger", count: 1, price: 3000, currency: "AED", spuOpenItemCode: "item-1" }],
};

function buildOrderService(opts: { connection?: any; existing?: any } = {}) {
  const prisma = {
    brandPlatformConnection: {
      findFirst: jest.fn().mockResolvedValue(opts.connection === undefined ? conn : opts.connection),
      update: jest.fn().mockResolvedValue({}),
    },
    order: {
      findFirst: jest.fn().mockResolvedValue(opts.existing ?? null),
      findUnique: jest.fn().mockResolvedValue({ metadata: {} }),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
  const orders = {
    ingestCanonical: jest.fn().mockResolvedValue({ id: "our-1" }),
    updateStatus: jest.fn().mockResolvedValue({}),
  } as any;
  const client = { batchDecrypt: jest.fn() } as any;
  const auth = { tokenForConnection: jest.fn().mockResolvedValue("tok") } as any;
  return { svc: new KeetaOrderService(prisma, orders, client, auth), prisma, orders, client };
}

describe("KeetaOrderService.ingest", () => {
  it("routes by Keeta shopId to the mapped brand × location, pinned to that brand", async () => {
    const { svc, orders } = buildOrderService();
    const r = await svc.ingest(info as any);
    expect(r).toEqual({ orderId: "our-1", retry: false });
    const [canonical, tenantId, locationId] = orders.ingestCanonical.mock.calls[0];
    expect(tenantId).toBe("t-1");
    expect(locationId).toBe("loc-1");
    expect(canonical.brandId).toBe("brand-1");
    expect(canonical.platform).toBe("KEETA");
    expect(canonical.deliveryType).toBe("PLATFORM");
  });

  it("does not try to decrypt a Keeta-rider order — Keeta would refuse", async () => {
    const { svc, client } = buildOrderService();
    await svc.ingest(info as any);
    expect(client.batchDecrypt).not.toHaveBeenCalled();
  });

  it("decrypts the customer for a self-delivery order", async () => {
    const { svc, client, orders } = buildOrderService();
    client.batchDecrypt.mockResolvedValue(new Map([["ENC_x", "Sara"], ["ENC_y", "501112222"]]));
    await svc.ingest({ ...info, merchantOrderDeliveries: [{ deliveryMode: "9001" }] } as any);
    expect(client.batchDecrypt).toHaveBeenCalledWith("tok", "611469", ["ENC_x", "ENC_y"]);
    expect(orders.ingestCanonical.mock.calls[0][0].customerInfo).toEqual({ name: "Sara", phone: "+971501112222" });
  });

  it("still lands the order when decryption fails", async () => {
    const { svc, client, orders } = buildOrderService();
    client.batchDecrypt.mockRejectedValue(new Error("not allowed"));
    const r = await svc.ingest({ ...info, merchantOrderDeliveries: [{ deliveryMode: "9001" }] } as any);
    expect(r.orderId).toBe("our-1");
    expect(orders.ingestCanonical.mock.calls[0][0].customerInfo.name).toBe("Keeta customer");
  });

  it("drops an order for an unmapped store without asking Keeta to retry", async () => {
    const { svc, orders } = buildOrderService({ connection: null });
    expect(await svc.ingest(info as any)).toEqual({ retry: false, reason: "unmapped_shop" });
    expect(orders.ingestCanonical).not.toHaveBeenCalled();
  });

  it("treats a redelivery as a duplicate", async () => {
    const { svc, orders } = buildOrderService({ existing: { id: "our-1" } });
    expect(await svc.ingest(info as any)).toMatchObject({ orderId: "our-1", reason: "duplicate" });
    expect(orders.ingestCanonical).not.toHaveBeenCalled();
  });

  it("asks for a retry when saving fails", async () => {
    const { svc, orders } = buildOrderService();
    orders.ingestCanonical.mockRejectedValue(new Error("db down"));
    expect(await svc.ingest(info as any)).toMatchObject({ retry: true });
  });
});

describe("KeetaOrderService inbound status", () => {
  const found = (status: string) => ({ id: "our-1", tenantId: "t-1", status, locationId: "loc-1", brandId: "b", metadata: {} });

  it("accepts from 1002 only while pending", async () => {
    const { svc, prisma, orders } = buildOrderService();
    prisma.order.findFirst.mockResolvedValue(found("PENDING"));
    await svc.onAccepted({ orderViewId: "1" });
    expect(orders.updateStatus).toHaveBeenCalledWith("our-1", "t-1", { status: "ACCEPTED" }, "keeta", "WEBHOOK");
    orders.updateStatus.mockClear();
    prisma.order.findFirst.mockResolvedValue(found("READY"));
    await svc.onAccepted({ orderViewId: "1" });
    expect(orders.updateStatus).not.toHaveBeenCalled();
  });

  it("leaves a completed order completed when Keeta cancel it after the fact", async () => {
    const { svc, prisma, orders } = buildOrderService();
    prisma.order.findFirst.mockResolvedValue(found("COMPLETED"));
    await svc.onCancelled({ orderViewId: "1", opType: 30, cancelReason: "refund" });
    expect(orders.updateStatus).not.toHaveBeenCalled();
    expect(prisma.order.update.mock.calls[0][0].data.metadata.keetaLateCancel.reason).toContain("customer service");
  });

  it("cancels an open order with who and why", async () => {
    const { svc, prisma, orders } = buildOrderService();
    prisma.order.findFirst.mockResolvedValue(found("PREPARING"));
    await svc.onCancelled({ orderViewId: "1", opType: 10, cancelReason: "changed mind" });
    expect(orders.updateStatus.mock.calls[0][2]).toEqual({
      status: "CANCELLED",
      cancelReason: "Cancelled by the customer: changed mind",
    });
  });

  it("mirrors the rider onto the board", async () => {
    const { svc, prisma, orders } = buildOrderService();
    prisma.order.findFirst.mockResolvedValue(found("READY"));
    await svc.onDeliveryStatus({ orderViewId: "1", logisticsStatus: 30, courierName: "Ali" });
    expect(prisma.order.update.mock.calls[0][0].data).toMatchObject({ courierName: "Ali", courierStatus: "KEETA_30" });
    expect(orders.updateStatus.mock.calls[0][2]).toEqual({ status: "OUT_FOR_DELIVERY" });
  });

  it("records a refund request with the 15-minute deadline", async () => {
    const { svc, prisma } = buildOrderService();
    prisma.order.findFirst.mockResolvedValue({ ...found("COMPLETED"), metadata: { currency: "AED" } });
    await svc.onRefund("full", {
      orderViewId: "1",
      afterSaleOrderId: 99,
      status: 1001,
      money: 2600,
      currency: "AED",
      opTime: 1_700_000_000_000,
      pictures: '["https://x/1.jpg"]',
    });
    const refunds = prisma.order.update.mock.calls[0][0].data.metadata.keetaRefunds;
    expect(refunds[0]).toMatchObject({
      afterSaleOrderId: "99",
      amount: 26,
      pictures: ["https://x/1.jpg"],
      respondBy: new Date(1_700_000_000_000 + 15 * 60_000).toISOString(),
    });
  });
});

describe("KeetaOrderSyncService", () => {
  const build = (order: any) => {
    const prisma = {
      order: {
        findFirst: jest.fn().mockResolvedValue(order),
        findUnique: jest.fn().mockResolvedValue({ metadata: order?.metadata ?? {} }),
        update: jest.fn().mockResolvedValue({}),
      },
      brandPlatformConnection: { findFirst: jest.fn().mockResolvedValue(conn) },
    } as any;
    const client = { configured: true, request: jest.fn().mockResolvedValue({}) } as any;
    const auth = { tokenForConnection: jest.fn().mockResolvedValue("tok") } as any;
    return { svc: new KeetaOrderSyncService(prisma, client, auth), client, prisma };
  };
  const keetaOrder = (status: string, meta: Record<string, unknown> = {}) => ({
    id: "our-1",
    tenantId: "t-1",
    locationId: "loc-1",
    externalId: "12345678901234567",
    status,
    fulfillmentType: "PLATFORM_COURIER",
    metadata: { keetaShopId: "611469", deliveryType: "PLATFORM", ...meta },
  });

  it("confirms with the exact 64-bit id", async () => {
    const { svc, client } = build(keetaOrder("ACCEPTED"));
    await svc.onStatusChanged({ orderId: "our-1", tenantId: "t-1", actorType: "STAFF" });
    const [path, fields, opts] = client.request.mock.calls[0];
    expect(path).toBe("/order/confirm");
    expect(String(fields.orderViewId)).toBe("12345678901234567");
    expect(opts.accessToken).toBe("tok");
  });

  it("never echoes a webhook-driven change back to Keeta", async () => {
    const { svc, client } = build(keetaOrder("ACCEPTED"));
    await svc.onStatusChanged({ orderId: "our-1", tenantId: "t-1", actorType: "WEBHOOK" });
    expect(client.request).not.toHaveBeenCalled();
  });

  it("sends each call once — Keeta reject duplicates", async () => {
    const { svc, client } = build(keetaOrder("ACCEPTED", { keetaPushed: { confirm: "2026-01-01" } }));
    await svc.onStatusChanged({ orderId: "our-1", tenantId: "t-1" });
    expect(client.request).not.toHaveBeenCalled();
  });

  it("never throws into our own status change", async () => {
    const { svc, client } = build(keetaOrder("READY"));
    client.request.mockRejectedValue(new Error("boom"));
    await expect(svc.onStatusChanged({ orderId: "our-1", tenantId: "t-1" })).resolves.toBeUndefined();
  });
});

describe("KeetaAuthService state", () => {
  const svc = () =>
    new KeetaAuthService(
      {} as any,
      { webhookSecret: () => "secret", configured: true } as any,
      { encrypt: (x: any) => x, decrypt: (x: any) => x } as any,
    );

  it("round-trips a signed state", () => {
    const s = svc();
    const st = s.signState({ tenantId: "t-1", brandId: "b", locationId: "l" });
    expect(s.verifyState(st)).toMatchObject({ tenantId: "t-1", brandId: "b", locationId: "l" });
  });

  it("rejects a tampered state — it decides which tenant a Keeta brand attaches to", () => {
    const s = svc();
    const [body, mac] = s.signState({ tenantId: "t-1" }).split(".");
    const forged = Buffer.from(JSON.stringify({ tenantId: "attacker", exp: Date.now() + 60_000, nonce: "x" })).toString(
      "base64url",
    );
    expect(s.verifyState(`${forged}.${mac}`)).toBeNull();
    expect(s.verifyState(`${body}.AAAA`)).toBeNull();
    expect(s.verifyState("")).toBeNull();
  });
});

describe("KeetaWebhookController", () => {
  const build = () => {
    const prisma = {
      webhookEvent: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
    } as any;
    const config = { get: (k: string) => (k === "app.apiUrl" ? "https://api.example.com" : "") } as any;
    const client = { appId: "3762772727", webhookSecret: () => "secret" } as any;
    const orders = {
      ingest: jest.fn().mockResolvedValue({ orderId: "o", retry: false }),
      onAccepted: jest.fn(),
    } as any;
    const ctrl = new KeetaWebhookController(
      prisma,
      config,
      client,
      {} as any,
      orders,
      {} as any,
      {} as any,
      new KeetaWebhookLogService(),
    );
    return { ctrl, orders, prisma };
  };
  const req = (body: unknown) =>
    ({ rawBody: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)), headers: {}, ip: "1.2.3.4" }) as any;

  it("answers an empty heartbeat with success", async () => {
    const { ctrl } = build();
    expect(await ctrl.webhook(req(""))).toMatchObject({ code: 0 });
  });

  it("unwraps the JSON-string message and routes 1001 to intake with a 64-bit-safe id", async () => {
    const { ctrl, orders } = build();
    const message = `{"orderInfo":{"merchantOrder":{"orderViewId":12345678901234567,"shopId":611469}}}`;
    const res = await ctrl.webhook(
      req(`{"eventId":1001,"appId":3762772727,"messageId":"m1","shopId":611469,"message":${JSON.stringify(message)},"timestamp":1}`),
    );
    expect(res).toMatchObject({ code: 0 });
    expect(orders.ingest.mock.calls[0][0].merchantOrder.orderViewId).toBe("12345678901234567");
  });

  it("asks Keeta to retry a new order we failed to save", async () => {
    const { ctrl, orders } = build();
    orders.ingest.mockResolvedValue({ retry: true, reason: "ingest_failed" });
    const res = await ctrl.webhook(
      req({ eventId: 1001, appId: 3762772727, messageId: "m2", message: JSON.stringify({ orderInfo: { merchantOrder: {} } }) }),
    );
    expect(res.code).not.toBe(0);
  });

  it("ignores an event for someone else's app", async () => {
    const { ctrl, orders } = build();
    await ctrl.webhook(req({ eventId: 1002, appId: 999, messageId: "m3", message: '{"orderViewId":1}' }));
    expect(orders.onAccepted).not.toHaveBeenCalled();
  });

  it("skips a redelivery of an event already processed", async () => {
    const { ctrl, orders, prisma } = build();
    prisma.webhookEvent.findUnique.mockResolvedValue({ processedAt: new Date(), processingError: null });
    await ctrl.webhook(req({ eventId: 1002, appId: 3762772727, messageId: "m4", message: '{"orderViewId":1}' }));
    expect(orders.onAccepted).not.toHaveBeenCalled();
  });
});
