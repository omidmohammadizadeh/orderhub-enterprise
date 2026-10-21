import { CustomerPushService } from "../customer-push.service";

// The 4096-byte ceiling is the whole reason these exist. FCM rejects an
// oversized push with a 400 and delivers nothing — so a logo that happens to
// be a base64 data URL silently costs the customer every notification.

const svc = () => new CustomerPushService({} as any) as any;

describe("CustomerPushService payload budget", () => {
  it("keeps an ordinary payload untouched", () => {
    const out = svc().buildPayload({
      title: "Ready for collection · #A1B2C",
      body: "Your order is ready to pick up.",
      icon: "https://cdn.example.com/logo.png",
      tag: "order-abc",
      data: { orderId: "abc" },
    });
    expect(JSON.parse(out).icon).toBe("https://cdn.example.com/logo.png");
    expect(Buffer.byteLength(out)).toBeLessThan(3000);
  });

  it("drops the icon rather than the notification when a data URL blows the budget", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(6000)}`;
    const out = svc().buildPayload({
      title: "On its way",
      body: "Your driver is heading to you now.",
      icon: dataUrl,
      tag: "order-abc",
      data: { orderId: "abc" },
    });
    const parsed = JSON.parse(out);
    expect(parsed.icon).toBeUndefined();
    // The notification itself survives — that's the point.
    expect(parsed.title).toBe("On its way");
    expect(parsed.data.orderId).toBe("abc");
    expect(Buffer.byteLength(out)).toBeLessThan(4096);
  });

  it("refuses data URLs and over-long URLs as icons, accepts real ones", () => {
    const s = svc();
    expect(s.usableIcon("data:image/png;base64,AAAA")).toBeNull();
    expect(s.usableIcon(`https://cdn.example.com/${"x".repeat(600)}.png`)).toBeNull();
    expect(s.usableIcon(null)).toBeNull();
    expect(s.usableIcon("https://cdn.example.com/logo.png")).toBe(
      "https://cdn.example.com/logo.png",
    );
  });
});

// The tap target. The first version derived this server-side and invented
// /order/status/<id> — a route that does not exist — whenever the location
// had no slug, so every notification opened a 404.
describe("CustomerPushService tap target", () => {
  const safePath = (raw: string | null) => {
    // Mirrors the module-private helper; exercised through subscribe() below
    // for the real thing.
    if (!raw) return null;
    if (!raw.startsWith("/") || raw.startsWith("//")) return null;
    return raw.length <= 300 ? raw : null;
  };

  it("stores a relative storefront path", async () => {
    const order = { id: "o1", tenantId: "t1", locationId: "l1", brandId: null, customerId: null };
    const upserts: any[] = [];
    const prisma: any = {
      order: { findUnique: async () => order },
      customerPushSubscription: { upsert: async () => ({ id: "s1" }) },
      customerPushOrder: { findUnique: async () => null, upsert: async (a: any) => upserts.push(a) },
    };
    const s = new CustomerPushService(prisma);
    await s.subscribe({
      orderId: "o1",
      endpoint: "https://push.example/x",
      p256dh: "p",
      auth: "a",
      trackPath: "/order/demo/status/o1",
    });
    expect(upserts[0].create.trackPath).toBe("/order/demo/status/o1");
  });

  it("refuses anything that is not a same-origin relative path", async () => {
    const order = { id: "o1", tenantId: "t1", locationId: "l1", brandId: null, customerId: null };
    const upserts: any[] = [];
    const prisma: any = {
      order: { findUnique: async () => order },
      customerPushSubscription: { upsert: async () => ({ id: "s1" }) },
      customerPushOrder: { findUnique: async () => null, upsert: async (a: any) => upserts.push(a) },
    };
    const s = new CustomerPushService(prisma);

    for (const bad of ["//evil.com/x", "https://evil.com", "javascript:alert(1)", "order/demo"]) {
      upserts.length = 0;
      await s.subscribe({
        orderId: "o1",
        endpoint: "https://push.example/x",
        p256dh: "p",
        auth: "a",
        trackPath: bad,
      });
      expect(upserts[0].create.trackPath).toBeNull();
    }
    // sanity: the local mirror agrees
    expect(safePath("//evil.com")).toBeNull();
  });

  it("never overwrites a known path with a missing one", async () => {
    const order = { id: "o1", tenantId: "t1", locationId: "l1", brandId: null, customerId: null };
    const upserts: any[] = [];
    const prisma: any = {
      order: { findUnique: async () => order },
      customerPushSubscription: { upsert: async () => ({ id: "s1" }) },
      customerPushOrder: { findUnique: async () => null, upsert: async (a: any) => upserts.push(a) },
    };
    const s = new CustomerPushService(prisma);
    await s.subscribe({
      orderId: "o1",
      endpoint: "https://push.example/x",
      p256dh: "p",
      auth: "a",
    });
    // An update that blanked trackPath would lose the good path recorded by
    // whichever page subscribed first.
    expect(upserts[0].update).toEqual({});
  });
});

// RIDER_ARRIVED is overloaded: before pickup a courier is at the SHOP. Telling
// the customer "they're outside with your order" then sends them to an empty
// doorstep, so it only goes out once the order has left (outForDeliveryAt).
describe("CustomerPushService RIDER_ARRIVED", () => {
  const build = (outForDeliveryAt: Date | null) => {
    const prisma: any = {
      customerPushOrder: {
        findMany: jest.fn().mockResolvedValue([{ subscription: { tenantId: "t1" }, trackPath: null }]),
      },
      order: { findUnique: jest.fn().mockResolvedValue({ outForDeliveryAt }) },
    };
    const s: any = new CustomerPushService(prisma);
    s.automationsFor = jest.fn().mockResolvedValue(new Map());
    s.brandingFor = jest.fn().mockResolvedValue({ name: "Shop", icon: null });
    s.sendTo = jest.fn().mockResolvedValue({ delivered: 1 });
    return s;
  };

  it("stays quiet while the courier is at the shop", async () => {
    const s = build(null);
    await s.notifyOrderStatus({ orderId: "o1", status: "RIDER_ARRIVED" });
    expect(s.sendTo).not.toHaveBeenCalled();
  });

  it("tells the customer once the driver is at their door", async () => {
    const s = build(new Date());
    await s.notifyOrderStatus({ orderId: "o1", status: "RIDER_ARRIVED", fulfillmentType: "DELIVERY" });
    expect(s.sendTo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: expect.stringContaining("arrived") }),
    );
  });
});

// Auto-accept flips the order to ACCEPTED inside checkout, a second before
// the app subscribes, so "accepted" went to nobody (order cmvf5plsn, 19 Oct).
describe("CustomerPushService subscribe — accepted catch-up", () => {
  const build = (order: any, alreadyLinked = false) => {
    const prisma: any = {
      order: { findUnique: async () => ({ id: "o1", tenantId: "t1", locationId: "l1", brandId: null, customerId: null, ...order }) },
      customerPushSubscription: { upsert: async () => ({ id: "s1" }) },
      customerPushOrder: {
        findUnique: async () => (alreadyLinked ? { orderId: "o1" } : null),
        upsert: async () => undefined,
      },
    };
    const s: any = new CustomerPushService(prisma);
    s.notifyOrderStatus = jest.fn().mockResolvedValue(undefined);
    return s;
  };
  const sub = (s: any) => s.subscribe({ orderId: "o1", expoToken: "ExponentPushToken[abcdefghij12]", platform: "android", appId: "x" });

  it("sends the missed Accepted push to the new device only", async () => {
    const s = build({ status: "ACCEPTED", acceptedAt: new Date(Date.now() - 2000), orderNumber: 7 });
    await sub(s);
    expect(s.notifyOrderStatus).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "o1", status: "ACCEPTED", orderNumber: 7, onlySubscriptionId: "s1" }),
    );
  });

  it("does not resend when the device was already following the order", async () => {
    const s = build({ status: "ACCEPTED", acceptedAt: new Date() }, true);
    await sub(s);
    expect(s.notifyOrderStatus).not.toHaveBeenCalled();
  });

  it("stays quiet for an old acceptance or an order that has moved on", async () => {
    const old = build({ status: "ACCEPTED", acceptedAt: new Date(Date.now() - 11 * 60_000) });
    await sub(old);
    expect(old.notifyOrderStatus).not.toHaveBeenCalled();
    const pending = build({ status: "PENDING", acceptedAt: null });
    await sub(pending);
    expect(pending.notifyOrderStatus).not.toHaveBeenCalled();
  });
});

describe("CustomerPushService notifyOrderStatus — one device", () => {
  it("filters the links to that subscription", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const s = new CustomerPushService({ customerPushOrder: { findMany } } as any);
    await s.notifyOrderStatus({ orderId: "o1", status: "ACCEPTED", onlySubscriptionId: "s1" });
    expect(findMany.mock.calls[0][0].where).toMatchObject({ orderId: "o1", subscriptionId: "s1" });
  });
});
