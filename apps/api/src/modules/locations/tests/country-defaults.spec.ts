import { LocationsService } from "../locations.service";

// Moving a shop to another country has to move its money and its clock with
// it. Before this, the defaults only ran at CREATE — so the Country field
// looked like it worked and silently did nothing on an existing shop, leaving
// a Dubai location on GBP and Europe/London.
function build(current: any) {
  const writes: any[] = [];
  const prisma: any = {
    location: {
      findFirst: async () => current,
      findUnique: async () => current,
      update: async (args: any) => {
        writes.push(args.data);
        return { ...current, ...args.data };
      },
      create: async (args: any) => {
        writes.push(args.data);
        return args.data;
      },
    },
    brand: { findMany: async () => [{ id: "b1" }], findFirst: async () => ({ id: "b1" }) },
  };
  const svc = Object.create(LocationsService.prototype) as any;
  svc.prisma = prisma;
  svc.storage = { rehost: async (u: string) => u };
  svc.resolveOrCreateDefaultBrand = async () => "b1";
  return { svc, writes };
}

const GB_SHOP = { id: "loc-1", country: "GB", currency: "GBP", timezone: "Europe/London" };

describe("creating a location", () => {
  it("takes its currency and timezone from the country", async () => {
    const { svc, writes } = build(GB_SHOP);
    await svc.create("t1", { name: "Dubai Grill", address: { country: "AE" } } as any);
    expect(writes[0].currency).toBe("AED");
    expect(writes[0].timezone).toBe("Asia/Dubai");
  });

  it("still defaults to the UK when no country is given", async () => {
    const { svc, writes } = build(GB_SHOP);
    await svc.create("t1", { name: "Chippy", address: {} } as any);
    expect(writes[0].currency).toBe("GBP");
    expect(writes[0].timezone).toBe("Europe/London");
  });
});

describe("moving an existing location to another country", () => {
  it("moves its currency and timezone too", async () => {
    const { svc, writes } = build(GB_SHOP);
    await svc.update("loc-1", "t1", { country: "AE" } as any);
    expect(writes[0].currency).toBe("AED");
    expect(writes[0].timezone).toBe("Asia/Dubai");
  });

  it("leaves them alone on a save that does not change the country", async () => {
    // A rename or a new phone number must never silently rewrite a shop's
    // money, including when the same country is sent back unchanged.
    const { svc, writes } = build(GB_SHOP);
    await svc.update("loc-1", "t1", { name: "New Name" } as any);
    expect(writes[0].currency).toBeUndefined();
    expect(writes[0].timezone).toBeUndefined();

    const again = build(GB_SHOP);
    await again.svc.update("loc-1", "t1", { country: "gb" } as any);
    expect(again.writes[0].currency).toBeUndefined();
  });

  it("does not override a timezone the operator set in the same request", async () => {
    const { svc, writes } = build(GB_SHOP);
    await svc.update("loc-1", "t1", {
      country: "AE",
      timezone: "Asia/Riyadh",
    } as any);
    expect(writes[0].timezone).toBe("Asia/Riyadh");
    expect(writes[0].currency).toBe("AED");
  });
});
