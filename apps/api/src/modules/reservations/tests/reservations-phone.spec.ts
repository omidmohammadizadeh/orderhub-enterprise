// The phone door into the diary.
//
// Two doors already existed — staff, and the storefront form. This is the
// third, and the only one where nobody is in the room: an AI answers the line
// and speaks for the shop. So the rule that matters most is not about
// bookings at all. It is that a shop WITHOUT table service can never have one
// taken for it, and that this is enforced here rather than in a prompt,
// because a prompt is a request.

import { ReservationsService } from "../reservations.service";

const TABLE_SERVICE_ON = {
  tableService: { enabled: true, reservations: { maxPartySize: 12, leadTimeMins: 60, maxDaysAhead: 60, slotMinutes: 90 } },
};
const FRIDAY = new Date(Date.now() + 7 * 86_400_000);

const svc = (over: any = {}) => {
  const created: any[] = [];
  const emitted: any[] = [];
  const s: any = Object.create(ReservationsService.prototype);
  s.prisma = {
    location: {
      findUnique: async () => over.location ?? { id: "loc1", settings: TABLE_SERVICE_ON, brand: { tenantId: "t1" } },
    },
    table: { findMany: async () => over.tables ?? [{ id: "tbl1", name: "12", seats: 4, sortOrder: 0 }] },
    tableReservation: {
      // The fake honours `id: { not: … }`, because that filter is the whole
      // point of one of the tests below: a booking being moved must not be
      // counted as occupying the slot it is moving out of.
      findMany: async (args: any = {}) => {
        const rows = over.bookings ?? [];
        const not = args?.where?.id?.not;
        return not ? rows.filter((r: any) => r.id !== not) : rows;
      },
      findFirst: async () => over.existing ?? null,
      create: async ({ data }: any) => {
        created.push(data);
        return { ...data, id: "res1", startsAt: new Date(data.startsAt), table: null };
      },
      update: async ({ data }: any) => ({ id: "res1", reference: "R-AAA111", startsAt: FRIDAY, partySize: 2, ...data }),
    },
  };
  s.socket = { emitToLocation: (...a: any[]) => emitted.push(a) };
  return { s, created, emitted };
};

describe("a location without table service", () => {
  const off = { location: { id: "loc1", settings: {}, brand: { tenantId: "t1" } } };

  it("takes no booking, whatever it is asked", async () => {
    const { s, created } = svc(off);
    await expect(
      s.createFromPhone({ locationId: "loc1", customerName: "Sam", partySize: 2, startsAt: FRIDAY }),
    ).rejects.toThrow(/does not take table bookings/);
    expect(created).toHaveLength(0);
  });

  it("does not even answer questions about its tables", async () => {
    const { s } = svc(off);
    const free = await s.phoneAvailability("loc1", FRIDAY, 2, 90);
    expect(free.available).toEqual([]);
  });

  it("shows no bookings, and cannot change or cancel one", async () => {
    const { s } = svc({ ...off, existing: { id: "res1", tenantId: "t1", locationId: "loc1", startsAt: FRIDAY, partySize: 2, durationMins: 90 } });
    expect(await s.phoneSettings("loc1")).toBeNull();
    expect(await s.phoneLookup("loc1", { phone: "+447700900123" })).toEqual([]);
    await expect(s.updateFromPhone("loc1", "res1", { partySize: 4 })).rejects.toThrow(/does not take table bookings/);
    await expect(s.cancelFromPhone("loc1", "res1")).rejects.toThrow(/does not take table bookings/);
  });
});

describe("a location that has table service but shuts the phone line out", () => {
  it("is closed to the phone while the website stays open", async () => {
    const { s } = svc({
      location: {
        id: "loc1",
        settings: { tableService: { enabled: true, reservations: { onlineEnabled: true, phoneEnabled: false } } },
        brand: { tenantId: "t1" },
      },
    });
    expect(await s.phoneSettings("loc1")).toBeNull();
  });

  it("and is open to it by default, because table service is the switch", async () => {
    const { s } = svc();
    const settings = await s.phoneSettings("loc1");
    expect(settings?.tenantId).toBe("t1");
    expect(settings?.maxPartySize).toBe(12);
  });
});

describe("taking one over the phone", () => {
  it("saves it as a PHONE booking and rings the till", async () => {
    const { s, created, emitted } = svc();
    const out = await s.createFromPhone({
      locationId: "loc1",
      customerName: "Omid",
      customerPhone: "+447700900123",
      partySize: 2,
      startsAt: FRIDAY,
    });
    expect(created[0].source).toBe("PHONE");
    expect(created[0].status).toBe("CONFIRMED");
    expect(created[0].reference).toMatch(/^R-[A-Z0-9]{6}$/);
    expect(out.id).toBe("res1");
    // The floor finds out the same way it finds out about an online booking.
    const [locationId, event, payload] = emitted[0];
    expect(locationId).toBe("loc1");
    expect(event).toBe("reservation:new");
    expect(payload.source).toBe("PHONE");
    expect(payload.customerPhone).toBe("+447700900123");
  });

  it("hands a party too big for the line back to the shop", async () => {
    const { s, created } = svc();
    await expect(
      s.createFromPhone({ locationId: "loc1", customerName: "Omid", partySize: 30, startsAt: FRIDAY }),
    ).rejects.toThrow(/bigger than this line can book/);
    expect(created).toHaveLength(0);
  });

  it("will not take one when every table is already spoken for", async () => {
    const { s, created } = svc({
      bookings: [{ id: "other", tableId: "tbl1", startsAt: FRIDAY, durationMins: 90, status: "CONFIRMED" }],
    });
    await expect(
      s.createFromPhone({ locationId: "loc1", customerName: "Omid", partySize: 2, startsAt: FRIDAY }),
    ).rejects.toThrow(/fully booked/);
    expect(created).toHaveLength(0);
  });
});

describe("finding the caller's own booking", () => {
  const mine = {
    id: "res1",
    reference: "R-7QK4M2",
    customerPhone: "+447700900123",
    startsAt: FRIDAY,
    partySize: 2,
    status: "CONFIRMED",
  };
  const someoneElse = { ...mine, id: "res2", reference: "R-ZZZ999", customerPhone: "+447700900999" };

  it("matches the number however the front of it was written", async () => {
    for (const stored of ["+447700900123", "07700900123", "00447700900123", "447700900123"]) {
      const { s } = svc({ bookings: [{ ...mine, customerPhone: stored }, someoneElse] });
      const found = await s.phoneLookup("loc1", { phone: "+447700900123" });
      expect(found.map((r: any) => r.id)).toEqual(["res1"]);
    }
  });

  it("never hands back somebody else's table", async () => {
    const { s } = svc({ bookings: [someoneElse] });
    expect(await s.phoneLookup("loc1", { phone: "+447700900123" })).toEqual([]);
  });

  it("takes a reference said down a phone, with the punctuation gone", async () => {
    const { s } = svc({ bookings: [mine, someoneElse] });
    for (const said of ["R-7QK4M2", "r 7 q k 4 m 2", "R7QK4M2", "r-7qk4m2"]) {
      const found = await s.phoneLookup("loc1", { reference: said, phone: null });
      expect(found.map((r: any) => r.id)).toEqual(["res1"]);
    }
  });

  it("finds nothing at all when they give neither", async () => {
    const { s } = svc({ bookings: [mine] });
    expect(await s.phoneLookup("loc1", { phone: null, reference: null })).toEqual([]);
  });
});

describe("moving one", () => {
  const existing = { id: "res1", tenantId: "t1", locationId: "loc1", startsAt: FRIDAY, partySize: 2, durationMins: 90, tableId: "tbl1", status: "CONFIRMED" };

  it("does not count the booking against itself when it moves", async () => {
    // Its own row is in the diary at the old time. Counting it would make
    // every move look like a collision with itself.
    const { s } = svc({ existing, bookings: [{ ...existing, tableId: "tbl1" }] });
    const later = new Date(FRIDAY.getTime() + 3600_000);
    const out = await s.updateFromPhone("loc1", "res1", { startsAt: later });
    expect(out.id).toBe("res1");
  });

  it("refuses a new time with nothing free", async () => {
    const { s } = svc({
      existing,
      tables: [{ id: "tbl1", name: "12", seats: 4, sortOrder: 0 }],
      bookings: [{ id: "other", tableId: "tbl1", startsAt: FRIDAY, durationMins: 90, status: "CONFIRMED" }],
    });
    await expect(s.updateFromPhone("loc1", "res1", { startsAt: FRIDAY })).rejects.toThrow(/nothing free at that time/i);
  });

  it("will not move one into the notice the shop needs", async () => {
    const { s } = svc({ existing });
    const inTenMinutes = new Date(Date.now() + 10 * 60_000);
    await expect(s.updateFromPhone("loc1", "res1", { startsAt: inTenMinutes })).rejects.toThrow(/60 minutes' notice/);
  });

  it("will not grow one past what the line may book", async () => {
    const { s } = svc({ existing });
    await expect(s.updateFromPhone("loc1", "res1", { partySize: 30 })).rejects.toThrow(/bigger than this line can book/);
  });
});
