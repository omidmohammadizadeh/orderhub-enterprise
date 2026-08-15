// ── Server-side QR rasteriser ───────────────────────────────────────────────
//
// Why a raster and not a QR command:
//
// Sunmi's firmware implements NO QR command. `GS ( k` (the ESC/POS model-2
// symbol, which is what escpos-renderer emits for its test print) is accepted
// and silently dropped — nothing prints, no error. `ESC Z` prints the raw URL
// as text. The only thing that reliably produces a scannable code on a Sunmi
// is sending the pixels ourselves as a `GS v 0` raster bitmap.
//
// The Bluetooth tablets already do exactly this in the browser, where they
// have a canvas. A LAN printer with no bound agent is rendered inside the API
// by ServerDirectPrintCron, which has no browser — so the marketplace "scan to
// order direct" QR simply never appeared on a LAN Sunmi, with nothing logged
// to say so.
//
// The raster is built ONCE when the print job is created and carried on the
// payload as base64. The renderer then just splices bytes in, which keeps it
// synchronous and keeps it byte-identical to its Print Bridge twin — both
// copies only ever emit bytes they were handed.

import * as QRCode from "qrcode";

/** ESC/POS `GS v 0` — print raster bit image. */
const GS = 0x1d;

export interface QrRasterOptions {
  /** Printable dot width: 384 for 58mm paper, 576 for 80mm. */
  paperWidth: 58 | 80;
  /**
   * Roughly how wide the finished symbol should be, in dots. Kept well
   * inside the paper so the quiet zone survives a slightly misaligned roll —
   * a QR printed to the edge is one the camera can't lock onto.
   */
  targetDots?: number;
}

/** Printable dots across, by paper size. */
function printableDots(paperWidth: 58 | 80): number {
  return paperWidth === 58 ? 384 : 576;
}

/**
 * Build the `GS v 0` command for a QR of `text`, centred on the paper.
 *
 * Returns raw bytes. Throws only if the text can't be encoded at all (too
 * long for the largest symbol) — callers treat that as "print without a QR"
 * rather than failing the ticket.
 */
export function qrRasterBytes(
  text: string,
  opts: QrRasterOptions,
): number[] {
  const paper = printableDots(opts.paperWidth);
  const target = opts.targetDots ?? Math.floor(paper * 0.45);

  // Medium correction: survives a thermal roll's smudging and the odd
  // partially-fed line without inflating the symbol the way High does.
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size: number = qr.modules.size;
  const data: Uint8Array | number[] = qr.modules.data as any;

  // 4-module quiet zone is part of the spec, not decoration — most phone
  // scanners will not read a symbol printed flush against other ink.
  const QUIET = 4;
  const totalModules = size + QUIET * 2;

  // Integer scale only. A fractional scale means some modules are a pixel
  // wider than others, which is what makes a printed QR read on one phone
  // and not the next.
  const scale = Math.max(1, Math.floor(target / totalModules));
  const widthDots = totalModules * scale;

  // Rows are whole bytes on the wire; pad the remainder with white.
  const bytesPerRow = Math.ceil(widthDots / 8);
  const heightDots = widthDots;
  const bitmap = new Uint8Array(bytesPerRow * heightDots);

  for (let my = 0; my < size; my++) {
    for (let mx = 0; mx < size; mx++) {
      if (!data[my * size + mx]) continue; // light module — leave white
      const x0 = (mx + QUIET) * scale;
      const y0 = (my + QUIET) * scale;
      for (let dy = 0; dy < scale; dy++) {
        const rowStart = (y0 + dy) * bytesPerRow;
        for (let dx = 0; dx < scale; dx++) {
          const x = x0 + dx;
          // 1 = black, MSB first within each byte.
          const idx = rowStart + (x >> 3);
          bitmap[idx] = (bitmap[idx] ?? 0) | (0x80 >> (x & 7));
        }
      }
    }
  }

  // Centre it by prepending whole blank bytes. Dot-level centring would
  // need a bit-shift of the whole bitmap for at most 7 dots of accuracy.
  const padBytes = Math.max(0, Math.floor((paper / 8 - bytesPerRow) / 2));
  const rowBytes = bytesPerRow + padBytes;
  const padded = new Uint8Array(rowBytes * heightDots);
  for (let y = 0; y < heightDots; y++) {
    padded.set(
      bitmap.subarray(y * bytesPerRow, (y + 1) * bytesPerRow),
      y * rowBytes + padBytes,
    );
  }

  return [
    GS,
    0x76,
    0x30,
    0x00, // m = 0: normal density
    rowBytes & 0xff,
    (rowBytes >> 8) & 0xff,
    heightDots & 0xff,
    (heightDots >> 8) & 0xff,
    ...padded,
  ];
}

/**
 * The same thing as base64, for carrying on a PrintJob payload.
 *
 * Returns null rather than throwing when the text can't be encoded: a ticket
 * missing its marketing QR is a nuisance, a ticket that failed to print is a
 * lost order.
 */
export function qrRasterBase64(
  text: string,
  opts: QrRasterOptions,
): string | null {
  try {
    if (!text?.trim()) return null;
    return Buffer.from(qrRasterBytes(text, opts)).toString("base64");
  } catch {
    return null;
  }
}
