import { YangoTrackingService } from "../yango-tracking.service";
import { YangoApiError } from "../yango-client.service";

// Accepting a Yango claim books a REAL courier (there is no sandbox), so the
// rules around accept are the ones that cost money when wrong. Everything the
// poller, the callback and dispatch do to an order goes through apply().

type Row = Record<string, any>;

function svcWith(rows: Row[], clientOver: Record<string, any> = {}) {
  const prisma: any = {
    order: {
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((o) => o.id === where.id);
        if (row) Object.assign(row, data);
        return {};
      }),
    },
  };
  const client: any = {
    acceptClaim: jest.fn(async (_c: any, id: string, version: number) => ({ id, status: "accepted", version })),
    claimInfo: jest.fn(async (_c: any, id: string) => claim({ id })),
    cancelInfo: jest.fn(async () => ({ cancel_state: "free" })),
    cancelClaim: jest.fn(async () => ({ status: "cancelled" })),
    trackingLinks: jest.fn(async () => ({
      route_points: [
        { type: "source", sharing_link: "https://no.example/src" },
        { type: "destination", sharing_link: "https://yango.example/track/abc" },
      ],
    })),
    courierPhone: jest.fn(async () => ({ phone: "+97180012345", ext: "0163" })),
    performerPosition: jest.fn(async () => ({ position: { lat: 25.1, lon: 55.2, timestamp: 1790000000 } })),
    ...clientOver,
  };
  const orders = { updateStatus: jest.fn(async (_id: string, _t: string, dto: any) => {
    const row = rows.find((o) => o.id === _id);
    if (row) row.status = dto.status;
    return {};
  }) };
  const wallet = { refundDispatch: jest.fn().mockResolvedValue(undefined) };
  const activity = { record: jest.fn() };
  const s: any = Object.create(YangoTrackingService.prototype);
  s.prisma = prisma;
  s.client = client;
  s.orders = orders;
  s.wallet = wallet;
  s.activity = activity;
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { s: s as YangoTrackingService, client, orders, wallet, activity, rows };
}

const cfg = (over: Row = {}): any => ({
  tenantId: "t1",
  locationId: "loc1",
  token: "tok",
  mode: "live",
  taxiClass: "courier",
  contactEmail: "ops@shop.ae",
  pickupLat: 25.2,
  pickupLng: 55.27,
  webhookToken: "wh",
  active: true,
  ...over,
});

const order = (over: Row = {}, meta: Row = {}): Row => ({
  id: "o1",
  tenantId: "t1",
  locationId: "loc1",
  displayId: "1042",
  status: "READY",
  courierProvider: "YANGO",
  courierJobId: "claim-1",
  courierStatus: "NEW",
  metadata: {
    other: "kept",
    yango: { acceptPending: true, quotedPrice: 20, currency: "AED", walletFeeMinor: 50, ...meta },
  },
  ...over,
});

function claim(over: Row = {}): any {
  return {
    id: "claim-1",
    status: "ready_for_approval",
    version: 3,
    pricing: {
      currency: "AED",
      offer: { price: "21.00", price_with_vat: "22.05", valid_until: new Date(Date.now() + 5 * 60_000).toISOString() },
    },
    route_points: [
      { id: 9001, type: "source", visit_status: "pending" },
      { id: 9002, type: "destination", visit_status: "pending" },
    ],
    ...over,
  };
}

describe("accepting — the call that books a real courier", () => {
  it("accepts a fresh offer within the quote, with the claim's CURRENT version", async () => {
    const o = order();
    const { s, client, wallet } = svcWith([o]);
    const r = await s.apply(o, claim(), cfg());
    expect(r).toEqual({ accepted: true });
    expect(client.acceptClaim).toHaveBeenCalledWith(expect.anything(), "claim-1", 3);
    expect(o.metadata.yango.acceptPending).toBe(false);
    expect(o.metadata.yango.offerPrice).toBe(21);
    expect(o.metadata.other).toBe("kept");
    expect(o.courierStatus).toBe("ACCEPTED");
    expect(wallet.refundDispatch).not.toHaveBeenCalled();
  });

  it("NEVER accepts in estimate_only mode — cancels free and refunds instead", async () => {
    const o = order();
    const { s, client, wallet } = svcWith([o]);
    await s.apply(o, claim(), cfg({ mode: "estimate_only" }));
    expect(client.acceptClaim).not.toHaveBeenCalled();
    expect(client.cancelClaim).toHaveBeenCalledWith(expect.anything(), "claim-1", 3, "free");
    expect(wallet.refundDispatch).toHaveBeenCalledWith(expect.objectContaining({ amountMinor: 50 }));
    expect(o.courierProvider).toBeNull();
  });

  it("NEVER accepts a claim OrderHub didn't create to book (no acceptPending flag)", async () => {
    const o = order({}, { acceptPending: false });
    const { s, client } = svcWith([o]);
    const r = await s.apply(o, claim(), cfg());
    expect(r).toEqual({ accepted: false, reason: "not_pending" });
    expect(client.acceptClaim).not.toHaveBeenCalled();
    expect(client.cancelClaim).not.toHaveBeenCalled();
  });

  it("refuses an offer far above the quote, cancels it free, refunds the fee, back to READY", async () => {
    const o = order({ status: "PREPARING" });
    const { s, client, wallet, activity } = svcWith([o]);
    await s.apply(o, claim({ pricing: { currency: "AED", offer: { price: "40.00", valid_until: new Date(Date.now() + 60_000).toISOString() } } }), cfg());
    expect(client.acceptClaim).not.toHaveBeenCalled();
    expect(client.cancelClaim).toHaveBeenCalled();
    expect(wallet.refundDispatch).toHaveBeenCalled();
    expect(o.courierJobId).toBeNull();
    expect(o.status).toBe("READY");
    expect(activity.record.mock.calls[0][0].message).toMatch(/40.*20/);
  });

  it("refuses an expired offer (accepting it would return 200 then fail)", async () => {
    const o = order();
    const { s, client } = svcWith([o]);
    const r = await s.apply(
      o,
      claim({ pricing: { offer: { price: "20.00", valid_until: new Date(Date.now() - 1000).toISOString() } } }),
      cfg(),
    );
    expect(r).toEqual({ accepted: false, reason: "expired" });
    expect(client.acceptClaim).not.toHaveBeenCalled();
  });

  it("never pays to cancel on its own: a PAID cancel state is left alone", async () => {
    const o = order();
    const { s, client } = svcWith([o], { cancelInfo: jest.fn(async () => ({ cancel_state: "paid" })) });
    await s.apply(o, claim({ pricing: { offer: { price: "99" } } }), cfg());
    expect(client.cancelClaim).not.toHaveBeenCalled();
  });

  it("on old_version, re-reads the claim and accepts with the fresh version", async () => {
    const o = order();
    const acceptClaim = jest
      .fn()
      .mockRejectedValueOnce(new YangoApiError("409", 409, "old_version", {}))
      .mockResolvedValueOnce({ id: "claim-1", status: "accepted", version: 4 });
    const { s, client } = svcWith([o], {
      acceptClaim,
      claimInfo: jest.fn(async () => claim({ version: 4 })),
    });
    const r = await s.apply(o, claim(), cfg());
    expect(r).toEqual({ accepted: true });
    expect(client.acceptClaim.mock.calls.map((c: any[]) => c[2])).toEqual([3, 4]);
  });

  it("does NOT retry an accept that 5xx'd — a blind retry could book twice", async () => {
    const o = order();
    const acceptClaim = jest.fn().mockRejectedValue(new YangoApiError("500", 500, null, {}));
    const { s, client } = svcWith([o], { acceptClaim });
    const r = await s.apply(o, claim(), cfg());
    expect(r).toEqual({ accepted: false, reason: "error" });
    expect(client.acceptClaim).toHaveBeenCalledTimes(1);
    // Still pending: the next poll re-reads and retries only if still waiting.
    expect(o.metadata.yango.acceptPending).toBe(true);
    expect(o.courierJobId).toBe("claim-1");
  });

  it("inappropriate_status on accept (a racing poll won) just applies the real state", async () => {
    const o = order();
    const acceptClaim = jest.fn().mockRejectedValue(new YangoApiError("409", 409, "inappropriate_status", {}));
    const { s } = svcWith([o], {
      acceptClaim,
      claimInfo: jest.fn(async () => claim({ status: "performer_lookup" })),
    });
    await s.apply(o, claim(), cfg());
    expect(o.metadata.yango.acceptPending).toBe(false);
    expect(o.courierStatus).toBe("PERFORMER_LOOKUP");
  });
});

describe("failures", () => {
  it.each(["performer_not_found", "cancelled_by_taxi", "failed", "estimating_failed"])(
    "%s: Yango gave up → clear, refund our fee, order back to READY",
    async (status) => {
      const o = order({ status: "PREPARING" }, { acceptPending: false });
      const { s, wallet, client } = svcWith([o]);
      await s.apply(o, claim({ status, error_messages: [{ code: "x", message: "no couriers" }] }), cfg());
      expect(wallet.refundDispatch).toHaveBeenCalledTimes(1);
      expect(client.cancelClaim).not.toHaveBeenCalled();
      expect(o.courierProvider).toBeNull();
      expect(o.status).toBe("READY");
    },
  );

  it("an admin dispatch (fee 0) refunds nothing", async () => {
    const o = order({}, { acceptPending: false, walletFeeMinor: 0 });
    const { s, wallet } = svcWith([o]);
    await s.apply(o, claim({ status: "performer_not_found" }), cfg());
    expect(wallet.refundDispatch).not.toHaveBeenCalled();
  });

  it("is idempotent: once cleared, a repeat snapshot no longer touches the order", async () => {
    const o = order({}, { acceptPending: false });
    const { s, wallet } = svcWith([o]);
    await s.apply(o, claim({ status: "performer_not_found" }), cfg());
    await s.apply(o, claim({ status: "performer_not_found" }), cfg());
    expect(wallet.refundDispatch).toHaveBeenCalledTimes(1);
  });

  it("cancelled in the shop's Yango cabinet → cleared, NO refund (else a free loop)", async () => {
    const o = order({ status: "PREPARING" }, { acceptPending: false });
    const { s, wallet } = svcWith([o]);
    await s.apply(o, claim({ status: "cancelled" }), cfg());
    expect(wallet.refundDispatch).not.toHaveBeenCalled();
    expect(o.courierProvider).toBeNull();
    expect(o.status).toBe("READY");
  });

  it("cancelled_with_items_on_hands: the courier kept the food — don't put it back on the board as READY", async () => {
    const o = order({ status: "OUT_FOR_DELIVERY" }, { acceptPending: false });
    const { s, orders } = svcWith([o]);
    await s.apply(o, claim({ status: "cancelled_with_items_on_hands" }), cfg());
    expect(orders.updateStatus).not.toHaveBeenCalled();
  });
});

describe("progress", () => {
  it("performer_found: ASSIGNED_DRIVER + courier name, customer tracking link, masked phone, position", async () => {
    const o = order({ status: "PREPARING" }, { acceptPending: false });
    const { s, client } = svcWith([o]);
    await s.apply(
      o,
      claim({
        status: "performer_found",
        performer_info: { courier_name: "Rahul", car_model: "Honda", car_number: "D 12345" },
      }),
      cfg(),
    );
    expect(o.status).toBe("ASSIGNED_DRIVER");
    expect(o.courierName).toBe("Rahul · Honda · D 12345");
    expect(o.courierTrackingUrl).toBe("https://yango.example/track/abc");
    // The phone is fetched for the SOURCE point by Yango's SERVER id, not our 1.
    expect(client.courierPhone).toHaveBeenCalledWith(expect.anything(), "claim-1", 9001);
    expect(o.courierPhone).toBe("+97180012345");
    expect(o.courierPhoneAccessCode).toBe("0163");
    // performer-position has NAMED lat/lon — not the [lon, lat] we send.
    expect(o.courierLat).toBe(25.1);
    expect(o.courierLng).toBe(55.2);
    expect(o.courierLocationAt).toEqual(new Date(1790000000 * 1000));
    expect(o.courierAssignedAt).toBeInstanceOf(Date);
  });

  it("fetches the tracking link and phone once, the position every poll", async () => {
    const o = order({ status: "PREPARING" }, { acceptPending: false });
    const { s, client } = svcWith([o]);
    await s.apply(o, claim({ status: "performer_found" }), cfg());
    await s.apply(o, claim({ status: "pickup_arrived" }), cfg());
    expect(client.trackingLinks).toHaveBeenCalledTimes(1);
    expect(client.courierPhone).toHaveBeenCalledTimes(1);
    expect(client.performerPosition).toHaveBeenCalledTimes(2);
  });

  it("performer_lookup: still searching — records the status, moves nothing", async () => {
    const o = order({ status: "PREPARING" }, { acceptPending: false });
    const { s, orders, client } = svcWith([o]);
    await s.apply(o, claim({ status: "performer_lookup" }), cfg());
    expect(o.courierStatus).toBe("PERFORMER_LOOKUP");
    expect(orders.updateStatus).not.toHaveBeenCalled();
    expect(client.performerPosition).not.toHaveBeenCalled();
  });

  it("pickuped → OUT_FOR_DELIVERY with a pickup time; delivered_finish → COMPLETED", async () => {
    const o = order({ status: "ASSIGNED_DRIVER" }, { acceptPending: false });
    const { s } = svcWith([o]);
    await s.apply(o, claim({ status: "pickuped" }), cfg());
    expect(o.status).toBe("OUT_FOR_DELIVERY");
    expect(o.courierPickedUpAt).toBeInstanceOf(Date);
    await s.apply(o, claim({ status: "delivered_finish", pricing: { final_price: "22.05" } }), cfg());
    expect(o.status).toBe("COMPLETED");
    expect(o.courierDeliveredAt).toBeInstanceOf(Date);
    expect(o.metadata.yango.finalPrice).toBe(22.05);
  });

  it("per-point expected times become the pickup and delivery ETAs", async () => {
    const o = order({}, { acceptPending: false });
    const { s } = svcWith([o]);
    await s.apply(
      o,
      claim({
        status: "performer_found",
        route_points: [
          { id: 9001, type: "source", visit_status: "pending", visited_at: { expected: "2026-09-27T12:10:00Z" } },
          { id: 9002, type: "destination", visit_status: "pending", visited_at: { expected: "2026-09-27T12:30:00Z" } },
        ],
      }),
      cfg(),
    );
    expect(o.courierPickupEtaAt).toEqual(new Date("2026-09-27T12:10:00Z"));
    expect(o.courierEtaAt).toEqual(new Date("2026-09-27T12:30:00Z"));
  });

  it("a return warns the operator once and leaves the order alone", async () => {
    const o = order({ status: "OUT_FOR_DELIVERY" }, { acceptPending: false });
    const { s, activity, orders } = svcWith([o]);
    await s.apply(o, claim({ status: "returning" }), cfg());
    await s.apply(o, claim({ status: "return_arrived" }), cfg());
    const warns = activity.record.mock.calls.filter((c: any[]) => c[0].action === "courier.return");
    expect(warns).toHaveLength(1);
    expect(orders.updateStatus).not.toHaveBeenCalled();
  });

  it("ignores a claim that isn't this order's", async () => {
    const o = order();
    const { s, client } = svcWith([o]);
    expect(await s.apply(o, claim({ id: "someone-else" }), cfg())).toEqual({ ok: false, reason: "not_this_order" });
    expect(client.acceptClaim).not.toHaveBeenCalled();
  });
});
