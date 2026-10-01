import { OrderConfirmationEmailService } from "../order-confirmation-email.service";

// The email a customer gets after ordering online.
//
// Two things make this worth pinning. It touches the money path only by
// READING it — an order must never be affected by whether its email sent —
// and it must never send twice, because a second "order confirmed" for the
// same order reads as a second order.

const ORDER = {
  id: "ord-1",
  tenantId: "t1",
  brandId: "b1",
  locationId: "loc-1",
  platform: "ONLINE",
  status: "CONFIRMED",
  paymentStatus: "PAID",
  displayId: "A-1042",
  orderNumber: 1042,
  customerName: "Lee Morgan",
  customerInfo: { name: "Lee Morgan", email: "lee@example.com", phone: "07700900001" },
  fulfillmentType: "DELIVERY",
  subtotal: "18.40",
  deliveryFee: "2.50",
  serviceCharge: "0.75",
  total: "21.65",
  metadata: {},
  createdAt: new Date("2026-10-01T18:00:00Z"),
  items: [
    { name: "Margherita 12\"", quantity: 2, totalPrice: "15.00", modifiers: [{ name: "Thin base" }] },
    { name: "Garlic Bread", quantity: 1, totalPrice: "3.40", modifiers: [] },
  ],
  location: { name: "Pizza Uno", onlineOrderingSlug: "pizza-uno", slug: "pizza-uno" },
  brand: { name: "Pizza Uno" },
};

function svc(opts: { orders?: any[]; sentToday?: number; capWarnAt?: number } = {}) {
  const updates: Array<{ id: string; data: any }> = [];
  const prisma: any = {
    order: {
      findMany: jest.fn(async () => opts.orders ?? [ORDER]),
      update: jest.fn(async ({ where, data }: any) => {
        updates.push({ id: where.id, data });
        return {};
      }),
    },
    notificationLog: {
      count: jest.fn(async () => opts.sentToday ?? 0),
      create: jest.fn(async () => ({})),
    },
  };
  const email = { send: jest.fn().mockResolvedValue({ id: "e1" }) };
  const alerts = { raise: jest.fn().mockResolvedValue(undefined) };
  const s: any = Object.create(OrderConfirmationEmailService.prototype);
  Object.assign(s, {
    prisma,
    email,
    alerts,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    warnedOn: null,
    config: {
      get: jest.fn((k: string) => {
        if (k === "app.orderEmails.enabled") return true;
        if (k === "app.orderEmails.dailyCap") return 100;
        if (k === "app.orderEmails.capWarnAt") return opts.capWarnAt ?? 80;
        if (k === "app.orderEmails.opsAlertEmail") return "ops@orderhubpos.com";
        if (k === "app.webUrl") return "https://www.orderhubsolutions.com";
        return undefined;
      }),
    },
  });
  return { s: s as OrderConfirmationEmailService, prisma, email, updates };
}

describe("online order confirmation email", () => {
  it("sends one email carrying the order number, the items and the totals", async () => {
    const { s, email } = svc();

    await s.sweep();

    expect(email.send).toHaveBeenCalledTimes(1);
    const sent = email.send.mock.calls[0][0];
    expect(sent.to).toBe("lee@example.com");
    expect(sent.subject).toContain("A-1042");
    expect(sent.html).toContain("Pizza Uno");
    expect(sent.html).toContain("Margherita");
    expect(sent.html).toContain("Garlic Bread");
    // Quantities and money the customer can check against their bank.
    expect(sent.html).toContain("21.65");
    expect(sent.html).toContain("2.50");
  });

  it("includes a tracking link to the order's own status page", async () => {
    const { s, email } = svc();

    await s.sweep();

    const html = email.send.mock.calls[0][0].html;
    expect(html).toContain(
      "https://www.orderhubsolutions.com/order/pizza-uno/status/ord-1",
    );
    // The brand pin is load-bearing on the storefront: without it the page
    // can render the wrong shop's identity on a multi-brand site.
    expect(html).toContain("brand=b1");
  });

  it("marks the order so a second sweep cannot send it again", async () => {
    const { s, email, updates, prisma } = svc();

    await s.sweep();
    expect(updates).toHaveLength(1);
    expect(updates[0].data.metadata.confirmationEmail.sentAt).toBeTruthy();

    // Second pass: the query itself excludes marked orders, but prove the
    // marker is what does it rather than luck.
    prisma.order.findMany.mockResolvedValue([
      { ...ORDER, metadata: { confirmationEmail: { sentAt: "2026-10-01T18:00:05Z" } } },
    ]);
    email.send.mockClear();
    await s.sweep();
    expect(email.send).not.toHaveBeenCalled();
  });

  it("skips an order with no email address rather than failing the sweep", async () => {
    const { s, email } = svc({
      orders: [
        { ...ORDER, id: "no-email", customerInfo: { name: "Walk-in" } },
        ORDER,
      ],
    });

    await s.sweep();

    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0][0].to).toBe("lee@example.com");
  });

  it("does not mark the order when the send failed, so the next sweep retries", async () => {
    const { s, email, updates } = svc();
    email.send.mockRejectedValue(new Error("Resend 503"));

    await s.sweep();

    expect(updates).toHaveLength(0);
  });

  it("never lets an email problem escape into the order path", async () => {
    const { s, prisma } = svc();
    prisma.order.findMany.mockRejectedValue(new Error("db gone"));

    await expect(s.sweep()).resolves.toBeUndefined();
  });

  // The first live order sent nothing: `include: { items: { include:
  // { modifiers: true } } }` threw on every sweep because OrderItem.modifiers
  // is a Json COLUMN, not a relation — and an `as any` on the include stopped
  // the compiler saying so. A mocked Prisma cannot catch that; tsc can, now
  // that the cast is gone. This pins the shape so it is not reintroduced.
  it("loads order items as rows, not as a relation include", async () => {
    const { s, prisma } = svc();

    await s.sweep();

    const args = prisma.order.findMany.mock.calls[0][0];
    expect(args.include.items).toBe(true);
  });

  it("renders modifiers that arrive as JSON on the row", async () => {
    const { s, email } = svc();

    await s.sweep();

    // Exactly how Postgres hands them back: a plain array on the item.
    expect(email.send.mock.calls[0][0].html).toContain("Thin base");
  });

  it("is off when the feature is disabled", async () => {
    const { s, email } = svc();
    (s as any).config.get = jest.fn((k: string) =>
      k === "app.orderEmails.enabled" ? false : undefined,
    );

    await s.sweep();

    expect(email.send).not.toHaveBeenCalled();
  });
});

// Resend's free plan stops at 100 emails a day. Silently hitting that means
// customers stop getting confirmations with nothing to show why.
describe("online order confirmation email — the daily cap", () => {
  it("warns ops once when the day's sends approach the cap", async () => {
    const { s, email } = svc({ sentToday: 80 });

    await s.sweep();

    const subjects = email.send.mock.calls.map((c: any[]) => c[0].subject);
    expect(subjects.some((x: string) => /cap|limit/i.test(x))).toBe(true);
  });

  it("does not warn twice in the same day", async () => {
    const { s, email } = svc({ sentToday: 85 });

    await s.sweep();
    await s.sweep();

    const warnings = email.send.mock.calls
      .map((c: any[]) => c[0].subject)
      .filter((x: string) => /cap|limit/i.test(x));
    expect(warnings).toHaveLength(1);
  });

  it("stops sending once the cap is reached, rather than firing doomed requests", async () => {
    const { s, email, updates } = svc({ sentToday: 100 });

    await s.sweep();

    const customerEmails = email.send.mock.calls.filter(
      (c: any[]) => c[0].to === "lee@example.com",
    );
    expect(customerEmails).toHaveLength(0);
    // And crucially it is NOT marked — it goes out tomorrow instead of never.
    expect(updates).toHaveLength(0);
  });

  it("says nothing while the day is quiet", async () => {
    const { s, email } = svc({ sentToday: 3 });

    await s.sweep();

    const subjects = email.send.mock.calls.map((c: any[]) => c[0].subject);
    expect(subjects.some((x: string) => /cap|limit/i.test(x))).toBe(false);
  });
});
