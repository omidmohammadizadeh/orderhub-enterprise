import { SalonDepositService } from "../salon-deposit.service";

// The deposit's money path with the Stripe-facing services faked: what is
// created, what is charged, what a refund books, and when a hold lapses.

function setup(appt: Record<string, any>) {
  const rows = { appt: { ...appt } as any, orders: new Map<string, any>(), refunds: [] as any[], ledger: [] as any[] };
  const prisma: any = {
    salonAppointment: {
      findUnique: async ({ where }: any) =>
        where.id === rows.appt.id || where.manageToken === rows.appt.manageToken ? { ...rows.appt } : null,
      findMany: async ({ where }: any) => {
        if (where?.status === "PENDING_PAYMENT") return rows.appt.status === "PENDING_PAYMENT" ? [{ ...rows.appt }] : [];
        const ids = (where?.OR ?? []).map((w: any) => w.depositOrderId ?? w.orderId);
        return ids.includes(rows.appt.depositOrderId) || ids.includes(rows.appt.orderId) ? [{ id: rows.appt.id }] : [];
      },
      update: async ({ data }: any) => Object.assign(rows.appt, data),
      updateMany: async ({ where, data }: any) => {
        const ok =
          (!where.depositStatus || rows.appt.depositStatus === where.depositStatus) &&
          (!where.status || (typeof where.status === "string" ? rows.appt.status === where.status : !where.status.notIn?.includes(rows.appt.status)));
        if (ok) Object.assign(rows.appt, data);
        return { count: ok ? 1 : 0 };
      },
    },
    salonQueueEntry: { updateMany: async () => ({ count: 0 }) },
    order: {
      findUnique: async ({ where }: any) => rows.orders.get(where.id) ?? null,
      update: async ({ where, data }: any) => Object.assign(rows.orders.get(where.id), data),
      updateMany: async ({ where, data }: any) => {
        const o = rows.orders.get(where.id);
        if (o && o.paymentStatus !== "PAID") Object.assign(o, data);
        return { count: o ? 1 : 0 };
      },
    },
    refund: { create: async ({ data }: any) => (rows.refunds.push(data), { id: "rf1", ...data }) },
    ledgerEntry: { create: async ({ data }: any) => (rows.ledger.push(data), data) },
    payment: { update: async () => ({}) },
    $transaction: async (fn: any) => fn(prisma),
  };
  const created: any[] = [];
  const orders = {
    create: async (dto: any) => {
      const o = { id: "ord_dep", tenantId: "T", total: dto.total, paymentStatus: "PENDING", status: "PENDING", payments: [], location: { currency: "GBP" } };
      rows.orders.set(o.id, o);
      created.push(dto);
      return o;
    },
  };
  const charged: any[] = [];
  const refunded: any[] = [];
  const payments = {
    createCheckoutSession: async (p: any) => (charged.push(p), { url: "https://checkout.stripe.test/s1", sessionId: "cs_1" }),
    refundStripeAmount: async (payment: any, minor: number) => (refunded.push({ payment, minor }), "re_1"),
  };
  const emails: string[] = [];
  const notify = { appointment: (kind: string) => emails.push(kind) };
  const socket = { emitToLocation: () => undefined };
  const config = { get: () => "https://web.test" };
  const svc = new SalonDepositService(prisma, socket as any, orders as any, payments as any, notify as any, config as any);
  return { svc, rows, created, charged, refunded, emails };
}

const base = {
  id: "ap1",
  tenantId: "T",
  locationId: "L",
  reference: "S-ABC234",
  manageToken: "tok",
  customerName: "Liam",
  customerPhone: "07700900001",
  customerEmail: "liam@example.com",
  services: [{ serviceId: "s", name: "Full head colour", price: 65, durationMins: 120 }],
  status: "PENDING_PAYMENT",
  depositAmount: 20,
  depositStatus: "PENDING",
  depositOrderId: null,
  orderId: null,
  createdAt: new Date(),
  staffNotes: null,
};

describe("salon deposits", () => {
  it("makes the deposit a hidden POS order and sends the guest to Stripe on the shop's account", async () => {
    const t = setup(base);
    const { url } = await t.svc.start("ap1");
    expect(url).toBe("https://checkout.stripe.test/s1");
    expect(t.created[0]).toMatchObject({
      total: 20,
      paymentMethod: "PAYMENT_LINK",
      guestPrepay: true,
      isWalkIn: true,
      idempotencyKey: "salon-deposit:ap1",
      items: [{ name: "Deposit — Full head colour", unitPrice: 20 }],
    });
    expect(t.charged[0]).toMatchObject({
      orderId: "ord_dep",
      captureMethod: "automatic",
      successUrl: "https://web.test/salon/booking/tok?paid=1",
    });
    expect(t.rows.appt.depositOrderId).toBe("ord_dep");
  });

  it("confirms (and emails) once the deposit order is paid — once only", async () => {
    const t = setup(base);
    await t.svc.start("ap1");
    await t.svc.syncForOrder("ord_dep");
    expect(t.rows.appt.status).toBe("PENDING_PAYMENT");
    t.rows.orders.get("ord_dep").paymentStatus = "PAID";
    await t.svc.syncForOrder("ord_dep");
    await t.svc.syncForOrder("ord_dep");
    expect(t.rows.appt).toMatchObject({ status: "CONFIRMED", depositStatus: "PAID" });
    expect(t.emails).toEqual(["confirmed"]);
  });

  it("refunds a paid deposit to the card and books it", async () => {
    const t = setup({ ...base, status: "CONFIRMED", depositStatus: "PAID", depositOrderId: "ord_dep" });
    t.rows.orders.set("ord_dep", {
      id: "ord_dep",
      tenantId: "T",
      paymentStatus: "PAID",
      location: { currency: "GBP" },
      payments: [{ id: "pay1", provider: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: "pi_1", currency: "gbp" }],
    });
    expect(await t.svc.refund("ap1", "Cancelled in time")).toBe(true);
    expect(t.refunded[0].minor).toBe(2000);
    expect(t.rows.refunds[0]).toMatchObject({ amount: 20, method: "CARD", stripeRefundId: "re_1" });
    expect(t.rows.appt.depositStatus).toBe("REFUNDED");
    expect(t.rows.orders.get("ord_dep").paymentStatus).toBe("REFUNDED");
  });

  it("leaves a note instead of pretending when there's no card payment to refund", async () => {
    const t = setup({ ...base, status: "CONFIRMED", depositStatus: "PAID", depositOrderId: "ord_dep" });
    t.rows.orders.set("ord_dep", { id: "ord_dep", tenantId: "T", paymentStatus: "PAID", payments: [], location: { currency: "GBP" } });
    expect(await t.svc.refund("ap1", "x")).toBe(false);
    expect(t.rows.appt.depositStatus).toBe("PAID");
    expect(t.rows.appt.staffNotes).toMatch(/refund it from Payments/);
  });

  it("lets go of a slot nobody paid for, and cancels the unpaid deposit order", async () => {
    const t = setup({ ...base, depositOrderId: "ord_dep", createdAt: new Date(Date.now() - 25 * 60_000) });
    t.rows.orders.set("ord_dep", { id: "ord_dep", paymentStatus: "PENDING", status: "PENDING" });
    await t.svc.sweep();
    expect(t.rows.appt).toMatchObject({ status: "CANCELLED", depositStatus: "EXPIRED" });
    expect(t.rows.orders.get("ord_dep").status).toBe("CANCELLED");
  });

  it("completes the visit when the checkout order is paid", async () => {
    const t = setup({ ...base, status: "IN_SERVICE", depositStatus: "PAID", orderId: "ord_sale", depositOrderId: "ord_dep" });
    t.rows.orders.set("ord_dep", { id: "ord_dep", paymentStatus: "PAID" });
    t.rows.orders.set("ord_sale", { id: "ord_sale", paymentStatus: "PAID", tipAmount: 5, status: "COMPLETED" });
    await t.svc.syncForOrder("ord_sale");
    expect(t.rows.appt).toMatchObject({ status: "COMPLETED", tipAmount: 5, depositStatus: "APPLIED" });
  });

  it("refunds a deposit paid after the hold ran out, instead of keeping it", async () => {
    const t = setup({ ...base, status: "CANCELLED", depositStatus: "EXPIRED", depositOrderId: "ord_dep" });
    t.rows.orders.set("ord_dep", {
      id: "ord_dep",
      tenantId: "T",
      paymentStatus: "PAID",
      location: { currency: "GBP" },
      payments: [{ id: "pay1", provider: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: "pi_1", currency: "gbp" }],
    });
    await t.svc.sync("ap1");
    expect(t.refunded[0].minor).toBe(2000);
    expect(t.rows.appt).toMatchObject({ status: "CANCELLED", depositStatus: "REFUNDED" });
    expect(t.emails).toEqual([]);
  });
});
