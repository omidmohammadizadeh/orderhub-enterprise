import { AnalyticsService } from "../analytics.service";

// Simulated and test orders are isSandbox. Analytics leaves them out so a
// shop's figures stay real — but a platform admin checking the report's
// arithmetic needs to be able to count the orders they just made.

function whereFor(opts: { role: string; includeTestOrders?: boolean }) {
  const findMany = jest.fn().mockResolvedValue([]);
  const prisma: any = {
    order: { findMany },
    brand: { findMany: jest.fn().mockResolvedValue([]) },
    location: { findMany: jest.fn().mockResolvedValue([]) },
    userLocation: { findMany: jest.fn().mockResolvedValue([]) },
    userBrand: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const svc = new AnalyticsService(prisma);
  return svc
    .getOverview("t1", {
      from: new Date("2026-09-19T00:00:00Z"),
      to: new Date("2026-09-20T00:00:00Z"),
      userId: "u1",
      ...opts,
    })
    .catch(() => undefined)
    .then(() => findMany.mock.calls[0][0].where);
}

describe("Analytics overview — test orders", () => {
  it("leaves test orders out by default, even for an admin", async () => {
    expect((await whereFor({ role: "PLATFORM_ADMIN" })).isSandbox).toBe(false);
  });

  it("counts them when a platform admin asks", async () => {
    const where = await whereFor({ role: "PLATFORM_ADMIN", includeTestOrders: true });
    expect(where).not.toHaveProperty("isSandbox");
  });

  it("ignores the request from anyone else, so a shop's figures stay real", async () => {
    for (const role of ["TENANT_OWNER", "OWNER", "MANAGER"]) {
      expect((await whereFor({ role, includeTestOrders: true })).isSandbox).toBe(false);
    }
  });
});
