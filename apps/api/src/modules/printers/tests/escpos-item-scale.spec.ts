import { renderToEscPos } from "../escpos-renderer";

// "Font size: Large" saved on a printer and printed identically to Standard —
// the settings drawer wrote fontScale/modifierScale and NOTHING read them.
// (The same bug in its previous form is described in printers-tab.tsx: a dead
// `largeFont` boolean that "saved but never reached the renderer".)
//
// These assert the emitted BYTES, because that is the only place the bug was
// visible: every layer above it looked correct.

const ESC = 0x1b;
const GS = 0x1d;
const BOLD_ON = [ESC, 0x45, 0x01];
const BOLD_OFF = [ESC, 0x45, 0x00];
const SCALE_NORMAL = [GS, 0x21, 0x00];
const SCALE_DOUBLE_H = [GS, 0x21, 0x01];
const SCALE_DOUBLE_HW = [GS, 0x21, 0x11];

const PAYLOAD = {
  kind: "CUSTOMER_RECEIPT",
  locationName: "Pizza Uno",
  items: [
    {
      name: "Cheeseburger",
      quantity: 2,
      modifiers: [{ name: "Extra cheese" }],
      notes: "no pickles",
    },
  ],
  total: 12.5,
};

/** Does `haystack` contain this exact byte run? */
function containsBytes(buf: Buffer, needle: number[]): boolean {
  return buf.indexOf(Buffer.from(needle)) !== -1;
}

/** Byte offset of a UTF-8 string in the buffer, or -1. */
function offsetOf(buf: Buffer, text: string): number {
  return buf.indexOf(Buffer.from(text, "utf8"));
}

describe("escpos renderer — item scale", () => {
  it("leaves the item block at normal size on Standard", () => {
    // NB the ticket already contains GS ! 0x11 — the shop-name header prints
    // double size regardless. What must be true is that the ITEM block is not
    // scaled: the last size command before the item name is a reset.
    const buf = renderToEscPos(PAYLOAD, { paperWidth: 80 });
    const itemAt = offsetOf(buf, "2x Cheeseburger");
    const lastUp = Math.max(
      buf.lastIndexOf(Buffer.from(SCALE_DOUBLE_H), itemAt),
      buf.lastIndexOf(Buffer.from(SCALE_DOUBLE_HW), itemAt),
    );
    const lastReset = buf.lastIndexOf(Buffer.from(SCALE_NORMAL), itemAt);
    expect(lastReset).toBeGreaterThan(lastUp);
  });

  it("prints item headlines at double height on LARGE", () => {
    const buf = renderToEscPos(PAYLOAD, { paperWidth: 80, fontScale: "LARGE" });
    expect(containsBytes(buf, SCALE_DOUBLE_H)).toBe(true);
    // The scale is set before the item name, not after it.
    expect(buf.indexOf(Buffer.from(SCALE_DOUBLE_H))).toBeLessThan(
      offsetOf(buf, "2x Cheeseburger"),
    );
  });

  it("prints item headlines double height AND width on XLARGE", () => {
    const buf = renderToEscPos(PAYLOAD, { paperWidth: 80, fontScale: "XLARGE" });
    expect(containsBytes(buf, SCALE_DOUBLE_HW)).toBe(true);
  });

  it("resets to normal size before the totals block", () => {
    // An unreset GS ! turns the whole rest of the ticket into a poster —
    // totals, address and footer would all inherit double height.
    const buf = renderToEscPos(PAYLOAD, { paperWidth: 80, fontScale: "XLARGE" });
    const lastScaleUp = buf.lastIndexOf(Buffer.from(SCALE_DOUBLE_HW));
    const totalAt = offsetOf(buf, "TOTAL");
    expect(lastScaleUp).toBeGreaterThan(-1);
    expect(totalAt).toBeGreaterThan(-1);
    const resetAfter = buf.indexOf(Buffer.from(SCALE_NORMAL), lastScaleUp);
    expect(resetAfter).toBeGreaterThan(lastScaleUp);
    expect(resetAfter).toBeLessThan(totalAt);
  });

  it("sizes modifiers independently of the item headline", () => {
    // A twelve-option meal deal at double height runs a lot of paper, so big
    // items must not drag the options up with them.
    const buf = renderToEscPos(PAYLOAD, {
      paperWidth: 80,
      fontScale: "LARGE",
      modifierScale: "NORMAL",
    });
    const modAt = offsetOf(buf, "+ Extra cheese");
    const scaleBeforeMod = buf.lastIndexOf(Buffer.from(SCALE_DOUBLE_H), modAt);
    const resetBeforeMod = buf.lastIndexOf(Buffer.from(SCALE_NORMAL), modAt);
    expect(resetBeforeMod).toBeGreaterThan(scaleBeforeMod);
  });

  it("scales modifiers when asked", () => {
    const buf = renderToEscPos(PAYLOAD, {
      paperWidth: 80,
      modifierScale: "LARGE",
    });
    const modAt = offsetOf(buf, "+ Extra cheese");
    expect(buf.lastIndexOf(Buffer.from(SCALE_DOUBLE_H), modAt)).toBeGreaterThan(-1);
  });

  it("treats an unknown stored value as Standard rather than throwing", () => {
    // defaults is free-form JSON; a stale or hand-edited value must not take
    // printing down.
    const buf = renderToEscPos(PAYLOAD, {
      paperWidth: 80,
      fontScale: "HUGE" as any,
    });
    expect(containsBytes(buf, SCALE_DOUBLE_H)).toBe(false);
  });
});

describe("escpos renderer — bold items", () => {
  it("bolds item headlines by default", () => {
    const buf = renderToEscPos(PAYLOAD, { paperWidth: 80 });
    const itemAt = offsetOf(buf, "2x Cheeseburger");
    expect(buf.lastIndexOf(Buffer.from(BOLD_ON), itemAt)).toBeGreaterThan(-1);
  });

  it("still bolds when boldItems is explicitly true", () => {
    const buf = renderToEscPos(PAYLOAD, { paperWidth: 80, boldItems: true });
    const itemAt = offsetOf(buf, "2x Cheeseburger");
    const boldAt = buf.lastIndexOf(Buffer.from(BOLD_ON), itemAt);
    const offAt = buf.lastIndexOf(Buffer.from(BOLD_OFF), itemAt);
    expect(boldAt).toBeGreaterThan(offAt);
  });

  it("drops the bold command when switched off", () => {
    const buf = renderToEscPos(PAYLOAD, { paperWidth: 80, boldItems: false });
    const itemAt = offsetOf(buf, "2x Cheeseburger");
    const boldAt = buf.lastIndexOf(Buffer.from(BOLD_ON), itemAt);
    const offAt = buf.lastIndexOf(Buffer.from(BOLD_OFF), itemAt);
    // Whatever bold ran earlier (the header) must be closed before the item.
    expect(offAt).toBeGreaterThan(boldAt);
  });

  it("keeps TOTAL bold even when item bold is off", () => {
    // The toggle is about the item block, not the whole ticket.
    const buf = renderToEscPos(PAYLOAD, { paperWidth: 80, boldItems: false });
    const totalAt = offsetOf(buf, "TOTAL");
    expect(buf.lastIndexOf(Buffer.from(BOLD_ON), totalAt)).toBeGreaterThan(-1);
  });
});
