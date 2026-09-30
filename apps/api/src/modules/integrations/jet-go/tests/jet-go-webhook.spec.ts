import { JetGoWebhookService } from "../jet-go-webhook.service";

// JET Go's nine webhook types. The ones that matter most are the ones where
// believing the obvious reading of the payload loses money or a live delivery.

type Row = Record<string, any>;

function svcWith(rows: Row[]) {
  const updates: Array<{ id: string; data: Row }> = [];
  const matches = (o: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => (v === null ? o[k] == null : o[k] === v));
  const prisma: any = {
    order: {
      findFirst: jest.fn(async ({ where }: any) => rows.find((o) => matches(o, where)) ?? null),
      findUnique: jest.fn(async ({ where }: any) => rows.find((o) => o.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        updates.push({ id: where.id, data });
        const row = rows.find((o) => o.id === where.id);
        if (row) Object.assign(row, data);
        return {};
      }),
    },
  };
  const orders = { updateStatus: jest.fn().mockResolvedValue({}) };
  const wallet = {
    dispatchFeeMinor: () => 50,
    refundDispatch: jest.fn().mockResolvedValue(undefined),
  };
  const activity = { record: jest.fn() };
  const s: any = Object.create(JetGoWebhookService.prototype);
  s.prisma = prisma;
  s.orders = orders;
  s.wallet = wallet;
  s.activity = activity;
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { s: s as JetGoWebhookService, updates, orders, wallet, activity, rows };
}

const order = (over: Row = {}): Row => ({
  id: "o1",
  tenantId: "t1",
  locationId: "loc1",
  displayId: "A-1042",
  status: "READY",
  courierProvider: "JET_GO",
  courierJobId: "req-1",
  courierDeliveryId: null,
  courierStatus: "PENDING",
  courierAssignedAt: null,
  courierPickedUpAt: null,
  courierDeliveredAt: null,
  courierTrackingUrl: null,
  metadata: {},
  ...over,
});

const evt = (type: string, data: Row): Row => ({
  id: "evt-1",
  type,
  timestamp: "2026-09-26T12:00:00.000Z",
  data: { requestId: "req-1", ...data },
});

const lastFor = (updates: Array<{ id: string; data: Row }>, id: string) =>
  [...updates].reverse().find((u) => u.id === id)?.data ?? {};

describe("routing", () => {
  it("finds the order by requestId", async () => {
    const { s, updates } = svcWith([order()]);
    await s.handle(evt("DELIVERYCREATED", { deliveryId: "d-9" }));
    expect(lastFor(updates, "o1").courierDeliveryId).toBe("d-9");
  });

  it("falls back to the orderId we put in metadata", async () => {
    // Belt and braces: the metadata we send on /delivery comes back on every
    // event, so an unmatched requestId still resolves.
    const { s, updates } = svcWith([order({ courierJobId: "different" })]);
    await s.handle(evt("DELIVERYCREATED", { requestId: "req-1", metadata: { orderId: "o1" } }));
    expect(lastFor(updates, "o1").courierStatus).toBe("CREATED");
  });

  it("acknowledges an event for an order it doesn't know", async () => {
    const { s, updates } = svcWith([]);
    const r = await s.handle(evt("COURIERJOBSTATUS", { status: "DELIVERED" }));
    expect(r).toMatchObject({ ok: true, reason: "order_not_found" });
    expect(updates).toHaveLength(0);
  });
});

describe("COURIERJOBSTATUS", () => {
  it("does NOT move the order on ASSIGNED — that is only an offer", async () => {
    // JET's docs are explicit: ASSIGNED means an offer went out to one or more
    // couriers and may arrive several times. Treating it as "driver assigned"
    // tells the customer a rider is coming when nobody has accepted.
    const { s, orders, updates } = svcWith([order()]);
    await s.handle(evt("COURIERJOBSTATUS", { status: "ASSIGNED" }));
    expect(orders.updateStatus).not.toHaveBeenCalled();
    expect(lastFor(updates, "o1").courierStatus).toBe("ASSIGNED");
    expect(lastFor(updates, "o1").courierAssignedAt).toBeUndefined();
  });

  it("treats IN_TRANSIT_TO_COLLECT as the real assignment", async () => {
    const { s, orders, updates } = svcWith([order()]);
    await s.handle(
      evt("COURIERJOBSTATUS", { status: "IN_TRANSIT_TO_COLLECT", courier: { name: "Ana" } }),
    );
    expect(orders.updateStatus).toHaveBeenCalledWith(
      "o1",
      "t1",
      expect.objectContaining({ status: "ASSIGNED_DRIVER" }),
      "jet-go-webhook",
      "WEBHOOK",
    );
    const d = lastFor(updates, "o1");
    expect(d.courierName).toBe("Ana");
    expect(d.courierAssignedAt).toBeInstanceOf(Date);
  });

  it.each([
    ["COLLECTED", "OUT_FOR_DELIVERY"],
    ["IN_TRANSIT_TO_DELIVER", "OUT_FOR_DELIVERY"],
    ["ARRIVED_TO_DELIVER", "OUT_FOR_DELIVERY"],
    ["DELIVERED", "COMPLETED"],
    ["CANCELLED", "CANCELLED"],
  ])("maps %s → %s", async (jet, ours) => {
    const { s, orders } = svcWith([order()]);
    await s.handle(evt("COURIERJOBSTATUS", { status: jet }));
    expect(orders.updateStatus).toHaveBeenCalledWith(
      "o1",
      "t1",
      expect.objectContaining({ status: ours }),
      "jet-go-webhook",
      "WEBHOOK",
    );
  });

  it("stamps pickup and delivery times", async () => {
    const { s, updates } = svcWith([order()]);
    await s.handle(evt("COURIERJOBSTATUS", { status: "COLLECTED" }));
    expect(lastFor(updates, "o1").courierPickedUpAt).toBeInstanceOf(Date);
    const { s: s2, updates: u2 } = svcWith([order()]);
    await s2.handle(evt("COURIERJOBSTATUS", { status: "DELIVERED" }));
    expect(lastFor(u2, "o1").courierDeliveredAt).toBeInstanceOf(Date);
  });

  it('rejects the literal "Not available" tracking URL', async () => {
    // orderTrackerURL is a Canada-only feature; every other market returns this
    // string. Storing it puts a dead "Track your courier" link in front of a
    // customer.
    const { s, updates } = svcWith([order()]);
    await s.handle(
      evt("COURIERJOBSTATUS", { status: "COLLECTED", orderTrackerURL: "Not available" }),
    );
    expect(lastFor(updates, "o1").courierTrackingUrl).toBeUndefined();
  });

  it("keeps a real tracking URL", async () => {
    const { s, updates } = svcWith([order()]);
    await s.handle(
      evt("COURIERJOBSTATUS", {
        status: "COLLECTED",
        orderTrackerURL: "https://skipthedishes.com/t/abc",
      }),
    );
    expect(lastFor(updates, "o1").courierTrackingUrl).toBe("https://skipthedishes.com/t/abc");
  });

  it("surfaces a return without silently cancelling a paid order", async () => {
    const { s, orders, activity } = svcWith([order()]);
    await s.handle(
      evt("COURIERJOBSTATUS", {
        status: "RETURN_INITIATED",
        deliveryProperties: { isReturn: true, reasonForReturn: "Customer unreachable" },
      }),
    );
    expect(orders.updateStatus).not.toHaveBeenCalled();
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "courier.return", status: "WARNING" }),
    );
  });
});

describe("CANCELJOBSTATUS", () => {
  it("does nothing destructive when the cancellation FAILED", async () => {
    // status:false means JET refused — the courier is still coming. Clearing the
    // order here would drop a live delivery off the board.
    const { s, updates, orders, wallet } = svcWith([
      order({ courierStatus: "CANCELLATION_REQUESTED" }),
    ]);
    const r = await s.handle(
      evt("CANCELJOBSTATUS", { status: "false", message: "Already collected" }),
    );
    expect(r).toMatchObject({ reason: "cancellation_refused" });
    const d = lastFor(updates, "o1");
    expect(d.courierStatus).toBe("CANCELLATION_FAILURE");
    expect(d.courierProvider).toBeUndefined(); // not cleared
    expect(wallet.refundDispatch).not.toHaveBeenCalled();
    expect(orders.updateStatus).not.toHaveBeenCalled();
  });

  it("clears the courier and puts the order back on the board when it succeeded", async () => {
    const { s, updates, orders } = svcWith([order({ courierStatus: "CANCELLATION_REQUESTED" })]);
    await s.handle(evt("CANCELJOBSTATUS", { status: true }));
    const d = lastFor(updates, "o1");
    expect(d.courierProvider).toBeNull();
    expect(d.courierJobId).toBeNull();
    // The food is still made and still owed — the order survives, it just has
    // no courier.
    expect(orders.updateStatus).toHaveBeenCalledWith(
      "o1",
      "t1",
      expect.objectContaining({ status: "READY" }),
      "jet-go-webhook",
      "WEBHOOK",
    );
  });

  it("does NOT refund our fee when the operator asked for the cancellation", async () => {
    const { s, wallet } = svcWith([order({ courierStatus: "CANCELLATION_REQUESTED" })]);
    await s.handle(evt("CANCELJOBSTATUS", { status: true }));
    expect(wallet.refundDispatch).not.toHaveBeenCalled();
  });

  it("refunds our fee when JET cancelled on us", async () => {
    // The 2026-07-28 change: JET auto-cancels a delivery no courier picked up.
    // The shop paid a dispatch fee for a courier that never came.
    const { s, wallet, activity } = svcWith([order({ courierStatus: "CREATED" })]);
    await s.handle(
      evt("CANCELJOBSTATUS", { status: true, message: "No courier found within timeout" }),
    );
    expect(wallet.refundDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", locationId: "loc1", orderId: "o1", amountMinor: 50 }),
    );
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "courier.cancelled_by_jet", status: "WARNING" }),
    );
  });

  it("accepts a boolean true as well as the string", async () => {
    const { s, updates } = svcWith([order({ courierStatus: "CANCELLATION_REQUESTED" })]);
    await s.handle(evt("CANCELJOBSTATUS", { status: true }));
    expect(lastFor(updates, "o1").courierProvider).toBeNull();
  });

  it("cannot refund twice, because clearing the provider unroutes the order", async () => {
    const { s, wallet } = svcWith([order({ courierStatus: "CREATED" })]);
    await s.handle(evt("CANCELJOBSTATUS", { status: true }));
    await s.handle(evt("CANCELJOBSTATUS", { status: true }));
    expect(wallet.refundDispatch).toHaveBeenCalledTimes(1);
  });
});

describe("DELIVERYREJECTED", () => {
  it("refunds the dispatch fee and frees the order", async () => {
    const { s, updates, wallet, activity } = svcWith([order()]);
    await s.handle(evt("DELIVERYREJECTED", { message: "No couriers in area" }));
    expect(wallet.refundDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "o1", amountMinor: 50 }),
    );
    expect(lastFor(updates, "o1").courierProvider).toBeNull();
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "courier.rejected", status: "ERROR" }),
    );
  });
});

describe("ETA and location events", () => {
  it("keeps the shop ETA and the customer ETA in separate columns", async () => {
    const { s, updates } = svcWith([order()]);
    await s.handle(evt("COURIERCOLLECTIONTIME", { courierETA: "2026-09-26T12:20:00.000Z" }));
    expect(lastFor(updates, "o1").courierPickupEtaAt).toEqual(
      new Date("2026-09-26T12:20:00.000Z"),
    );

    const { s: s2, updates: u2 } = svcWith([order()]);
    await s2.handle(
      evt("COURIERDELIVERYTIME", { postPurchaseDeliveryEta: "2026-09-26T12:45:00.000Z" }),
    );
    expect(lastFor(u2, "o1").courierEtaAt).toEqual(new Date("2026-09-26T12:45:00.000Z"));
  });

  it("writes the courier pin with the time it was taken", async () => {
    const { s, updates } = svcWith([order()]);
    await s.handle(evt("COURIERLOCATION", { latitude: 51.5, longitude: -0.12 }));
    const d = lastFor(updates, "o1");
    expect(d.courierLat).toBe(51.5);
    expect(d.courierLng).toBe(-0.12);
    expect(d.courierLocationAt).toBeInstanceOf(Date);
  });

  it("refuses 0,0 — that is the Atlantic, not a courier", async () => {
    const { s, updates } = svcWith([order()]);
    const r = await s.handle(evt("COURIERLOCATION", { latitude: 0, longitude: 0 }));
    expect(r).toMatchObject({ reason: "no_location" });
    expect(updates).toHaveLength(0);
  });

  it("ignores an unparseable ETA rather than writing an Invalid Date", async () => {
    const { s, updates } = svcWith([order()]);
    await s.handle(evt("COURIERCOLLECTIONTIME", { courierETA: "soon" }));
    expect(updates).toHaveLength(0);
  });
});

describe("proof of delivery", () => {
  it("stores the PIN the customer has to give the courier", async () => {
    const { s, updates } = svcWith([order()]);
    await s.handle(evt("PROOFOFDELIVERY", { pinCode: "4821", status: "CREATED" }));
    expect(lastFor(updates, "o1").metadata.jetGo).toMatchObject({
      pinCode: "4821",
      pinStatus: "CREATED",
    });
  });

  it("keeps the rest of metadata when merging", async () => {
    const { s, updates } = svcWith([order({ metadata: { keepMe: 1, jetGo: { pinCode: "1" } } })]);
    await s.handle(evt("PROOFOFDELIVERY", { status: "VALID" }));
    const meta = lastFor(updates, "o1").metadata;
    expect(meta.keepMe).toBe(1);
    expect(meta.jetGo.pinCode).toBe("1"); // not wiped by an event with no PIN
    expect(meta.jetGo.pinStatus).toBe("VALID");
  });

  it("flags a wrong PIN for the operator", async () => {
    const { s, activity } = svcWith([order()]);
    await s.handle(evt("PROOFOFDELIVERY", { status: "INVALID" }));
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "courier.pin_invalid" }),
    );
  });

  it("stores photo proof with a timestamp, because the links expire", async () => {
    const { s, updates } = svcWith([order()]);
    await s.handle(evt("PICTUREASPROOFOFDELIVERY", { urls: ["https://x/1.jpg"] }));
    const jetGo = lastFor(updates, "o1").metadata.jetGo;
    expect(jetGo.proofPhotoUrls).toEqual(["https://x/1.jpg"]);
    expect(jetGo.proofPhotoAt).toBeTruthy();
  });

  it("accepts a single url string as well as an array", async () => {
    const { s, updates } = svcWith([order()]);
    await s.handle(evt("PICTUREASPROOFOFDELIVERY", { urls: "https://x/1.jpg" }));
    expect(lastFor(updates, "o1").metadata.jetGo.proofPhotoUrls).toEqual(["https://x/1.jpg"]);
  });
});

describe("unknown payloads", () => {
  it("acknowledges an event type it has never seen", async () => {
    const { s } = svcWith([order()]);
    expect(await s.handle(evt("SOMETHINGNEW", {}))).toMatchObject({
      ok: true,
      reason: "unhandled_type",
    });
  });

  it("rejects a body with no type", async () => {
    const { s } = svcWith([order()]);
    expect(await s.handle({ data: {} })).toMatchObject({ ok: false, reason: "no_type" });
  });
});
