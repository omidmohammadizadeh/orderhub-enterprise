import { renderToEscPos } from "../escpos-renderer";
import { paymentLabelFor } from "../formatters/receipt.formatter";

// The payment state is the one thing on a ticket that must not be misread: a
// driver handing over a CASH NOT PAID order without collecting is money gone.
// It used to print as centred bold text wrapped in asterisks, which reads as
// more text on a busy pass. It now prints as a full-width reverse-video band.

const GS = 0x1d;
const REVERSE_ON = [GS, 0x42, 0x01];
const REVERSE_OFF = [GS, 0x42, 0x00];
const SCALE_DOUBLE_H = [GS, 0x21, 0x01];
const SCALE_NORMAL = [GS, 0x21, 0x00];

const base = (paymentLabel: string) => ({
  kind: "CUSTOMER_RECEIPT",
  locationName: "Best Kebab",
  items: [{ name: "Parmo Wrap", quantity: 2, modifiers: [] }],
  total: 14.1,
  paymentLabel,
});

describe("paymentLabelFor — wording", () => {
  it("says CASH PAID when the money is in", () => {
    expect(paymentLabelFor("CASH", "PAID")).toBe("CASH PAID");
  });

  it("says CASH NOT PAID when it is still owed", () => {
    // Same wording for collection and delivery — cash is owed until someone
    // takes it, and the ticket should not need interpreting.
    expect(paymentLabelFor("CASH", "PENDING")).toBe("CASH NOT PAID");
    expect(paymentLabelFor("CASH", null)).toBe("CASH NOT PAID");
  });

  it("mirrors the same shape for card", () => {
    expect(paymentLabelFor("CARD", "PAID")).toBe("CARD PAID");
    expect(paymentLabelFor("CARD", "AUTHORIZED")).toBe("CARD PAID");
    expect(paymentLabelFor("CARD", "PENDING")).toBe("CARD NOT PAID");
  });

  it("does not claim cash on a phone collection order", () => {
    // The customer has not chosen yet and may tap a card at the counter;
    // asserting cash would have staff expecting notes.
    expect(paymentLabelFor("PAY_ON_COLLECTION", null)).toBe("PAY ON COLLECTION");
  });

  it("carries no asterisks — they would sit inside the highlight", () => {
    for (const [m, s] of [
      ["CASH", "PAID"],
      ["CASH", null],
      ["CARD", "PAID"],
      [null, null],
    ] as const) {
      expect(paymentLabelFor(m, s)).not.toContain("*");
    }
  });
});

describe("payment banner — rendering", () => {
  it("prints the label in reverse video", () => {
    const buf = renderToEscPos(base("CASH NOT PAID"), { paperWidth: 80 });
    const labelAt = buf.indexOf(Buffer.from("CASH NOT PAID", "utf8"));
    expect(labelAt).toBeGreaterThan(-1);
    const onAt = buf.lastIndexOf(Buffer.from(REVERSE_ON), labelAt);
    const offAt = buf.lastIndexOf(Buffer.from(REVERSE_OFF), labelAt);
    expect(onAt).toBeGreaterThan(offAt);
  });

  it("closes reverse video after the band", () => {
    // Leaving it on would invert the whole rest of the ticket.
    const buf = renderToEscPos(base("CASH NOT PAID"), { paperWidth: 80 });
    const labelAt = buf.indexOf(Buffer.from("CASH NOT PAID", "utf8"));
    expect(buf.indexOf(Buffer.from(REVERSE_OFF), labelAt)).toBeGreaterThan(labelAt);
  });

  it("pads the band to the full paper width so it reads as a block", () => {
    // 80mm = 42 columns. The point of the band is the solid bar; a highlight
    // hugging the words is just bold with extra steps.
    const buf = renderToEscPos(base("CASH NOT PAID"), { paperWidth: 80 });
    const onAt = buf.indexOf(Buffer.from(REVERSE_ON));
    const offAt = buf.indexOf(Buffer.from(REVERSE_OFF), onAt);
    const banner = buf
      .subarray(onAt + REVERSE_ON.length, offAt)
      .toString("utf8")
      .replace(/\n/g, "");
    expect(banner.length).toBe(42);
    expect(banner.trim()).toBe("CASH NOT PAID");
  });

  it("narrows the band on 58mm paper", () => {
    const buf = renderToEscPos(base("CASH PAID"), { paperWidth: 58 });
    const onAt = buf.indexOf(Buffer.from(REVERSE_ON));
    const offAt = buf.indexOf(Buffer.from(REVERSE_OFF), onAt);
    const banner = buf
      .subarray(onAt + REVERSE_ON.length, offAt)
      .toString("utf8")
      .replace(/\n/g, "");
    expect(banner.length).toBe(32);
  });

  it("prints the band at double height and resets after", () => {
    const buf = renderToEscPos(base("CASH NOT PAID"), { paperWidth: 80 });
    const labelAt = buf.indexOf(Buffer.from("CASH NOT PAID", "utf8"));
    expect(buf.lastIndexOf(Buffer.from(SCALE_DOUBLE_H), labelAt)).toBeGreaterThan(-1);
    expect(buf.indexOf(Buffer.from(SCALE_NORMAL), labelAt)).toBeGreaterThan(labelAt);
  });

  it("truncates an over-long label rather than wrapping the band", () => {
    // A band that spills onto a second line stops reading as a band.
    const long = "BILL - TO PAY £1234.56 AND SOME MORE TEXT THAT IS FAR TOO LONG";
    const buf = renderToEscPos(base(long), { paperWidth: 58 });
    const onAt = buf.indexOf(Buffer.from(REVERSE_ON));
    const offAt = buf.indexOf(Buffer.from(REVERSE_OFF), onAt);
    const banner = buf.subarray(onAt + REVERSE_ON.length, offAt).toString("utf8");
    expect(banner).not.toContain("\n");
    expect(banner.length).toBe(32);
  });
});
