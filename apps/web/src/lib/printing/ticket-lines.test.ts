import { describe, expect, it } from "vitest";
import { buildOrderReceipt, buildOrderReceiptStar } from "./bridge";
import { readLineStyles } from "./ticket-layout";

const order = {
  platform: "Just Eat",
  fulfillmentType: "DELIVERY",
  customerName: "Sam Taylor",
  customerPhone: "07700 900123",
  deliveryAddress: "Flat 3, 48 Westgate Road, Newcastle NE4 6AR",
  specialInstructions: "Ring the bell, don't knock.",
  items: [{ quantity: 1, name: "Margherita", totalPrice: 10 }],
  total: 10,
  paymentLabel: "CASH NOT PAID",
};

const text = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");
const BOLD_ON = "\x1bE\x01";
const TALL = "\x1d!\x01";
const REVERSE_ON = "\x1dB\x01";

describe("order note", () => {
  it("prints between the address and the items, in a bar", () => {
    const t = text(buildOrderReceipt(order));
    const note = t.indexOf("ORDER NOTE: Ring the bell");
    expect(note).toBeGreaterThan(t.indexOf("NE4"));
    expect(note).toBeLessThan(t.indexOf("Margherita"));
    expect(t.slice(0, note)).toMatch(/\x1dB\x01$/);
    expect(t).not.toContain("Special instructions");
  });

  it("appears once, and goes when the printer hides it", () => {
    const t = text(buildOrderReceipt(order));
    expect(t.split("Ring the bell").length).toBe(2);
    expect(text(buildOrderReceipt(order, 80, { hide: ["specialInstructions"] }))).not.toContain(
      "ORDER NOTE",
    );
  });

  it("uses Star's own highlight on a Star printer", () => {
    const t = text(buildOrderReceiptStar(order));
    const note = t.indexOf("ORDER NOTE:");
    expect(t.slice(0, note)).toMatch(/\x1b4$/);
    expect(note).toBeLessThan(t.indexOf("Margherita"));
    expect(t).not.toContain(REVERSE_ON);
  });
});

describe("line styles", () => {
  it("leaves an untouched line as plain normal text", () => {
    const t = text(buildOrderReceipt(order));
    expect(t).toContain(`\nChannel : Just Eat\n`.replace(/^\n/, ""));
    expect(t).not.toContain(`${BOLD_ON}Channel`);
    expect(t).not.toContain(`${TALL}Channel`);
    expect(t).toContain("Type    : DELIVERY");
    expect(t).toContain("Phone   : 07700 900123");
  });

  it("applies bold and size to the chosen line only", () => {
    const t = text(
      buildOrderReceipt(order, 80, {
        lineStyles: { customerPhone: { bold: true, size: 20 } },
      }),
    );
    expect(t).toContain(`${BOLD_ON}${TALL}Phone   : 07700 900123`);
    expect(t).not.toContain(`${BOLD_ON}Customer`);
  });

  it("keeps the payment band double height until the shop changes it", () => {
    expect(text(buildOrderReceipt(order))).toContain(`${TALL}${REVERSE_ON}`);
    const small = text(
      buildOrderReceipt(order, 80, { lineStyles: { payment: { size: 10, bold: true } } }),
    );
    expect(small).toContain(`${BOLD_ON}${REVERSE_ON}`);
    expect(small).not.toContain(`${TALL}${REVERSE_ON}`);
  });

  it("drops junk from a saved style", () => {
    expect(
      readLineStyles({
        defaults: {
          lineStyles: { channel: { size: 99, bold: "yes" }, nonsense: { size: 5 }, table: {} },
        },
      }),
    ).toEqual({ channel: { size: 30 } });
  });
});
