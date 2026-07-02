import { CustomersService } from "../customers.service";

// Caller-ID lookup: match the ringing number against past orders across the
// 0…/+44… formatting variants, and surface distinct previous addresses for
// the POS popup.

function setup(orders: any[]) {
  const prisma = {
    order: { findMany: jest.fn().mockResolvedValue(orders) },
  } as any;
  return new CustomersService(prisma);
}

const order = (over: Record<string, any>) => ({
  customerName: "Omid",
  customerPhone: "+44 7788 180709",
  customerInfo: { email: "omid@example.com" },
  deliveryAddress: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  postcode: null,
  createdAt: new Date("2026-06-01"),
  ...over,
});

describe("CustomersService.lookupByPhone", () => {
  it("matches across 0 / +44 / spaced formats via digit suffix", async () => {
    const svc = setup([order({})]);
    const hit = await svc.lookupByPhone("t1", "07788180709");
    expect(hit).not.toBeNull();
    expect(hit!.name).toBe("Omid");
    expect(hit!.orders).toBe(1);
    expect(hit!.email).toBe("omid@example.com");
  });

  it("returns distinct addresses newest-first and skips duplicates", async () => {
    const svc = setup([
      order({
        deliveryAddress: { line1: "15 Front Street", city: "Newcastle", postcode: "DH2 1LY" },
        createdAt: new Date("2026-07-01"),
      }),
      order({
        deliveryAddress: { line1: "15 Front Street", city: "Newcastle", postcode: "DH2 1LY" },
        createdAt: new Date("2026-06-15"),
      }),
      order({
        addressLine1: "9 Coach Road",
        postcode: "NE37 2LL",
        createdAt: new Date("2026-06-01"),
      }),
    ]);
    const hit = await svc.lookupByPhone("t1", "+447788180709");
    expect(hit!.orders).toBe(3);
    expect(hit!.addresses).toHaveLength(2);
    expect(hit!.addresses[0]!.line1).toBe("15 Front Street");
    expect(hit!.addresses[1]!.line1).toBe("9 Coach Road");
  });

  it("returns null for unknown or too-short numbers", async () => {
    const svc = setup([order({})]);
    expect(await svc.lookupByPhone("t1", "07000000000")).toBeNull();
    expect(await svc.lookupByPhone("t1", "123")).toBeNull();
  });
});
