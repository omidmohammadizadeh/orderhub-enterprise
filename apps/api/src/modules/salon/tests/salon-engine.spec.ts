import {
  canStartAt,
  dayWindows,
  depositFor,
  estimateQueue,
  freeStarts,
  normaliseWeeklyHours,
  occupancy,
  staffDayWindows,
  teamFreeStarts,
  wallDate,
  wallTime,
  weekdayOf,
  zonedWallToUtc,
  commissionOn,
  linesTotal,
  lineBlock,
} from "@orderhub/shared";

const TZ = "Europe/London";
const MIN = 60_000;
const at = (date: string, time: string) => zonedWallToUtc(date, time, TZ);

describe("salon engine — time zones", () => {
  it("turns London wall time into the right instant in summer and winter", () => {
    // BST (UTC+1)
    expect(new Date(at("2026-07-14", "09:00")).toISOString()).toBe("2026-07-14T08:00:00.000Z");
    // GMT
    expect(new Date(at("2026-12-14", "09:00")).toISOString()).toBe("2026-12-14T09:00:00.000Z");
  });

  it("survives the clocks going back", () => {
    // 25 Oct 2026 — BST ends at 02:00. 09:00 that day is GMT.
    expect(new Date(at("2026-10-25", "09:00")).toISOString()).toBe("2026-10-25T09:00:00.000Z");
    expect(new Date(at("2026-10-24", "09:00")).toISOString()).toBe("2026-10-24T08:00:00.000Z");
  });

  it("reads back the shop's own date and clock", () => {
    const ms = Date.parse("2026-07-14T23:30:00.000Z"); // 00:30 BST on the 15th
    expect(wallDate(ms, TZ)).toBe("2026-07-15");
    expect(wallTime(ms, TZ)).toBe("00:30");
    expect(weekdayOf("2026-10-13")).toBe("tuesday");
  });

  it("works for Dubai too", () => {
    expect(new Date(zonedWallToUtc("2026-10-13", "10:00", "Asia/Dubai")).toISOString()).toBe(
      "2026-10-13T06:00:00.000Z",
    );
  });
});

describe("salon engine — working hours", () => {
  it("cleans up messy hours and accepts the location opening-hours shape", () => {
    const h = normaliseWeeklyHours({
      monday: [
        { from: "14:00", to: "18:00" },
        { from: "09:00", to: "13:00" },
        { from: "12:30", to: "14:30" },
        { from: "bad", to: "10:00" },
      ],
      tuesday: { enabled: false, slots: [{ from: "09:00", to: "17:00" }] },
      wednesday: { enabled: true, slots: [{ from: "10:00", to: "16:00" }] },
    });
    expect(h.monday).toEqual([{ from: "09:00", to: "18:00" }]);
    expect(h.tuesday).toBeUndefined();
    expect(h.wednesday).toEqual([{ from: "10:00", to: "16:00" }]);
  });

  it("clips a barber's own hours to the shop's", () => {
    const w = staffDayWindows({
      staffHours: { tuesday: [{ from: "08:00", to: "20:00" }] },
      shopHours: { tuesday: [{ from: "09:00", to: "18:00" }] },
      date: "2026-10-13",
      tz: TZ,
    });
    expect(w).toEqual([{ start: at("2026-10-13", "09:00"), end: at("2026-10-13", "18:00") }]);
  });

  it("falls back to the shop's hours, then Mon–Sat 9–6", () => {
    const shop = staffDayWindows({
      staffHours: {},
      shopHours: { tuesday: [{ from: "10:00", to: "16:00" }] },
      date: "2026-10-13",
      tz: TZ,
    });
    expect(shop[0]!.start).toBe(at("2026-10-13", "10:00"));
    const dflt = staffDayWindows({ staffHours: {}, shopHours: {}, date: "2026-10-18", tz: TZ });
    expect(dflt).toEqual([]); // Sunday closed by default
  });
});

describe("salon engine — occupancy", () => {
  const t0 = at("2026-10-13", "10:00");

  it("runs services back to back with the buffer once at the end", () => {
    const occ = occupancy(t0, [
      { durationMins: 30, bufferMins: 5 },
      { durationMins: 15, bufferMins: 10 },
    ]);
    expect(occ.endMs).toBe(t0 + 45 * MIN);
    expect(occ.busy).toEqual([{ start: t0, end: t0 + 55 * MIN }]);
  });

  it("frees the stylist while colour develops", () => {
    const occ = occupancy(t0, [
      { durationMins: 120, processingStartMins: 30, processingMins: 45 },
    ]);
    expect(occ.endMs).toBe(t0 + 120 * MIN);
    expect(occ.busy).toEqual([
      { start: t0, end: t0 + 30 * MIN },
      { start: t0 + 75 * MIN, end: t0 + 120 * MIN },
    ]);
  });
});

describe("salon engine — free slots", () => {
  const date = "2026-10-13";
  const windows = [{ start: at(date, "09:10"), end: at(date, "12:00") }];

  it("aligns starts to the clock and stops before closing", () => {
    const s = freeStarts({ windows, busy: [], blocks: [{ durationMins: 30 }], stepMins: 15 });
    expect(wallTime(s[0]!, TZ)).toBe("09:15");
    expect(wallTime(s[s.length - 1]!, TZ)).toBe("11:30");
  });

  it("skips anything that would clash with a booking (buffer included)", () => {
    const busy = [{ start: at(date, "10:00"), end: at(date, "10:30") }];
    const s = freeStarts({
      windows,
      busy,
      blocks: [{ durationMins: 30, bufferMins: 10 }],
      stepMins: 15,
    }).map((t) => wallTime(t, TZ));
    expect(s).toContain("09:15");
    expect(s).not.toContain("09:30"); // 09:30–10:00 + 10 min buffer runs into 10:00
    expect(s).not.toContain("10:00");
    expect(s).toContain("10:30");
  });

  it("lets a short cut slot into a colour's processing gap", () => {
    const colour = occupancy(at(date, "09:15"), [
      { durationMins: 120, processingStartMins: 30, processingMins: 45 },
    ]);
    const s = freeStarts({
      windows,
      busy: colour.busy,
      blocks: [{ durationMins: 30 }],
      stepMins: 15,
    }).map((t) => wallTime(t, TZ));
    expect(s).toContain("09:45"); // gap is 09:45–10:30
    expect(s).not.toContain("10:15");
  });

  it("honours lead time", () => {
    const s = freeStarts({
      windows,
      busy: [],
      blocks: [{ durationMins: 30 }],
      stepMins: 15,
      notBefore: at(date, "11:00"),
    });
    expect(wallTime(s[0]!, TZ)).toBe("11:00");
  });

  it("checks one exact start", () => {
    expect(canStartAt({ startMs: at(date, "11:45"), windows, busy: [], blocks: [{ durationMins: 30 }] })).toBe(false);
    expect(canStartAt({ startMs: at(date, "11:30"), windows, busy: [], blocks: [{ durationMins: 30 }] })).toBe(true);
  });

  it("puts 'anyone' on the quietest barber first", () => {
    const team = teamFreeStarts({
      staff: [
        { staffId: "busy", windows, busy: [], bookedCount: 6 },
        { staffId: "quiet", windows, busy: [], bookedCount: 1 },
        { staffId: "booked", windows, busy: [{ start: at(date, "09:00"), end: at(date, "12:00") }] },
      ],
      blocks: [{ durationMins: 30 }],
      stepMins: 15,
    });
    expect(team[0]!.staffIds).toEqual(["quiet", "busy"]);
  });
});

describe("salon engine — money", () => {
  const cut = { serviceId: "a", name: "Skin fade", price: 22, durationMins: 30 };
  it("adds add-ons to price and time", () => {
    const line = { ...cut, addons: [{ id: "x", name: "Beard", price: 8, durationMins: 15 }] };
    expect(linesTotal([line])).toBe(30);
    expect(lineBlock(line).durationMins).toBe(45);
  });
  it("sums deposits by each service's rule", () => {
    expect(
      depositFor([
        { ...cut, depositType: "FIXED", depositValue: 5 },
        { ...cut, depositType: "PERCENT", depositValue: 50 },
        { ...cut, depositType: "FULL" },
        { ...cut, depositType: "NONE" },
        { ...cut, depositType: "FIXED", depositValue: 100 },
      ]),
    ).toBe(5 + 11 + 22 + 0 + 22);
  });
  it("works out commission", () => {
    expect(commissionOn(100, 40)).toBe(40);
    expect(commissionOn(100, null)).toBe(0);
  });
});

describe("salon engine — walk-in queue", () => {
  const date = "2026-10-13";
  const now = at(date, "10:00");
  const day = [{ start: at(date, "09:00"), end: at(date, "18:00") }];

  it("puts each walk-in in the first chair free, in order", () => {
    const est = estimateQueue({
      now,
      barbers: [
        { staffId: "jay", windows: day, busy: [{ start: at(date, "09:40"), end: at(date, "10:20") }] },
        { staffId: "sam", windows: day, busy: [{ start: at(date, "09:50"), end: at(date, "10:10") }] },
      ],
      queue: [
        { id: "1", mins: 30 },
        { id: "2", mins: 30 },
        { id: "3", mins: 30 },
      ],
    });
    expect(est.map((e) => [e.id, e.staffId, e.waitMins])).toEqual([
      ["1", "sam", 10],
      ["2", "jay", 20],
      ["3", "sam", 40],
    ]);
  });

  it("does not squeeze a walk-in in before a booking it would run into", () => {
    const est = estimateQueue({
      now,
      barbers: [{ staffId: "jay", windows: day, busy: [{ start: at(date, "10:15"), end: at(date, "11:00") }] }],
      queue: [{ id: "1", mins: 30 }],
    });
    expect(est[0]!.waitMins).toBe(60);
  });

  it("someone waiting for their own barber only looks at that barber", () => {
    const est = estimateQueue({
      now,
      barbers: [
        { staffId: "jay", windows: day, busy: [{ start: at(date, "10:00"), end: at(date, "11:00") }] },
        { staffId: "sam", windows: day, busy: [] },
      ],
      queue: [{ id: "1", mins: 30, preferredStaffId: "jay" }],
    });
    expect(est[0]).toMatchObject({ staffId: "jay", waitMins: 60 });
  });

  it("says so when nobody can fit them in today", () => {
    const est = estimateQueue({
      now: at(date, "17:45"),
      barbers: [{ staffId: "jay", windows: day, busy: [] }],
      queue: [{ id: "1", mins: 30 }],
    });
    expect(est[0]!.startMs).toBeNull();
  });
});

describe("salon engine — dayWindows", () => {
  it("returns nothing on a closed day", () => {
    expect(dayWindows({ monday: [{ from: "09:00", to: "17:00" }] }, "2026-10-13", TZ)).toEqual([]);
  });
});
