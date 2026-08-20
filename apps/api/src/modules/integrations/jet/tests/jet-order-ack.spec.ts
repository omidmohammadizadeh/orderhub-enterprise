import { JetOrderAckService } from "../jet-order-ack.service";

// The async acknowledgement IS the order-injection SLA.
//
// Answering JET's webhook with 202 starts a 3-minute clock. Miss it and the
// order is marked "failed to inject" — which counts against the 99.5% target
// AND skips the restaurant's backup flow, so the customer simply never gets
// their food. An explicit failure is strictly better than silence, and these
// tests pin the three mechanisms that guarantee one is always sent.

function makeAck(opts: {
  request?: jest.Mock;
  rows?: any[];
  config?: Record<string, unknown>;
} = {}) {
  const request = opts.request ?? jest.fn().mockResolvedValue(null);
  const updates: any[] = [];
  const stored = new Map<string, any>();
  for (const row of opts.rows ?? []) stored.set(row.externalEventId, row);

  const prisma = {
    webhookEvent: {
      findUnique: jest.fn(async ({ where }: any) => {
        const id = where.platform_externalEventId.externalEventId;
        return stored.get(id) ?? { metadata: {} };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        updates.push({
          id: where.platform_externalEventId.externalEventId,
          ...data,
        });
        return data;
      }),
      findMany: jest.fn(async () => opts.rows ?? []),
    },
  } as any;

  const values: Record<string, unknown> = {
    "app.platforms.jet.ackDeadlineSeconds": 90,
    "app.platforms.jet.ackWatchdogEnabled": true,
    ...(opts.config ?? {}),
  };
  const config = { get: (k: string) => values[k] } as any;
  const client = { request, configured: true } as any;
  const activity = { record: jest.fn() } as any;

  return {
    service: new JetOrderAckService(prisma, config, client, activity),
    request,
    updates,
    activity,
  };
}

describe("JetOrderAckService.ackSuccess", () => {
  it("posts to the order-status host with the ORDER key", async () => {
    const { service, request } = makeAck();
    await service.ackSuccess({ jetOrderId: "abc-123", brandId: "b1", locationId: "l1" });

    expect(request).toHaveBeenCalledTimes(1);
    const [method, path, opts] = request.mock.calls[0]!;
    expect(method).toBe("POST");
    expect(path).toBe("/order/abc-123/sent-to-pos-success");
    // The menu key is a DIFFERENT key issued by JET; using it here 403s.
    expect(opts.keyType).toBe("order");
    expect(opts.host).toBe("orderStatus");
    expect(opts.retries).toBeGreaterThan(0);
  });

  it("sends happenedAt and omits transmissionId when there isn't one", async () => {
    const { service, request } = makeAck();
    await service.ackSuccess({ jetOrderId: "abc-123" });

    const body = request.mock.calls[0]![2].body;
    expect(typeof body.happenedAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.happenedAt))).toBe(false);
    // JET rejects an empty transmissionId, so it must be absent, not "".
    expect("transmissionId" in body).toBe(false);
  });

  it("echoes the transmission id for multi-injection partners", async () => {
    const { service, request } = makeAck();
    await service.ackSuccess({ jetOrderId: "abc-123", transmissionId: "t-9" });
    expect(request.mock.calls[0]![2].body.transmissionId).toBe("t-9");
  });

  it("url-encodes an order id so a slash cannot escape the path", async () => {
    const { service, request } = makeAck();
    await service.ackSuccess({ jetOrderId: "a/b?c" });
    expect(request.mock.calls[0]![1]).toBe("/order/a%2Fb%3Fc/sent-to-pos-success");
  });

  it("records the ack so the watchdog stops chasing it", async () => {
    const { service, updates } = makeAck();
    await service.ackSuccess({ jetOrderId: "abc-123" });
    const ack = updates.at(-1)!.metadata.jetAck;
    expect(ack.state).toBe("success");
    expect(typeof ack.ackedAt).toBe("string");
  });

  it("reports failure rather than throwing when every retry is spent", async () => {
    const request = jest.fn().mockRejectedValue(new Error("503 upstream"));
    const { service, activity } = makeAck({ request });
    await expect(service.ackSuccess({ jetOrderId: "abc", tenantId: "t1" })).resolves.toBe(
      false,
    );
    // An un-acked order is an SLA event; it has to reach the operator's log,
    // not just the server's.
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ERROR", action: "order.ack.error" }),
    );
  });
});

describe("JetOrderAckService.ackFailure", () => {
  it("sends the classified code and a non-empty message", async () => {
    const { service, request } = makeAck();
    await service.ackFailure({
      jetOrderId: "abc-123",
      code: "MENU_ERROR",
      message: "PLU M2 is not on the menu",
    });

    const [, path, opts] = request.mock.calls[0]!;
    expect(path).toBe("/order/abc-123/sent-to-pos-failed");
    expect(opts.body.errorCode).toBe("MENU_ERROR");
    expect(opts.body.errorMessage).toBe("PLU M2 is not on the menu");
  });

  it("substitutes a message when the caller has none", async () => {
    // JET's schema requires errorMessage. A blank one 400s the ack, turning a
    // handled failure into the silent timeout we are trying to avoid.
    const { service, request } = makeAck();
    await service.ackFailure({ jetOrderId: "abc", code: "UNKNOWN", message: "  " });
    expect(request.mock.calls[0]![2].body.errorMessage).toBeTruthy();
  });
});

describe("JetOrderAckService.markPending", () => {
  it("records the debt to JET", async () => {
    const { service, updates } = makeAck();
    await service.markPending({ jetOrderId: "abc", tenantId: "t1", brandId: "b1" });
    const ack = updates.at(-1)!.metadata.jetAck;
    expect(ack.state).toBe("pending");
    expect(ack.tenantId).toBe("t1");
  });

  it("never reopens an order that has already been acked", async () => {
    // A redelivery arriving after we acked must not put the order back into
    // pending — the watchdog would then send a second, contradictory ack.
    const { service, updates } = makeAck({
      rows: [
        {
          externalEventId: "abc",
          metadata: { jetAck: { state: "success", ackedAt: "2026-01-01T00:00:00Z" } },
        },
      ],
    });
    await service.markPending({ jetOrderId: "abc", tenantId: "t1" });
    expect(updates.at(-1)!.metadata.jetAck.state).toBe("success");
  });
});

describe("JetOrderAckService watchdog", () => {
  const stalled = [
    {
      externalEventId: "stalled-1",
      metadata: {
        jetAck: {
          state: "pending",
          tenantId: "t1",
          brandId: "b1",
          locationId: "l1",
          transmissionId: "tx-1",
        },
      },
    },
  ];

  it("force-acks a stalled order with TIMEOUT before JET's cutoff", async () => {
    const { service, request } = makeAck({ rows: stalled });
    await service.sweepPendingAcks();

    expect(request).toHaveBeenCalledTimes(1);
    const [, path, opts] = request.mock.calls[0]!;
    expect(path).toBe("/order/stalled-1/sent-to-pos-failed");
    expect(opts.body.errorCode).toBe("TIMEOUT");
    // Attributed to the right brand so the ack resolves that brand's key.
    expect(opts.brandId).toBe("b1");
    expect(opts.body.transmissionId).toBe("tx-1");
  });

  it("only looks at orders past the deadline and still pending", async () => {
    const prismaCalls: any[] = [];
    const { service } = makeAck({ rows: [] });
    (service as any).prisma.webhookEvent.findMany = jest.fn(async (args: any) => {
      prismaCalls.push(args);
      return [];
    });
    await service.sweepPendingAcks();

    const where = prismaCalls[0]!.where;
    expect(where.platform).toBe("JUST_EAT");
    expect(where.metadata).toEqual({ path: ["jetAck", "state"], equals: "pending" });
    // 90s deadline leaves ~90s of margin inside JET's 3-minute cutoff.
    const ageMs = Date.now() - where.receivedAt.lt.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(90_000);
    expect(ageMs).toBeLessThan(95_000);
  });

  it("can be switched off without a deploy", async () => {
    const { service, request } = makeAck({
      rows: stalled,
      config: { "app.platforms.jet.ackWatchdogEnabled": false },
    });
    await service.sweepPendingAcks();
    expect(request).not.toHaveBeenCalled();
  });

  it("caps the batch so one sweep cannot overrun its tick", async () => {
    const { service } = makeAck({ rows: [] });
    const findMany = jest.fn(async () => []);
    (service as any).prisma.webhookEvent.findMany = findMany;
    await service.sweepPendingAcks();
    expect(findMany.mock.calls[0]![0].take).toBe(25);
  });

  it("survives a query failure without throwing into the scheduler", async () => {
    const { service } = makeAck({ rows: [] });
    (service as any).prisma.webhookEvent.findMany = jest
      .fn()
      .mockRejectedValue(new Error("db down"));
    await expect(service.sweepPendingAcks()).resolves.toBeUndefined();
  });
});
