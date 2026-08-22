import { buildReceiptDocument, renderEscPos } from "../formatters/escpos.formatter";

// A ticket printing £ against AED prices is the failure this guards. It is
// also silent: the numbers look plausible, so nobody notices until a customer
// queries the total.
const order = (currency: string | null, total = 24.5): any => ({
  displayId: "42",
  platform: "POS",
  orderSource: "POS",
  fulfillmentType: "COLLECTION",
  customerName: "Sam",
  currency,
  items: [{ quantity: 1, name: "Shawarma", unitPrice: total, totalPrice: total }],
  subtotal: total,
  total,
});

const textOf = (o: any) => renderEscPos(buildReceiptDocument(o));

describe("receipt currency", () => {
  it("prints the shop's own currency, not a hardcoded pound", () => {
    const out = textOf(order("AED"));
    expect(out).toContain("AED");
    expect(out).not.toContain("£");
  });

  it("keeps a dinar's THIRD decimal place", () => {
    // 1.250 KWD is one dinar 250 fils. Printed as "1.25" it is a different
    // amount of money, which is why .toFixed(2) is not safe here.
    expect(textOf(order("KWD", 1.25))).toContain("1.250");
  });

  it("still prints £ for a UK shop", () => {
    expect(textOf(order("GBP", 6.49))).toContain("£6.49");
  });

  it("falls back to £ when the order has no currency, so old orders are unchanged", () => {
    expect(textOf(order(null, 6.49))).toContain("£6.49");
  });
});
