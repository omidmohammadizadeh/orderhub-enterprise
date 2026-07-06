import { MenuAssignmentsService } from "../menu-assignments.service";

// Phase BA — assignment resolution rules. Rows are the serving truth, but a
// dead menu (deleted / inactive / not-published when required) must fall
// through to the caller's legacy cascade (resolver returns null), and brand
// pins/preferences must pick the right slot in multi-brand kitchens.

function makeService(rows: any[]) {
  const prisma = {
    menuChannelAssignment: {
      findMany: jest.fn(async (args: any) => {
        let out = rows.filter(
          (r) =>
            r.locationId === args.where.locationId &&
            r.channel === args.where.channel &&
            (!args.where.brandId || r.brandId === args.where.brandId),
        );
        out = out.sort(
          (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime(),
        );
        return out;
      }),
    },
  } as any;
  return new MenuAssignmentsService(prisma);
}

const live = { deletedAt: null, isActive: true, status: "PUBLISHED" };
const at = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

describe("MenuAssignmentsService.resolveAssignedMenuId", () => {
  it("returns the assigned menu for (location, channel)", async () => {
    const svc = makeService([
      {
        menuId: "M1",
        locationId: "L1",
        channel: "ONLINE",
        brandId: "B1",
        publishedAt: at(1),
        menu: { id: "M1", ...live },
      },
    ]);
    await expect(
      svc.resolveAssignedMenuId({ locationId: "L1", channel: "ONLINE" }),
    ).resolves.toBe("M1");
  });

  it("returns null (→ legacy cascade) when nothing is assigned", async () => {
    const svc = makeService([]);
    await expect(
      svc.resolveAssignedMenuId({ locationId: "L1", channel: "ONLINE" }),
    ).resolves.toBeNull();
  });

  it("falls through when the assigned menu is inactive (auto-schedule) or deleted", async () => {
    const svc = makeService([
      {
        menuId: "M1",
        locationId: "L1",
        channel: "ONLINE",
        brandId: "B1",
        publishedAt: at(1),
        menu: { id: "M1", ...live, isActive: false },
      },
      {
        menuId: "M2",
        locationId: "L1",
        channel: "POS",
        brandId: "B1",
        publishedAt: at(1),
        menu: { id: "M2", ...live, deletedAt: new Date() },
      },
    ]);
    await expect(
      svc.resolveAssignedMenuId({ locationId: "L1", channel: "ONLINE" }),
    ).resolves.toBeNull();
    await expect(
      svc.resolveAssignedMenuId({ locationId: "L1", channel: "POS" }),
    ).resolves.toBeNull();
  });

  it("requirePublished rejects DRAFT menus", async () => {
    const svc = makeService([
      {
        menuId: "M1",
        locationId: "L1",
        channel: "POS",
        brandId: "B1",
        publishedAt: at(1),
        menu: { id: "M1", ...live, status: "DRAFT" },
      },
    ]);
    await expect(
      svc.resolveAssignedMenuId({
        locationId: "L1",
        channel: "POS",
        requirePublished: true,
      }),
    ).resolves.toBeNull();
    await expect(
      svc.resolveAssignedMenuId({ locationId: "L1", channel: "POS" }),
    ).resolves.toBe("M1");
  });

  it("brandId pin only matches that brand's slot", async () => {
    const rows = [
      {
        menuId: "M-pizza",
        locationId: "L1",
        channel: "ONLINE",
        brandId: "B-pizza",
        publishedAt: at(5),
        menu: { id: "M-pizza", ...live },
      },
      {
        menuId: "M-burger",
        locationId: "L1",
        channel: "ONLINE",
        brandId: "B-burger",
        publishedAt: at(1),
        menu: { id: "M-burger", ...live },
      },
    ];
    const svc = makeService(rows);
    await expect(
      svc.resolveAssignedMenuId({
        locationId: "L1",
        channel: "ONLINE",
        brandId: "B-pizza",
      }),
    ).resolves.toBe("M-pizza");
    await expect(
      svc.resolveAssignedMenuId({
        locationId: "L1",
        channel: "ONLINE",
        brandId: "B-unknown",
      }),
    ).resolves.toBeNull();
  });

  it("preferBrandId beats latest-publish, but latest wins without it", async () => {
    const rows = [
      {
        menuId: "M-pizza",
        locationId: "L1",
        channel: "ONLINE",
        brandId: "B-pizza",
        publishedAt: at(5),
        menu: { id: "M-pizza", ...live },
      },
      {
        menuId: "M-burger",
        locationId: "L1",
        channel: "ONLINE",
        brandId: "B-burger",
        publishedAt: at(1),
        menu: { id: "M-burger", ...live },
      },
    ];
    const svc = makeService(rows);
    await expect(
      svc.resolveAssignedMenuId({
        locationId: "L1",
        channel: "ONLINE",
        preferBrandId: "B-pizza",
      }),
    ).resolves.toBe("M-pizza");
    await expect(
      svc.resolveAssignedMenuId({ locationId: "L1", channel: "ONLINE" }),
    ).resolves.toBe("M-burger");
  });
});
