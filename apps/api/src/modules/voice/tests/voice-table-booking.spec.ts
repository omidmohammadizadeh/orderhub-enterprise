// Taking a table booking over the phone.
//
// A different job from taking an order, sharing only the line — and the first
// thing this phone line does where the exact minute matters and it is not
// "now". Two things are worth more than the rest of the feature:
//
//   1. A shop without tables must be offered NONE of it. Not the tools, not
//      the prompt, not a token of either — the line already runs close to its
//      per-minute limit, and a takeaway should pay nothing for a diary it
//      does not have.
//   2. Nothing is written that was not checked and read back. A booking
//      nobody agreed to costs a table on a Friday night and leaves a family
//      standing in a doorway.

import { VoiceAiService } from "../voice-ai.service";
import { whenInShop, shopNow, spokenWhen } from "../voice-when";

const TZ = "Europe/London";
// A Friday evening, comfortably inside every window.
const FRIDAY_7PM = "2026-09-11T19:00";

const ctx = (over: any = {}): any => ({
  tenantId: "t1",
  locationId: "loc1",
  currency: "GBP",
  timezone: TZ,
  items: [{ id: "pizza", name: "MARGHERITA", price: 8, categoryName: "PIZZA", modifierGroups: [] }],
  itemIndex: new Map([["pizza", { id: "pizza", name: "MARGHERITA", price: 8, modifierGroups: [] }]]),
  optionIndex: new Map(),
  deliveryZones: [],
  openingHours: null,
  reservations: { slotMinutes: 90, maxPartySize: 12, leadTimeMins: 60, maxDaysAhead: 60 },
  ...over,
});

const ai = (reservations: any = {}) => {
  const a: any = Object.create(VoiceAiService.prototype);
  a.logger = { log() {}, warn() {}, error() {} };
  a.reservations = {
    phoneAvailability: jest.fn().mockResolvedValue({ available: [{ id: "tbl1", name: "12" }] }),
    createFromPhone: jest.fn(),
    phoneLookup: jest.fn().mockResolvedValue([]),
    updateFromPhone: jest.fn(),
    cancelFromPhone: jest.fn(),
    ...reservations,
  };
  return a;
};
const state = (): any => ({ cart: { items: [] }, turns: [] });
const at = (local: string) => whenInShop(local, TZ)!;

describe("a shop with no tables is offered none of it", () => {
  const takeaway = ctx({ reservations: null });

  it("has no booking tools at all", () => {
    const names = ai().toolsForConversation(takeaway).map((t: any) => t.name);
    for (const tool of ["check_table", "book_table", "find_booking", "change_booking", "cancel_booking"]) {
      expect(names).not.toContain(tool);
    }
    // And the ordering tools are all still there.
    expect(names).toEqual(expect.arrayContaining(["add_item", "place_order", "change_item"]));
  });

  it("is told nothing about bookings, and pays nothing for them", () => {
    const prompt = ai().promptForConversation(takeaway, state(), null);
    expect(prompt).not.toMatch(/BOOKING A TABLE/);
    expect(prompt).not.toMatch(/book_table|check_table/);
    const withTables = ai().promptForConversation(ctx(), state(), null);
    expect(withTables).toMatch(/BOOKING A TABLE/);
    // The whole feature costs a takeaway zero characters of prompt.
    expect(withTables.length).toBeGreaterThan(prompt.length);
  });

  it("refuses to book even if the tool is somehow called", async () => {
    const a = ai();
    for (const tool of ["check_table", "book_table", "find_booking", "change_booking", "cancel_booking"]) {
      const out = await a.runToolForConversation(tool, { when: FRIDAY_7PM, partySize: 2, name: "Sam" }, takeaway, state(), "+447700900123");
      expect(out.result).toMatch(/does not take table bookings/);
    }
    expect(a.reservations.createFromPhone).not.toHaveBeenCalled();
  });
});

describe("checking a time before promising it", () => {
  it("says yes with the day spelled out, and remembers what it proved", async () => {
    const a = ai();
    const st = state();
    const out = await a.runToolForConversation("check_table", { when: FRIDAY_7PM, partySize: 4 }, ctx(), st, null);
    expect(out.result).toMatch(/Free: a table for 4 on Friday 11 September at 7pm/);
    expect(a.reservations.phoneAvailability).toHaveBeenCalledWith("loc1", at(FRIDAY_7PM), 4, 90);
    expect(st.booking.checked).toBe(`${at(FRIDAY_7PM).toISOString()}|4`);
  });

  it("says no when the diary is full, and does not remember a slot it never got", async () => {
    const a = ai({ phoneAvailability: jest.fn().mockResolvedValue({ available: [] }) });
    const st = state();
    const out = await a.runToolForConversation("check_table", { when: FRIDAY_7PM, partySize: 4 }, ctx(), st, null);
    expect(out.result).toMatch(/Nothing free for 4 on Friday 11 September at 7pm/);
    expect(st.booking).toBeUndefined();
  });

  it("will not book a time that has gone, or one inside the notice the shop needs", async () => {
    const a = ai();
    const past = await a.runToolForConversation("check_table", { when: "2020-01-01T19:00", partySize: 2 }, ctx(), state(), null);
    expect(past.result).toMatch(/has already gone/);
    const soon = shopNow(TZ, new Date(Date.now() + 10 * 60_000));
    const rushed = await a.runToolForConversation("check_table", { when: soon, partySize: 2 }, ctx(), state(), null);
    expect(rushed.result).toMatch(/Too soon — the shop needs 60 minutes' notice/);
    expect(a.reservations.phoneAvailability).not.toHaveBeenCalled();
  });

  it("will not book past the end of the diary", async () => {
    const a = ai();
    const far = shopNow(TZ, new Date(Date.now() + 400 * 86_400_000));
    const out = await a.runToolForConversation("check_table", { when: far, partySize: 2 }, ctx(), state(), null);
    expect(out.result).toMatch(/further ahead than the diary goes/);
  });

  it("checks the hours of the day booked, not the hours right now", async () => {
    // Closed on Fridays; open every other day. The call itself is on some
    // other day entirely — what matters is the day of the booking.
    const closedFriday = ctx({ openingHours: { friday: { enabled: false, slots: [] } } });
    const a = ai();
    const out = await a.runToolForConversation("check_table", { when: FRIDAY_7PM, partySize: 2 }, closedFriday, state(), null);
    expect(out.result).toMatch(/The shop is closed then — Friday 11 September at 7pm/);
    expect(a.reservations.phoneAvailability).not.toHaveBeenCalled();
  });

  it("hands a party too big for the line to a person instead of booking it", async () => {
    const a = ai();
    const out = await a.runToolForConversation("check_table", { when: FRIDAY_7PM, partySize: 20 }, ctx(), state(), null);
    expect(out.result).toMatch(/bigger than this line books/);
    expect(out.result).toMatch(/put them through or take a message/);
    expect(a.reservations.phoneAvailability).not.toHaveBeenCalled();
  });
});

describe("writing it in the diary", () => {
  const saved = {
    id: "res1",
    reference: "R-7QK4M2",
    startsAt: at(FRIDAY_7PM),
    partySize: 4,
    customerName: "Omid",
  };
  const checked = async (a: any, c = ctx()) => {
    const st = state();
    await a.runToolForConversation("check_table", { when: FRIDAY_7PM, partySize: 4 }, c, st, null);
    return st;
  };

  it("saves it, tells the caller, and never reads the reference out unasked", async () => {
    const a = ai({ createFromPhone: jest.fn().mockResolvedValue(saved) });
    const st = await checked(a);
    const out = await a.runToolForConversation(
      "book_table",
      { name: "Omid", __spokeAfterQuestion: true },
      ctx(),
      st,
      "+447700900123",
    );
    expect(a.reservations.createFromPhone).toHaveBeenCalledWith(
      expect.objectContaining({
        locationId: "loc1",
        customerName: "Omid",
        customerPhone: "+447700900123",
        partySize: 4,
        startsAt: at(FRIDAY_7PM),
        durationMins: 90,
      }),
    );
    expect(out.sayNow).toBe("That's booked — a table for 4 on Friday 11 September at 7pm, under Omid. Anything else?");
    expect(out.sayNow).not.toMatch(/R-7QK4M2/);
    expect(out.result).toMatch(/Do not read the reference out unless they ask/);
    expect(st.booking.reference).toBe("R-7QK4M2");
  });

  it("will not save a slot that was never checked", async () => {
    const a = ai({ createFromPhone: jest.fn() });
    const out = await a.runToolForConversation(
      "book_table",
      { name: "Omid", __spokeAfterQuestion: true },
      ctx(),
      state(),
      "+447700900123",
    );
    expect(out.result).toMatch(/Nothing has been checked yet/);
    expect(a.reservations.createFromPhone).not.toHaveBeenCalled();
  });

  it("will not save one the caller has not agreed to since it was read back", async () => {
    const a = ai({ createFromPhone: jest.fn() });
    const st = await checked(a);
    const out = await a.runToolForConversation("book_table", { name: "Omid" }, ctx(), st, "+447700900123");
    expect(out.result).toMatch(/has not spoken since you read it back/);
    expect(a.reservations.createFromPhone).not.toHaveBeenCalled();
  });

  it("will not save a slot that changed after it was checked", async () => {
    const a = ai({ createFromPhone: jest.fn() });
    const st = await checked(a);
    st.booking.partySize = 8; // they said "actually eight of us" and nobody re-checked
    const out = await a.runToolForConversation(
      "book_table",
      { name: "Omid", __spokeAfterQuestion: true },
      ctx(),
      st,
      null,
    );
    expect(out.result).toMatch(/changed since it was checked. Call check_table again/);
    expect(a.reservations.createFromPhone).not.toHaveBeenCalled();
  });

  it("asks for a name rather than booking a table under nobody", async () => {
    const a = ai({ createFromPhone: jest.fn() });
    const st = await checked(a);
    const out = await a.runToolForConversation("book_table", { __spokeAfterQuestion: true }, ctx(), st, null);
    expect(out.result).toMatch(/Ask what name/);
    expect(a.reservations.createFromPhone).not.toHaveBeenCalled();
  });

  it("says plainly when the diary refuses it", async () => {
    const a = ai({
      createFromPhone: jest.fn().mockRejectedValue(new Error("We're fully booked at that time — please try another slot.")),
    });
    const st = await checked(a);
    const out = await a.runToolForConversation(
      "book_table",
      { name: "Omid", __spokeAfterQuestion: true },
      ctx(),
      st,
      null,
    );
    expect(out.result).toMatch(/Not booked — We're fully booked/);
    expect(out.sayNow).toBeUndefined();
  });
});

describe("changing and cancelling one", () => {
  const existing = {
    id: "res1",
    reference: "R-7QK4M2",
    startsAt: at(FRIDAY_7PM),
    partySize: 4,
    customerName: "Omid",
  };

  it("finds it by the number they are ringing from", async () => {
    const a = ai({ phoneLookup: jest.fn().mockResolvedValue([existing]) });
    const st = state();
    const out = await a.runToolForConversation("find_booking", {}, ctx(), st, "+447700900123");
    expect(a.reservations.phoneLookup).toHaveBeenCalledWith("loc1", {
      phone: "+447700900123",
      reference: null,
    });
    expect(out.result).toMatch(/Found it: 4 on Friday 11 September at 7pm, under Omid/);
    expect(st.booking.id).toBe("res1");
  });

  it("asks which one when there are two, rather than guessing", async () => {
    const a = ai({
      phoneLookup: jest.fn().mockResolvedValue([existing, { ...existing, id: "res2", startsAt: at("2026-09-12T20:00"), partySize: 2 }]),
    });
    const st = state();
    const out = await a.runToolForConversation("find_booking", {}, ctx(), st, "+447700900123");
    expect(out.result).toMatch(/More than one booking under this number/);
    expect(st.booking).toBeUndefined();
  });

  it("offers a person when the diary has nothing under their number", async () => {
    const a = ai({ phoneLookup: jest.fn().mockResolvedValue([]) });
    const out = await a.runToolForConversation("find_booking", {}, ctx(), state(), "+447700900123");
    expect(out.result).toMatch(/Nothing in the diary under this number/);
    expect(out.result).toMatch(/offer to put them through/);
  });

  it("moves it, and says the new day back", async () => {
    const moved = { ...existing, startsAt: at("2026-09-12T20:00") };
    const a = ai({ phoneLookup: jest.fn().mockResolvedValue([existing]), updateFromPhone: jest.fn().mockResolvedValue(moved) });
    const st = state();
    await a.runToolForConversation("find_booking", {}, ctx(), st, "+447700900123");
    const out = await a.runToolForConversation("change_booking", { when: "2026-09-12T20:00" }, ctx(), st, null);
    expect(a.reservations.updateFromPhone).toHaveBeenCalledWith("loc1", "res1", { startsAt: at("2026-09-12T20:00") });
    expect(out.sayNow).toBe("Done — that's now a table for 4 on Saturday 12 September at 8pm. Anything else?");
  });

  it("will not change or cancel a booking it has not found", async () => {
    const a = ai({ updateFromPhone: jest.fn(), cancelFromPhone: jest.fn() });
    const change = await a.runToolForConversation("change_booking", { partySize: 6 }, ctx(), state(), null);
    expect(change.result).toMatch(/No booking has been found yet/);
    const cancel = await a.runToolForConversation("cancel_booking", {}, ctx(), state(), null);
    expect(cancel.result).toMatch(/No booking has been found yet/);
    expect(a.reservations.updateFromPhone).not.toHaveBeenCalled();
    expect(a.reservations.cancelFromPhone).not.toHaveBeenCalled();
  });

  it("cancels it and lets the table go", async () => {
    const a = ai({
      phoneLookup: jest.fn().mockResolvedValue([existing]),
      cancelFromPhone: jest.fn().mockResolvedValue({ ...existing, status: "CANCELLED" }),
    });
    const st = state();
    await a.runToolForConversation("find_booking", {}, ctx(), st, "+447700900123");
    const out = await a.runToolForConversation("cancel_booking", {}, ctx(), st, null);
    expect(a.reservations.cancelFromPhone).toHaveBeenCalledWith("loc1", "res1");
    expect(out.sayNow).toMatch(/That's cancelled — the table on Friday 11 September at 7pm is gone from the book/);
    expect(st.booking).toBeUndefined();
  });
});

describe("the prompt a shop with tables gets", () => {
  it("states the day and time, because the model cannot know them", () => {
    const prompt = ai().promptForConversation(ctx(), state(), null);
    expect(prompt).toMatch(/Right now it is [A-Z][a-z]+ \d+ [A-Z][a-z]+ at/);
    expect(prompt).toMatch(/which is \d{4}-\d{2}-\d{2}T\d{2}:\d{2} on the shop's clock/);
  });

  it("says to read the day back, and that a booking is not an order", () => {
    const prompt = ai().promptForConversation(ctx(), state(), null);
    expect(prompt).toMatch(/Read the DAY back as well as the time/);
    expect(prompt).toMatch(/A booking is not an order/);
  });
});
