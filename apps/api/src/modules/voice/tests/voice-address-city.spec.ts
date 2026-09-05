// Which town gets read back to a caller.
//
// From a live call: the caller gave NE37 2LL and heard "Sunningdale Drive,
// Salford". The lookup took 52ms — far too fast to have left the building —
// because it was answered from the shop's OWN order history, where one row
// carried a wrong city. A second route did the same thing: when a row had no
// city at all, the code borrowed the SHOP's city.
//
// Both are guesses wearing the costume of a fact. A postcode belongs to
// exactly one town, so that is the only thing allowed to decide it, and "no
// town" is a real answer that must be read back as such.

import { VoiceAiService } from "../voice-ai.service";

const ai = (over: Record<string, any> = {}) => {
  const s: any = Object.create(VoiceAiService.prototype);
  s.logger = { log() {}, warn() {}, error() {} };
  s.prisma = { order: { findMany: async () => [] } };
  s.addresses = {
    searchByPostcode: async () => ({ provider: "test", suggestions: [] }),
    townForPostcode: async () => null,
  };
  Object.assign(s, over);
  return s;
};

const ctx = (over: Record<string, any> = {}) =>
  ({
    tenantId: "t1",
    locationId: "l1",
    locationName: "Pizza Uno",
    country: "GB",
    currency: "GBP",
    // The shop's own city. A shop delivers to more than one town, so this is
    // never evidence about where a CALLER lives.
    address: { city: "Salford", postcode: "NE37 1AA" },
    deliveryZones: [{ postcodePrefix: "NE37", fee: 2.5 }],
    deliveryPrepMinutes: 45,
    collectionPrepMinutes: 20,
    items: [],
    itemIndex: new Map(),
    optionIndex: new Map(),
    ...over,
  }) as any;

const state = () => ({ cart: { items: [] }, turns: [] }) as any;

describe("the town comes from the postcode and nowhere else", () => {
  it("never borrows the shop's city for a caller's address", async () => {
    const svc = ai({
      prisma: {
        order: {
          findMany: async () => [{ addressLine1: "5 Sunningdale Drive", city: null }],
        },
      },
      addresses: {
        searchByPostcode: async () => ({ suggestions: [] }),
        townForPostcode: async () => "Washington",
      },
    });
    const st = state();

    const out = await svc.addressAloud(ctx(), st, "Five Sunningdale Drive, N E 3 7 2 L L", async () => []);

    expect(out.say).toContain("Sunningdale Drive");
    expect(out.say).not.toContain("Salford");
    expect(st.cart.deliveryAddress.city).toBe("Washington");
  });

  it("ignores a wrong city typed into our own order history", async () => {
    // This is the 52ms answer: our own rows, one of them carrying Salford.
    const svc = ai({
      prisma: {
        order: {
          findMany: async () => [
            { addressLine1: "5 Sunningdale Drive", city: "Salford" },
          ],
        },
      },
      addresses: {
        searchByPostcode: async () => ({ suggestions: [] }),
        townForPostcode: async () => "Washington",
      },
    });
    const st = state();

    const out = await svc.addressAloud(ctx(), st, "Five Sunningdale Drive, N E 3 7 2 L L", async () => []);

    expect(out.say).not.toContain("Salford");
    expect(st.cart.deliveryAddress.city).toBe("Washington");
  });

  it("says the street and postcode with NO town rather than inventing one", async () => {
    // "5 Sunningdale Drive, NE37 2LL" is a correct address. The version with a
    // borrowed town is a wrong one, and only that version sounds confident.
    const svc = ai({
      prisma: {
        order: { findMany: async () => [{ addressLine1: "5 Sunningdale Drive", city: "Salford" }] },
      },
      addresses: {
        searchByPostcode: async () => ({ suggestions: [] }),
        townForPostcode: async () => null,
      },
    });
    const st = state();

    const out = await svc.addressAloud(ctx(), st, "Five Sunningdale Drive, N E 3 7 2 L L", async () => []);

    expect(out.say).toContain("Sunningdale Drive");
    expect(out.say).not.toContain("Salford");
    expect(st.cart.deliveryAddress.city).toBe("");
  });

  it("tells a caller in another county we don't deliver, instead of relocating them", async () => {
    const svc = ai();
    const st = state();

    const out = await svc.addressAloud(ctx(), st, "Five Sunningdale Drive, M 2 7 5 A B", async () => []);

    expect(out.say).toMatch(/outside our delivery area/i);
    expect(out.say).toMatch(/collect|another address/i);
    expect(st.cart.deliveryAddress).toBeUndefined();
  });
});

describe("an address with no house number is not an address", () => {
  // From the same live run: asked for "the street name and house number", the
  // caller said only "Sunningdale Drive" — and it was read back to them as a
  // complete address. A confident read-back is exactly what stops somebody
  // noticing that the number is missing, and a driver cannot deliver to a
  // street.
  const svc = () => {
    const s: any = Object.create(VoiceAiService.prototype);
    s.logger = { log() {}, warn() {}, error() {} };
    return s;
  };

  it("asks for the number when they gave only a street", () => {
    const st: any = { cart: { items: [] }, addr: { postcode: "NE37 2LL" } };
    const out = svc().houseNumberAloud(ctx(), st, "Sunningdale Drive");

    expect(out.say).toMatch(/house number/i);
    expect(out.next).toBe("ADDR_HOUSE");
    expect(st.cart.deliveryAddress).toBeUndefined();
    expect(st.addr.street).toBe("Sunningdale Drive");
  });

  it("still takes a house NAME as a complete answer", () => {
    // "Rose Cottage" is as valid an answer as "11", and refusing it strands
    // whoever lives there.
    const st: any = {
      cart: { items: [] },
      addr: { postcode: "NE10 8YH", street: "Follingsby Drive" },
    };
    const out = svc().houseNumberAloud(ctx(), st, "Rose Cottage");

    expect(st.cart.deliveryAddress.line1).toBe("Rose Cottage Follingsby Drive");
    expect(out.next).toBe("ADDRESS_CONFIRM");
  });
});
