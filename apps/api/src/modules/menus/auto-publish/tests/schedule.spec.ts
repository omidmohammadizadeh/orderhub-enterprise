import { nextRunAfter, zonedWallTimeToUtc } from "../schedule";

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("auto-publish schedule", () => {
  it("converts London wall time to UTC in winter and summer", () => {
    expect(iso(zonedWallTimeToUtc(2026, 1, 15, 10, 45, "Europe/London"))).toBe("2026-01-15T10:45:00.000Z"); // GMT
    expect(iso(zonedWallTimeToUtc(2026, 7, 15, 10, 45, "Europe/London"))).toBe("2026-07-15T09:45:00.000Z"); // BST
    expect(iso(zonedWallTimeToUtc(2026, 7, 15, 10, 45, "Asia/Dubai"))).toBe("2026-07-15T06:45:00.000Z");
  });

  it("picks the next time later today, else the next chosen day", () => {
    const every = { days: [0, 1, 2, 3, 4, 5, 6], times: ["10:45", "17:00"], timezone: "Europe/London" };
    // Thu 8 Oct 2026 09:00 BST = 08:00Z
    expect(iso(nextRunAfter(new Date("2026-10-08T08:00:00Z"), every))).toBe("2026-10-08T09:45:00.000Z");
    // after 10:45 → 17:00 same day
    expect(iso(nextRunAfter(new Date("2026-10-08T09:45:00Z"), every))).toBe("2026-10-08T16:00:00.000Z");
    // after 17:00 → tomorrow 10:45
    expect(iso(nextRunAfter(new Date("2026-10-08T16:30:00Z"), every))).toBe("2026-10-09T09:45:00.000Z");
  });

  it("respects chosen weekdays (Mon only) and wraps the week", () => {
    const mondays = { days: [1], times: ["06:00"], timezone: "Europe/London" };
    // Thu 8 Oct → Mon 12 Oct 06:00 BST = 05:00Z
    expect(iso(nextRunAfter(new Date("2026-10-08T12:00:00Z"), mondays))).toBe("2026-10-12T05:00:00.000Z");
  });

  it("lands on the right instant across the October clock change", () => {
    // Clocks go back Sun 25 Oct 2026 02:00 BST → 01:00 GMT. A 10:45 run that
    // Sunday is 10:45 GMT = 10:45Z (it was 09:45Z the day before).
    const daily = { days: [0, 1, 2, 3, 4, 5, 6], times: ["10:45"], timezone: "Europe/London" };
    expect(iso(nextRunAfter(new Date("2026-10-24T12:00:00Z"), daily))).toBe("2026-10-25T10:45:00.000Z");
    expect(iso(nextRunAfter(new Date("2026-10-23T12:00:00Z"), daily))).toBe("2026-10-24T09:45:00.000Z");
  });

  it("returns null for an empty schedule and ignores bad times", () => {
    expect(nextRunAfter(new Date(), { days: [], times: ["10:00"], timezone: "Europe/London" })).toBeNull();
    expect(nextRunAfter(new Date(), { days: [1], times: ["25:00", "x"], timezone: "Europe/London" })).toBeNull();
  });
});
