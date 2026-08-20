import { JetMenuPublishService } from "../jet-menu-publish.service";

// Publish wiring. The behaviour worth pinning is the one that is easy to get
// wrong and expensive to discover: JET's 202 is NOT a success. The spec says a
// structurally valid menu can still fail to publish downstream, so the real
// outcome only arrives on the callback — which also means a publish that never
// sends a callback_url can never be measured against the 97% menu-injection
// target.

const CONN = {
  id: "conn-1",
  locationId: "location-1",
  externalStoreId: "POS-1",
  metadata: { restaurantReference: "8282340", country: "GB" },
};

const MENU = {
  id: "menu-1",
  name: "Summer Menu",
  description: null,
  brandId: "brand-1",
  locationId: "location-1",
};

function makeService(
  opts: {
    connection?: any;
    menu?: any;
    categories?: any[];
    request?: jest.Mock;
    openingHours?: any;
    connectionForCallback?: any;
  } = {},
) {
  const request = opts.request ?? jest.fn().mockResolvedValue(null);
  const connectionUpdate = jest.fn().mockResolvedValue({});

  const prisma = {
    menu: {
      findFirst: jest.fn(async () =>
        opts.menu === undefined ? MENU : opts.menu,
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    brandPlatformConnection: {
      findFirst: jest.fn(async () =>
        opts.connection === undefined ? CONN : opts.connection,
      ),
      findUnique: jest.fn(async () => ({ metadata: {} })),
      update: connectionUpdate,
    },
    menuCategory: {
      findMany: jest.fn(async () =>
        opts.categories ?? [
          {
            id: "cat-1",
            name: "Burgers",
            description: "",
            items: [
              {
                isVisible: true,
                priceOverride: null,
                item: {
                  id: "item-1",
                  name: "Cheeseburger",
                  description: "",
                  basePrice: 10,
                  plu: "B1",
                  imageUrl: null,
                  hasMultipleSkus: false,
                },
              },
            ],
          },
        ],
      ),
    },
    modifierGroupOnItem: { findMany: jest.fn(async () => []) },
    modifierGroup: { findMany: jest.fn(async () => []) },
    location: {
      findUnique: jest.fn(async () => ({
        // `in` rather than ?? so a test can assert the no-hours-at-all case.
        openingHours:
          "openingHours" in opts
            ? opts.openingHours
            : { monday: [{ from: "09:00", to: "22:00" }] },
      })),
    },
    brand: { findUnique: jest.fn(async () => ({ openingHours: null })) },
  } as any;

  const config = { get: () => "https://api.example.com" } as any;
  const client = { request } as any;
  const variantResolver = { forBrandChannel: jest.fn(async () => null) } as any;
  const activity = { record: jest.fn() } as any;

  return {
    service: new JetMenuPublishService(
      prisma,
      client,
      config,
      variantResolver,
      activity,
    ),
    prisma,
    request,
    activity,
    connectionUpdate,
  };
}

describe("JetMenuPublishService.publishMenu", () => {
  it("posts to /menus with the menu API key and the restaurant reference", async () => {
    const { service, request } = makeService();
    await service.publishMenu({ tenantId: "t1", menuId: "menu-1" });

    const [method, path, opts] = request.mock.calls[0]!;
    expect(method).toBe("POST");
    expect(path).toBe("/menus");
    // Menu key, not the order key — they are different keys and the wrong
    // one 403s.
    expect(opts.keyType).toBe("menu");
    expect(opts.body.restaurants).toEqual(["8282340"]);
  });

  it("publishes against JET's restaurant reference, not the POS location id", async () => {
    // Orders arrive stamped with posLocationId; menus are addressed by the
    // reference JET issued. Confusing the two publishes to nothing.
    const { service, request } = makeService();
    await service.publishMenu({ tenantId: "t1", menuId: "menu-1" });
    expect(request.mock.calls[0]![2].body.restaurants).not.toContain("POS-1");
  });

  it("falls back to the POS location id when no reference was entered", async () => {
    const { service, request } = makeService({
      connection: { ...CONN, metadata: {} },
    });
    await service.publishMenu({ tenantId: "t1", menuId: "menu-1" });
    expect(request.mock.calls[0]![2].body.restaurants).toEqual(["POS-1"]);
  });

  it("ALWAYS sends a callback_url", async () => {
    // Without it there is no way to learn whether the menu actually published,
    // and no way to measure the 97% menu-injection target at all.
    const { service, request } = makeService();
    await service.publishMenu({ tenantId: "t1", menuId: "menu-1" });
    expect(request.mock.calls[0]![2].body.callback_url).toContain(
      "/integrations/jet/menu-callback",
    );
  });

  it("reports the publish as PENDING, never as succeeded", async () => {
    // JET's 202 means "the JSON parsed". Claiming success here is how an
    // operator believes a menu is live when the partner rejected it.
    const { service, activity } = makeService();
    const result = await service.publishMenu({ tenantId: "t1", menuId: "menu-1" });

    expect(result.pending).toBe(true);
    const entry = activity.record.mock.calls.at(-1)![0];
    expect(entry.status).toBe("INFO");
    expect(entry.status).not.toBe("SUCCESS");
    expect(entry.message).toContain("awaiting");
  });

  it("takes availability from the location's opening hours", async () => {
    const { service, request } = makeService();
    await service.publishMenu({ tenantId: "t1", menuId: "menu-1" });
    const menu = request.mock.calls[0]![2].body.menus[0]!;
    expect(menu.availability.monday).toEqual(["09:00 - 22:00"]);
  });

  it("falls back to all-day when we hold no hours at all", async () => {
    // In UK/IE/ES/IT/AU the menu availability also sets opening hours, so a
    // too-narrow guess would quietly change when the shop appears open.
    // All-day is the direction the service-times endpoint can still narrow.
    const { service, request } = makeService({ openingHours: null });
    await service.publishMenu({ tenantId: "t1", menuId: "menu-1" });
    expect(
      request.mock.calls[0]![2].body.menus[0]!.availability.monday,
    ).toEqual(["00:00 - 23:59"]);
  });

  it("refuses when the brand has no Just Eat connection", async () => {
    const { service, request } = makeService({ connection: null });
    await expect(
      service.publishMenu({ tenantId: "t1", menuId: "menu-1" }),
    ).rejects.toThrow(/isn't connected/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses when the menu has nothing to publish", async () => {
    const { service } = makeService({ categories: [] });
    await expect(
      service.publishMenu({ tenantId: "t1", menuId: "menu-1" }),
    ).rejects.toThrow(/no categories/i);
  });

  it("names the filter that emptied the menu", async () => {
    // JET's own rejection for an empty menu says nothing about which filter
    // did it, leaving the operator to guess.
    const { service } = makeService({
      categories: [
        {
          id: "c",
          name: "C",
          description: "",
          items: [{ isVisible: false, item: { id: "i", name: "x" } }],
        },
      ],
    });
    await expect(
      service.publishMenu({ tenantId: "t1", menuId: "menu-1" }),
    ).rejects.toThrow(/hidden or point at deleted/i);
  });

  it("records an ERROR when the call itself fails", async () => {
    const request = jest.fn().mockRejectedValue(new Error("500 upstream"));
    const { service, activity } = makeService({ request });
    await expect(
      service.publishMenu({ tenantId: "t1", menuId: "menu-1" }),
    ).rejects.toThrow();
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ERROR" }),
    );
  });
});

describe("JetMenuPublishService.handleMenuCallback", () => {
  it("records a successful ingest as the real outcome", async () => {
    const { service, activity } = makeService({
      connection: {
        id: "conn-1",
        tenantId: "t1",
        brandId: "brand-1",
        locationId: "location-1",
        metadata: { jetMenuPublish: { menuId: "menu-1" } },
      },
    });
    const result = await service.handleMenuCallback({
      restaurant: "8282340",
      ingestion_succeeded: true,
    });

    expect(result.handled).toBe(true);
    const entry = activity.record.mock.calls.at(-1)![0];
    expect(entry.status).toBe("SUCCESS");
    expect(entry.action).toBe("menu.publish_result");
  });

  it("surfaces the rejection reason when JET refuses the menu", async () => {
    const { service, activity } = makeService({
      connection: {
        id: "conn-1",
        tenantId: "t1",
        brandId: "brand-1",
        locationId: "location-1",
        metadata: {},
      },
    });
    await service.handleMenuCallback({
      restaurant: "8282340",
      ingestion_succeeded: false,
      error: { code: "INVALID_FORMAT", message: "item 3 has no plu" },
    });

    const entry = activity.record.mock.calls.at(-1)![0];
    expect(entry.status).toBe("ERROR");
    expect(entry.message).toContain("item 3 has no plu");
  });

  it("treats a missing ingestion_succeeded as a failure, not a success", async () => {
    // `undefined !== true`. Defaulting an absent flag to success would report
    // a menu as live on the strength of a field that never arrived.
    const { service, activity } = makeService({
      connection: {
        id: "conn-1",
        tenantId: "t1",
        brandId: "brand-1",
        locationId: "location-1",
        metadata: {},
      },
    });
    await service.handleMenuCallback({ restaurant: "8282340" });
    expect(activity.record.mock.calls.at(-1)![0].status).toBe("ERROR");
  });

  it("stores the result on the connection for the health probe", async () => {
    const { service, connectionUpdate } = makeService({
      connection: {
        id: "conn-1",
        tenantId: "t1",
        brandId: "brand-1",
        locationId: "location-1",
        metadata: {},
      },
    });
    await service.handleMenuCallback({
      restaurant: "8282340",
      ingestion_succeeded: false,
      error: { code: "CONNECTION_FAILED", message: "partner unreachable" },
    });
    const stored = connectionUpdate.mock.calls[0]![0].data.metadata.jetMenuPublish;
    expect(stored).toMatchObject({
      lastResultSucceeded: false,
      lastErrorCode: "CONNECTION_FAILED",
    });
  });

  it("ignores a callback for a restaurant that is not ours", async () => {
    const { service } = makeService({ connection: null });
    await expect(
      service.handleMenuCallback({ restaurant: "someone-else", ingestion_succeeded: true }),
    ).resolves.toMatchObject({ handled: false });
  });

  it("ignores a callback with no restaurant", async () => {
    const { service } = makeService();
    await expect(service.handleMenuCallback({})).resolves.toMatchObject({
      handled: false,
      reason: "no_restaurant",
    });
  });
});
