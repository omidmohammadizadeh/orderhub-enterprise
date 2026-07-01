import { toDeliverooOpeningHours } from "../deliveroo-connection.service";

// Deliveroo wants opening_hours as { monday: [{local_start_time, local_end_time}] }.
// We store three internal shapes; the normaliser must produce Deliveroo's from
// each, dropping disabled/empty days.

describe("toDeliverooOpeningHours", () => {
  it("converts the location editor map ({enabled, slots})", () => {
    const input = {
      monday: { enabled: true, slots: [{ from: "09:00", to: "22:00" }] },
      tuesday: { enabled: false, slots: [{ from: "09:00", to: "22:00" }] },
    };
    expect(toDeliverooOpeningHours(input)).toEqual({
      monday: [{ local_start_time: "09:00", local_end_time: "22:00" }],
    });
  });

  it("converts the brand map (array per day) with multiple slots", () => {
    const input = {
      friday: [
        { from: "12:00", to: "14:00" },
        { from: "18:00", to: "23:00" },
      ],
    };
    expect(toDeliverooOpeningHours(input)).toEqual({
      friday: [
        { local_start_time: "12:00", local_end_time: "14:00" },
        { local_start_time: "18:00", local_end_time: "23:00" },
      ],
    });
  });

  it("converts the legacy [{day, open, close}] shape", () => {
    expect(
      toDeliverooOpeningHours([{ day: "Sunday", open: "10:00", close: "20:00" }]),
    ).toEqual({
      sunday: [{ local_start_time: "10:00", local_end_time: "20:00" }],
    });
  });

  it("returns {} when nothing is configured", () => {
    expect(toDeliverooOpeningHours(null)).toEqual({});
    expect(toDeliverooOpeningHours({})).toEqual({});
    expect(toDeliverooOpeningHours({ monday: { enabled: false, slots: [] } })).toEqual(
      {},
    );
  });
});
