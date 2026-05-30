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
  // calls the real lookup() so the longest-prefix matching logic is
  // exercised end-to-end.
  const buildService = (
    zones: Array<{
      id: string;
      postcodePrefix: string;
      fee: any;
      minOrderValue: any;
      isActive?: boolean;
    }>,
  ) => {
    const prisma = {
      location: {
        findFirst: jest.fn().mockResolvedValue({ id: "loc1" }),
      },
      deliveryZone: {
        // Honour the { where: { isActive: true } } predicate the service
        // sends in so the inactive-zones test is exercising real behaviour.
        findMany: jest.fn().mockImplementation((args: any) => {
          const out = zones.map((z) => ({ ...z, isActive: z.isActive ?? true }));
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
    const result = await svc.lookup("t1", "loc1", "E14 5AA");
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
    const result = await svc.lookup("t1", "loc1", "SW1A 1AA");
    expect(result.matched).toBe(true);
    expect(result.zoneId).toBe("narrow");
    expect(result.fee).toBe(2.0);
  });

  it("returns minOrderValue when set", async () => {
    const svc = buildService([
      { id: "z1", postcodePrefix: "NW3", fee: 1.5, minOrderValue: 15 },
    ]);
    const result = await svc.lookup("t1", "loc1", "NW3 5BB");
    expect(result.matched).toBe(true);
    expect(result.minOrderValue).toBe(15);
  });

  it("ignores inactive zones", async () => {
    const svc = buildService([
      { id: "z1", postcodePrefix: "EC1", fee: 2.0, minOrderValue: null, isActive: false },
    ]);
    const result = await svc.lookup("t1", "loc1", "EC1A 2BB");
    expect(result.matched).toBe(false);
  });

  it("normalises postcode with whitespace + lowercase", async () => {
    const svc = buildService([
      { id: "z1", postcodePrefix: "SW1", fee: 2.5, minOrderValue: null },
    ]);
    const result = await svc.lookup("t1", "loc1", "  sw1 0aa  ");
    expect(result.matched).toBe(true);
  });
});
