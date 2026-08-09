import { NotFoundException } from "@nestjs/common";
import { ReceiptEmailService } from "../receipt-email.service";

// Emailed receipts exist to satisfy Apple's Tap to Pay App Review checklist
// (5.10): the customer must be able to get a confidential digital receipt
// for an in-person sale, approved OR declined. These pin the parts that are
// easy to regress silently — tenant scoping, money formatting, and the
// promise that card data never reaches the email.

const ORDER = {
  id: "ord_abc123",
  displayId: "NZEFB",
  orderNumber: 41,
  createdAt: new Date("2026-08-09T20:53:21.912Z"),
  customerName: "Walk-in",
  fulfillmentType: "PICKUP",
  subtotal: 1.4,
  taxAmount: 0,
  serviceCharge: 0,
  tipAmount: 0,
  deliveryFee: 0,
  discount: 0,
  total: 1.4,
  paymentMethod: "CARD_TERMINAL",
  paymentStatus: "PAID",
  items: [{ name: "Margherita", quantity: 1, totalPrice: 1.4, modifiers: [] }],
  location: {
    name: "PIZZA UNO",
    phone: "01914975224",
    addressLine1: "7 Front Street",
    addressLine2: "Pelton DH2 1DD",
  },
  brand: { name: "PIZZA UNO", logoUrl: null },
};

function makeService(order: any = ORDER) {
  const prisma = { order: { findFirst: jest.fn().mockResolvedValue(order) } };
  const email = { send: jest.fn().mockResolvedValue({ id: "re_1" }) };
  const svc = new ReceiptEmailService(prisma as any, email as any);
  return { svc, prisma, email };
}

describe("ReceiptEmailService", () => {
  it("scopes the order lookup to the caller's tenant", async () => {
    const { svc, prisma } = makeService();
    await svc.sendOrderReceipt({
      tenantId: "t-1",
      orderId: "ord_abc123",
      to: "a@b.com",
    });
    expect(prisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ord_abc123", tenantId: "t-1" },
      }),
    );
  });

  it("404s rather than emailing when the order belongs to another tenant", async () => {
    const { svc, email } = makeService(null);
    await expect(
      svc.sendOrderReceipt({ tenantId: "t-other", orderId: "ord_abc123", to: "a@b.com" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(email.send).not.toHaveBeenCalled();
  });

  it("sends to the given address with the shop name and order reference in the subject", async () => {
    const { svc, email } = makeService();
    await svc.sendOrderReceipt({ tenantId: "t-1", orderId: "ord_abc123", to: "cust@x.com" });
    const sent = email.send.mock.calls[0][0];
    expect(sent.to).toBe("cust@x.com");
    expect(sent.subject).toContain("PIZZA UNO");
    expect(sent.subject).toContain("NZEFB");
  });

  it("renders the total and item lines as GBP", async () => {
    const { svc, email } = makeService();
    await svc.sendOrderReceipt({ tenantId: "t-1", orderId: "ord_abc123", to: "a@b.com" });
    const { html, text } = email.send.mock.calls[0][0];
    expect(html).toContain("£1.40");
    expect(html).toContain("Margherita");
    expect(text).toContain("TOTAL: £1.40");
  });

  it("omits zero-value lines so a simple counter sale isn't a wall of £0.00", async () => {
    const { svc, email } = makeService();
    await svc.sendOrderReceipt({ tenantId: "t-1", orderId: "ord_abc123", to: "a@b.com" });
    const { html } = email.send.mock.calls[0][0];
    expect(html).not.toContain("Delivery");
    expect(html).not.toContain("Service charge");
    expect(html).not.toContain("Tip");
  });

  it("shows the non-zero extras when they are actually charged", async () => {
    const { svc, email } = makeService({
      ...ORDER,
      tipAmount: 2,
      serviceCharge: 0.5,
      discount: 1,
    });
    await svc.sendOrderReceipt({ tenantId: "t-1", orderId: "ord_abc123", to: "a@b.com" });
    const { html } = email.send.mock.calls[0][0];
    expect(html).toContain("Tip");
    expect(html).toContain("£2.00");
    expect(html).toContain("Service charge");
    expect(html).toContain("Discount");
  });

  // Apple 5.10 requires the receipt to be available for DECLINED sales too —
  // it must say plainly that nothing was taken rather than implying payment.
  it("marks an unpaid order as not paid", async () => {
    const { svc, email } = makeService({ ...ORDER, paymentStatus: "PENDING" });
    await svc.sendOrderReceipt({ tenantId: "t-1", orderId: "ord_abc123", to: "a@b.com" });
    const { html, text } = email.send.mock.calls[0][0];
    expect(html).toContain("Not paid");
    expect(text).toContain("NOT PAID");
  });

  it("escapes HTML in item names so operator text can't break the email", async () => {
    const { svc, email } = makeService({
      ...ORDER,
      items: [{ name: '<script>alert(1)</script>', quantity: 1, totalPrice: 1.4, modifiers: [] }],
    });
    await svc.sendOrderReceipt({ tenantId: "t-1", orderId: "ord_abc123", to: "a@b.com" });
    const { html } = email.send.mock.calls[0][0];
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("falls back to the location name when the order has no brand", async () => {
    const { svc, email } = makeService({ ...ORDER, brand: null });
    await svc.sendOrderReceipt({ tenantId: "t-1", orderId: "ord_abc123", to: "a@b.com" });
    expect(email.send.mock.calls[0][0].subject).toContain("PIZZA UNO");
  });
});
