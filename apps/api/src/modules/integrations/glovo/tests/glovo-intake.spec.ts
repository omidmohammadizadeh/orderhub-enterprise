import { GlovoOrderService } from "../glovo-order.service";
import { GlovoWebhookController } from "../glovo-webhook.controller";
import { GlovoClientService } from "../glovo-client.service";
import {
  GLOVO_CANCELLATION,
  GLOVO_COURIER_ORDER,
} from "./glovo-order.fixtures";

// Order intake end to end, with Prisma faked in memory so the idempotency
// rules are exercised against real state rather than mocked return values.
//
// The invariants:
//   1. A redelivered webhook NEVER creates a second order.
//   2. A delivery we FAILED is processed again when Glovo retries it (5xx).
//   3. A notification naming another store cannot touch this store's order.
//   4. A wrong token is refused.

const CONN = {
  id: "conn-1",
  tenantId: "tenant-1",
  brandId: "brand-1",
  locationId: "loc-1",
  externalStoreId: "OH-TESTSTORE1",
};
const OTHER_CONN = {
  id: "conn-2",
  tenantId: "tenant-2",
  brandId: "brand-2",
  locationId: "loc-2",
  externalStoreId: "OH-OTHER",
};

function makeWorld(opts: { ingestFails?: number; token?: string } = {}) {
  const events = new Map<string, any>();
  const orders: any[] = [];
  let failuresLeft = opts.ingestFails ?? 0;
  const key = (w: any) => `${w.platform_externalEventId.platform}|${w.platform_externalEventId.externalEventId}`;

  const prisma: any = {
    webhookEvent: {
      findUnique: jest.fn(async ({ where }: any) => events.get(key(where)) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const k = `${data.platform}|${data.externalEventId}`;
        if (events.has(k)) throw Object.assign(new Error("dup"), { code: "P2002" });
        events.set(k, { ...data, processedAt: data.processedAt ?? null, retryCount: 0 });
        return events.get(k);
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = events.get(key(where));
        if (!row) throw new Error("not found");
        Object.assign(row, data.retryCount ? {} : data);
        return row;
      }),
    },
    brandPlatformConnection: {
      findFirst: jest.fn(async ({ where }: any) =>
        [CONN, OTHER_CONN].find((c) => c.externalStoreId === where.externalStoreId) ?? null,
      ),
      update: jest.fn(async () => ({})),
    },
    order: {
      findFirst: jest.fn(async ({ where }: any) =>
        orders.find((o) => o.externalId === where.externalId) ?? null,
      ),
      update: jest.fn(async () => ({})),
    },
    location: { findUnique: jest.fn(async () => ({ country: "ES" })) },
  };

  const ordersService: any = {
    ingestCanonical: jest.fn(async (canonical: any, tenantId: string, locationId: string) => {
      if (failuresLeft > 0) {
        failuresLeft--;
        throw new Error("database hiccup");
      }
      // Mirrors Order's @@unique([externalId, platform]): a repeat returns the row.
      const hit = orders.find((o) => o.externalId === canonical.externalId);
      if (hit) return hit;
      const row = {
        id: `order-${orders.length + 1}`,
        externalId: canonical.externalId,
        tenantId,
        locationId,
        brandId: canonical.brandId,
        status: "PENDING",
        displayId: canonical.displayId,
      };
      orders.push(row);
      return row;
    }),
    updateStatus: jest.fn(async (id: string, _t: string, dto: any) => {
      const o = orders.find((x) => x.id === id);
      if (o) o.status = dto.status;
      return o;
    }),
  };

  const activity = { record: jest.fn() };
  const service = new GlovoOrderService(prisma, ordersService, activity as any);
  const config: any = {
    get: (k: string) =>
      ({ "app.platforms.glovo.apiToken": opts.token ?? "secret-token" } as Record<string, string>)[k],
  };
  const client = new GlovoClientService(config);
  const controller = new GlovoWebhookController(client, service);

  const post = async (kind: "dispatched" | "picked_up" | "cancelled", body: any, auth = "secret-token") => {
    const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; } };
    const req: any = { rawBody: Buffer.from(JSON.stringify(body)), body };
    const out = await controller.handle(kind, req, res, auth);
    return { status: res.statusCode, body: out };
  };

  return { prisma, ordersService, orders, events, post, service, activity };
}

describe("Glovo dispatched webhook — idempotent intake", () => {
  it("creates the order at the connection's tenant/location/brand and answers 200", async () => {
    const w = makeWorld();
    const r = await w.post("dispatched", GLOVO_COURIER_ORDER);
    expect(r.status).toBe(200);
    expect(w.orders).toHaveLength(1);
    expect(w.orders[0]).toEqual(
      expect.objectContaining({ tenantId: "tenant-1", locationId: "loc-1", brandId: "brand-1" }),
    );
  });

  it("a redelivery of a processed order does NOT ingest again", async () => {
    const w = makeWorld();
    await w.post("dispatched", GLOVO_COURIER_ORDER);
    const again = await w.post("dispatched", GLOVO_COURIER_ORDER);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(expect.objectContaining({ duplicate: true }));
    expect(w.ordersService.ingestCanonical).toHaveBeenCalledTimes(1);
    expect(w.orders).toHaveLength(1);
  });

  it("a FAILED ingest answers 500, and Glovo's retry is processed rather than skipped", async () => {
    const w = makeWorld({ ingestFails: 1 });
    const first = await w.post("dispatched", GLOVO_COURIER_ORDER);
    expect(first.status).toBe(500);
    expect(w.orders).toHaveLength(0);
    const retry = await w.post("dispatched", GLOVO_COURIER_ORDER);
    expect(retry.status).toBe(200);
    expect(w.orders).toHaveLength(1);
  });

  it("an unknown store_id answers 200 (a retry cannot fix routing) and creates nothing", async () => {
    const w = makeWorld();
    const r = await w.post("dispatched", { ...GLOVO_COURIER_ORDER, store_id: "NOPE" });
    expect(r.status).toBe(200);
    expect(w.orders).toHaveLength(0);
  });

  it("a wrong token is a 401 and nothing is ingested", async () => {
    const w = makeWorld();
    const r = await w.post("dispatched", GLOVO_COURIER_ORDER, "wrong");
    expect(r.status).toBe(401);
    expect(w.ordersService.ingestCanonical).not.toHaveBeenCalled();
  });

  it("persists the raw envelope for shape verification", async () => {
    const w = makeWorld();
    await w.post("dispatched", GLOVO_COURIER_ORDER);
    const row = w.events.get("GLOVO|dispatched:12345");
    expect(row.rawPayload).toEqual(GLOVO_COURIER_ORDER);
    expect(row.processedAt).toBeInstanceOf(Date);
  });
});

describe("Glovo cancelled webhook — scoped to the store that owns the order", () => {
  it("cancels the order with Glovo's reason in words", async () => {
    const w = makeWorld();
    await w.post("dispatched", GLOVO_COURIER_ORDER);
    const r = await w.post("cancelled", GLOVO_CANCELLATION);
    expect(r.status).toBe(200);
    expect(w.ordersService.updateStatus).toHaveBeenCalledWith(
      "order-1",
      "tenant-1",
      expect.objectContaining({ status: "CANCELLED", cancelReason: expect.stringContaining("customer cancelled") }),
      "glovo-cancel-webhook",
      "WEBHOOK",
    );
  });

  it("a cancellation naming ANOTHER store cannot touch this store's order", async () => {
    const w = makeWorld();
    await w.post("dispatched", GLOVO_COURIER_ORDER);
    await w.post("cancelled", { ...GLOVO_CANCELLATION, store_id: "OH-OTHER" });
    expect(w.ordersService.updateStatus).not.toHaveBeenCalled();
    expect(w.orders[0].status).toBe("PENDING");
  });
});

describe("Glovo picked-up webhook", () => {
  it("moves the order to OUT_FOR_DELIVERY as a WEBHOOK actor", async () => {
    const w = makeWorld();
    await w.post("dispatched", GLOVO_COURIER_ORDER);
    await w.post("picked_up", GLOVO_COURIER_ORDER);
    expect(w.ordersService.updateStatus).toHaveBeenCalledWith(
      "order-1",
      "tenant-1",
      { status: "OUT_FOR_DELIVERY" },
      "glovo-picked-up-webhook",
      "WEBHOOK",
    );
  });

  it("ingests the order from the picked-up copy when dispatched never arrived", async () => {
    const w = makeWorld();
    await w.post("picked_up", GLOVO_COURIER_ORDER);
    expect(w.orders).toHaveLength(1);
  });
});
