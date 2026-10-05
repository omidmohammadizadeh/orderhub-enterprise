import { YangoDispatchService } from "../yango-dispatch.service";
import { YangoTrackingService } from "../yango-tracking.service";
import { YangoPollCron } from "../yango-poll.cron";
import { YangoApiError } from "../yango-client.service";

// Money paths. Yango has no sandbox, so: estimate-only must never create a claim
// or take a fee; a failed create refunds; a retried create reuses request_id so
// a timeout can't produce two couriers; and a paid cancel is never a surprise.

type Row = Record<string, any>;

function setup(opts: { cfg?: Row; order?: Row; location?: Row; client?: Row } = {}) {
  const orderRow: Row = {
    id: "o1",
    tenantId: "t1",
    locationId: "loc1",
    displayId: "1042",
    status: "READY",
    total: 86.5,
    customerName: "Aisha",
    customerPhone: "0509876543",
    deliveryAddress: { line1: "JLT Cluster D", city: "Dubai", lat: 25.0692, lng: 55.1438 },
    deliveryLat: 25.0692,
    deliveryLng: 55.1438,
    paymentMethod: "CARD",
    courierProvider: null,
    courierJobId: null,
    metadata: {},
    items: [{ quantity: 1 }],
    ...opts.order,
  };
  const rows = [orderRow];
  const location = {
    id: "loc1",
    name: "Shawarma House",
    country: "AE",
    currency: "AED",
    phone: "04 123 4567",
    addressLine1: "Al Wasl Road 12",
    city: "Dubai",
    ...opts.location,
  };
  const cfg = {
    tenantId: "t1",
    locationId: "loc1",
    token: "tok",
    mode: "live",
    taxiClass: "courier",
    contactEmail: "ops@shop.ae",
    pickupLat: 25.1972,
    pickupLng: 55.2396,
    webhookToken: "wh",
    active: true,
    ...opts.cfg,
  };
  const prisma: any = {
    order: {
      findFirst: jest.fn(async () => rows[0]),
      findUnique: jest.fn(async () => rows[0]),
      update: jest.fn(async ({ data }: any) => Object.assign(rows[0]!, data)),
    },
    location: { findUnique: jest.fn(async () => location) },
  };
  const readyClaim = (over: Row = {}) => ({
    id: "claim-1",
    status: "ready_for_approval",
    version: 1,
    pricing: { currency: "AED", offer: { price: "21.00", valid_until: new Date(Date.now() + 600_000).toISOString() } },
    route_points: [],
    ...over,
  });
  const client: any = {
    checkPrice: jest.fn(async () => ({ price: "20.0000", currency_rules: { code: "AED" }, eta: 12, distance_meters: 8000 })),
    createClaim: jest.fn(async () => ({ id: "claim-1", status: "new", version: 1 })),
    claimInfo: jest.fn(async () => readyClaim()),
    acceptClaim: jest.fn(async () => ({ id: "claim-1", status: "accepted", version: 1 })),
    cancelInfo: jest.fn(async () => ({ cancel_state: "free" })),
    cancelClaim: jest.fn(async () => ({ status: "cancelled" })),
    trackingLinks: jest.fn(),
    courierPhone: jest.fn(),
    performerPosition: jest.fn(),
    ...opts.client,
  };
  const wallet: any = {
    dispatchFeeMinor: () => 50,
    dispatchFeeMinorFor: jest.fn().mockResolvedValue(50),
    debitForDispatch: jest.fn(async () => ({ chargedMinor: 50 })),
    refundDispatch: jest.fn(async () => undefined),
  };
  const config: any = {
    getDecrypted: jest.fn(async () => cfg),
    webhookUrl: (base: string, t: string) => `${base}/api/v1/webhooks/yango/${t}?`,
  };
  const activity = { record: jest.fn() };
  const tracking: any = Object.create(YangoTrackingService.prototype);
  Object.assign(tracking, {
    prisma,
    client,
    wallet,
    activity,
    orders: { updateStatus: jest.fn(async () => ({})) },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  const s: any = Object.create(YangoDispatchService.prototype);
  Object.assign(s, {
    prisma,
    wallet,
    config,
    client,
    tracking,
    geocoding: { geocode: jest.fn(async () => null) },
    appConfig: { get: () => "https://api.x" },
    activity,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    sleep: async () => undefined,
    estimateWaitMs: () => 50,
  });
  return { s: s as YangoDispatchService, client, wallet, rows, cfg, readyClaim };
}

const dispatch = (s: YangoDispatchService) =>
  s.dispatch({ orderId: "o1", tenantId: "t1", userId: "u1", isAdmin: false });

describe("estimate-only mode", () => {
  it("quotes (free) but dispatch refuses BEFORE any claim or wallet charge", async () => {
    const { s, client, wallet } = setup({ cfg: { mode: "estimate_only" } });
    const q = await s.quote({ orderId: "o1", tenantId: "t1" });
    expect(q.amount).toBe(20);
    expect(q.currency).toBe("AED");
    expect(q.canDispatch).toBe(false);
    await expect(dispatch(s)).rejects.toThrow(/estimate-only/);
    expect(client.createClaim).not.toHaveBeenCalled();
    expect(client.acceptClaim).not.toHaveBeenCalled();
    expect(wallet.debitForDispatch).not.toHaveBeenCalled();
  });
});

describe("UAE only", () => {
  it("refuses a location outside the UAE even with a config", async () => {
    const { s, client } = setup({ location: { country: "GB" } });
    await expect(s.quote({ orderId: "o1", tenantId: "t1" })).rejects.toThrow(/UAE/);
    expect(client.checkPrice).not.toHaveBeenCalled();
  });
});

describe("live dispatch", () => {
  it("quote → debit → create → accept, and records it on the order", async () => {
    const { s, client, wallet, rows } = setup();
    const r = await dispatch(s);
    expect(wallet.debitForDispatch).toHaveBeenCalledTimes(1);
    expect(client.createClaim).toHaveBeenCalledTimes(1);
    const [, requestId, body] = client.createClaim.mock.calls[0];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.route_points[0].address.coordinates).toEqual([55.2396, 25.1972]);
    expect(body.route_points[0].contact.phone).toBe("+97141234567");
    expect(body.route_points[1].contact.phone).toBe("+971509876543");
    expect(body.callback_properties.callback_url).toBe("https://api.x/api/v1/webhooks/yango/wh?");
    expect(client.acceptClaim).toHaveBeenCalledWith(expect.anything(), "claim-1", 1);
    expect(r).toMatchObject({ ok: true, jobId: "claim-1", accepted: true, pending: false, feeChargedMinor: 50 });
    expect(rows[0]!.courierProvider).toBe("YANGO");
    expect(rows[0]!.metadata.yango).toMatchObject({ quotedPrice: 20, acceptPending: false, walletFeeMinor: 50 });
  });

  it("still estimating after the wait → returns pending, leaves the accept to the poller", async () => {
    const { s, client } = setup({
      client: { claimInfo: jest.fn(async () => ({ id: "claim-1", status: "estimating", version: 1 })) },
    });
    const r = await dispatch(s);
    expect(r).toMatchObject({ accepted: false, pending: true });
    expect(client.acceptClaim).not.toHaveBeenCalled();
  });

  it("a price far above the quote is refused, cancelled free, and the fee refunded", async () => {
    const { s, client, wallet, readyClaim } = setup();
    client.claimInfo.mockImplementation(async () =>
      readyClaim({ pricing: { offer: { price: "35.00", valid_until: new Date(Date.now() + 600_000).toISOString() } } }),
    );
    await expect(dispatch(s)).rejects.toThrow(/didn't book a courier/);
    expect(client.acceptClaim).not.toHaveBeenCalled();
    expect(client.cancelClaim).toHaveBeenCalled();
    expect(wallet.refundDispatch).toHaveBeenCalledWith(expect.objectContaining({ amountMinor: 50 }));
  });

  it("a failed create refunds the wallet fee", async () => {
    const { s, wallet } = setup({
      client: { createClaim: jest.fn(async () => { throw new YangoApiError("400", 400, "validation_error", {}); }) },
    });
    await expect(dispatch(s)).rejects.toThrow(/couldn't create/);
    expect(wallet.refundDispatch).toHaveBeenCalledTimes(1);
  });

  it("a 5xx on create is retried ONCE with the SAME request_id (no second courier)", async () => {
    const createClaim = jest
      .fn()
      .mockRejectedValueOnce(new YangoApiError("502", 502, null, {}))
      .mockResolvedValueOnce({ id: "claim-1", status: "new", version: 1 });
    const { s } = setup({ client: { createClaim } });
    await dispatch(s);
    expect(createClaim).toHaveBeenCalledTimes(2);
    expect(createClaim.mock.calls[0][1]).toBe(createClaim.mock.calls[1][1]);
  });

  it("a 4xx on create is NOT retried", async () => {
    const createClaim = jest.fn().mockRejectedValue(new YangoApiError("400", 400, "bad_request", {}));
    const { s } = setup({ client: { createClaim } });
    await expect(dispatch(s)).rejects.toThrow();
    expect(createClaim).toHaveBeenCalledTimes(1);
  });

  it("no charge when the quote fails (outside the zone)", async () => {
    const { s, wallet } = setup({
      client: { checkPrice: jest.fn(async () => { throw new YangoApiError("409", 409, "estimating.claim.no_zone_id", {}); }) },
    });
    await expect(dispatch(s)).rejects.toThrow(/outside Yango's delivery zone/);
    expect(wallet.debitForDispatch).not.toHaveBeenCalled();
  });

  it("admin bypass takes no fee and refunds nothing on failure", async () => {
    const { s, wallet } = setup({
      client: { createClaim: jest.fn(async () => { throw new YangoApiError("400", 400, "x", {}); }) },
    });
    await expect(s.dispatch({ orderId: "o1", tenantId: "t1", isAdmin: true })).rejects.toThrow();
    expect(wallet.debitForDispatch).not.toHaveBeenCalled();
    expect(wallet.refundDispatch).not.toHaveBeenCalled();
  });

  it("needs a customer phone and a shop phone", async () => {
    await expect(dispatch(setup({ order: { customerPhone: "" } }).s)).rejects.toThrow(/customer's phone/);
    await expect(dispatch(setup({ location: { phone: null } }).s)).rejects.toThrow(/shop's phone/);
  });

  it("refuses an order already on another courier network", async () => {
    const { s } = setup({ order: { courierProvider: "STUART", courierJobId: "j" } });
    await expect(dispatch(s)).rejects.toThrow(/STUART/);
  });

  it("warns BEFORE dispatch about an unpaid cash order", async () => {
    const { s } = setup({ cfg: { mode: "estimate_only" }, order: { paymentMethod: "CASH", paymentStatus: "PENDING" } });
    const q = await s.quote({ orderId: "o1", tenantId: "t1" });
    expect(q.warnings.join(" ")).toMatch(/CASH/);
  });
});

describe("cancel", () => {
  const onYango = { courierProvider: "YANGO", courierJobId: "claim-1", metadata: { yango: { walletFeeMinor: 50 } } };

  it("free: cancels with the current version, clears the order, no refund (operator's own cancel)", async () => {
    const { s, client, wallet, rows } = setup({ order: onYango });
    client.claimInfo.mockResolvedValue({ id: "claim-1", status: "performer_found", version: 7 });
    const r = await s.cancel({ orderId: "o1", tenantId: "t1" });
    expect(client.cancelClaim).toHaveBeenCalledWith(expect.anything(), "claim-1", 7, "free");
    expect(r.ok).toBe(true);
    expect(rows[0]!.courierProvider).toBeNull();
    expect(wallet.refundDispatch).not.toHaveBeenCalled();
  });

  it("paid: first call only reports the fee; nothing is cancelled until confirmed", async () => {
    const { s, client } = setup({ order: onYango, client: { cancelInfo: jest.fn(async () => ({ cancel_state: "paid", price_with_vat: "9.45", currency: "AED" })) } });
    const r: any = await s.cancel({ orderId: "o1", tenantId: "t1" });
    expect(r).toMatchObject({ ok: false, needsConfirmation: true, fee: 9.45, currency: "AED" });
    expect(client.cancelClaim).not.toHaveBeenCalled();
    await s.cancel({ orderId: "o1", tenantId: "t1", confirmPaid: true });
    expect(client.cancelClaim).toHaveBeenCalledWith(expect.anything(), "claim-1", 1, "paid");
  });

  it("unavailable (courier has the food): refuses and points to Yango support", async () => {
    const { s, client } = setup({ order: onYango, client: { cancelInfo: jest.fn(async () => ({ cancel_state: "unavailable" })) } });
    await expect(s.cancel({ orderId: "o1", tenantId: "t1" })).rejects.toThrow(/support/);
    expect(client.cancelClaim).not.toHaveBeenCalled();
  });
});

describe("poller", () => {
  function cron(orders: Row[], claims: Row[]) {
    const prisma: any = { order: { findMany: jest.fn(async () => orders) } };
    const client: any = { bulkInfo: jest.fn(async () => claims) };
    const config: any = { getDecrypted: jest.fn(async (loc: string) => ({ locationId: loc, token: "tok" })) };
    const tracking: any = { apply: jest.fn(async () => ({ ok: true })) };
    const c: any = Object.create(YangoPollCron.prototype);
    Object.assign(c, { prisma, client, config, tracking, logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() } });
    return { c: c as YangoPollCron, client, tracking };
  }

  it("one bulk_info per location, applies each matching claim", async () => {
    const orders = [
      { id: "a", locationId: "L1", courierJobId: "c1", metadata: {} },
      { id: "b", locationId: "L1", courierJobId: "c2", metadata: {} },
      { id: "c", locationId: "L2", courierJobId: "c3", metadata: {} },
    ];
    const { c, client, tracking } = cron(orders, [{ id: "c1" }, { id: "c2" }, { id: "c3" }]);
    const r = await c.pollOnce();
    expect(client.bulkInfo).toHaveBeenCalledTimes(2);
    expect(tracking.apply).toHaveBeenCalledTimes(3);
    expect(r).toEqual({ polled: 3, applied: 3 });
  });

  it("leaves a claim dispatch created seconds ago to the dispatch call (no racing accept)", async () => {
    const now = Date.now();
    const orders = [
      { id: "a", locationId: "L1", courierJobId: "c1", metadata: { yango: { acceptPending: true, dispatchedAt: new Date(now - 5000).toISOString() } } },
      { id: "b", locationId: "L1", courierJobId: "c2", metadata: { yango: { acceptPending: true, dispatchedAt: new Date(now - 60_000).toISOString() } } },
    ];
    const { c, client } = cron(orders, [{ id: "c2" }]);
    await c.pollOnce(now);
    expect(client.bulkInfo).toHaveBeenCalledWith(expect.anything(), ["c2"]);
  });

  it("can be switched off without a deploy", async () => {
    process.env.YANGO_POLL_ENABLED = "false";
    try {
      const { c, client } = cron([{ id: "a", locationId: "L1", courierJobId: "c1", metadata: {} }], []);
      await c.tick();
      expect(client.bulkInfo).not.toHaveBeenCalled();
    } finally {
      delete process.env.YANGO_POLL_ENABLED;
    }
  });
});
