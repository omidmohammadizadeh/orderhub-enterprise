import { JetLifecycleService } from "../jet-lifecycle.service";

// Driver events belong in the Logs page.
//
// Cancellations, acks, menu pushes and stock changes all write an activity log
// the operator can read per location. Driver notifications did not — so when a
// courier never showed up there was nothing to look at, and the only way to
// find out what happened was to read raw server logs, which an operator has no
// access to.
//
// That is precisely the case this is for: Just Eat dispatched a driver AFTER
// the test order had been deleted, and nothing in the dashboard recorded
// either fact.

function harness(order: any) {
  const records: any[] = [];
  const svc = Object.create(JetLifecycleService.prototype) as any;
  svc.prisma = {
    order: {
      findFirst: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  svc.orders = { updateStatus: jest.fn().mockResolvedValue({}) };
  svc.activity = { record: jest.fn((r: any) => records.push(r)) };
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { svc, records };
}

const ORDER = {
  id: "o1",
  tenantId: "t1",
  locationId: "l1",
  brandId: "b1",
  status: "ACCEPTED",
  displayId: "949897623",
  courierAssignedAt: null,
  courierPickedUpAt: null,
  courierDeliveredAt: null,
};

const event = (code: string) => ({
  orderID: "jet-1",
  driverStatus: { code },
  happenedAt: "2026-09-17T20:45:00.000Z",
});

describe("JET driver status — what the operator sees in Logs", () => {
  it("records the event against the order's location", async () => {
    const { svc, records } = harness(ORDER);
    await svc.handleDriverStatus(event("onItsWay"));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tenantId: "t1",
      locationId: "l1",
      brandId: "b1",
      channel: "JUST_EAT",
    });
  });

  it("says what the driver did in words, not a status code", async () => {
    const { svc, records } = harness(ORDER);
    await svc.handleDriverStatus(event("driverAtRestaurant"));

    expect(records[0].message).toMatch(/arrived at the restaurant/i);
    expect(records[0].message).toContain("949897623");
  });

  it("covers every code in JET's enum", async () => {
    for (const code of [
      "driverArrivingAtRestaurant",
      "driverAtRestaurant",
      "onItsWay",
      "delivered",
    ]) {
      const { svc, records } = harness(ORDER);
      await svc.handleDriverStatus(event(code));
      expect(records[0].message).not.toMatch(/undefined|\[object/i);
    }
  });

  it("flags a code we do not recognise rather than logging nothing", async () => {
    // A code outside the spec's four would otherwise pass silently and the
    // order would sit still with no explanation anywhere.
    const { svc, records } = harness(ORDER);
    await svc.handleDriverStatus(event("driverVanished"));

    expect(records[0].status).toBe("WARNING");
    expect(records[0].details.code).toBe("driverVanished");
  });

  it("records a driver event that lands after the order was cancelled", async () => {
    // The case that prompted this. Just Eat deleted the test order and then
    // dispatched a driver anyway. Our row still exists — cancelled, not
    // deleted — so the event finds it and the operator can now see that the
    // courier turned up after the order was already dead.
    const { svc, records } = harness({ ...ORDER, status: "CANCELLED" });
    await svc.handleDriverStatus(event("onItsWay"));

    expect(records).toHaveLength(1);
    expect(records[0].details.code).toBe("onItsWay");
  });

  it("writes nothing for an order id we have never seen", async () => {
    // No order means no tenant or location to file it under, so there is
    // nowhere to put it. Server logs still carry the warning.
    const { svc, records } = harness(null);
    await svc.handleDriverStatus(event("onItsWay"));

    expect(records).toHaveLength(0);
  });
});
