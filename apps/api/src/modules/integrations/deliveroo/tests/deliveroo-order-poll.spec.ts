// Deliveroo order polling — the only way a platform-delivery order closes.
//
// The rider webhook stops at pickup (see deliveroo-rider-collection.spec.ts),
// so this cron ASKS Deliveroo. It runs unattended against a live POS, so the
// tests below are mostly about what it must REFUSE to do.

import { DeliverooOrderPollService } from "../deliveroo-order-poll.service";

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
  const request = opts.get ?? jest.fn().mockResolvedValue({ status: "delivered" });
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
        get: jest.fn().mockResolvedValue({ status: raw }),
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
        get: jest.fn().mockResolvedValue({ status: raw }),
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
      get: jest.fn().mockResolvedValue({ status: "delivered" }),
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
  it("finds the status wherever Deliveroo puts it", async () => {
    // The webhook nests under body.order; the REST read is expected at the
    // top level. Docs have been wrong three times, so both are tried.
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
