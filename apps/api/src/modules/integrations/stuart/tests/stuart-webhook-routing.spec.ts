import { StuartWebhookService } from "../stuart-webhook.service";

// Which order a Stuart update belongs to.
//
// One Stuart job can now carry several orders — a multi-drop run, one courier,
// up to 8 dropoffs — so every order on the run shares the job id. The handler
// used to find "the order with this job id" and apply the event to it, which
// on a run meant one arbitrary order took every update and the rest never
// moved: stuck on the board, customers never told their food was coming.
//
// These pin down the routing: each leg goes to its own order, jobs from before
// per-leg ids existed still work, and when an event doesn't say which leg it is
// on a run, nothing is guessed.

type Row = Record<string, any>;

function svcWith(rows: Row[]) {
  const updates: Array<{ id: string; data: Row }> = [];
  const matches = (o: Row, where: Row) =>
    Object.entries(where).every(([k, v]) =>
      v === null ? o[k] == null : o[k] === v,
    );
  const prisma: any = {
    order: {
      findFirst: jest.fn(async ({ where }: any) =>
        rows.find((o) => matches(o, where)) ?? null,
      ),
      findMany: jest.fn(async ({ where, take }: any) =>
        rows.filter((o) => matches(o, where)).slice(0, take ?? Infinity),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        updates.push({ id: where.id, data });
        return {};
      }),
    },
  };
  const orders = { updateStatus: jest.fn().mockResolvedValue({}) };
  const s: any = Object.create(StuartWebhookService.prototype);
  s.prisma = prisma;
  s.orders = orders;
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { s: s as StuartWebhookService, updates, orders };
}

const order = (id: string, over: Row = {}): Row => ({
  id,
  tenantId: "t1",
  status: "READY",
  courierProvider: "STUART",
  courierJobId: "job-1",
  courierDeliveryId: null,
  courierAssignedAt: null,
  courierPickedUpAt: null,
  courierDeliveredAt: null,
  ...over,
});

describe("Stuart webhook routing", () => {
  it("applies each leg of a run to its own order", async () => {
    const { s, updates } = svcWith([
      order("o1", { courierDeliveryId: "d1" }),
      order("o2", { courierDeliveryId: "d2" }),
    ]);

    await s.handle({
      data: {
        id: "job-1",
        status: "in_progress",
        deliveries: [
          { id: "d2", status: "delivering", tracking_url: "https://t/d2" },
          { id: "d1", status: "picking", tracking_url: "https://t/d1" },
        ],
      },
    });

    const byOrder = Object.fromEntries(updates.map((u) => [u.id, u.data]));
    expect(byOrder.o1).toMatchObject({
      courierStatus: "picking",
      courierTrackingUrl: "https://t/d1",
    });
    expect(byOrder.o2).toMatchObject({
      courierStatus: "delivering",
      courierTrackingUrl: "https://t/d2",
    });
  });

  it("routes a delivery event to the order for that leg, not the first on the job", async () => {
    const { s, updates, orders } = svcWith([
      order("o1", { courierDeliveryId: "d1" }),
      order("o2", { courierDeliveryId: "d2" }),
    ]);

    await s.handle({
      data: { id: "d2", status: "delivered", job: { id: "job-1" } },
    });

    expect(updates.map((u) => u.id)).toEqual(["o2"]);
    expect(orders.updateStatus).toHaveBeenCalledWith(
      "o2",
      "t1",
      expect.objectContaining({ status: "COMPLETED" }),
      "stuart-webhook",
      "WEBHOOK",
    );
  });

  it("still finds a job dispatched before per-leg ids were stored", async () => {
    // Legacy: courierDeliveryId was never written for this order.
    const { s, updates } = svcWith([order("o1")]);

    await s.handle({
      data: { id: "d9", status: "delivering", job: { id: "job-1" } },
    });

    expect(updates.map((u) => u.id)).toEqual(["o1"]);
  });

  it("still finds a single order from a job-level event with no legs listed", async () => {
    const { s, updates } = svcWith([order("o1", { courierDeliveryId: "d1" })]);

    await s.handle({ data: { id: "job-1", status: "in_progress" } });

    expect(updates.map((u) => u.id)).toEqual(["o1"]);
  });

  it("does not guess an order when a run's event names no leg", async () => {
    const { s, updates, orders } = svcWith([
      order("o1", { courierDeliveryId: "d1" }),
      order("o2", { courierDeliveryId: "d2" }),
    ]);

    const res = await s.handle({ data: { id: "job-1", status: "finished" } });

    expect(res).toEqual({ ok: true, reason: "order_not_found" });
    expect(updates).toHaveLength(0);
    // Above all: not every order on the run marked delivered off one event.
    expect(orders.updateStatus).not.toHaveBeenCalled();
  });

  it("gives each leg its own tracking link, never the job's", async () => {
    const { s, updates } = svcWith([
      order("o1", { courierDeliveryId: "d1" }),
      order("o2", { courierDeliveryId: "d2" }),
    ]);

    await s.handle({
      data: {
        id: "job-1",
        tracking_url: "https://t/whole-job",
        deliveries: [{ id: "d1", status: "picking" }, { id: "d2", status: "picking" }],
      },
    });

    for (const u of updates) {
      expect(u.data.courierTrackingUrl).toBeUndefined();
    }
  });

  it("shares the run's courier with every leg", async () => {
    const { s, updates } = svcWith([
      order("o1", { courierDeliveryId: "d1" }),
      order("o2", { courierDeliveryId: "d2" }),
    ]);

    await s.handle({
      data: {
        id: "job-1",
        driver: { name: "Ana Silva", phone: "+447700900123" },
        deliveries: [{ id: "d1", status: "picking" }, { id: "d2", status: "picking" }],
      },
    });

    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.data).toMatchObject({ courierName: "Ana Silva" });
    }
  });
});
