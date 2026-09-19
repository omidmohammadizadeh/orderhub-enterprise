import { GlovoStoreStatusService, glovoUntil, GLOVO_OPEN_ENDED_CLOSE_DAYS } from "../glovo-store-status.service";
import { GlovoItemAvailabilityService } from "../glovo-item-availability.service";
import { GlovoConnectionService, defaultGlovoStoreId } from "../glovo-connection.service";
import { GlovoClientService, glovoTokenMatches } from "../glovo-client.service";
import { GlovoWebhookController } from "../glovo-webhook.controller";
import { GlovoController } from "../glovo.controller";
import { PATH_METADATA } from "@nestjs/common/constants";

// Store closing, 86s, connection rules, transport — and the URLs we give Glovo.

const CONN = { id: "conn-1", tenantId: "t1", brandId: "b1", locationId: "l1", externalStoreId: "OH-1" };

describe("GlovoStoreStatusService", () => {
  const make = () => {
    const prisma: any = {
      brandPlatformConnection: {
        findFirst: jest.fn(async ({ where }: any) => (where.tenantId === "t1" ? CONN : null)),
        findMany: jest.fn(async () => [CONN]),
      },
    };
    const client: any = { configured: true, request: jest.fn(async () => null) };
    return { svc: new GlovoStoreStatusService(prisma, client, { record: jest.fn() } as any), client };
  };

  it("formats `until` as ISO with an explicit offset and no milliseconds", () => {
    expect(glovoUntil(new Date("2026-09-19T10:00:00.123Z"))).toBe("2026-09-19T10:00:00+00:00");
  });

  it("a timed pause closes until exactly that time", async () => {
    const { svc, client } = make();
    const until = new Date(Date.now() + 3600_000);
    await svc.setOpen("t1", "conn-1", false, { until });
    expect(client.request).toHaveBeenCalledWith(
      "PUT",
      "/webhook/stores/OH-1/closing",
      expect.objectContaining({ body: { until: glovoUntil(until) } }),
    );
  });

  it("an open-ended pause still sends an end time (Glovo requires one), capped", async () => {
    const { svc, client } = make();
    const res = await svc.setOpen("t1", "conn-1", false);
    expect(res.openEnded).toBe(true);
    const sent = Date.parse(client.request.mock.calls[0][2].body.until);
    const days = (sent - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(GLOVO_OPEN_ENDED_CLOSE_DAYS - 0.01);
    expect(days).toBeLessThan(GLOVO_OPEN_ENDED_CLOSE_DAYS + 0.01);
  });

  it("resume DELETEs the closing", async () => {
    const { svc, client } = make();
    await svc.setOpen("t1", "conn-1", true);
    expect(client.request).toHaveBeenCalledWith("DELETE", "/webhook/stores/OH-1/closing", expect.anything());
  });

  it("another tenant's connection id is not found", async () => {
    const { svc, client } = make();
    await expect(svc.setOpen("t2", "conn-1", true)).rejects.toThrow(/not found/);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("refuses to publish hours — the Glovo API has no endpoint for them", async () => {
    const { svc } = make();
    await expect(svc.publishHours()).rejects.toThrow(/Partner Webapp/);
  });
});

describe("GlovoItemAvailabilityService", () => {
  const make = (opts: { stillSnoozed?: boolean; itemTenant?: string } = {}) => {
    const prisma: any = {
      menuItem: {
        findUnique: jest.fn(async () => ({ id: "i1", name: "Burger", brandId: "b1", hasMultipleSkus: false })),
      },
      brand: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.tenantId === (opts.itemTenant ?? "t1") ? { id: "b1" } : null,
        ),
        findMany: jest.fn(async () => [{ id: "b1", tenantId: "t1" }]),
      },
      brandPlatformConnection: {
        findMany: jest.fn(async () => [{ ...CONN, metadata: { glovoMenuPublish: { menuId: "m1" } } }]),
      },
      menuCategory: { findFirst: jest.fn(async () => ({ id: "c1" })) },
      menuItemChannelAvailability: {
        findFirst: jest.fn(async () => (opts.stillSnoozed ? { id: "s1" } : null)),
        findMany: jest.fn(async () => [{ itemId: "i1", locationId: "l1", item: { brandId: "b1" } }]),
      },
    };
    const client: any = { configured: true, request: jest.fn(async () => ({ transaction_id: "tx" })) };
    return { svc: new GlovoItemAvailabilityService(prisma, client, { record: jest.fn() } as any), client };
  };

  it("86s through the bulk endpoint with available:false", async () => {
    const { svc, client } = make();
    await svc.pushItemAvailability({ tenantId: "t1", itemId: "i1", available: false });
    expect(client.request).toHaveBeenCalledWith(
      "POST",
      "/webhook/stores/OH-1/menu/updates",
      expect.objectContaining({ body: { products: [{ id: "i1", available: false }] } }),
    );
  });

  it("does not restore an item another snooze still covers at that store", async () => {
    const { svc, client } = make({ stillSnoozed: true });
    await svc.pushItemAvailability({ tenantId: "t1", itemId: "i1", available: true });
    expect(client.request).not.toHaveBeenCalled();
  });

  it("an item from another tenant pushes nothing", async () => {
    const { svc, client } = make({ itemTenant: "t-other" });
    await svc.pushItemAvailability({ tenantId: "t1", itemId: "i1", available: false });
    expect(client.request).not.toHaveBeenCalled();
  });

  it("the sweep restores a snooze that has just expired (Glovo has no timed 86)", async () => {
    const { svc, client } = make();
    const restored = await svc.sweepExpired();
    expect(restored).toBe(1);
    expect(client.request.mock.calls[0][2].body.products[0]).toEqual({ id: "i1", available: true });
  });
});

describe("GlovoConnectionService", () => {
  const make = (clash = false) => {
    const prisma: any = {
      brand: { findFirst: jest.fn(async ({ where }: any) => (where.tenantId === "t1" ? { id: "b1" } : null)) },
      location: { findFirst: jest.fn(async () => ({ id: "l1" })) },
      brandPlatformConnection: {
        findFirst: jest.fn(async ({ where }: any) => (where.NOT && clash ? { id: "other" } : null)),
        upsert: jest.fn(async ({ create }: any) => ({ id: "conn-1", ...create })),
      },
    };
    return { svc: new GlovoConnectionService(prisma, {} as any, { record: jest.fn() } as any), prisma };
  };

  it("defaults the store id to a stable, short value derived from brand + location", async () => {
    const { svc } = make();
    const res = await svc.connect("t1", { brandId: "b1", locationId: "l1" });
    expect(res.storeId).toBe(defaultGlovoStoreId("b1", "l1"));
    expect(res.storeId).toMatch(/^OH-[0-9A-F]{10}$/);
    expect(defaultGlovoStoreId("b1", "l1")).toBe(defaultGlovoStoreId("b1", "l1"));
  });

  it("refuses a store id another connection already routes on", async () => {
    const { svc } = make(true);
    await expect(svc.connect("t1", { brandId: "b1", locationId: "l1", storeId: "TAKEN" })).rejects.toThrow(
      /already used/,
    );
  });

  it("refuses a brand outside the caller's tenant", async () => {
    const { svc } = make();
    await expect(svc.connect("t2", { brandId: "b1", locationId: "l1" })).rejects.toThrow(/Brand not found/);
  });
});

describe("GlovoClientService", () => {
  const cfg = (vals: Record<string, string>) =>
    ({ get: (k: string) => vals[k.replace("app.platforms.glovo.", "")] }) as any;

  it("defaults to the STAGE host; production only when asked", () => {
    expect(new GlovoClientService(cfg({})).baseUrl).toBe("https://stageapi.glovoapp.com");
    expect(new GlovoClientService(cfg({ env: "production" })).baseUrl).toBe("https://api.glovoapp.com");
  });

  it("sends the token as-is in Authorization (no Bearer prefix)", async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 204, text: async () => "" }));
    (global as any).fetch = fetchMock;
    await new GlovoClientService(cfg({ apiToken: "tok123" })).request("DELETE", "/x");
    expect((fetchMock.mock.calls[0] as any)[1].headers.Authorization).toBe("tok123");
  });

  it("token comparison: exact match, tolerates a Bearer prefix, rejects anything else", () => {
    expect(glovoTokenMatches("abc", "abc")).toBe(true);
    expect(glovoTokenMatches("abc", "Bearer abc")).toBe(true);
    expect(glovoTokenMatches("abc", "abd")).toBe(false);
    expect(glovoTokenMatches("abc", undefined)).toBe(false);
    expect(glovoTokenMatches("", "")).toBe(false);
  });
});

describe("Glovo URLs — the contract we register with Glovo", () => {
  // Once these are on Glovo's side, renaming a path silently stops orders.
  const pathOf = (cls: any, method: string) => Reflect.getMetadata(PATH_METADATA, cls.prototype[method]);

  it("webhooks live under integrations/glovo/orders", () => {
    expect(Reflect.getMetadata(PATH_METADATA, GlovoWebhookController)).toBe("integrations/glovo/orders");
    expect(pathOf(GlovoWebhookController, "dispatched")).toBe("dispatched");
    expect(pathOf(GlovoWebhookController, "pickedUp")).toEqual(["picked-up", "picked_up"]);
    expect(pathOf(GlovoWebhookController, "cancelled")).toBe("cancelled");
  });

  it("the menu feed and the public probe keep their paths", () => {
    expect(Reflect.getMetadata(PATH_METADATA, GlovoController)).toBe("integrations/glovo");
    expect(pathOf(GlovoController, "menuFeed")).toBe("menu-feed/:connectionId/:token");
    expect(pathOf(GlovoController, "probe")).toBe("health");
  });
});
