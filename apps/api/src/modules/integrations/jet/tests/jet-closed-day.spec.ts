import { JetStoreStatusService, toJetOpeningTimes } from "../jet-store-status.service";

// A DAY THE SHOP IS SHUT.
//
// KOREAN FRIED CHICKEN-CORBY (restaurant 440845) is closed on Mondays. We sent
// its service times on 23 Oct with SIX days — Monday simply left out, which is
// what this code always did and believed meant "closed":
//
//   "Service times pushed to Just Eat restaurant 440845 (6 open days)"
//
// Just Eat kept taking Monday orders. Changing a day's HOURS works (Sunday
// moved to 22:48 and showed up), because that day is present in the payload.
// Omitting a day changes nothing at all.
//
// And the day cannot be closed through the menu either: JET rejects an empty
// availability array ("Array must have at least 1 items"), so buildMenus
// backfills a day with no hours as ALL DAY. Real trading hours are the
// intersection of the two — and with the menu saying all-day and the service
// times saying nothing, the intersection is OPEN ALL DAY.
//
// So a closed day was expressible in neither place. It has to be sent
// explicitly: the day is present, with no windows in it.

const CLOSED_MONDAY = {
  monday: { enabled: false, slots: [] },
  tuesday: { enabled: true, slots: [{ from: "16:00", to: "22:45" }] },
  wednesday: { enabled: true, slots: [{ from: "16:00", to: "22:45" }] },
  thursday: { enabled: true, slots: [{ from: "16:00", to: "22:45" }] },
  friday: { enabled: true, slots: [{ from: "16:00", to: "22:45" }] },
  saturday: { enabled: true, slots: [{ from: "16:00", to: "22:45" }] },
  sunday: { enabled: true, slots: [{ from: "16:00", to: "22:48" }] },
};

const DAYS = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
] as const;

describe("toJetOpeningTimes — a closed day is stated, not omitted", () => {
  it("sends Monday as an empty day rather than leaving it out", () => {
    const out = toJetOpeningTimes(CLOSED_MONDAY);

    expect(out.monday).toEqual([]);
  });

  it("sends all seven days, so the week is unambiguous", () => {
    // A partial payload reads as "here are some days", which is how Monday
    // survived. Seven keys says "this is the whole week".
    const out = toJetOpeningTimes(CLOSED_MONDAY);

    expect(Object.keys(out).sort()).toEqual([...DAYS].sort());
  });

  it("leaves the open days exactly as they were", () => {
    const out = toJetOpeningTimes(CLOSED_MONDAY);

    expect(out.sunday).toEqual([{ openingTime: "16:00", closingTime: "22:48" }]);
    expect(out.tuesday).toEqual([{ openingTime: "16:00", closingTime: "22:45" }]);
  });

  it("treats a day missing from the stored hours as closed too", () => {
    // The editor can leave a day out entirely; that is still a shut day.
    const out = toJetOpeningTimes({
      friday: { enabled: true, slots: [{ from: "16:00", to: "22:00" }] },
    });

    expect(out.monday).toEqual([]);
    expect(out.friday).toEqual([{ openingTime: "16:00", closingTime: "22:00" }]);
  });

  it("still splits a past-midnight window across two days", () => {
    // The overnight fix and this one have to coexist: Friday's tail lands on
    // Saturday even though Saturday is otherwise shut.
    const out = toJetOpeningTimes({
      friday: { enabled: true, slots: [{ from: "20:00", to: "02:00" }] },
    });

    expect(out.friday).toEqual([{ openingTime: "20:00", closingTime: "23:59" }]);
    expect(out.saturday).toEqual([{ openingTime: "00:00", closingTime: "02:00" }]);
    expect(out.monday).toEqual([]);
  });
});

describe("publishServiceTimes — closed days reach Just Eat", () => {
  function makeStatus(opts: { request?: jest.Mock; openingHours?: any } = {}) {
    const request = opts.request ?? jest.fn().mockResolvedValue(null);
    const prisma = {
      brandPlatformConnection: {
        findFirst: jest.fn(async () => ({
          id: "conn-1",
          brandId: "b1",
          locationId: "l1",
          externalStoreId: "440845",
          metadata: { restaurantReference: "440845" },
          location: { timezone: "Europe/London" },
        })),
        findMany: jest.fn(async () => [{ id: "conn-1" }]),
      },
      location: {
        findUnique: jest.fn(async () => ({
          openingHours: "openingHours" in opts ? opts.openingHours : CLOSED_MONDAY,
        })),
      },
      brand: { findUnique: jest.fn(async () => ({ openingHours: null })) },
    } as any;
    const activity = { record: jest.fn() } as any;
    return {
      service: new JetStoreStatusService(prisma, { request } as any, activity),
      request,
      activity,
    };
  }

  const bodyOf = (request: jest.Mock) => request.mock.calls[0]![2].body;

  it("puts the closed day in the request Just Eat actually receives", async () => {
    const { service, request } = makeStatus();

    await service.publishServiceTimes("t1", "conn-1");

    for (const st of bodyOf(request).serviceTimes) {
      expect(st.openingTimes.monday).toEqual([]);
    }
  });

  it("reports the open days, not a count of seven", async () => {
    // "7 open days" for a shop shut on Monday would be a lie in the log that
    // is used to chase this sort of thing down.
    const { service, activity } = makeStatus();

    const res: any = await service.publishServiceTimes("t1", "conn-1");

    expect(res.days).toEqual([
      "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    ]);
    expect(activity.record.mock.calls[0][0].message).toContain("6 open days");
  });

  it("still refuses when every day is shut", async () => {
    // Sending a week of empty days would take the shop off Just Eat entirely.
    const { service, request } = makeStatus({
      openingHours: { monday: { enabled: false, slots: [] } },
    });

    await expect(service.publishServiceTimes("t1", "conn-1")).rejects.toThrow(
      /would close the restaurant/i,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("falls back to the old shape if Just Eat rejects the empty day", async () => {
    // We cannot read JET's schema from here. If an empty array turns out to be
    // invalid, hours publishing must not break for every shop with a closed
    // day — it should degrade to exactly what it did before.
    const request = jest
      .fn()
      .mockRejectedValueOnce(new Error("400 openingTimes.monday: invalid"))
      .mockResolvedValue(null);
    const { service } = makeStatus({ request });

    const res: any = await service.publishServiceTimes("t1", "conn-1");

    expect(request).toHaveBeenCalledTimes(2);
    expect(Object.keys(request.mock.calls[1]![2].body.serviceTimes[0].openingTimes))
      .not.toContain("monday");
    expect(res.closedDaysSent).toBe(false);
  });
});
