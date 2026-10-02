import { Test } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { Global, Module } from "@nestjs/common";
import { PrismaService } from "../../../../infrastructure/database/prisma.service";
import { TalabatModule } from "../talabat.module";
import { TalabatController } from "../talabat.controller";
import { TalabatPluginController } from "../talabat-plugin.controller";
import { TalabatSandboxController } from "../talabat-sandbox.controller";
import { TalabatOrderSyncService } from "../talabat-order-sync.service";
import { TalabatOrderService } from "../talabat-order.service";
import { TalabatApiError } from "../talabat-client.service";
import { GENERIC_ORDER_EXAMPLE } from "./talabat-spec-examples";

@Global()
@Module({ providers: [{ provide: PrismaService, useValue: {} }], exports: [PrismaService] })
class FakePrismaModule {}

jest.mock("../../../orders/orders.module", () => {
  const { Module } = jest.requireActual("@nestjs/common");
  const { OrdersService } = jest.requireActual("../../../orders/orders.service");
  @Module({ providers: [{ provide: OrdersService, useValue: {} }], exports: [OrdersService] })
  class OrdersModule {}
  return { OrdersModule };
});

describe("TalabatModule wiring", () => {
  it("resolves every provider and controller", async () => {
    const mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), EventEmitterModule.forRoot(), FakePrismaModule, TalabatModule],
    }).compile();
    expect(mod.get(TalabatController)).toBeDefined();
    expect(mod.get(TalabatPluginController)).toBeDefined();
    expect(mod.get(TalabatSandboxController)).toBeDefined();
    expect(mod.get(TalabatOrderSyncService)).toBeDefined();
  });
});

const CONN = {
  id: "conn1",
  tenantId: "t1",
  brandId: "b1",
  locationId: "l1",
  status: "connected",
  externalStoreId: "OH-1",
  metadata: { chainCode: "chain-ae" },
};

function intake(over: { existing?: any; ingest?: jest.Mock } = {}) {
  const prisma: any = {
    order: { findFirst: jest.fn().mockResolvedValue(over.existing ?? null), update: jest.fn() },
    webhookEvent: { create: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
    location: { findUnique: jest.fn().mockResolvedValue({ country: "AE" }) },
    brand: { findMany: jest.fn().mockResolvedValue([{ id: "b1" }]) },
    menuItem: { findMany: jest.fn().mockResolvedValue([]) },
    brandPlatformConnection: { update: jest.fn().mockResolvedValue({}) },
  };
  const orders: any = {
    ingestCanonical: over.ingest ?? jest.fn().mockResolvedValue({ id: "ord_1" }),
    updateStatus: jest.fn().mockResolvedValue({}),
  };
  const connections: any = { byRemoteId: jest.fn(async (id: string) => (id === "OH-1" ? CONN : null)) };
  return { svc: new TalabatOrderService(prisma, orders, connections), prisma, orders };
}

describe("Talabat dispatch", () => {
  it("persists, then acks with remoteResponse.remoteOrderId = our order id", async () => {
    const { svc, orders } = intake();
    const res = await svc.dispatch("OH-1", GENERIC_ORDER_EXAMPLE);
    expect(res).toEqual({ httpStatus: 200, body: { remoteResponse: { remoteOrderId: "ord_1" } }, orderId: "ord_1" });
    const [canonical, tenantId, locationId, opts] = orders.ingestCanonical.mock.calls[0];
    expect(canonical.brandId).toBe("b1");
    expect([tenantId, locationId]).toEqual(["t1", "l1"]);
    expect(opts).toEqual({ isSandbox: false });
  });

  it("a test order is ingested as sandbox (kept out of sales)", async () => {
    const { svc, orders } = intake();
    await svc.dispatch("OH-1", { ...GENERIC_ORDER_EXAMPLE, test: true });
    expect(orders.ingestCanonical.mock.calls[0][3]).toEqual({ isSandbox: true });
  });

  it("a retried dispatch acks with the SAME id and does not ingest twice", async () => {
    const { svc, orders } = intake({ existing: { id: "ord_9", tenantId: "t1", locationId: "l1" } });
    const res = await svc.dispatch("OH-1", GENERIC_ORDER_EXAMPLE);
    expect(res.body).toEqual({ remoteResponse: { remoteOrderId: "ord_9" } });
    expect(orders.ingestCanonical).not.toHaveBeenCalled();
  });

  it("an unknown remoteId is a 400 with a valid reject reason", async () => {
    const { svc } = intake();
    const res = await svc.dispatch("NOPE", GENERIC_ORDER_EXAMPLE);
    expect(res.httpStatus).toBe(400);
    expect(res.body.reason).toBe("MENU_ACCOUNT_SETTINGS");
  });

  it("a failed ingest is a 500 so the middleware retries", async () => {
    const { svc } = intake({ ingest: jest.fn().mockRejectedValue(new Error("db down")) });
    const res = await svc.dispatch("OH-1", GENERIC_ORDER_EXAMPLE);
    expect(res.httpStatus).toBe(500);
  });
});

describe("Talabat order sync", () => {
  const callbackUrls = {
    orderAcceptedUrl: "https://integration-middleware.stg.restaurant-partners.com/v2/order/status/tok",
    orderRejectedUrl: "https://integration-middleware.stg.restaurant-partners.com/v2/order/status/tok",
    orderPreparedUrl: "https://integration-middleware.stg.restaurant-partners.com/v2/orders/tok/preparation-completed",
    orderPickedUpUrl: null,
  };
  function sync(order: any, client: any) {
    const prisma: any = {
      order: {
        findFirst: jest.fn().mockResolvedValue(order),
        findUnique: jest.fn().mockResolvedValue({ metadata: order.metadata }),
        update: jest.fn().mockResolvedValue({}),
      },
      webhookEvent: { create: jest.fn().mockResolvedValue({}), delete: jest.fn().mockResolvedValue({}) },
      brandPlatformConnection: { findFirst: jest.fn().mockResolvedValue({ metadata: {} }) },
    };
    return { svc: new TalabatOrderSyncService(prisma, client), prisma };
  }
  const base = (status: string, talabat: any = {}) => ({
    id: "ord_1",
    tenantId: "t1",
    locationId: "l1",
    brandId: "b1",
    displayId: "TB-42",
    externalId: "tok",
    status,
    failureReason: null,
    cancelReason: null,
    metadata: {
      talabat: { token: "tok", kind: "OWN_DELIVERY", riderPickupTime: new Date(Date.now() + 20 * 60_000).toISOString(), callbackUrls, ...talabat },
    },
  });

  it("READY on an un-accepted order sends accept THEN prepared", async () => {
    const client = { callback: jest.fn().mockResolvedValue({ status: 200, data: {} }) };
    const { svc } = sync(base("READY"), client);
    const res = await svc.sync("ord_1", "t1");
    expect(res.sent).toEqual(["accept", "prepared"]);
    expect(client.callback.mock.calls[0][1]).toMatchObject({ status: "order_accepted", remoteOrderId: "ord_1" });
    expect(client.callback.mock.calls[1][0]).toBe(callbackUrls.orderPreparedUrl);
  });

  it("no orderAcceptedUrl (indirect integration) = nothing sent", async () => {
    const client = { callback: jest.fn() };
    const { svc } = sync(base("ACCEPTED", { callbackUrls: {} }), client);
    expect((await svc.sync("ord_1", "t1")).sent).toEqual([]);
    expect(client.callback).not.toHaveBeenCalled();
  });

  it("a cancel before accepting rejects with a mapped reason", async () => {
    const client = { callback: jest.fn().mockResolvedValue({ status: 200, data: {} }) };
    const order = { ...base("CANCELLED"), cancelReason: "Sold out of wings" };
    const { svc } = sync(order, client);
    expect((await svc.sync("ord_1", "t1")).sent).toEqual(["reject"]);
    expect(client.callback.mock.calls[0][1]).toMatchObject({ status: "order_rejected", reason: "ITEM_UNAVAILABLE" });
  });

  it("a cancel AFTER accepting with a before-only reason is NOT sent (staff told to call)", async () => {
    const client = { callback: jest.fn() };
    const order = { ...base("CANCELLED", { sent: { accept: "2026-10-02T10:00:00Z" } }), cancelReason: "too busy" };
    const { svc } = sync(order, client);
    expect((await svc.sync("ord_1", "t1")).sent).toEqual([]);
    expect(client.callback).not.toHaveBeenCalled();
  });

  it("an accept refused by a non-retryable error releases the latch", async () => {
    const client = {
      callback: jest.fn().mockRejectedValue(new TalabatApiError(400, '{"code":"INVALID_REQUEST"}', "POST", "/x")),
    };
    const { svc, prisma } = sync(base("ACCEPTED"), client);
    await svc.sync("ord_1", "t1");
    expect(prisma.webhookEvent.delete).toHaveBeenCalled();
  });

  it("AWT prep-time refuses a time outside the order's window", async () => {
    const order = base("ACCEPTED", {
      callbackUrls: { ...callbackUrls, orderPreparationTimeAdjustmentUrl: "https://integration-middleware.stg.restaurant-partners.com/v2/orders/tok/adjust-preparation-time" },
      riderPickupTime: "2026-10-02T12:20:00.000Z",
      prepTime: { minPickUpTimestamp: "2026-10-02T12:10:00.000Z", maxPickUpTimestamp: "2026-10-02T12:40:00.000Z" },
    });
    const client = { callback: jest.fn().mockResolvedValue({ status: 204, data: null }) };
    const { svc } = sync(order, client);
    await expect(svc.adjustPrepTime("t1", "ord_1", { minutes: 30 })).rejects.toThrow(/after/);
    await expect(svc.adjustPrepTime("t1", "ord_1", { minutes: 10 })).resolves.toEqual({ expectedPickupAt: "2026-10-02T12:30:00.000Z" });
    expect(client.callback.mock.calls[0][1]).toEqual({ expectedPickupAt: "2026-10-02T12:30:00.000Z" });
  });
});
