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
      customerPushOrder: { upsert: async (a: any) => upserts.push(a) },
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
      customerPushOrder: { upsert: async (a: any) => upserts.push(a) },
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
      customerPushOrder: { upsert: async (a: any) => upserts.push(a) },
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
