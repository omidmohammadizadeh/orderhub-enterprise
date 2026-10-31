import { BrandConnectionsService } from "../brand-connections.service";

// The brand page reads its tiles from this list. A channel that connects through
// its own flow has to come back here, or its tile says "Not connected" for good.

const row = (over: Record<string, unknown>) => ({
  id: "x",
  tenantId: "t",
  brandId: "b",
  status: "connected",
  ...over,
});

const list = (rows: unknown[]) => {
  const prisma = {
    brand: { findFirst: jest.fn().mockResolvedValue({ id: "b" }) },
    brandPlatformConnection: { findMany: jest.fn().mockResolvedValue(rows) },
  };
  return new BrandConnectionsService(prisma as never).listForBrand("t", "b");
};

describe("BrandConnectionsService.listForBrand", () => {
  it("returns connections on platforms outside the placeholder list", async () => {
    const out = await list([row({ platform: "CAREEM", locationId: "l1" })]);
    expect(out.find((c) => c.platform === "CAREEM")).toMatchObject({ locationId: "l1" });
  });

  it("returns every location's connection, not just the first", async () => {
    const out = await list([
      row({ id: "a", platform: "CAREEM", locationId: "l1" }),
      row({ id: "b", platform: "CAREEM", locationId: "l2" }),
    ]);
    expect(out.filter((c) => c.platform === "CAREEM").map((c) => c.locationId)).toEqual(["l1", "l2"]);
  });

  it("keeps one row per placeholder platform, without duplicating a real one", async () => {
    const out = await list([row({ platform: "JUST_EAT", locationId: "l1" })]);
    expect(out.filter((c) => c.platform === "JUST_EAT")).toHaveLength(1);
    expect(out.filter((c) => c.platform === "UBER_EATS")[0]).toMatchObject({ status: "not_connected" });
  });
});
