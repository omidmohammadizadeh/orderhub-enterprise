// Deliveroo order polling — the only way a platform-delivery order closes.
//
// The rider webhook stops at pickup (see deliveroo-rider-collection.spec.ts),
// so this cron ASKS Deliveroo. It runs unattended against a live POS, so the
// tests below are mostly about what it must REFUSE to do.

import { DeliverooOrderPollService } from "../deliveroo-order-poll.service";

/**
 * The REAL shape of GET /order/v1/orders/{id}, captured from production on
 * 2026-08-17. It is an AUDIT TRAIL, not an order — there is no top-level
 * `status`, which is exactly why the first cut of the poller read nothing
 * and warned every two minutes for six hours.
 */
const trail = (...statuses: string[]) => ({
  order_id: "gb:f9c1378c",
  created_at: "2026-08-16T21:27:08Z",
  order_events: statuses.map((status) => ({ status })),
  order_sync_statuses: [],
  order_prep_stages: [],
});

const ORDER = {
  id: "o1",
  tenantId: "t1",
  externalId: "gb:f9c1378c",
  status: "OUT_FOR_DELIVERY",
  displayId: "5049",
};

function build(opts: {
  rows?: any[];
  get?: jest.Mock;
  update?: jest.Mock;
  configured?: boolean;
  flag?: boolean;
}) {
  const findMany = jest.fn().mockResolvedValue(opts.rows ?? [ORDER]);
  const update = opts.update ?? jest.fn().mockResolvedValue(undefined);
  const request =
    opts.get ?? jest.fn().mockResolvedValue(trail("placed", "accepted", "delivered"));
  const svc = new DeliverooOrderPollService(
    { get: jest.fn().mockReturnValue(opts.flag) } as any,
    { order: { findMany } } as any,
    { updateStatus: update } as any,
    { request, configured: opts.configured ?? true } as any,
  );
  return { svc, findMany, update, request };
}

describe("DeliverooOrderPollService — closing the order", () => {
  it("completes an order Deliveroo reports as delivered", async () => {
    const { svc, update } = build({});
    const res = await svc.pollOnce();

    expect(res).toEqual({ checked: 1, closed: 1 });
    expect(update).toHaveBeenCalledWith(
      "o1",
      "t1",
      { status: "COMPLETED" },
      "deliveroo-poll",
      // WEBHOOK, so the outbound sync doesn't echo it straight back.
      "WEBHOOK",
    );
  });

  it("maps Deliveroo's other terminal words too", async () => {
    for (const [raw, expected] of [
      ["succeeded", "COMPLETED"],
      ["canceled", "CANCELLED"],
      ["failed", "FAILED"],
      ["rejected", "REJECTED"],
    ]) {
      const { svc, update } = build({
        get: jest.fn().mockResolvedValue(trail("placed", "accepted", raw)),
      });
      await svc.pollOnce();
      expect(update).toHaveBeenCalledWith(
        "o1",
        "t1",
        { status: expected },
        "deliveroo-poll",
        "WEBHOOK",
      );
    }
  });
});

describe("DeliverooOrderPollService — what it must not do", () => {
  it("never writes an intermediate status (the webhooks own those)", async () => {
    // Polling these would race the webhook for the same transition and give
    // the board two sources of truth.
    for (const raw of ["in_kitchen", "ready_for_collection", "collected", "accepted"]) {
      const { svc, update } = build({
        get: jest.fn().mockResolvedValue(trail("placed", raw)),
      });
      const res = await svc.pollOnce();
      expect(update).not.toHaveBeenCalled();
      expect(res.closed).toBe(0);
    }
  });

  it("only asks about platform-courier orders inside the age bound", async () => {
    const { svc, findMany } = build({ rows: [] });
    await svc.pollOnce();

    const where = findMany.mock.calls[0][0].where;
    expect(where.platform).toBe("DELIVEROO");
    expect(where.integrationSource).toBe("DIRECT");
    expect(where.viaHubrise).toBe(false);
    expect(where.OR).toEqual([
      { deliveryType: "PLATFORM" },
      { fulfillmentType: "PLATFORM_COURIER" },
    ]);
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    // Terminal orders must never be re-opened.
    expect(where.status.in).not.toContain("COMPLETED");
    expect(where.status.in).not.toContain("CANCELLED");
  });

  it("survives a failed lookup without taking the tick down", async () => {
    const { svc, update } = build({
      get: jest.fn().mockRejectedValue(new Error("404 not found")),
    });
    await expect(svc.pollOnce()).resolves.toEqual({ checked: 1, closed: 0 });
    expect(update).not.toHaveBeenCalled();
  });

  it("survives a rejected transition", async () => {
    const { svc } = build({
      update: jest.fn().mockRejectedValue(new Error("illegal transition")),
    });
    await expect(svc.pollOnce()).resolves.toEqual({ checked: 1, closed: 0 });
  });

  it("does not re-write a status the order already has", async () => {
    const { svc, update } = build({
      rows: [{ ...ORDER, status: "COMPLETED" }],
      get: jest.fn().mockResolvedValue(trail("accepted", "delivered")),
    });
    await svc.pollOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps quiet when there is nothing in flight", async () => {
    const { svc, request } = build({ rows: [] });
    await expect(svc.pollOnce()).resolves.toEqual({ checked: 0, closed: 0 });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("DeliverooOrderPollService — reading the response", () => {
  it("reads the real audit-trail shape (order_events)", async () => {
    // The shape that broke the first cut: no top-level status at all.
    const { svc, update } = build({
      get: jest.fn().mockResolvedValue(trail("placed", "accepted", "delivered")),
    });
    await svc.pollOnce();
    expect(update).toHaveBeenCalled();
  });

  it("finds a terminal event even when it isn't the last one", async () => {
    // Same lesson as furthestRiderStage: ordering is Deliveroo's business.
    // Trusting the last entry is what left delivered orders stuck before.
    const { svc, update } = build({
      get: jest.fn().mockResolvedValue(trail("accepted", "delivered", "collected")),
    });
    await svc.pollOnce();
    expect(update).toHaveBeenCalledWith(
      "o1",
      "t1",
      { status: "COMPLETED" },
      "deliveroo-poll",
      "WEBHOOK",
    );
  });

  it("probes the field name inside an event", async () => {
    // The array is confirmed; the key inside each entry is not.
    for (const key of ["status", "event", "event_type", "type", "name", "state"]) {
      const { svc, update } = build({
        get: jest.fn().mockResolvedValue({
          order_id: "gb:1",
          order_events: [{ [key]: "delivered" }],
        }),
      });
      await svc.pollOnce();
      expect(update).toHaveBeenCalled();
    }
  });

  it("still falls back to the older flat shapes", async () => {
    for (const payload of [
      { status: "delivered" },
      { order: { status: "delivered" } },
      { body: { order: { status: "delivered" } } },
      { data: { status: "delivered" } },
      { order_status: "delivered" },
    ]) {
      const { svc, update } = build({ get: jest.fn().mockResolvedValue(payload) });
      await svc.pollOnce();
      expect(update).toHaveBeenCalled();
    }
  });

  it("warns ONCE per order, not every tick", async () => {
    // This warned every 2 minutes for six hours on order #4952 and buried
    // the log. An unreadable payload is one fact, not 180 of them.
    const { svc } = build({
      get: jest.fn().mockResolvedValue({ order_id: "gb:1", order_events: [] }),
    });
    const warn = jest.spyOn((svc as any).logger, "warn").mockImplementation();

    await svc.pollOnce();
    await svc.pollOnce();
    await svc.pollOnce();

    expect(warn).toHaveBeenCalledTimes(1);
    // And it must carry the evidence needed to fix it next time.
    expect(warn.mock.calls[0]![0]).toContain("order_events");
  });

  it("does nothing on an unreadable payload rather than guessing", async () => {
    const { svc, update } = build({
      get: jest.fn().mockResolvedValue({ some_new_field: "delivered" }),
    });
    await expect(svc.pollOnce()).resolves.toEqual({ checked: 1, closed: 0 });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("DeliverooOrderPollService — the off switch", () => {
  it("does nothing when Deliveroo isn't configured", async () => {
    const { svc, findMany } = build({ configured: false });
    await svc.run();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("stops on DELIVEROO_ORDER_POLL_ENABLED=false without a deploy", async () => {
    const { svc, findMany } = build({ flag: false });
    await svc.run();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("reads the flag under the namespaced key app.config actually sets", async () => {
    // A raw process.env read wouldn't survive ConfigModule's `validate`
    // step, so the off switch would silently never work.
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const svc = new DeliverooOrderPollService(
      config as any,
      { order: { findMany: jest.fn().mockResolvedValue([]) } } as any,
      {} as any,
      { request: jest.fn(), configured: true } as any,
    );
    await svc.run();
    expect(config.get).toHaveBeenCalledWith(
      "app.platforms.deliveroo.orderPollEnabled",
    );
  });

  it("runs when the flag is unset", async () => {
    const { svc, findMany } = build({ flag: undefined });
    await svc.run();
    expect(findMany).toHaveBeenCalled();
  });

  it("skips a tick while the previous one is still running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { svc, request } = build({
      get: jest.fn().mockImplementation(async () => {
        await gate;
        return { status: "delivered" };
      }),
    });

    const first = svc.run();
    await svc.run(); // overlapping tick — must be a no-op
    expect(request).toHaveBeenCalledTimes(1);

    release();
    await first;
  });
});

describe("DeliverooOrderPollService — completing on the rider's ETA", () => {
  // Deliveroo never reports a delivery: no rider_delivered across 1,755
  // events, no terminal order status in six weeks, and order_events still
  // held ACCEPTED alone 30 minutes after a rider had left. Their ETA is the
  // only per-order signal there is.
  const inTransit = (over: Record<string, any> = {}) => ({
    ...ORDER,
    status: "OUT_FOR_DELIVERY",
    ...over,
  });
  const minsFromNow = (m: number) => new Date(Date.now() + m * 60_000);
  /** Deliveroo has nothing terminal — the normal case for a live delivery. */
  const noTerminal = () => jest.fn().mockResolvedValue(trail("placed", "accepted"));

  it("completes once the ETA plus its grace period has passed", async () => {
    const { svc, update } = build({
      rows: [inTransit({ courierEtaAt: minsFromNow(-15) })],
      get: noTerminal(),
    });
    const res = await svc.pollOnce();

    expect(res.closed).toBe(1);
    expect(update).toHaveBeenCalledWith(
      "o1",
      "t1",
      { status: "COMPLETED" },
      "deliveroo-eta",
      // SYSTEM, not WEBHOOK — this is our estimate, not Deliveroo's word.
      "SYSTEM",
    );
  });

  it("waits while the order is still inside the grace period", async () => {
    // ETA passed 2 minutes ago; the 10-minute buffer hasn't elapsed.
    const { svc, update } = build({
      rows: [inTransit({ courierEtaAt: minsFromNow(-2) })],
      get: noTerminal(),
    });
    await svc.pollOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it("waits while the rider is still on the way", async () => {
    const { svc, update } = build({
      rows: [inTransit({ courierEtaAt: minsFromNow(20) })],
      get: noTerminal(),
    });
    await svc.pollOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it("NEVER completes an order the rider hasn't collected", async () => {
    // The dangerous case: completing food still sitting on the pass.
    for (const status of [
      "ACCEPTED",
      "PREPARING",
      "READY",
      "ASSIGNED_DRIVER",
      "RIDER_ARRIVED",
    ]) {
      const { svc, update } = build({
        rows: [inTransit({ status, courierEtaAt: minsFromNow(-120) })],
        get: noTerminal(),
      });
      await svc.pollOnce();
      expect(update).not.toHaveBeenCalled();
    }
  });

  // Deliveroo's only estimate is `estimated_arrival_time`, and it is the ride
  // to the SHOP: two production orders had it landing 3 and 7 minutes after
  // the rider was assigned. So by the time the food is collected that moment
  // has already passed, and ETA + 10 was completing the order on the board
  // the instant the rider left the door.
  it("ignores an ETA that predates the pickup — that is the shop leg", async () => {
    const { svc, update } = build({
      rows: [
        inTransit({
          // Rider reached the shop 12 minutes ago and collected 8 minutes
          // ago. ETA + grace is already past, but they are still driving.
          courierEtaAt: minsFromNow(-12),
          courierPickedUpAt: minsFromNow(-8),
        }),
      ],
      get: noTerminal(),
    });
    await svc.pollOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it("still closes it once the pickup clock runs out", async () => {
    const { svc, update } = build({
      rows: [
        inTransit({
          courierEtaAt: minsFromNow(-70),
          courierPickedUpAt: minsFromNow(-60),
        }),
      ],
      get: noTerminal(),
    });
    await svc.pollOnce();
    expect(update).toHaveBeenCalled();
  });

  it("honours a real drop-off ETA that falls after the pickup", async () => {
    const { svc, update } = build({
      rows: [
        inTransit({
          courierEtaAt: minsFromNow(-15),
          courierPickedUpAt: minsFromNow(-40),
        }),
      ],
      get: noTerminal(),
    });
    await svc.pollOnce();
    expect(update).toHaveBeenCalled();
  });

  it("falls back to pickup time when Deliveroo sent no ETA", async () => {
    const { svc, update } = build({
      rows: [
        inTransit({ courierEtaAt: null, courierPickedUpAt: minsFromNow(-60) }),
      ],
      get: noTerminal(),
    });
    await svc.pollOnce();
    expect(update).toHaveBeenCalled();
  });

  it("does nothing with neither an ETA nor a pickup time", async () => {
    // Nothing trustworthy to count from — leave it for the 05:00 rollover
    // rather than invent a delivery moment.
    const { svc, update } = build({
      rows: [inTransit({ courierEtaAt: null, courierPickedUpAt: null })],
      get: noTerminal(),
    });
    await svc.pollOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it("still prefers a real terminal status from Deliveroo over the estimate", async () => {
    // A cancellation must win — completing a cancelled order would be worse
    // than leaving it open.
    const { svc, update } = build({
      rows: [inTransit({ courierEtaAt: minsFromNow(-120) })],
      get: jest.fn().mockResolvedValue(trail("placed", "accepted", "canceled")),
    });
    await svc.pollOnce();
    expect(update).toHaveBeenCalledWith(
      "o1",
      "t1",
      { status: "CANCELLED" },
      "deliveroo-poll",
      "WEBHOOK",
    );
  });
});
