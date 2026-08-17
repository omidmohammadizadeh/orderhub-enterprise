// Normalising opening hours between the two shapes we store.
//
// Location.openingHours is the legacy ARRAY ([{day: 0-6, open, close}], day
// 0 = Sunday). Brand.openingHours is the MAP ({monday: {enabled, slots}}).
// Two shapes for the same fact, which is why a brand could never simply
// reuse its location's hours — a raw copy writes an array into a field every
// reader treats as a map.
//
// The day indexing is the dangerous part: the array counts from Sunday and
// the map starts on Monday, so an off-by-one shifts the entire trading week
// by a day and nobody notices until a shop opens on the wrong morning.

import { toWeekHours, WEEK_DAYS } from "../opening-hours.util";

describe("toWeekHours — legacy array (location) → map (brand)", () => {
  it("puts Sunday (day 0) on Sunday, not Monday", () => {
    // The off-by-one that would silently move every shift a day earlier.
    const week = toWeekHours([{ day: 0, open: "12:00", close: "22:00" }]);
    expect(week.sunday).toEqual([{ from: "12:00", to: "22:00" }]);
    expect(week.monday).toEqual([]);
  });

  it("puts Monday (day 1) on Monday", () => {
    const week = toWeekHours([{ day: 1, open: "09:00", close: "17:00" }]);
    expect(week.monday).toEqual([{ from: "09:00", to: "17:00" }]);
  });

  it("puts Saturday (day 6) on Saturday", () => {
    const week = toWeekHours([{ day: 6, open: "10:00", close: "23:00" }]);
    expect(week.saturday).toEqual([{ from: "10:00", to: "23:00" }]);
  });

  it("maps a whole week without shifting it", () => {
    const week = toWeekHours(
      [0, 1, 2, 3, 4, 5, 6].map((day) => ({
        day,
        open: `0${day}:00`,
        close: "23:00",
      })),
    );
    // day 0 = Sunday carries "00:00", day 1 = Monday carries "01:00", …
    expect(week.sunday![0]!.from).toBe("00:00");
    expect(week.monday![0]!.from).toBe("01:00");
    expect(week.saturday![0]!.from).toBe("06:00");
  });

  it("keeps several slots on the same day (split shifts)", () => {
    const week = toWeekHours([
      { day: 2, open: "09:00", close: "14:00" },
      { day: 2, open: "17:00", close: "23:00" },
    ]);
    expect(week.tuesday).toEqual([
      { from: "09:00", to: "14:00" },
      { from: "17:00", to: "23:00" },
    ]);
  });

  it("ignores rows with a nonsense day rather than throwing", () => {
    const week = toWeekHours([
      { day: 9, open: "09:00", close: "17:00" },
      { day: null, open: "09:00", close: "17:00" },
      { day: 1, open: "09:00", close: "17:00" },
    ]);
    expect(week.monday).toHaveLength(1);
  });
});

describe("toWeekHours — map (brand) in, map out", () => {
  it("passes the brand's own shape through", () => {
    const week = toWeekHours({
      monday: { enabled: true, slots: [{ from: "09:00", to: "17:00" }] },
    });
    expect(week.monday).toEqual([{ from: "09:00", to: "17:00" }]);
  });

  it("treats a disabled day as closed", () => {
    // enabled:false must win over whatever slots are left sitting in the row.
    const week = toWeekHours({
      monday: { enabled: false, slots: [{ from: "09:00", to: "17:00" }] },
    });
    expect(week.monday).toEqual([]);
  });

  it("accepts the bare-array day variant", () => {
    const week = toWeekHours({ friday: [{ from: "11:00", to: "23:00" }] });
    expect(week.friday).toEqual([{ from: "11:00", to: "23:00" }]);
  });
});

describe("toWeekHours — always a complete week", () => {
  it("returns all seven days even when nothing is configured", () => {
    // A caller rendering an editor shouldn't have to guard every day.
    for (const src of [null, undefined, {}, [], "nonsense"]) {
      const week = toWeekHours(src);
      expect(Object.keys(week)).toEqual([...WEEK_DAYS]);
      for (const d of WEEK_DAYS) expect(week[d]).toEqual([]);
    }
  });

  it("fills the days that aren't mentioned with an empty list", () => {
    const week = toWeekHours([{ day: 1, open: "09:00", close: "17:00" }]);
    expect(week.tuesday).toEqual([]);
    expect(week.sunday).toEqual([]);
  });

  it("drops half-specified slots instead of storing undefined times", () => {
    const week = toWeekHours([
      { day: 1, open: "09:00" },
      { day: 1, close: "17:00" },
    ]);
    expect(week.monday).toEqual([]);
  });
});
