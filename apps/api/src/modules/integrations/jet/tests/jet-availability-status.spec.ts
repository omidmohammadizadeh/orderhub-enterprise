import { JetItemAvailabilityService } from "../jet-item-availability.service";
import {
  JetStoreStatusService,
  toJetOpeningTimes,
  toJetLocalTimestamp,
} from "../jet-store-status.service";
import { buildJetMenus } from "../jet-menu.transformer";

// JE-4 (86) and JE-5 (store status / service times).
//
// The single most important assertion in this file is the one tying the 86's
// item references to what the publish transformer actually emitted. HubRise's
// 86 silently no-opped for weeks because those two rules drifted apart: JET
// accepts the request, changes nothing, and there is no error anywhere.

const CONN = {
  brandId: "brand-1",
  locationId: "location-1",
  externalStoreId: "POS-1",
  metadata: { restaurantReference: "8282340", country: "GB" },
};

function makeAvailability(
  opts: { assignments?: any[]; menu?: any; connection?: any; item?: any; request?: jest.Mock } = {},
) {
  const request = opts.request ?? jest.fn().mockResolvedValue(null);
  const prisma = {
    menuItem: {
      findUnique: jest.fn(async () =>
        opts.item === undefined
          ? {
              id: "item-1",
              name: "Cheeseburger",
              plu: "B1",
              brandId: "brand-1",
              hasMultipleSkus: false,
              productSkus: null,
            }
          : opts.item,
      ),
    },
    menuChannelAssignment: { findMany: jest.fn(async () => opts.assignments ?? []) },
    menu: { findFirst: jest.fn(async () => opts.menu ?? null) },
    brandPlatformConnection: {
      findFirst: jest.fn(async () =>
        opts.connection === undefined ? CONN : opts.connection,
      ),
    },
  } as any;
  const activity = { record: jest.fn() } as any;
  return {
    service: new JetItemAvailabilityService(prisma, { request } as any, activity),
    request,
    prisma,
    activity,
  };
}

describe("JetItemAvailabilityService.referencesFor", () => {
  it("uses the PLU, falling back to the row id", () => {
    expect(
      JetItemAvailabilityService.referencesFor({ id: "item-1", plu: "B1" }),
    ).toEqual(["B1"]);
    expect(
      JetItemAvailabilityService.referencesFor({ id: "item-1", plu: "  " }),
    ).toEqual(["item-1"]);
  });

  it("includes every size, because 86ing a pizza must take all sizes off", () => {
    const refs = JetItemAvailabilityService.referencesFor({
      id: "pizza",
      plu: "PZ",
      hasMultipleSkus: true,
      productSkus: [
        { name: "10 inch", plu: "PZ10" },
        { name: "12 inch", plu: "" },
      ],
    });
    expect(refs).toEqual(["PZ", "PZ10", "pizza__s1"]);
  });

  it("de-duplicates a PLU shared by a product and one of its sizes", () => {
    const refs = JetItemAvailabilityService.referencesFor({
      id: "x",
      plu: "SAME",
      hasMultipleSkus: true,
      productSkus: [{ name: "only", plu: "SAME" }],
    });
    expect(refs).toEqual(["SAME"]);
  });

  it("MATCHES the references the publish transformer emitted", () => {
    // The load-bearing assertion. If these two rules ever drift, JET accepts
    // the 86 and silently changes nothing — exactly how the HubRise version
    // hid for weeks. Build a real menu payload and compare PLU for PLU.
    const item = {
      id: "pizza",
      plu: "PZ",
      hasMultipleSkus: true,
      productSkus: [
        { name: "10 inch", plu: "PZ10" },
        { name: "12 inch", plu: "" },
      ],
    };
    const { menus } = buildJetMenus({
      menuName: "M",
      menuReference: "m1",
      serviceTypes: ["DELIVERY"],
      categories: [
        {
          id: "c",
          name: "Pizza",
          description: "",
          products: [
            {
              id: item.id,
              name: "Margherita",
              price: 8,
              plu: item.plu,
              groups: [],
              portions: [
                { id: "pizza__s0", name: "10 inch", price: 8, plu: "PZ10", groups: [] },
                { id: "pizza__s1", name: "12 inch", price: 10, plu: "", groups: [] },
              ],
            },
          ],
        },
      ],
    });
    const published = menus[0]!.categories[0]!.items[0]!;
    const publishedRefs = [
      published.plu,
      ...published.portions.map((p: any) => p.plu),
    ];
    expect(JetItemAvailabilityService.referencesFor(item).sort()).toEqual(
      publishedRefs.sort(),
    );
  });
});

describe("JetItemAvailabilityService.pushItemAvailability", () => {
  const assignments = [{ brandId: "brand-1", locationId: "location-1" }];

  it("posts UNAVAILABLE against the restaurant reference", async () => {
    const { service, request } = makeAvailability({ assignments });
    await service.pushItemAvailability({
      tenantId: "t1",
      itemId: "item-1",
      available: false,
    });

    const [method, path, opts] = request.mock.calls[0]!;
    expect(method).toBe("POST");
    expect(path).toBe("/item-availability");
    expect(opts.keyType).toBe("menu");
    expect(opts.body.event).toBe("UNAVAILABLE");
    expect(opts.body.restaurant).toBe("8282340");
    expect(opts.body.itemReferences).toEqual(["B1"]);
  });

  it("sends nextAvailableAt for a timed snooze — JET restores it itself", async () => {
    // The advantage over Deliveroo, where an expiring snooze never pushes
    // back and the item stays off until someone notices.
    const until = new Date(Date.now() + 3_600_000);
    const { service, request } = makeAvailability({ assignments });
    await service.pushItemAvailability({
      tenantId: "t1",
      itemId: "item-1",
      available: false,
      until,
    });
    expect(request.mock.calls[0]![2].body.nextAvailableAt).toBe(until.toISOString());
  });

  it("drops an expiry that is already in the past", async () => {
    // nextAvailableAt must be in the future; a past one is a 400 and would
    // drop the whole update. A snooze that has already expired is a restore.
    const { service, request } = makeAvailability({ assignments });
    await service.pushItemAvailability({
      tenantId: "t1",
      itemId: "item-1",
      available: false,
      until: new Date(Date.now() - 1000),
    });
    expect("nextAvailableAt" in request.mock.calls[0]![2].body).toBe(false);
  });

  it("never sends nextAvailableAt on a restore", async () => {
    const { service, request } = makeAvailability({ assignments });
    await service.pushItemAvailability({
      tenantId: "t1",
      itemId: "item-1",
      available: true,
      until: new Date(Date.now() + 3_600_000),
    });
    expect(request.mock.calls[0]![2].body.event).toBe("AVAILABLE");
    expect("nextAvailableAt" in request.mock.calls[0]![2].body).toBe(false);
  });

  it("falls back to a published menu when no assignment row exists", async () => {
    const { service, request } = makeAvailability({
      assignments: [],
      menu: { brandId: "brand-1", locationId: "location-1" },
    });
    await service.pushItemAvailability({
      tenantId: "t1",
      itemId: "item-1",
      available: false,
    });
    expect(request).toHaveBeenCalled();
  });

  it("does nothing when the item is on no Just Eat menu", async () => {
    const { service, request } = makeAvailability({ assignments: [], menu: null });
    await service.pushItemAvailability({
      tenantId: "t1",
      itemId: "item-1",
      available: false,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("pushes once per restaurant even when several menus resolve to it", async () => {
    const { service, request } = makeAvailability({
      assignments: [
        { brandId: "brand-1", locationId: "location-1" },
        { brandId: "brand-1", locationId: "location-1" },
      ],
    });
    await service.pushItemAvailability({
      tenantId: "t1",
      itemId: "item-1",
      available: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("records an ERROR rather than throwing into the 86 board", async () => {
    // The push is fire-and-forget from the inventory service; a JET outage
    // must not make the local 86 look like it failed.
    const request = jest.fn().mockRejectedValue(new Error("503"));
    const { service, activity } = makeAvailability({ assignments, request });
    await expect(
      service.pushItemAvailability({
        tenantId: "t1",
        itemId: "item-1",
        available: false,
      }),
    ).resolves.toBeUndefined();
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ERROR" }),
    );
  });
});

// ── JE-5 ───────────────────────────────────────────────────────────────

function makeStatus(
  opts: { connection?: any; request?: jest.Mock; openingHours?: any } = {},
) {
  const request = opts.request ?? jest.fn().mockResolvedValue(null);
  const prisma = {
    brandPlatformConnection: {
      findFirst: jest.fn(async () =>
        opts.connection === undefined
          ? { ...CONN, id: "conn-1", location: { timezone: "Europe/London" } }
          : opts.connection,
      ),
      findMany: jest.fn(async () => [{ id: "conn-1" }]),
    },
    location: {
      findUnique: jest.fn(async () => ({
        openingHours:
          "openingHours" in opts
            ? opts.openingHours
            : { monday: [{ from: "09:00", to: "22:00" }] },
      })),
    },
    brand: { findUnique: jest.fn(async () => ({ openingHours: null })) },
  } as any;
  const activity = { record: jest.fn() } as any;
  return {
    service: new JetStoreStatusService(prisma, { request } as any, activity),
    request,
    activity,
  };
}

describe("JetStoreStatusService.setStoreOnline", () => {
  it("PUTs /online with no body", async () => {
    const { service, request } = makeStatus();
    await service.setStoreOnline("t1", "conn-1", true);
    const [method, path, opts] = request.mock.calls[0]!;
    expect(method).toBe("PUT");
    expect(path).toBe("/restaurants/8282340/online");
    expect(opts.body).toBeUndefined();
  });

  it("PUTs /offline with a LOCAL timestamp, no timezone suffix", async () => {
    // JET reads the value as restaurant-local. A UTC-suffixed timestamp would
    // be read as local and shift the return time by the offset — a whole hour
    // of a closed shop during British Summer Time.
    const { service, request } = makeStatus();
    await service.setStoreOnline("t1", "conn-1", false, {
      onlineAt: new Date("2026-08-20T11:30:00Z"),
    });
    const body = request.mock.calls[0]![2].body;
    expect(request.mock.calls[0]![1]).toBe("/restaurants/8282340/offline");
    expect(body.onlineAt).toBe("2026-08-20T12:30:00");
    expect(body.onlineAt).not.toMatch(/Z$/);
  });

  it("goes offline indefinitely when no return time is given, and says so", async () => {
    const { service, request, activity } = makeStatus();
    await service.setStoreOnline("t1", "conn-1", false);
    expect(request.mock.calls[0]![2].body).toEqual({});
    expect(activity.record.mock.calls[0]![0].message).toContain("indefinitely");
  });

  it("refuses a connection with no restaurant reference", async () => {
    const { service } = makeStatus({
      connection: {
        id: "conn-1",
        brandId: "b",
        locationId: "l",
        externalStoreId: null,
        metadata: {},
        location: { timezone: "Europe/London" },
      },
    });
    await expect(service.setStoreOnline("t1", "conn-1", true)).rejects.toThrow(
      /restaurant reference/i,
    );
  });
});

describe("JetStoreStatusService.publishServiceTimes", () => {
  it("sends Delivery and Collection with the location timezone", async () => {
    const { service, request } = makeStatus();
    await service.publishServiceTimes("t1", "conn-1");
    const [method, path, opts] = request.mock.calls[0]!;
    expect(method).toBe("PUT");
    expect(path).toBe("/restaurants/8282340/servicetimes");
    expect(opts.body.timezone).toBe("Europe/London");
    expect(opts.body.serviceTimes.map((s: any) => s.serviceType)).toEqual([
      "Delivery",
      "Collection",
    ]);
    expect(opts.body.serviceTimes[0]!.openingTimes.monday).toEqual([
      { openingTime: "09:00", closingTime: "22:00" },
    ]);
  });

  it("refuses to publish an empty set rather than closing the shop", async () => {
    // An empty service-times payload reads as "closed every day" and would
    // take the restaurant off Just Eat entirely.
    const { service, request } = makeStatus({ openingHours: null });
    await expect(service.publishServiceTimes("t1", "conn-1")).rejects.toThrow(
      /would close the restaurant/i,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("returns the intersection caveat, because widening here often does nothing", async () => {
    const { service } = makeStatus();
    const res = await service.publishServiceTimes("t1", "conn-1");
    expect((res as any).note).toContain("intersection");
  });
});

describe("JetStoreStatusService.reconcile", () => {
  it("passes the pause's own end time so JET restores the shop itself", async () => {
    const until = new Date("2026-08-20T18:00:00Z");
    const { service, request } = makeStatus();
    await service.reconcile({
      tenantId: "t1",
      brandId: "brand-1",
      locationId: "location-1",
      paused: true,
      until,
    });
    expect(request.mock.calls[0]![1]).toContain("/offline");
    expect(request.mock.calls[0]![2].body.onlineAt).toBe("2026-08-20T19:00:00");
  });

  it("brings the restaurant back when the pause is lifted", async () => {
    const { service, request } = makeStatus();
    await service.reconcile({ tenantId: "t1", paused: false });
    expect(request.mock.calls[0]![1]).toContain("/online");
  });

  it("keeps going when one restaurant fails", async () => {
    // One unreachable restaurant must not stop an operator pausing the rest
    // of their estate.
    const request = jest.fn().mockRejectedValue(new Error("timeout"));
    const { service } = makeStatus({ request });
    await expect(
      service.reconcile({ tenantId: "t1", paused: true }),
    ).resolves.toBeUndefined();
  });
});

describe("toJetOpeningTimes", () => {
  it("omits closed days rather than sending empty arrays", () => {
    // Unlike the menu availability schema, service times have no
    // all-days-required rule, and [] is ambiguous between closed and unset.
    const t = toJetOpeningTimes({ monday: [{ from: "09:00", to: "17:00" }] });
    expect(t.monday).toEqual([{ openingTime: "09:00", closingTime: "17:00" }]);
    expect("sunday" in t).toBe(false);
  });

  it("reads all three stored hour shapes", () => {
    expect(
      toJetOpeningTimes({ tuesday: { enabled: true, slots: [{ from: "10:00", to: "14:00" }] } })
        .tuesday,
    ).toEqual([{ openingTime: "10:00", closingTime: "14:00" }]);
    expect(
      toJetOpeningTimes([{ day: "friday", open: "11:00", close: "23:00" }]).friday,
    ).toEqual([{ openingTime: "11:00", closingTime: "23:00" }]);
    expect(toJetOpeningTimes({ wednesday: { enabled: false, slots: [] } }).wednesday)
      .toBeUndefined();
  });

  it("keeps split shifts", () => {
    const t = toJetOpeningTimes({
      monday: [
        { from: "10:00", to: "14:00" },
        { from: "17:00", to: "23:00" },
      ],
    });
    expect(t.monday).toHaveLength(2);
  });
});

describe("toJetLocalTimestamp", () => {
  it("renders restaurant-local time with no offset marker", () => {
    // 11:30 UTC in August is 12:30 in London.
    expect(
      toJetLocalTimestamp(new Date("2026-08-20T11:30:00Z"), "Europe/London"),
    ).toBe("2026-08-20T12:30:00");
  });

  it("handles a winter date, when London is UTC", () => {
    expect(
      toJetLocalTimestamp(new Date("2026-01-20T11:30:00Z"), "Europe/London"),
    ).toBe("2026-01-20T11:30:00");
  });

  it("renders midnight as 00, not 24", () => {
    expect(
      toJetLocalTimestamp(new Date("2026-01-20T00:00:00Z"), "Europe/London"),
    ).toBe("2026-01-20T00:00:00");
  });
});
