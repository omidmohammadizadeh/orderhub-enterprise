import {
  transformCareemHours,
  careemDayNumber,
  END_OF_DAY,
} from "../careem-hours.transformer";

// Careem has no concept of a shift crossing midnight. Their docs: "When we say
// that a branch is operational from 11 AM to 2 AM on day X, we actually include
// two days" — day X 11:00 to end of day, day X+1 00:00 to 02:00.
//
// That is why their own example has a Friday shift for a shop that is closed on
// Fridays: it is Thursday night spilling over.

const day = (slots: Array<{ from: string; to: string }>) => ({ enabled: true, slots });

describe("careemDayNumber", () => {
  it("numbers from Monday by default (ISO)", () => {
    expect(careemDayNumber(1, "monday")).toBe(1); // Monday
    expect(careemDayNumber(5, "monday")).toBe(5); // Friday
    expect(careemDayNumber(0, "monday")).toBe(7); // Sunday
  });

  it("can number from Sunday instead", () => {
    // Undocumented — their examples show 1 and 5 and never say which day is 1.
    // Values start at 1, so JavaScript's 0 = Sunday is out, leaving these two.
    expect(careemDayNumber(0, "sunday")).toBe(1);
    expect(careemDayNumber(5, "sunday")).toBe(6);
  });
});

describe("transformCareemHours", () => {
  it("passes an ordinary daytime shift straight through", () => {
    const out = transformCareemHours({ monday: day([{ from: "10:00", to: "22:00" }]) });
    const mon = out.find((d) => d.day_of_week === 1)!;
    expect(mon.active).toBe(true);
    expect(mon.shifts).toEqual([{ start_time: "10:00", end_time: "22:00" }]);
  });

  it("splits an overnight shift across two days", () => {
    // Their worked example, exactly: 11 AM to 2 AM.
    const out = transformCareemHours({ thursday: day([{ from: "11:00", to: "02:00" }]) });
    const thu = out.find((d) => d.day_of_week === 4)!;
    const fri = out.find((d) => d.day_of_week === 5)!;
    expect(thu.shifts).toEqual([{ start_time: "11:00", end_time: END_OF_DAY }]);
    expect(fri.shifts).toEqual([{ start_time: "00:00", end_time: "02:00" }]);
    // The point their docs make: the shop is "closed Friday", yet Friday is
    // active because Thursday night runs into it.
    expect(fri.active).toBe(true);
  });

  it("ends the day at 23:59, because Careem rejects 00:00", () => {
    const out = transformCareemHours({ monday: day([{ from: "18:00", to: "01:00" }]) });
    expect(out.find((d) => d.day_of_week === 1)!.shifts[0]!.end_time).toBe("23:59");
  });

  it("wraps Sunday night round to Monday", () => {
    const out = transformCareemHours({ sunday: day([{ from: "20:00", to: "03:00" }]) });
    expect(out.find((d) => d.day_of_week === 7)!.shifts).toEqual([
      { start_time: "20:00", end_time: END_OF_DAY },
    ]);
    expect(out.find((d) => d.day_of_week === 1)!.shifts).toEqual([
      { start_time: "00:00", end_time: "03:00" },
    ]);
  });

  it("keeps two shifts in a day as two shifts, in order", () => {
    const out = transformCareemHours({
      tuesday: day([
        { from: "18:00", to: "23:00" },
        { from: "11:00", to: "15:00" },
      ]),
    });
    expect(out.find((d) => d.day_of_week === 2)!.shifts).toEqual([
      { start_time: "11:00", end_time: "15:00" },
      { start_time: "18:00", end_time: "23:00" },
    ]);
  });

  it("merges a spillover with the next day's own shift", () => {
    const out = transformCareemHours({
      friday: day([{ from: "18:00", to: "02:00" }]),
      saturday: day([{ from: "12:00", to: "22:00" }]),
    });
    expect(out.find((d) => d.day_of_week === 6)!.shifts).toEqual([
      { start_time: "00:00", end_time: "02:00" },
      { start_time: "12:00", end_time: "22:00" },
    ]);
  });

  it("sends a closed day as inactive rather than omitting it", () => {
    // Leaving the day out would let whatever Careem already holds stand, so a
    // shop that stops opening Mondays would still show as open on Mondays.
    const out = transformCareemHours({ monday: day([{ from: "10:00", to: "22:00" }]) });
    expect(out).toHaveLength(7);
    const tue = out.find((d) => d.day_of_week === 2)!;
    expect(tue.active).toBe(false);
    expect(tue.shifts).toEqual([]);
  });

  it("honours a day switched off", () => {
    const out = transformCareemHours({
      monday: { enabled: false, slots: [{ from: "10:00", to: "22:00" }] },
    });
    expect(out.find((d) => d.day_of_week === 1)!.active).toBe(false);
  });

  it("reads the legacy array-per-day shape too", () => {
    const out = transformCareemHours({ monday: [{ from: "09:00", to: "17:00" }] });
    expect(out.find((d) => d.day_of_week === 1)!.shifts).toEqual([
      { start_time: "09:00", end_time: "17:00" },
    ]);
  });

  it("drops a zero-length slot instead of emitting an empty shift", () => {
    const out = transformCareemHours({ monday: day([{ from: "10:00", to: "10:00" }]) });
    expect(out.find((d) => d.day_of_week === 1)!.active).toBe(false);
  });

  it("does not emit a midnight-to-midnight tail", () => {
    // 18:00 → 00:00 ends at the day boundary; the next day gets nothing.
    const out = transformCareemHours({ monday: day([{ from: "18:00", to: "00:00" }]) });
    expect(out.find((d) => d.day_of_week === 1)!.shifts).toEqual([
      { start_time: "18:00", end_time: END_OF_DAY },
    ]);
    expect(out.find((d) => d.day_of_week === 2)!.shifts).toEqual([]);
  });

  it("returns a full inactive week for a shop with no hours set", () => {
    const out = transformCareemHours({});
    expect(out).toHaveLength(7);
    expect(out.every((d) => d.active === false)).toBe(true);
  });
});

// A shop with no hours set is OPEN on the till — isCurrentlyOpen treats an
// unconfigured schedule as always open. Publishing seven inactive days made
// Careem the only place the shop was shut, and silently: nothing on our side
// looks wrong, and their FAQ lists this as why a branch shows closed on the
// SuperApp.
describe("an unconfigured week", () => {
  const ALL_WEEK_OPEN = Object.fromEntries(
    ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map(
      (d) => [d, [{ from: "00:00", to: "23:59" }]],
    ),
  );

  it("publishes open all week, not closed all week", () => {
    const out = transformCareemHours(ALL_WEEK_OPEN);
    expect(out).toHaveLength(7);
    expect(out.every((d) => d.active)).toBe(true);
    for (const day of out) {
      expect(day.shifts).toEqual([{ start_time: "00:00", end_time: END_OF_DAY }]);
    }
  });

  it("does not spill a full day into the next one", () => {
    // 00:00–23:59 does not cross midnight, so nothing should be added to the
    // following day — otherwise every day would carry a phantom second shift.
    const out = transformCareemHours(ALL_WEEK_OPEN);
    expect(out.every((d) => d.shifts.length === 1)).toBe(true);
  });
});
