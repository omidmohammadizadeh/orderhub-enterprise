import { describe, expect, it } from "vitest";
import { rasterHasInk } from "./bridge";
import { describeQrDecision } from "./print-order";

// Grill Stop's QR slips printed the caption over an empty square (2026-10-15).
// The QR is drawn to a canvas and read back; the read could beat the paint and
// capture a blank square, and that blank was cached for the whole session
// under the brand's link. rasterHasInk is the gate that stops a blank being
// kept or sent.

const header = [0x1d, 0x76, 0x30, 0x00, 2, 0, 2, 0]; // GS v 0, 16x2 dots

describe("rasterHasInk", () => {
  it("is false for an all-white bitmap", () => {
    expect(rasterHasInk([...header, 0, 0, 0, 0])).toBe(false);
  });

  it("is true once any dot is set", () => {
    expect(rasterHasInk([...header, 0, 0, 0x80, 0])).toBe(true);
  });

  it("ignores the header's own non-zero bytes", () => {
    // The width/height bytes are never ink.
    expect(rasterHasInk(header)).toBe(false);
  });
});

describe("describeQrDecision", () => {
  it("marks an auto-print so the log tells it from a reprint", () => {
    const d = describeQrDecision({
      printer: { name: "Till", defaults: { qrDetached: true } },
      renderOpts: { qrCode: true, qrDialect: "RASTER" },
      order: { orderSource: "JUST_EAT", brandId: "b1" },
      offer: { url: "https://x/brand/grill-stop", caption: "c", logoUrl: null, isMarketplace: true },
      payload: { qrData: "https://x/brand/grill-stop" },
      qrSlip: new Uint8Array(10),
      receiptWithQr: new Uint8Array(20),
      auto: true,
    });
    expect(d).toMatchObject({
      printer: "Till",
      auto: true,
      dialect: "RASTER",
      marketplace: true,
      qrData: "yes",
      detachedOpt: true,
      slipBytes: 10,
      withQrBytes: 20,
    });
  });
});
