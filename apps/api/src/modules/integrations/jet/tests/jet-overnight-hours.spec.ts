import { toJetAvailability } from "../jet-menu.transformer";
import { toJetOpeningTimes } from "../jet-store-status.service";

// HOURS THAT RUN PAST MIDNIGHT.
//
// CHICKEN COTTAGE (Monster Burgerz High Street, restaurant 446600) trades
// 12:00–02:00 on Friday and Saturday. We stored that honestly and sent it
// to Just Eat exactly as stored:
//
//   availability.friday = ["12:00 - 02:00"]
//   serviceTimes.friday = [{ openingTime: "12:00", closingTime: "02:00" }]
//
// Just Eat ACCEPTED the menu — our logs say so, no warnings — and the hours
// still did not move on the platform. A window whose closing time is before
// its opening time has no same-day meaning: JET's day windows run 00:00 to
// 23:59 (which is why ALL_DAY_WINDOW stops at 23:59, not 24:00), so
// "12:00 - 02:00" describes a day with no open minutes in it.
//
// A night that ends at 02:00 belongs to TWO days: Friday 12:00–23:59, then
// Saturday 00:00–02:00. That is what the platform has to be told.
//
// This matters beyond the hours display: a menu's availability can only ever
// NARROW the real trading window (service times and the delivery pool are
// intersected with it), so a Friday that reads as closed takes the shop off
// Just Eat on its busiest night.

describe("Opening hours that cross midnight", () => {
  const friLate = {
    friday: { enabled: true, slots: [{ from: "12:00", to: "02:00" }] },
  };

  describe("menu availability", () => {
    it("ends Friday at 23:59 instead of an impossible 12:00–02:00", () => {
      const out = toJetAvailability(friLate);

      expect(out.friday).toEqual(["12:00 - 23:59"]);
    });

    it("carries the small hours onto Saturday, where they actually fall", () => {
      const out = toJetAvailability(friLate);

      expect(out.saturday).toEqual(["00:00 - 02:00"]);
    });

    it("wraps Sunday night round to Monday morning", () => {
      // The end of the week has to wrap, or Sunday's late trade is dropped.
      const out = toJetAvailability({
        sunday: { enabled: true, slots: [{ from: "16:00", to: "01:00" }] },
      });

      expect(out.sunday).toEqual(["16:00 - 23:59"]);
      expect(out.monday).toEqual(["00:00 - 01:00"]);
    });

    it("merges a spill-over with the day's own opening", () => {
      // CHICKEN COTTAGE's real week: Friday AND Saturday both run to 02:00,
      // so Saturday holds its own 12:00 start plus Friday's tail.
      const out = toJetAvailability({
        friday: { enabled: true, slots: [{ from: "12:00", to: "02:00" }] },
        saturday: { enabled: true, slots: [{ from: "12:00", to: "02:00" }] },
      });

      expect(out.saturday).toEqual(["00:00 - 02:00", "12:00 - 23:59"]);
      expect(out.sunday).toEqual(["00:00 - 02:00"]);
    });

    it("leaves an ordinary same-day window alone", () => {
      const out = toJetAvailability({
        monday: { enabled: true, slots: [{ from: "12:00", to: "23:59" }] },
      });

      expect(out.monday).toEqual(["12:00 - 23:59"]);
      expect(out.tuesday).toEqual([]);
    });

    it("still emits every day, so the schema stays happy", () => {
      // JET rejects a missing day outright; a closed day is an empty array.
      const out = toJetAvailability(friLate);

      expect(Object.keys(out).sort()).toEqual(
        [
          "friday",
          "monday",
          "saturday",
          "sunday",
          "thursday",
          "tuesday",
          "wednesday",
        ].sort(),
      );
    });
  });

  describe("service times", () => {
    it("splits the same way, or the two disagree and the narrower wins", () => {
      const out = toJetOpeningTimes(friLate);

      expect(out.friday).toEqual([
        { openingTime: "12:00", closingTime: "23:59" },
      ]);
      expect(out.saturday).toEqual([
        { openingTime: "00:00", closingTime: "02:00" },
      ]);
    });

    it("handles the legacy [{day, open, close}] shape too", () => {
      const out = toJetOpeningTimes([
        { day: "saturday", open: "17:00", close: "03:00" },
      ]);

      expect(out.saturday).toEqual([
        { openingTime: "17:00", closingTime: "23:59" },
      ]);
      expect(out.sunday).toEqual([
        { openingTime: "00:00", closingTime: "03:00" },
      ]);
    });

    it("states a closed day as an empty array", () => {
      // Written as "omits" when this file was added two days ago; Corby then
      // proved an omitted day is one JET never closes. jet-closed-day.spec.ts
      // carries the full reasoning.
      const out = toJetOpeningTimes(friLate);

      expect(out.tuesday).toEqual([]);
    });
  });
});
