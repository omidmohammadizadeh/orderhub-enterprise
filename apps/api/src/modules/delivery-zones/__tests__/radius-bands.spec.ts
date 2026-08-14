import {
  milesBetween,
  resolveRadiusBand,
} from "../delivery-zones.service";

// Delivery fees are money on every order, so the two pure pieces — how far
// away the customer is, and which band that lands in — are pinned here.

describe("milesBetween", () => {
  it("measures a known distance", () => {
    // Newcastle Central Station → Gateshead Interchange, about 0.8 miles.
    const d = milesBetween(
      { lat: 54.9686, lng: -1.6174 },
      { lat: 54.9622, lng: -1.6015 },
    );
    expect(d).toBeGreaterThan(0.5);
    expect(d).toBeLessThan(1.1);
  });

  it("is zero for the same point", () => {
    const p = { lat: 54.9686, lng: -1.6174 };
    expect(milesBetween(p, p)).toBeCloseTo(0, 6);
  });

  it("is symmetric", () => {
    const a = { lat: 54.97, lng: -1.61 };
    const b = { lat: 55.02, lng: -1.44 };
    expect(milesBetween(a, b)).toBeCloseTo(milesBetween(b, a), 9);
  });
});

describe("resolveRadiusBand", () => {
  // 0–3 miles £3, 3–4 miles £4, 4–6 miles £6 — the shape from the request.
  const bands = [
    { id: "b3", maxDistanceMiles: 3 },
    { id: "b4", maxDistanceMiles: 4 },
    { id: "b6", maxDistanceMiles: 6 },
  ];

  it("puts a close address in the first band", () => {
    expect(resolveRadiusBand(bands, 1.2)?.band.id).toBe("b3");
  });

  it("puts a mid address in the middle band", () => {
    expect(resolveRadiusBand(bands, 3.5)?.band.id).toBe("b4");
  });

  it("treats a band edge as inside that band, not the next one", () => {
    // Exactly 3.0 miles is "up to 3 miles", so £3 — charging £4 for landing on
    // the boundary is the kind of thing customers ring up about.
    expect(resolveRadiusBand(bands, 3)?.band.id).toBe("b3");
  });

  it("charges the TOP band beyond the furthest edge rather than nothing", () => {
    // Same rule as an unrecognised postcode: quoting £0 sends food out with no
    // delivery fee, which is the failure that costs the shop money.
    const hit = resolveRadiusBand(bands, 12);
    expect(hit?.band.id).toBe("b6");
    expect(hit?.beyondLastBand).toBe(true);
  });

  it("flags in-range results as NOT beyond the last band", () => {
    expect(resolveRadiusBand(bands, 2)?.beyondLastBand).toBe(false);
  });

  it("does not care what order the bands were saved in", () => {
    const shuffled = [
      { id: "b6", maxDistanceMiles: 6 },
      { id: "b3", maxDistanceMiles: 3 },
      { id: "b4", maxDistanceMiles: 4 },
    ];
    expect(resolveRadiusBand(shuffled, 3.5)?.band.id).toBe("b4");
  });

  it("ignores postcode rows mixed into the set", () => {
    const mixed = [
      { id: "pc", maxDistanceMiles: null },
      { id: "b3", maxDistanceMiles: 3 },
    ];
    expect(resolveRadiusBand(mixed as any, 1)?.band.id).toBe("b3");
  });

  it("returns null when there are no radius bands at all", () => {
    expect(resolveRadiusBand([{ id: "pc", maxDistanceMiles: null }] as any, 1))
      .toBeNull();
  });

  it("handles Decimal-like values, as Prisma returns them", () => {
    const decimalish = [
      { id: "b3", maxDistanceMiles: { toString: () => "3.00" } },
      { id: "b5", maxDistanceMiles: { toString: () => "5.00" } },
    ];
    expect(resolveRadiusBand(decimalish as any, 4)?.band.id).toBe("b5");
  });
});
