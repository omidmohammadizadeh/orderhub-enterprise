import { MenuAvailabilityService } from "../menu-availability.service";

// A DELIVEROO 86 must push the full unavailable set to Deliveroo's
// item_unavailabilities replace-all endpoint, expanding multi-SKU products to
// their per-size item ids (mirroring what the menu publish emitted).

function setup(opts: {
  conn?: any;
  menu?: any;
  categories: any[];
  snoozedRows: any[]; // menuItemChannelAvailability rows for DELIVEROO
  items: any[]; // menuItem rows for the snoozed ids
}) {
  const requests: any[] = [];
  const prisma = {
    brandPlatformConnection: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          "conn" in opts
            ? opts.conn
            : { externalStoreId: "site-1", externalBrandId: "brand-gb1" },
        ),
    },
    menu: {
      findFirst: jest
        .fn()
        .mockResolvedValue("menu" in opts ? opts.menu : { id: "menuA" }),
    },
    menuCategory: {
      findMany: jest.fn().mockResolvedValue(opts.categories),
    },
    menuItemChannelAvailability: {
      findMany: jest.fn().mockResolvedValue(opts.snoozedRows),
    },
    menuItem: {
      findMany: jest.fn().mockResolvedValue(opts.items),
    },
  } as any;
  const deliverooClient = {
    request: jest.fn((method: string, path: string, body: any) => {
      requests.push({ method, path, body });
      return Promise.resolve({});
    }),
  } as any;
  const svc = new MenuAvailabilityService(prisma, {} as any, deliverooClient);
  return { svc, requests };
}

describe("MenuAvailabilityService → Deliveroo item_unavailabilities", () => {
  it("PUTs the full unavailable set, expanding multi-SKU items per size", async () => {
    const { svc, requests } = setup({
      categories: [{ items: [{ itemId: "single1" }, { itemId: "pizza1" }] }],
      snoozedRows: [{ itemId: "single1" }, { itemId: "pizza1" }],
      items: [
        { id: "single1", hasMultipleSkus: false, productSkus: [] },
        {
          id: "pizza1",
          hasMultipleSkus: true,
          productSkus: [{ name: "10 inch" }, { name: "12 inch" }],
        },
      ],
    });

    await (svc as any).syncDeliverooAvailability("b1", "t1");

    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.method).toBe("PUT");
    expect(req.path).toBe(
      "/menu/v1/brands/brand-gb1/menus/menuA/item_unavailabilities/site-1",
    );
    expect(req.body.hidden_ids).toEqual([]);
    expect(req.body.unavailable_ids.sort()).toEqual(
      ["pizza1__s0", "pizza1__s1", "single1"].sort(),
    );
  });

  it("sends an empty set (clears all) when nothing is snoozed", async () => {
    const { svc, requests } = setup({
      categories: [{ items: [{ itemId: "single1" }] }],
      snoozedRows: [],
      items: [],
    });
    await (svc as any).syncDeliverooAvailability("b1", "t1");
    expect(requests[0].body.unavailable_ids).toEqual([]);
  });

  it("no-ops when the brand isn't connected to Deliveroo", async () => {
    const { svc, requests } = setup({
      conn: null,
      categories: [],
      snoozedRows: [],
      items: [],
    });
    await (svc as any).syncDeliverooAvailability("b1", "t1");
    expect(requests).toHaveLength(0);
  });
});
