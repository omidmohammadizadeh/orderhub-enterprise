// The guest hears about their booking by email — when it's made, when it
// moves, and when it's cancelled — and about nothing else. A table shuffle on
// the floor is not their business, and a failed send must never undo a
// booking that saved.

import { ReservationsService } from "../reservations.service";
import { reservationEmail } from "../reservation-emails";

const ONLINE_ON = {
  tableService: {
    enabled: true,
    reservations: { onlineEnabled: true, maxPartySize: 12, leadTimeMins: 60, maxDaysAhead: 60, slotMinutes: 90 },
  },
};
const FRIDAY = new Date(Date.now() + 7 * 86_400_000);

const svc = (over: any = {}) => {
  const sent: [string, string][] = [];
  const s: any = Object.create(ReservationsService.prototype);
  const existing = over.existing ?? {
    id: "res1",
    tenantId: "t1",
    locationId: "loc1",
    tableId: "tbl1",
    startsAt: FRIDAY,
    partySize: 2,
    durationMins: 90,
    status: "CONFIRMED",
    customerEmail: "sam@example.com",
  };
  s.prisma = {
    location: {
      findUnique: async () => ({ id: "loc1", settings: ONLINE_ON, openingHours: [], timezone: "Europe/London", brand: { tenantId: "t1" } }),
      findFirst: async () => ({ id: "loc1", settings: ONLINE_ON }),
    },
    table: {
      findMany: async () => [
        { id: "tbl1", name: "1", seats: 4, sortOrder: 0 },
        { id: "tbl2", name: "2", seats: 4, sortOrder: 1 },
      ],
    },
    tableReservation: {
      findMany: async () => over.bookings ?? [],
      findFirst: async () => existing,
      create: async ({ data }: any) => ({ ...data, id: "res1", table: null }),
      update: async ({ data }: any) => ({ ...existing, ...data }),
    },
  };
  s.socket = { emitToLocation: () => {} };
  s.emails = { send: async (kind: string, id: string) => (sent.push([kind, id]), true) };
  return { s, sent };
};

describe("booking online", () => {
  it("needs an email, because that's where the confirmation goes", async () => {
    const { s } = svc();
    await expect(
      s.createPublic({ locationId: "loc1", customerName: "Sam", partySize: 2, startsAt: FRIDAY }),
    ).rejects.toThrow(/email/);
  });

  it("emails the guest a confirmation", async () => {
    const { s, sent } = svc();
    await s.createPublic({
      locationId: "loc1",
      customerName: "Sam",
      customerEmail: "sam@example.com",
      partySize: 2,
      startsAt: FRIDAY,
    });
    expect(sent).toEqual([["confirmed", "res1"]]);
  });

  it("still books the table when the email fails to send", async () => {
    const { s } = svc();
    s.emails = { send: () => Promise.resolve(false) };
    const res = await s.createPublic({
      locationId: "loc1",
      customerName: "Sam",
      customerEmail: "sam@example.com",
      partySize: 2,
      startsAt: FRIDAY,
    });
    expect(res.reference).toMatch(/^R-/);
  });
});

describe("staff changing a booking", () => {
  it("tells the guest about a new time", async () => {
    const { s, sent } = svc();
    await s.update("t1", "res1", { startsAt: new Date(FRIDAY.getTime() + 3600_000).toISOString() });
    expect(sent).toEqual([["updated", "res1"]]);
  });

  it("says nothing about a table shuffle", async () => {
    const { s, sent } = svc();
    await s.update("t1", "res1", { tableId: "tbl2" });
    expect(sent).toEqual([]);
  });

  it("stays quiet when staff ask it to", async () => {
    const { s, sent } = svc();
    await s.update("t1", "res1", {
      startsAt: new Date(FRIDAY.getTime() + 3600_000).toISOString(),
      notifyCustomer: false,
    });
    expect(sent).toEqual([]);
  });

  it("emails a cancellation, but not a no-show", async () => {
    const a = svc();
    await a.s.setStatus("t1", "res1", "CANCELLED");
    expect(a.sent).toEqual([["cancelled", "res1"]]);
    const b = svc();
    await b.s.setStatus("t1", "res1", "NO_SHOW");
    expect(b.sent).toEqual([]);
  });
});

describe("the guest's time picker", () => {
  it("offers only times with a table free", async () => {
    const day = new Date(FRIDAY);
    day.setHours(0, 0, 0, 0);
    const next = new Date(day.getTime() + 86_400_000);
    // Both tables taken 19:00–20:30.
    const seven = new Date(day);
    seven.setHours(19, 0, 0, 0);
    const { s } = svc({
      bookings: [
        { tableId: "tbl1", startsAt: seven, durationMins: 90 },
        { tableId: "tbl2", startsAt: seven, durationMins: 90 },
      ],
    });
    const { slots } = await s.publicSlots("loc1", day, next, 2);
    expect(slots.length).toBeGreaterThan(0);
    const at = (h: number, m: number) => {
      const d = new Date(day);
      d.setHours(h, m, 0, 0);
      return slots.find((x: any) => x.startsAt === d.toISOString());
    };
    expect(at(19, 0)?.available).toBe(false);
    expect(at(17, 0)?.available).toBe(true);
  });
});

describe("the email itself", () => {
  it("writes the time in the restaurant's timezone", () => {
    // 18:00 UTC in July is 19:00 in London.
    const mail = reservationEmail({
      kind: "confirmed",
      shopName: "Pizza Uno",
      logoUrl: null,
      address: null,
      shopPhone: null,
      timezone: "Europe/London",
      customerName: "Sam Smith",
      partySize: 4,
      startsAt: new Date("2026-07-10T18:00:00Z"),
      durationMins: 90,
      reference: "R-ABC123",
      notes: null,
      bookUrl: null,
    });
    expect(mail.subject).toContain("19:00");
    expect(mail.html).toContain("R-ABC123");
    expect(mail.html).toContain("Hi Sam,");
  });
});
