import { MenusService } from "../menus.service";

// Phase BA — publish transaction semantics. Publishing menu M with
// { publishedTo, locationIds } must:
//   • upsert one assignment per (location × channel) — the unique
//     (locationId, channel, brandId) key REPLACES whatever menu held the
//     slot, and never touches locations that weren't selected;
//   • leave this menu's OTHER channels alone. Publish is additive (per the
//     operator): publishing a menu to Online must not pull it off POS.
//     Taking a menu off one channel is the explicit unpublishFromChannel
//     call, never a side effect of publishing somewhere else;
//   • write nothing at all when locationIds is absent (legacy PATCH callers).

function makeService() {
  const upserts: any[] = [];
  const deleteManys: any[] = [];
  const prisma = {
    menu: {
      findFirst: jest.fn(async () => ({ id: "M1" })), // assertMenuAccess
      findUnique: jest.fn(async () => ({
        brandId: "B1",
        brand: { tenantId: "T1" },
      })),
      update: jest.fn(() => ({ __op: "menuUpdate" })),
    },
    location: {
      findFirst: jest.fn(async (args: any) =>
        ["L1", "L2"].includes(args.where.id)
          ? { id: args.where.id, brandId: "B1" }
          : null,
      ),
    },
    brand: {
      findFirst: jest.fn(async () => ({ id: "B1" })),
    },
    menuChannelAssignment: {
      upsert: jest.fn((args: any) => {
        upserts.push(args);
        return { __op: "upsert" };
      }),
      deleteMany: jest.fn((args: any) => {
        deleteManys.push(args);
        return { __op: "deleteMany", count: 1 };
      }),
    },
    // $transaction receives the built prisma "promises"; execute order is
    // irrelevant to these assertions — return placeholders.
    $transaction: jest.fn(async (ops: any[]) => ops.map(() => ({}))),
  } as any;

  const svc = new MenusService(
    prisma,
    { add: jest.fn() } as any, // menuSyncQueue
    {} as any, // plu
    {} as any, // menuAvailability
    {} as any, // menuAssignments (not used by update)
  );
  return { svc, prisma, upserts, deleteManys };
}

describe("MenusService.update — Phase BA assignment writes", () => {
  it("upserts one assignment per (location × channel) and deletes nothing", async () => {
    const { svc, upserts, deleteManys } = makeService();

    await svc.update(
      "M1",
      "T1",
      { publishedTo: ["ONLINE", "POS"], locationIds: ["L1", "L2"] } as any,
      "user-1",
    );

    // 2 locations × 2 channels = 4 upserts, keyed on the replace slot.
    expect(upserts).toHaveLength(4);
    const keys = upserts.map(
      (u) =>
        `${u.where.locationId_channel_brandId.locationId}:${u.where.locationId_channel_brandId.channel}:${u.where.locationId_channel_brandId.brandId}`,
    );
    expect(keys.sort()).toEqual(
      ["L1:ONLINE:B1", "L1:POS:B1", "L2:ONLINE:B1", "L2:POS:B1"].sort(),
    );
    for (const u of upserts) {
      expect(u.create.menuId).toBe("M1");
      expect(u.update.menuId).toBe("M1");
      expect(u.create.createdBy).toBe("user-1");
      expect(u.create.tenantId).toBe("T1");
    }

    // Publishing deletes NOTHING. An earlier version pruned this menu's rows
    // for every channel missing from the current publish, which meant
    // republishing to Online silently took the menu off the till.
    expect(deleteManys).toHaveLength(0);
  });

  it("removes a menu from one channel only via unpublishFromChannel", async () => {
    const { svc, deleteManys } = makeService();

    const res = await svc.unpublishFromChannel("M1", "T1", "L1", "POS");

    expect(res).toEqual({ removed: 1 });
    expect(deleteManys).toHaveLength(1);
    // Exactly one slot: this menu, this shop, this channel. Other channels,
    // other shops and other menus are untouched.
    expect(deleteManys[0].where).toEqual({
      menuId: "M1",
      locationId: "L1",
      channel: "POS",
    });
  });

  it("writes no assignments when locationIds is absent (legacy callers)", async () => {
    const { svc, upserts, deleteManys, prisma } = makeService();
    await svc.update("M1", "T1", { publishedTo: ["ONLINE"] } as any);
    expect(upserts).toHaveLength(0);
    expect(deleteManys).toHaveLength(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects locations outside the tenant", async () => {
    const { svc } = makeService();
    await expect(
      svc.update("M1", "T1", {
        publishedTo: ["ONLINE"],
        locationIds: ["L-evil"],
      } as any),
    ).rejects.toThrow("Location not found");
  });
});
