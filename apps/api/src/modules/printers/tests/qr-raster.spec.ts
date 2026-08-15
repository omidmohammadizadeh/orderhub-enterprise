import * as QRCode from "qrcode";
import { qrRasterBytes, qrRasterBase64 } from "../qr-raster";

// A LAN printer is rendered inside the API, which has no canvas, so the
// marketplace QR has to be rasterised here. Sunmi accepts `GS ( k` and prints
// nothing at all, so `GS v 0` pixels are the only thing that works — which
// means a mistake here is a receipt with a black smear on it, or a symbol no
// phone will read. These tests check the bytes, and reconstruct the symbol
// back out of them to prove the pixels say what the QR encoder said.

const URL = "https://www.orderhubsolutions.com/order/cmssni4mh04fkqigg35v9d1fh";

/** Pull the GS v 0 header back apart. */
function parse(bytes: number[]) {
  expect(bytes.slice(0, 4)).toEqual([0x1d, 0x76, 0x30, 0x00]);
  const rowBytes = bytes[4] | (bytes[5] << 8);
  const height = bytes[6] | (bytes[7] << 8);
  return { rowBytes, height, data: bytes.slice(8) };
}

const bitAt = (
  d: number[],
  rowBytes: number,
  x: number,
  y: number,
): 0 | 1 => ((d[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1) as 0 | 1;

describe("QR raster — the command", () => {
  it("emits a well-formed GS v 0 with a body matching its header", () => {
    // A length that disagrees with the header is how a printer ends up
    // eating the rest of the ticket as bitmap data.
    const { rowBytes, height, data } = parse(qrRasterBytes(URL, { paperWidth: 80 }));
    expect(data).toHaveLength(rowBytes * height);
  });

  it("stays inside the paper", () => {
    for (const paperWidth of [58, 80] as const) {
      const { rowBytes } = parse(qrRasterBytes(URL, { paperWidth }));
      const printable = paperWidth === 58 ? 384 : 576;
      expect(rowBytes * 8).toBeLessThanOrEqual(printable);
    }
  });

  it("is square", () => {
    const { rowBytes, height } = parse(qrRasterBytes(URL, { paperWidth: 80 }));
    // rowBytes includes the centring pad, so compare against the symbol.
    expect(height).toBeGreaterThan(0);
    expect(height).toBeLessThanOrEqual(rowBytes * 8);
  });

  it("gives a bigger symbol on 80mm than on 58mm", () => {
    const wide = parse(qrRasterBytes(URL, { paperWidth: 80 })).height;
    const narrow = parse(qrRasterBytes(URL, { paperWidth: 58 })).height;
    expect(wide).toBeGreaterThan(narrow);
  });

  it("is deterministic", () => {
    // Same order reprinted must produce the same ticket.
    expect(qrRasterBytes(URL, { paperWidth: 80 })).toEqual(
      qrRasterBytes(URL, { paperWidth: 80 }),
    );
  });

  it("keeps a white quiet zone all the way round", () => {
    // Without it most phone cameras won't lock on, and the failure looks
    // like "the printer is fine, the QR just doesn't scan".
    const { rowBytes, height, data } = parse(qrRasterBytes(URL, { paperWidth: 80 }));
    const width = rowBytes * 8;
    const rowIsWhite = (y: number) =>
      data.slice(y * rowBytes, (y + 1) * rowBytes).every((b) => b === 0);

    expect(rowIsWhite(0)).toBe(true);
    expect(rowIsWhite(height - 1)).toBe(true);
    for (let y = 0; y < height; y++) {
      expect(bitAt(data, rowBytes, 0, y)).toBe(0);
      expect(bitAt(data, rowBytes, width - 1, y)).toBe(0);
    }
  });

  it("actually has ink in it", () => {
    // Guards the silent disaster: a correctly-shaped, entirely blank raster.
    const { data } = parse(qrRasterBytes(URL, { paperWidth: 80 }));
    expect(data.some((b) => b !== 0)).toBe(true);
  });
});

describe("QR raster — the pixels say what the encoder said", () => {
  it("reproduces every module of the symbol", () => {
    // Read the bitmap back at the scale it was drawn and compare module for
    // module with the encoder's own matrix. This is the check that the code
    // is scannable — a transposed or off-by-one loop still produces a
    // plausible-looking square of noise.
    const bytes = qrRasterBytes(URL, { paperWidth: 80 });
    const { rowBytes, height, data } = parse(bytes);

    const qr = QRCode.create(URL, { errorCorrectionLevel: "M" });
    const size = qr.modules.size;
    const modules = qr.modules.data as any;

    const QUIET = 4;
    const scale = height / (size + QUIET * 2);
    expect(Number.isInteger(scale)).toBe(true);

    // Where the symbol starts: the encoder centres by prepending whole
    // blank bytes, so the pad is (rowBytes - the symbol's own byte width).
    const xOffset = (rowBytes - Math.ceil(height / 8)) * 8;

    for (let my = 0; my < size; my++) {
      for (let mx = 0; mx < size; mx++) {
        const expected = modules[my * size + mx] ? 1 : 0;
        // Sample the middle of the module, away from any edge.
        const x = xOffset + (mx + QUIET) * scale + Math.floor(scale / 2);
        const y = (my + QUIET) * scale + Math.floor(scale / 2);
        expect(bitAt(data, rowBytes, x, y)).toBe(expected);
      }
    }
  });

  it("draws each module as a solid square, not a single dot", () => {
    // A one-dot module is invisible to a camera at any realistic distance.
    const bytes = qrRasterBytes(URL, { paperWidth: 80 });
    const { rowBytes, height, data } = parse(bytes);
    const qr = QRCode.create(URL, { errorCorrectionLevel: "M" });
    const size = qr.modules.size;
    const scale = height / (size + 8);
    expect(scale).toBeGreaterThanOrEqual(3);

    // The finder pattern's top-left module is always dark — check the whole
    // scale×scale block is inked.
    const xOffset = (rowBytes - Math.ceil(height / 8)) * 8;
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        expect(
          bitAt(data, rowBytes, xOffset + 4 * scale + dx, 4 * scale + dy),
        ).toBe(1);
      }
    }
  });
});

describe("QR raster — base64 wrapper", () => {
  it("round-trips to the same bytes", () => {
    const b64 = qrRasterBase64(URL, { paperWidth: 80 })!;
    expect(Array.from(Buffer.from(b64, "base64"))).toEqual(
      qrRasterBytes(URL, { paperWidth: 80 }),
    );
  });

  it("returns null for nothing to encode rather than throwing", () => {
    // A ticket missing its marketing QR is a nuisance; a ticket that failed
    // to print is a lost order.
    expect(qrRasterBase64("", { paperWidth: 80 })).toBeNull();
    expect(qrRasterBase64("   ", { paperWidth: 80 })).toBeNull();
  });

  it("returns null for text too long to encode", () => {
    expect(qrRasterBase64("x".repeat(10_000), { paperWidth: 80 })).toBeNull();
  });
});
