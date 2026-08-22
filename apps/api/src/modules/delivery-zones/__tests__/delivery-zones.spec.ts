import { normalisePostcode, DeliveryZonesService } from "../delivery-zones.service";

describe("normalisePostcode", () => {
  it.each([
    ["sw1 0aa", "SW10AA"],
    ["  SW1A  1AA ", "SW1A1AA"],
    ["nw3", "NW3"],
    ["", ""],
  ])("normalises %j → %j", (input, expected) => {
    expect(normalisePostcode(input)).toBe(expected);
  });
});

describe("DeliveryZonesService.lookup", () => {
  // We mock just the prisma surface the service uses. Each test sets up
  // findFirst (for the location assertion) + findMany (for the zones) and
  // calls the real lookup() so the matching logic is exercised end-to-end.
  const buildService = (
    zones: Array<{
      id: string;
      postcodePrefix?: string | null;
      areaName?: string | null;
      maxDistanceMiles?: number | null;
      fee: any;
      minOrderValue: any;
      isActive?: boolean;
    }>,
  ) => {
    const prisma = {
      location: {
        findFirst: jest.fn().mockResolvedValue({ id: "loc1", country: "GB" }),
        update: jest.fn().mockResolvedValue({}),
      },
      deliveryZone: {
        // Honour the { where: { isActive: true } } predicate the service
        // sends in so the inactive-zones test is exercising real behaviour.
        findMany: jest.fn().mockImplementation((args: any) => {
          const out = zones.map((z) => ({
            postcodePrefix: null,
            areaName: null,
            maxDistanceMiles: null,
            ...z,
            isActive: z.isActive ?? true,
          }));
          if (args?.where?.isActive === true) {
            return Promise.resolve(out.filter((z) => z.isActive));
          }
          return Promise.resolve(out);
        }),
      },
    } as any;
    return new DeliveryZonesService(prisma);
  };

  it("returns matched=false when no zones match", async () => {
    const svc = buildService([
      { id: "z1", postcodePrefix: "SW1", fee: 3.5, minOrderValue: null },
    ]);
    const result = await svc.lookup("t1", "loc1", { postcode: "E14 5AA" });
    expect(result.matched).toBe(false);
    expect(result.fee).toBe(0);
  });

  it("matches longest prefix first", async () => {
    // Both SW1 (£3.50) and SW1A (£2.00) match — the more specific SW1A
    // should win.
    const svc = buildService([
      { id: "broad", postcodePrefix: "SW1", fee: 3.5, minOrderValue: null },
      { id: "narrow", postcodePrefix: "SW1A", fee: 2.0, minOrderValue: null },
    ]);
    const result = await svc.lookup("t1", "loc1", { postcode: "SW1A 1AA" });
    expect(result.matched).toBe(true);
    expect(result.zoneId).toBe("narrow");
    expect(result.fee).toBe(2.0);
  });

  it("returns minOrderValue when set", async () => {
    const svc = buildService([
      { id: "z1", postcodePrefix: "NW3", fee: 1.5, minOrderValue: 15 },
    ]);
    const result = await svc.lookup("t1", "loc1", { postcode: "NW3 5BB" });
    expect(result.matched).toBe(true);
    expect(result.minOrderValue).toBe(15);
  });

  it("ignores inactive zones", async () => {
    const svc = buildService([
      { id: "z1", postcodePrefix: "EC1", fee: 2.0, minOrderValue: null, isActive: false },
    ]);
    const result = await svc.lookup("t1", "loc1", { postcode: "EC1A 2BB" });
    expect(result.matched).toBe(false);
  });

  it("normalises postcode with whitespace + lowercase", async () => {
    const svc = buildService([
      { id: "z1", postcodePrefix: "SW1", fee: 2.5, minOrderValue: null },
    ]);
    const result = await svc.lookup("t1", "loc1", { postcode: "  sw1 0aa  " });
    expect(result.matched).toBe(true);
  });

  // ── Area mode (the Gulf) ──────────────────────────────────────────────────

  it("prices by the picked area", async () => {
    const svc = buildService([
      { id: "marina", areaName: "Dubai Marina", fee: 15, minOrderValue: 40 },
      { id: "jlt", areaName: "JLT", fee: 12, minOrderValue: null },
    ]);
    const result = await svc.lookup("t1", "loc1", { area: "Dubai Marina" });
    expect(result.mode).toBe("AREA");
    expect(result.zoneId).toBe("marina");
    expect(result.fee).toBe(15);
    expect(result.minOrderValue).toBe(40);
  });

  it("refuses an area the shop does not serve rather than pricing it", async () => {
    // The distinction that matters: unserviceable, not merely unmatched. The
    // checkout treats the first as a refusal and the second as a data gap to
    // charge the top rate for.
    const svc = buildService([
      { id: "marina", areaName: "Dubai Marina", fee: 15, minOrderValue: null },
    ]);
    const result = await svc.lookup("t1", "loc1", { area: "Al Quoz" });
    expect(result.matched).toBe(false);
    expect(result.unserviceable).toBe(true);
    expect(result.fee).toBe(0);
  });

  it("does not call an empty area unserviceable", async () => {
    // Nothing picked yet is not a refusal — the cart just has no fee to show.
    const svc = buildService([
      { id: "marina", areaName: "Dubai Marina", fee: 15, minOrderValue: null },
    ]);
    const result = await svc.lookup("t1", "loc1", {});
    expect(result.matched).toBe(false);
    expect(result.unserviceable).toBeUndefined();
  });

  it("ignores a postcode when the shop prices by area", async () => {
    // A Gulf customer's browser may still send an empty/garbage postcode.
    // It must not be able to pick a zone in a mode that isn't postcode.
    const svc = buildService([
      { id: "marina", areaName: "Dubai Marina", fee: 15, minOrderValue: null },
    ]);
    const result = await svc.lookup("t1", "loc1", {
      postcode: "SW1A 1AA",
      area: "Dubai Marina",
    });
    expect(result.zoneId).toBe("marina");
  });

  // ── Radius mode ───────────────────────────────────────────────────────────

  it("charges the top band when the customer can't be located", async () => {
    // No coordinates, no geocoder key in test — the fail-safe is the top
    // band, never nothing.
    const svc = buildService([
      { id: "near", maxDistanceMiles: 2, fee: 2, minOrderValue: null },
      { id: "far", maxDistanceMiles: 5, fee: 6, minOrderValue: null },
    ]);
    const result = await svc.lookup("t1", "loc1", { postcode: "SW1A 1AA" });
    expect(result.mode).toBe("RADIUS");
    expect(result.zoneId).toBe("far");
    expect(result.beyondLastBand).toBe(true);
  });
});
