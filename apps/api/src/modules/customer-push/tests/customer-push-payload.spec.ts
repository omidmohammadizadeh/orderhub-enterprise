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
