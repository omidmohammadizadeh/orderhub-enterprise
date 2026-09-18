import { JetStoreStatusService } from "../jet-store-status.service";

// "Push hours" did nothing visible on Just Eat.
//
// Just Eat opens a restaurant only where the service times AND the menu's
// availability both say open. The menu publish writes the shop's real hours
// into that availability, so once a menu is live the service times can only
// NARROW the hours. An operator who widened their hours and pressed "Push
// hours" got a 202, a green toast, and no change — until they happened to
// re-publish the menu.
//
// So pushing hours now also re-publishes the menu that is live on that Just
// Eat restaurant, which carries the new hours in its availability.

const CONN = {
  id: "conn-1",
  brandId: "brand-1",
  locationId: "location-1",
  externalStoreId: "POS-1",
  location: { timezone: "Europe/London" },
};

function make(opts: {
  metadata?: Record<string, unknown>;
  publishMenu?: jest.Mock;
  withMenuPublish?: boolean;
} = {}) {
  const calls: string[] = [];
  const request = jest.fn(async (_m: string, path: string) => {
    calls.push(`request ${path}`);
    return null;
  });
  const publishMenu =
    opts.publishMenu ??
    jest.fn(async () => {
      calls.push("publishMenu");
      return { ok: true, pending: true };
    });
  const prisma = {
    brandPlatformConnection: {
      findFirst: jest.fn(async () => ({
        ...CONN,
        metadata: opts.metadata ?? {
          restaurantReference: "440823",
          jetMenuPublish: { menuId: "menu-live", restaurantReference: "440823" },
        },
      })),
    },
    location: {
      findUnique: jest.fn(async () => ({
        openingHours: { monday: [{ from: "08:00", to: "23:00" }] },
      })),
    },
    brand: { findUnique: jest.fn(async () => ({ openingHours: null })) },
  } as any;
  const activity = { record: jest.fn() } as any;
  const service = new (JetStoreStatusService as any)(
    prisma,
    { request },
    activity,
    opts.withMenuPublish === false ? undefined : { publishMenu },
  ) as JetStoreStatusService;
  return { service, request, publishMenu, calls, activity };
}

describe("Push hours also re-publishes the live Just Eat menu", () => {
  it("re-publishes the menu last published to this restaurant, for this location", async () => {
    const { service, publishMenu } = make();
    await service.publishServiceTimes("t1", "conn-1");

    expect(publishMenu).toHaveBeenCalledTimes(1);
    expect(publishMenu).toHaveBeenCalledWith({
      tenantId: "t1",
      menuId: "menu-live",
      locationId: "location-1",
    });
  });

  it("pushes the service times first, then the menu", async () => {
    const { service, calls } = make();
    await service.publishServiceTimes("t1", "conn-1");
    expect(calls).toEqual([
      "request /restaurants/440823/servicetimes",
      "publishMenu",
    ]);
  });

  it("tells the operator the menu went out too", async () => {
    const { service } = make();
    const res: any = await service.publishServiceTimes("t1", "conn-1");
    expect(res.menuRepublished).toBe(true);
    expect(res.note).toMatch(/menu/i);
  });

  it("does not invent a menu when none has ever been published", async () => {
    // Guessing a menu could put the wrong brand's items on Just Eat.
    const { service, publishMenu } = make({
      metadata: { restaurantReference: "440823" },
    });
    const res: any = await service.publishServiceTimes("t1", "conn-1");

    expect(publishMenu).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.menuRepublished).toBe(false);
    expect(res.note).toMatch(/publish the menu/i);
  });

  it("keeps the hours push when the menu re-publish fails, and says so", async () => {
    const publishMenu = jest.fn(async () => {
      throw new Error("Menu not found");
    });
    const { service, activity } = make({ publishMenu });
    const res: any = await service.publishServiceTimes("t1", "conn-1");

    expect(res.ok).toBe(true);
    expect(res.menuRepublished).toBe(false);
    expect(res.note).toContain("Menu not found");
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "store.publish_hours_menu",
        status: "ERROR",
      }),
    );
  });
});
