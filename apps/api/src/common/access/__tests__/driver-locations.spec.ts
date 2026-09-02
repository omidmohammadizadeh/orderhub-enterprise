import { driverIdsForLocations } from "../accessible-locations";

// A driver's shop comes from Team Roles (UserLocation), not from
// Driver.locationId. Assigning the DRIVER role and the locations on Team
// Roles used to leave the driver off that shop's map until an operator went
// to the Fleet tab and picked the location a second time.

function fakePrisma(
  userLocations: { userId: string; locationId: string }[],
  drivers: { id: string; userId: string | null; tenantId: string }[],
) {
  return {
    userLocation: {
      findMany: async ({ where }: any) =>
        userLocations.filter((l) => where.locationId.in.includes(l.locationId)),
    },
    driver: {
      findMany: async ({ where }: any) =>
        drivers.filter(
          (d) =>
            d.tenantId === where.tenantId &&
            d.userId !== null &&
            where.userId.in.includes(d.userId),
        ),
    },
  };
}

const LINKS = [
  { userId: "u-anees", locationId: "loc-best-kebab" },
  { userId: "u-ashkan", locationId: "loc-kingston" },
  { userId: "u-both", locationId: "loc-best-kebab" },
  { userId: "u-both", locationId: "loc-kingston" },
];
const DRIVERS = [
  { id: "d-anees", userId: "u-anees", tenantId: "t1" },
  { id: "d-ashkan", userId: "u-ashkan", tenantId: "t1" },
  { id: "d-both", userId: "u-both", tenantId: "t1" },
  { id: "d-orphan", userId: null, tenantId: "t1" },
  { id: "d-other-tenant", userId: "u-anees", tenantId: "t2" },
];

const resolve = (locs: string[], tenant = "t1") =>
  driverIdsForLocations(fakePrisma(LINKS, DRIVERS), tenant, locs);

describe("a driver's shops come from Team Roles", () => {
  it("finds the drivers assigned to one shop", async () => {
    expect((await resolve(["loc-best-kebab"])).sort()).toEqual([
      "d-anees",
      "d-both",
    ]);
  });

  it("does not leak another shop's drivers", async () => {
    expect(await resolve(["loc-kingston"])).not.toContain("d-anees");
  });

  it("returns a driver who works at two shops from either", async () => {
    expect(await resolve(["loc-best-kebab"])).toContain("d-both");
    expect(await resolve(["loc-kingston"])).toContain("d-both");
  });

  it("never returns a driver record with no login attached", async () => {
    // These are the operator-created twins behind the duplicate names in
    // Fleet. They belong to no shop, so they belong under no shop.
    expect(await resolve(["loc-best-kebab", "loc-kingston"])).not.toContain(
      "d-orphan",
    );
  });

  it("stays inside the tenant", async () => {
    // The same person can hold a login in two tenants. Asking as t2 returns
    // t2's driver record and never t1's.
    expect(await resolve(["loc-best-kebab"], "t2")).toEqual(["d-other-tenant"]);
    expect(await resolve(["loc-best-kebab"], "t2")).not.toContain("d-anees");
  });

  it("returns nothing when the caller can reach no location", async () => {
    expect(await resolve([])).toEqual([]);
  });
});
