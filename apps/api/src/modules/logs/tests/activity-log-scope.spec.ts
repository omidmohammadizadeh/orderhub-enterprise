import { ActivityLogService } from "../activity-log.service";

// Log-feed scoping. A tenant owner used to read every location's activity in
// the tenant — other operators' menu publishes, order failures and store
// pauses included. Only a platform admin sees across locations now.

const LOCS = { mine: "loc-mine", theirs: "loc-theirs" };

function makeService(opts: {
  userLocations?: string[];
  userBrands?: string[];
  brandLocations?: Record<string, string[]>;
}) {
  const rows = [
    { id: "l1", locationId: LOCS.mine, brandId: null, createdAt: new Date() },
    { id: "l2", locationId: LOCS.theirs, brandId: null, createdAt: new Date() },
  ];
  const prisma: any = {
    userLocation: {
      findMany: async () =>
        (opts.userLocations ?? []).map((locationId) => ({ locationId })),
    },
    userBrand: {
      findMany: async () => (opts.userBrands ?? []).map((brandId) => ({ brandId })),
    },
    brand: {
      findMany: async ({ where }: any) =>
        (where.id?.in ?? []).map((id: string) => ({
          id,
          name: id,
          primaryLocationId: null,
          locations: (opts.brandLocations?.[id] ?? []).map((l) => ({ id: l })),
        })),
    },
    activityLog: {
      // Evaluates the composed where-clause rather than reading one field.
      // The service now builds `AND: [filters, locationClause]` where the
      // location half is an OR (location match, or a brand-scoped row with no
      // location) — a fake that only looked at `where.locationId` would stop
      // filtering entirely and quietly turn this leak guard green.
      findMany: async ({ where }: any) => {
        const matchesLocation = (row: any, clause: any): boolean => {
          if (clause.locationId !== undefined) {
            const want = clause.locationId;
            if (want === null) {
              if (row.locationId !== null) return false;
            } else if (typeof want === "string") {
              if (row.locationId !== want) return false;
            } else if (want?.in && !want.in.includes(row.locationId)) {
              return false;
            }
          }
          if (clause.brandId?.in && !clause.brandId.in.includes(row.brandId)) {
            return false;
          }
          return true;
        };
        const matches = (row: any, clause: any): boolean => {
          if (!clause || Object.keys(clause).length === 0) return true;
          if (Array.isArray(clause.AND)) {
            return clause.AND.every((c: any) => matches(row, c));
          }
          if (Array.isArray(clause.OR)) {
            return clause.OR.some((c: any) => matchesLocation(row, c));
          }
          return matchesLocation(row, clause);
        };
        return rows.filter((r) => matches(r, where));
      },
    },
  };
  return new ActivityLogService(prisma);
}

const admin = { userId: "u1", tenantId: "t1", role: "PLATFORM_ADMIN" };
const owner = { userId: "u2", tenantId: "t1", role: "TENANT_OWNER" };

describe("ActivityLogService feed scope", () => {
  it("gives PLATFORM_ADMIN every location in the tenant", async () => {
    const svc = makeService({});
    const out = await svc.list(admin);
    expect(out.entries.map((e: any) => e.locationId).sort()).toEqual([
      LOCS.mine,
      LOCS.theirs,
    ]);
  });

  it("scopes TENANT_OWNER to assigned locations — the leak this fixes", async () => {
    const svc = makeService({ userLocations: [LOCS.mine] });
    const out = await svc.list(owner);
    expect(out.entries.map((e: any) => e.locationId)).toEqual([LOCS.mine]);
  });

  it("includes locations reached through a brand assignment", async () => {
    const svc = makeService({
      userBrands: ["b1"],
      brandLocations: { b1: [LOCS.theirs] },
    });
    const out = await svc.list(owner);
    expect(out.entries.map((e: any) => e.locationId)).toEqual([LOCS.theirs]);
  });

  it("returns nothing for an owner with no assignments, never everything", async () => {
    const svc = makeService({});
    const out = await svc.list(owner);
    expect(out.entries).toEqual([]);
  });

  it("refuses a locationId outside the allowlist rather than honouring it", async () => {
    const svc = makeService({ userLocations: [LOCS.mine] });
    const out = await svc.list(owner, { locationId: LOCS.theirs });
    expect(out.entries).toEqual([]);
  });

  it("fails closed when the caller has no resolved identity", async () => {
    const svc = makeService({});
    const out = await svc.list({ userId: "", tenantId: "t1", role: "" } as any);
    expect(out.entries).toEqual([]);
  });
});
