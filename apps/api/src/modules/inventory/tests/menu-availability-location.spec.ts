import { MenuAvailabilityService } from "../menu-availability.service";

// Phase BA — per-location snooze semantics at the read choke-point
// (getSnoozedItemIdsForChannel) and the unsnooze fallback rules.
//
// Row model: locationId NULL = 86'd at every location; a locationId =
// 86'd only there. channel "ALL" = 86'd on every channel (at that scope).
// The mock filters rows the way Postgres would for the where-clauses the
// service builds, so these tests pin the QUERY semantics.

function rowMatches(row: any, where: any, now: Date): boolean {
  const channels: string[] = where.channel.in;
  if (!channels.includes(row.channel)) return false;
  if (!where.itemId.in.includes(row.itemId)) return false;
  const [expiry, loc] = where.AND;
  const unexpired =
    row.expiresAt === null || (row.expiresAt && row.expiresAt > now);
  if (!unexpired) return false;
  if ("locationId" in loc) return row.locationId === loc.locationId;
  return loc.OR.some((c: any) =>
    c.locationId === null ? row.locationId === null : row.locationId === c.locationId,
  );
}

function makeService(rows: any[]) {
  const deleted: any[] = [];
  const prisma = {
    menuItemChannelAvailability: {
      findMany: jest.fn(async (args: any) => {
        const now = new Date();
        return rows
          .filter((r) => rowMatches(r, args.where, now))
          .map((r) => ({ itemId: r.itemId }));
      }),
      deleteMany: jest.fn(async (args: any) => {
        const match = rows.filter(
          (r) =>
            r.itemId === args.where.itemId &&
            r.channel === args.where.channel &&
            r.locationId === args.where.locationId,
        );
        deleted.push(...match);
        match.forEach((m) => rows.splice(rows.indexOf(m), 1));
        return { count: match.length };
      }),
    },
    menuItem: {
      findUnique: jest.fn(async () => ({
        id: "I1",
        name: "Margherita",
        brandId: "B1",
        brandIds: [],
        menuIds: [],
        plu: null,
        hasMultipleSkus: false,
        productSkus: [],
      })),
    },
    brand: {
      findUnique: jest.fn(async () => ({ tenantId: "T1" })),
    },
    location: {
      findFirst: jest.fn(async (args: any) =>
        args.where.id === "L1" || args.where.id === "L2"
          ? { id: args.where.id }
          : null,
      ),
    },
    menuChannelAssignment: {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
    },
    menu: { findFirst: jest.fn(async () => null) },
  } as any;
  const deliverooClient = { request: jest.fn(async () => ({})) } as any;
  const svc = new MenuAvailabilityService(prisma, {} as any, deliverooClient);
  return { svc, rows, deleted, prisma };
}

const globalRow = (itemId: string, channel = "ONLINE") => ({
  itemId,
  channel,
  locationId: null,
  expiresAt: null,
});
const locRow = (itemId: string, locationId: string, channel = "ONLINE") => ({
  itemId,
  channel,
  locationId,
  expiresAt: null,
});

describe("getSnoozedItemIdsForChannel — location scoping", () => {
  it("a global row hides the item at every location", async () => {
    const { svc } = makeService([globalRow("I1")]);
    for (const loc of ["L1", "L2", undefined]) {
      const out = await svc.getSnoozedItemIdsForChannel("ONLINE", ["I1"], loc);
      expect(out.has("I1")).toBe(true);
    }
  });

  it("a location row hides the item ONLY at that location", async () => {
    const { svc } = makeService([locRow("I1", "L1")]);
    expect(
      (await svc.getSnoozedItemIdsForChannel("ONLINE", ["I1"], "L1")).has("I1"),
    ).toBe(true);
    expect(
      (await svc.getSnoozedItemIdsForChannel("ONLINE", ["I1"], "L2")).has("I1"),
    ).toBe(false);
    // Unscoped surfaces never see location-scoped 86s.
    expect(
      (await svc.getSnoozedItemIdsForChannel("ONLINE", ["I1"])).has("I1"),
    ).toBe(false);
  });

  it('an "ALL"-channel row hides the item on every channel at its location', async () => {
    const { svc } = makeService([locRow("I1", "L1", "ALL")]);
    for (const ch of ["ONLINE", "POS", "DELIVEROO"] as const) {
      expect(
        (await svc.getSnoozedItemIdsForChannel(ch, ["I1"], "L1")).has("I1"),
      ).toBe(true);
      expect(
        (await svc.getSnoozedItemIdsForChannel(ch, ["I1"], "L2")).has("I1"),
      ).toBe(false);
    }
  });

  it("expired rows never count", async () => {
    const { svc } = makeService([
      { itemId: "I1", channel: "ONLINE", locationId: "L1", expiresAt: new Date(Date.now() - 60_000) },
    ]);
    expect(
      (await svc.getSnoozedItemIdsForChannel("ONLINE", ["I1"], "L1")).has("I1"),
    ).toBe(false);
  });
});

describe("unsnooze — location fallback", () => {
  it("deletes the location row when one exists", async () => {
    const { svc, rows } = makeService([
      locRow("I1", "L1"),
      globalRow("I1"),
    ]);
    await svc.unsnooze({ itemId: "I1", tenantId: "T1", channel: "ONLINE", locationId: "L1" });
    // Location row gone, global row untouched.
    expect(rows.some((r) => r.locationId === "L1")).toBe(false);
    expect(rows.some((r) => r.locationId === null)).toBe(true);
  });

  it("falls back to deleting the GLOBAL row when no location row exists", async () => {
    const { svc, rows } = makeService([globalRow("I1")]);
    await svc.unsnooze({ itemId: "I1", tenantId: "T1", channel: "ONLINE", locationId: "L1" });
    expect(rows).toHaveLength(0);
  });
});
