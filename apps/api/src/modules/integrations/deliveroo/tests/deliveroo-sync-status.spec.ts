// sync_status — the call behind the partner dashboard's Injection Rate.
//
// Deliveroo's accept is ASYNCHRONOUS: PATCH {status:"accepted"} returns 204
// before the order is really accepted on their side. Firing sync_status
// straight after gets 404 "order not found or hasn't been accepted".
//
// Production evidence (gb:58a8cc1b, 2026-08-17):
//   17:28:52.671  PATCH  … → 204
//   17:28:52.742  POST   …/sync_status → 404
// Seventy-one milliseconds. It happened on every order, which is why the
// Injection Success Rate read 0% across 43 orders.

import { DeliverooOrderSyncService } from "../deliveroo-order-sync.service";

/** The exact error the client throws for that 404. */
const NOT_ACCEPTED = new Error(
  'Deliveroo POST /order/v1/orders/gb%3A1/sync_status → 404: {"error":' +
    '{"code":"not_found","message":"order not found or hasn\'t been accepted"}}',
);

function build(requestImpl: jest.Mock) {
  const svc = new DeliverooOrderSyncService(
    {} as any,
    { request: requestImpl } as any,
  );
  // Collapse the backoff so the ladder runs instantly under test.
  jest
    .spyOn(global, "setTimeout")
    .mockImplementation(((fn: any) => {
      fn();
      return 0 as any;
    }) as any);
  return svc;
}

const sync = (svc: any) => svc.syncStatus("gb%3A1", "gb:1", "2026-08-17T17:28:52Z");

afterEach(() => jest.restoreAllMocks());

describe("sync_status — the accept race", () => {
  it("retries the 'hasn't been accepted' 404 instead of giving up", async () => {
    // The whole bug: one attempt, 71ms after accept, always 404.
    const request = jest
      .fn()
      .mockRejectedValueOnce(NOT_ACCEPTED)
      .mockResolvedValueOnce(undefined);

    await expect(sync(build(request))).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying while Deliveroo's state settles", async () => {
    const request = jest
      .fn()
      .mockRejectedValueOnce(NOT_ACCEPTED)
      .mockRejectedValueOnce(NOT_ACCEPTED)
      .mockRejectedValueOnce(NOT_ACCEPTED)
      .mockResolvedValueOnce(undefined);

    await expect(sync(build(request))).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("sends the confirmation Deliveroo actually counts", async () => {
    const request = jest.fn().mockResolvedValue(undefined);
    await sync(build(request));

    expect(request).toHaveBeenCalledWith(
      "POST",
      "/order/v1/orders/gb%3A1/sync_status",
      // occurred_at keeps its ORIGINAL value — it records when we accepted,
      // not when a retry happened.
      { status: "succeeded", occurred_at: "2026-08-17T17:28:52Z" },
    );
  });

  it("gives up eventually rather than looping forever", async () => {
    const request = jest.fn().mockRejectedValue(NOT_ACCEPTED);

    await expect(sync(build(request))).rejects.toThrow();
    // First attempt plus the five-step ladder — bounded, and well inside
    // Deliveroo's 3-minute sync_status deadline.
    expect(request).toHaveBeenCalledTimes(6);
  });
});

describe("sync_status — what it must NOT retry", () => {
  it("does not retry a 401", async () => {
    // A credentials problem won't fix itself in 15 seconds.
    const request = jest
      .fn()
      .mockRejectedValue(new Error("Deliveroo POST /x/sync_status → 401: nope"));

    await expect(sync(build(request))).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 400", async () => {
    const request = jest
      .fn()
      .mockRejectedValue(
        new Error("Deliveroo POST /x/sync_status → 400: bad occurred_at"),
      );

    await expect(sync(build(request))).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not retry an unrelated 404", async () => {
    // A genuinely unknown order is not a race we can wait out.
    const request = jest
      .fn()
      .mockRejectedValue(
        new Error("Deliveroo POST /x/sync_status → 404: no such route"),
      );

    await expect(sync(build(request))).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("succeeds first time without any delay when Deliveroo is ready", async () => {
    const request = jest.fn().mockResolvedValue(undefined);
    await sync(build(request));
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("sync_status — the 429 that broke the first fix", () => {
  // Live sequence, 18:17:12 on gb:e609a9b1:
  //   sync_status → 404 "hasn't been accepted"
  //   retrying in 500ms                      ← the retry worked
  //   sync_status → 429 "exceeded the RPS limit, try again later in 10s"
  //   push failed                            ← and then gave up
  // A rate limit is a WAIT: the request was never made. The client now
  // absorbs it, and the ladder starts slower so it's less likely at all.
  const RATE_LIMITED = new Error(
    "Deliveroo POST /x/sync_status → 429: " +
      '{"error":{"code":"too_many_requests","message":"api calls have ' +
      'exceeded the RPS limit, try again later in 10s"}}',
  );

  it("does not treat a rate limit as a permanent failure of the order", async () => {
    // The client absorbs 429s, so one reaching here means it exhausted its
    // own retries — the order must still surface as failed, not silently
    // succeed.
    const request = jest.fn().mockRejectedValue(RATE_LIMITED);
    await expect(sync(build(request))).rejects.toThrow(/429/);
  });

  it("starts the ladder slowly enough not to provoke the limiter", async () => {
    // 500ms was what tripped it. The first wait must be seconds, not
    // milliseconds.
    const waits: number[] = [];
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: any, ms: any) => {
      waits.push(ms);
      fn();
      return 0 as any;
    }) as any);

    const request = jest.fn().mockRejectedValue(NOT_ACCEPTED);
    const svc = new DeliverooOrderSyncService({} as any, { request } as any);
    await expect(sync(svc)).rejects.toThrow();

    expect(waits[0]).toBeGreaterThanOrEqual(2000);
    // And the whole ladder stays inside Deliveroo's 3-minute deadline.
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThan(180_000);
  });
});
