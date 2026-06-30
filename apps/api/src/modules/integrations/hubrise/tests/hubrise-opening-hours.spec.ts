import { toHubRiseOpeningHours } from "../hubrise-location-pause.service";

// HubRise expects opening_hours as { monday: [{from,to}], … }. We store three
// different internal shapes; the normaliser must produce HubRise's shape from
// all of them, or the location PATCH 422s.

describe("toHubRiseOpeningHours", () => {
  it("converts the location editor map ({enabled, slots})", () => {
    const input = {
      monday: { enabled: true, slots: [{ from: "09:00", to: "22:00" }] },
      tuesday: { enabled: false, slots: [{ from: "09:00", to: "22:00" }] },
      wednesday: { enabled: true, slots: [] },
    };
    expect(toHubRiseOpeningHours(input)).toEqual({
      monday: [{ from: "09:00", to: "22:00" }],
    });
  });

  it("passes through the brand map (array per day) with multiple slots", () => {
    const input = {
      friday: [
        { from: "12:00", to: "14:00" },
        { from: "18:00", to: "01:00" },
      ],
    };
    expect(toHubRiseOpeningHours(input)).toEqual({
      friday: [
        { from: "12:00", to: "14:00" },
        { from: "18:00", to: "01:00" },
      ],
    });
  });

  it("converts the legacy array shape [{day, open, close}]", () => {
    const input = [
      { day: "Saturday", open: "10:00", close: "23:00" },
      { day: "sunday", open: "10:00", close: "20:00" },
    ];
    expect(toHubRiseOpeningHours(input)).toEqual({
      saturday: [{ from: "10:00", to: "23:00" }],
      sunday: [{ from: "10:00", to: "20:00" }],
    });
  });

  it("drops empty/disabled days and returns null when nothing is configured", () => {
    expect(toHubRiseOpeningHours({})).toBeNull();
    expect(toHubRiseOpeningHours([])).toBeNull();
    expect(toHubRiseOpeningHours(null)).toBeNull();
    expect(
      toHubRiseOpeningHours({ monday: { enabled: false, slots: [] } }),
    ).toBeNull();
  });
});
