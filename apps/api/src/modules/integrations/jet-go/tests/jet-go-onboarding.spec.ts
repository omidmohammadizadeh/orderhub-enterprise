import { JetGoOnboardingService } from "../jet-go-onboarding.service";

// Collect-point onboarding. Two things here are worth a test rather than a
// comment: the country code (JET wants alpha-3, we store alpha-2) and the
// resolve matching, where picking the wrong collect point would quietly send
// one shop's deliveries from another shop's door.

type Row = Record<string, any>;

const LOC = (over: Row = {}): Row => ({
  id: "loc1",
  name: "Pelton",
  brand: { tenantId: "t1", name: "Pizza Uno", phone: null },
  addressLine1: "38 Exchange St E",
  addressLine2: null,
  city: "Liverpool",
  postcode: "L2 3PS",
  country: "GB",
  phone: "+447700900000",
  latitude: 53.40824,
  longitude: -2.99145,
  ...over,
});

function svc(over: { location?: Row; cfg?: Row; points?: Row[]; geo?: Row | null } = {}) {
  const updates: Row[] = [];
  const s: any = Object.create(JetGoOnboardingService.prototype);
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  s.zones = {
    locateShop: jest.fn().mockResolvedValue(
      over.geo === undefined ? { lat: 53.40824, lng: -2.99145 } : over.geo,
    ),
  };
  s.config = {
    getDecrypted: async () => ({
      tenantId: "t1",
      locationId: "loc1",
      clientId: "id",
      clientSecret: "sec",
      collectPointId: null,
      collectPointName: null,
      ...(over.cfg ?? {}),
    }),
  };
  s.client = {
    onboardCollectPoint: jest.fn().mockResolvedValue(undefined),
    updateCollectPoint: jest.fn().mockResolvedValue(undefined),
    collectPoints: jest.fn().mockResolvedValue(over.points ?? []),
  };
  s.db = () => ({
    location: { findFirst: async () => over.location ?? LOC() },
    jetGoConfig: {
      update: async (a: Row) => {
        updates.push(a.data);
        return {};
      },
    },
  });
  return { s, updates };
}

const args = { locationId: "loc1", tenantId: "t1" };

describe("registering a shop with JET Go", () => {
  it("sends the alpha-3 country code JET asks for, not the alpha-2 we store", async () => {
    const { s } = svc();
    await s.onboard(args);
    const body = s.client.onboardCollectPoint.mock.calls[0][1];
    expect(body.location.country).toBe("GBR");
  });

  it("refuses a country it has no JET code for rather than guessing one", async () => {
    const { s } = svc({ location: LOC({ country: "ZZ" }) });
    await expect(s.onboard(args)).rejects.toThrow(/country code/i);
    expect(s.client.onboardCollectPoint).not.toHaveBeenCalled();
  });

  it("names the collect point after the SHOPFRONT, never the brand record", async () => {
    // Location.brand is routinely a placeholder ("Order Hub") or, on a cloned
    // site, the brand it was copied from. Registering KINGSTON PIZZA by brand
    // produced "Order Hub (KINGSTON PIZZA)" and would send riders looking for
    // a shop that doesn't exist on the high street.
    const { s } = svc({
      location: LOC({
        name: "KINGSTON PIZZA",
        city: "Washington",
        brand: { tenantId: "t1", name: "Order Hub" },
      }),
    });
    await s.onboard(args);
    const body = s.client.onboardCollectPoint.mock.calls[0][1];
    expect(body.collectPointName).toBe("KINGSTON PIZZA");
    expect(body.locationName).toBe("Washington");
  });

  it("puts the town in the bracket, not the shop name again", async () => {
    const { s } = svc();
    await s.onboard(args);
    const body = s.client.onboardCollectPoint.mock.calls[0][1];
    // JET displays this as "Pelton (Liverpool)".
    expect(body.collectPointName).toBe("Pelton");
    expect(body.locationName).toBe("Liverpool");
  });

  it("doesn't read \"Shop (Shop)\" when the site is named after its town", async () => {
    const { s } = svc({ location: LOC({ name: "Liverpool", city: "Liverpool" }) });
    await s.onboard(args);
    const body = s.client.onboardCollectPoint.mock.calls[0][1];
    expect(body.collectPointName).toBe("Liverpool");
    expect(body.locationName).toBe("Liverpool");
  });

  it("capitalises a lower-case town but leaves a postcode alone", async () => {
    // The town is operator-typed and lands in front of a courier as stored.
    const a = svc({ location: LOC({ name: "KINGSTON PIZZA", city: "newcastle" }) });
    await a.s.onboard(args);
    expect(a.s.client.onboardCollectPoint.mock.calls[0][1].locationName).toBe("Newcastle");

    // Onboarding requires a city, but an update doesn't — and there the
    // bracket falls back to the postcode, which must not be title-cased.
    const b = svc({
      location: LOC({ name: "KINGSTON PIZZA", city: "", postcode: "L2 3PS" }),
      cfg: { collectPointId: "cp-1" },
    });
    await b.s.syncDetails(args);
    expect(b.s.client.updateCollectPoint.mock.calls[0][2].locationName).toBe("L2 3PS");
  });

  it("geocodes a shop that has none rather than sending the operator away", async () => {
    // Only distance-based delivery zones ever write Location.latitude, so a
    // flat-fee shop has no coordinates and "go and save the postcode" would
    // geocode nothing — it just loops.
    const { s } = svc({ location: LOC({ latitude: null, longitude: null }) });
    await s.onboard(args);
    expect(s.zones.locateShop).toHaveBeenCalledWith("loc1");
    const body = s.client.onboardCollectPoint.mock.calls[0][1];
    expect(body.location.latitude).toBe(53.40824);
    expect(body.location.longitude).toBe(-2.99145);
  });

  it("doesn't re-geocode a shop that already has coordinates", async () => {
    const { s } = svc();
    await s.onboard(args);
    expect(s.zones.locateShop).not.toHaveBeenCalled();
  });

  it("refuses when the address can't be found — a wrong pin misprices every delivery", async () => {
    const { s } = svc({ location: LOC({ latitude: null, longitude: null }), geo: null });
    await expect(s.onboard(args)).rejects.toThrow(/couldn't find/i);
    expect(s.client.onboardCollectPoint).not.toHaveBeenCalled();
  });

  it("stays PENDING when JET accepts but hasn't built the collect point", async () => {
    // POST /onboarding answers 202 with no id. "Registered" is not "ready".
    const { s, updates } = svc({ points: [] });
    const r = await s.onboard(args);
    expect(r.status).toBe("PENDING");
    expect(r.collectPointId).toBeNull();
    expect(updates.some((u) => u.onboardingStatus === "PENDING")).toBe(true);
  });

  it("records the failure instead of leaving the screen silent", async () => {
    const { s, updates } = svc();
    s.client.onboardCollectPoint.mockRejectedValue(
      new Error("JET Go POST /v1/collect-point/onboarding → 400: Invalid phone number format."),
    );
    await expect(s.onboard(args)).rejects.toThrow(/Invalid phone number format/);
    const failed = updates.find((u) => u.onboardingStatus === "FAILED");
    expect(failed?.onboardingError).toBe("Invalid phone number format.");
  });
});

describe("resolving the collect point JET created", () => {
  it("matches on the location id we sent, not on the name", async () => {
    const { s } = svc({
      points: [
        { id: "cp-other", name: "Someone Else", corporateIdentifier: "loc9" },
        { id: "cp-ours", name: "Pelton (Liverpool)", corporateIdentifier: "loc1" },
      ],
    });
    const r = await s.resolve(args);
    expect(r.collectPointId).toBe("cp-ours");
    expect(r.pending).toBe(false);
  });

  it("will not accept a name match whose postcode disagrees", async () => {
    // Two shops of the same brand in different towns is the normal case, and
    // taking the wrong one sends this shop's food from the other one's door.
    const { s } = svc({
      points: [{ id: "cp-wrong", name: "Pelton (Liverpool)", postalCode: "M1 1AA" }],
    });
    const r = await s.resolve(args);
    expect(r.collectPointId).toBeNull();
    expect(r.pending).toBe(true);
  });

  it("will not guess when two collect points carry the same name", async () => {
    const { s } = svc({
      points: [
        { id: "cp-a", name: "Pelton (Liverpool)", postalCode: "L2 3PS" },
        { id: "cp-b", name: "Pelton (Liverpool)", postalCode: "L2 3PS" },
      ],
    });
    expect((await s.resolve(args)).pending).toBe(true);
  });

  it("accepts an unambiguous name match when the postcode agrees", async () => {
    const { s, updates } = svc({
      points: [{ id: "cp-a", name: "Pelton (Liverpool)", postalCode: "l23ps" }],
    });
    const r = await s.resolve(args);
    expect(r.collectPointId).toBe("cp-a");
    expect(updates.some((u) => u.onboardingStatus === "COMPLETE")).toBe(true);
  });
});

describe("updating a collect point", () => {
  it("spells pickUpInstructions the PATCH way, not the POST way", async () => {
    // POST says PickupInstructions, PATCH says pickUpInstructions. They are
    // not interchangeable and a wrong key is silently dropped.
    const { s } = svc({ cfg: { collectPointId: "cp-1" } });
    await s.syncDetails({ ...args, pickupInstructions: "Side door" });
    const body = s.client.updateCollectPoint.mock.calls[0][2];
    expect(body.pickUpInstructions).toBe("Side door");
    expect((body as Row).PickupInstructions).toBeUndefined();
  });

  it("refuses before there is anything to update", async () => {
    const { s } = svc();
    await expect(s.syncDetails(args)).rejects.toThrow(/register it first/i);
  });
});
