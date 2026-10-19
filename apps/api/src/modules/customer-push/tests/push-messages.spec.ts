import {
  isEnabled,
  isExpoToken,
  resolveMessage,
  reviewDelayMinutes,
  storefrontRootFrom,
} from "../push-messages";
import { CustomerPushService } from "../customer-push.service";
import { PushCampaignsService } from "../push-campaigns.service";

const row = (over: Partial<any> = {}) => ({
  trigger: "READY",
  enabled: true,
  title: null,
  body: null,
  delayMinutes: null,
  ...over,
});

describe("push messages", () => {
  it("keeps every order stage on, and the review ask off, until a restaurant says otherwise", () => {
    expect(isEnabled("READY", null)).toBe(true);
    expect(isEnabled("REVIEW_REQUEST", null)).toBe(false);
    expect(isEnabled("READY", row({ enabled: false }))).toBe(false);
    expect(isEnabled("REVIEW_REQUEST", row({ trigger: "REVIEW_REQUEST" }))).toBe(true);
  });

  it("matches the old wording, order ref on the title, delivery READY included", () => {
    expect(resolveMessage({ trigger: "READY", orderRef: "#A1" })).toEqual({
      title: "Ready for collection · #A1",
      body: "Your order is ready to pick up.",
    });
    expect(resolveMessage({ trigger: "READY", fulfillmentType: "DELIVERY" })?.title).toBe(
      "Ready — waiting for a driver",
    );
  });

  it("uses the restaurant's wording and does not append the ref twice", () => {
    const msg = resolveMessage({
      trigger: "PREPARING",
      row: row({ trigger: "PREPARING", title: "{shop} is cooking {order}", body: "Hang tight!" }),
      orderRef: "#A1",
      shopName: "Saleems",
    });
    expect(msg).toEqual({ title: "Saleems is cooking #A1", body: "Hang tight!" });
  });

  it("returns nothing for a stage the restaurant switched off", () => {
    expect(resolveMessage({ trigger: "READY", row: row({ enabled: false }) })).toBeNull();
  });

  it("clamps the review delay", () => {
    expect(reviewDelayMinutes(null)).toBe(45);
    expect(reviewDelayMinutes(row({ delayMinutes: 1 }))).toBe(10);
    expect(reviewDelayMinutes(row({ delayMinutes: 99999 }))).toBe(1440);
  });

  it("finds the storefront a tracking path belongs to", () => {
    expect(storefrontRootFrom("/order/demo/status/o1")).toBe("/order/demo");
    expect(storefrontRootFrom("/status/o1")).toBe("/");
    expect(storefrontRootFrom("//evil.com/status/o1")).toBeNull();
    expect(storefrontRootFrom(null)).toBeNull();
  });

  it("recognises Expo tokens and nothing else", () => {
    expect(isExpoToken("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]")).toBe(true);
    expect(isExpoToken("https://fcm.googleapis.com/x")).toBe(false);
    expect(isExpoToken("ExponentPushToken[]")).toBe(false);
  });
});

describe("CustomerPushService native installs", () => {
  const order = { id: "o1", tenantId: "t1", locationId: "l1", brandId: "b1", customerId: null };

  it("stores an app token as an EXPO row with no keys", async () => {
    const upserts: any[] = [];
    const prisma: any = {
      order: { findUnique: async () => order },
      customerPushSubscription: { upsert: async (a: any) => (upserts.push(a), { id: "s1" }) },
      customerPushOrder: { findUnique: async () => null, upsert: async () => undefined },
    };
    await new CustomerPushService(prisma).subscribe({
      orderId: "o1",
      expoToken: "ExponentPushToken[abcdefghijklmnop]",
      platform: "ios",
      appId: "com.orderhubsolutions.saleems",
    });
    expect(upserts[0].create).toMatchObject({
      kind: "EXPO",
      endpoint: "ExponentPushToken[abcdefghijklmnop]",
      p256dh: null,
      platform: "ios",
      marketingOptIn: false,
    });
  });

  it("never turns offers off from an order subscribe — only on", async () => {
    const upserts: any[] = [];
    const prisma: any = {
      order: { findUnique: async () => order },
      customerPushSubscription: { upsert: async (a: any) => (upserts.push(a), { id: "s1" }) },
      customerPushOrder: { findUnique: async () => null, upsert: async () => undefined },
    };
    const s = new CustomerPushService(prisma);
    await s.subscribe({ orderId: "o1", endpoint: "https://push.example/x", p256dh: "p", auth: "a" });
    expect(upserts[0].update.marketingOptIn).toBeUndefined();
    await s.subscribe({
      orderId: "o1",
      endpoint: "https://push.example/x",
      p256dh: "p",
      auth: "a",
      marketingOptIn: true,
    });
    expect(upserts[1].update.marketingOptIn).toBe(true);
  });

  it("refuses a request that is neither a browser nor an app", async () => {
    const prisma: any = { order: { findUnique: async () => order } };
    await expect(
      new CustomerPushService(prisma).subscribe({ orderId: "o1", endpoint: "http://insecure", p256dh: "p", auth: "a" }),
    ).rejects.toThrow();
  });

  it("queues one review ask when an order completes, even with Completed switched off", async () => {
    const queued: any[] = [];
    const prisma: any = {
      customerPushOrder: {
        findMany: async () => [{ trackPath: "/order/demo/status/o1", subscription: { id: "s1", tenantId: "t1", kind: "WEB" } }],
      },
      pushAutomation: {
        findMany: async () => [
          row({ trigger: "COMPLETED", enabled: false }),
          row({ trigger: "REVIEW_REQUEST", delayMinutes: 30 }),
        ],
      },
      pushReviewRequest: { upsert: async (a: any) => queued.push(a) },
      order: { findUnique: async () => ({ locationId: "l1", location: { timezone: "Europe/London" } }) },
      pushLocationReview: { findUnique: async () => null },
    };
    const s = new CustomerPushService(prisma);
    const sendTo = jest.spyOn(s, "sendTo");
    await s.notifyOrderStatus({ orderId: "o1", status: "COMPLETED" });
    expect(queued).toHaveLength(1);
    expect(queued[0].where).toEqual({ orderId: "o1" });
    expect(queued[0].update).toEqual({});
    const due = queued[0].create.dueAt.getTime() - Date.now();
    expect(due).toBeGreaterThan(29 * 60_000);
    expect(due).toBeLessThanOrEqual(30 * 60_000);
    expect(sendTo).not.toHaveBeenCalled();
  });
});

describe("PushCampaignsService", () => {
  it("does not ask for a review that was already left", async () => {
    const prisma: any = {
      pushAutomation: { findMany: async () => [row({ trigger: "REVIEW_REQUEST" })] },
      order: { findUnique: async () => ({ status: "COMPLETED" }) },
      review: { findUnique: async () => ({ id: "r1" }) },
    };
    const push = new CustomerPushService(prisma);
    const sendTo = jest.spyOn(push, "sendTo");
    const svc = new PushCampaignsService(prisma, push);
    const sent = await svc.sendReviewRequest({ tenantId: "t1", orderId: "o1", dueAt: new Date() });
    expect(sent).toBe(false);
    expect(sendTo).not.toHaveBeenCalled();
  });

  it("sends the review ask to the tracking page with ?review=1", async () => {
    const prisma: any = {
      pushAutomation: { findMany: async () => [row({ trigger: "REVIEW_REQUEST" })] },
      order: { findUnique: async () => ({ status: "COMPLETED" }) },
      review: { findUnique: async () => null },
      customerPushOrder: {
        findMany: async () => [{ trackPath: "/order/demo/status/o1", subscription: { id: "s1", kind: "WEB" } }],
      },
    };
    const push = new CustomerPushService(prisma);
    const sendTo = jest.spyOn(push, "sendTo").mockResolvedValue({ delivered: 1, failed: 0 });
    jest.spyOn(push, "brandingFor").mockResolvedValue({ name: "Saleems", icon: null });
    const svc = new PushCampaignsService(prisma, push);
    expect(await svc.sendReviewRequest({ tenantId: "t1", orderId: "o1", dueAt: new Date() })).toBe(true);
    const content = sendTo.mock.calls[0][1];
    expect(content.body).toContain("Saleems");
    expect(content.urlFor?.({})).toBe("/order/demo/status/o1?review=1");
  });

  it("pages through opted-in subscribers only and records the result", async () => {
    const pages = [[{ id: "a", orders: [{ trackPath: "/order/demo/status/o1" }] }, { id: "b", orders: [] }], []];
    const finds: any[] = [];
    const updates: any[] = [];
    const prisma: any = {
      customerPushSubscription: { findMany: async (a: any) => (finds.push(a), pages.shift()) },
      pushCampaign: { update: async (a: any) => updates.push(a) },
    };
    const push = new CustomerPushService(prisma);
    jest.spyOn(push, "brandingFor").mockResolvedValue({ name: null, icon: null });
    const sendTo = jest.spyOn(push, "sendTo").mockResolvedValue({ delivered: 1, failed: 1 });
    const svc = new PushCampaignsService(prisma, push);
    await svc.sendCampaign({ id: "c1", tenantId: "t1", title: "Hi", body: "Offer", locationId: "l1", brandId: null });

    expect(finds[0].where).toMatchObject({ tenantId: "t1", isActive: true, marketingOptIn: true, locationId: "l1" });
    expect(finds[1].where.id).toEqual({ gt: "b" });
    const urlFor = sendTo.mock.calls[0][1].urlFor!;
    expect(urlFor({ orders: [{ trackPath: "/order/demo/status/o1" }] })).toBe("/order/demo");
    expect(urlFor({ orders: [] })).toBeNull();
    expect(updates[updates.length - 1].data).toMatchObject({ status: "SENT", targeted: 2, delivered: 1, failed: 1 });
  });
});

describe("review ask per location", () => {
  const { effectiveReviewRow, fitSendWindow, inSendWindow } = jest.requireActual("../push-messages");
  const business = { trigger: "REVIEW_REQUEST", enabled: true, title: "Biz title", body: null, delayMinutes: 45 };

  it("follows the business when the shop has no row of its own", () => {
    expect(effectiveReviewRow(business, null)).toBe(business);
  });

  it("uses the shop's own switch and delay, falling back to the business text", () => {
    const row = effectiveReviewRow(business, {
      enabled: false,
      delayMinutes: 90,
      title: null,
      body: "Shop body",
      sendFromHour: 11,
      sendUntilHour: 21,
    });
    expect(row).toEqual({ trigger: "REVIEW_REQUEST", enabled: false, title: "Biz title", body: "Shop body", delayMinutes: 90 });
  });

  it("knows overnight windows", () => {
    expect(inSendWindow(23, 18, 2)).toBe(true);
    expect(inSendWindow(1, 18, 2)).toBe(true);
    expect(inSendWindow(3, 18, 2)).toBe(false);
    expect(inSendWindow(12, 11, 21)).toBe(true);
    expect(inSendWindow(21, 11, 21)).toBe(false);
  });

  it("sends inside the hours unchanged", () => {
    const due = new Date("2026-07-10T14:30:00Z"); // 15:30 London (BST)
    expect(fitSendWindow(due, "Europe/London", 11, 21)).toEqual(due);
  });

  it("holds a late ask until the window opens next morning, in the shop's time", () => {
    const due = new Date("2026-07-10T23:15:00Z"); // 00:15 London on the 11th
    expect(fitSendWindow(due, "Europe/London", 11, 21).toISOString()).toBe("2026-07-11T10:00:00.000Z"); // 11:00 BST
  });

  it("works in winter time and other timezones", () => {
    expect(fitSendWindow(new Date("2026-12-10T22:00:00Z"), "Europe/London", 11, 21).toISOString()).toBe(
      "2026-12-11T11:00:00.000Z",
    );
    expect(fitSendWindow(new Date("2026-12-10T19:00:00Z"), "Asia/Dubai", 11, 21).toISOString()).toBe(
      "2026-12-11T07:00:00.000Z",
    );
  });

  it("any time when no hours are set", () => {
    const due = new Date("2026-07-10T23:15:00Z");
    expect(fitSendWindow(due, "Europe/London", null, null)).toEqual(due);
  });
});

  it("uses the shop's own setting: switched off there means no ask", async () => {
    const queued: any[] = [];
    const prisma: any = {
      customerPushOrder: {
        findMany: async () => [{ trackPath: "/order/demo/status/o1", subscription: { id: "s1", tenantId: "t1", kind: "WEB" } }],
      },
      pushAutomation: { findMany: async () => [] },
      pushReviewRequest: { upsert: async (a: any) => queued.push(a) },
      order: { findUnique: async () => ({ locationId: "l1", location: { timezone: "Europe/London" } }) },
      pushLocationReview: {
        findUnique: async () => ({ enabled: false, delayMinutes: null, title: null, body: null, sendFromHour: null, sendUntilHour: null }),
      },
    };
    const s = new CustomerPushService(prisma);
    jest.spyOn(s, "sendTo").mockResolvedValue({ delivered: 1 } as any);
    await s.notifyOrderStatus({ orderId: "o1", status: "COMPLETED" });
    expect(queued).toHaveLength(0);
  });

