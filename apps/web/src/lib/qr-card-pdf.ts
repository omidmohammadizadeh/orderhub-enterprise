// "Scan to order" QR card → a real PDF file, with no PDF library.
//
// Printing to PDF through the browser dialog works, but operators asked for
// a downloadable file they can hand to a print shop for card stock — that
// needs an actual .pdf, and pulling in jsPDF (~350KB) for one A6 card would
// be the wrong trade.
//
// The trick that makes this small: PDF supports JPEG natively via the
// DCTDecode filter, so a canvas-rendered QR can be embedded byte-for-byte
// with no compression code of our own. Text uses Helvetica-Bold, one of the
// 14 standard fonts every reader has built in, so nothing is embedded.
//
// Output is A6 (105 × 148 mm) portrait — the usual table-tent / card size.

const MM = 72 / 25.4; // PDF units are points
const PAGE_W = 105 * MM;
const PAGE_H = 148 * MM;

/** Escape the few characters that would break a PDF literal string. */
function pdfText(s: string): string {
  return s.replace(/[\\()]/g, (c) => `\\${c}`);
}

/**
 * Width of a string in Helvetica-Bold at size 1, good enough to centre
 * text. Real metrics vary per glyph; 0.58em is the average for caps +
 * lowercase in this face and lands within a couple of points on the short
 * strings we print. Centring is forgiving; kerning is not worth 3KB of
 * width tables.
 */
function approxWidth(s: string, size: number): number {
  return s.length * size * 0.58;
}

/**
 * Build the PDF from an already-rendered QR <canvas>.
 *
 * Taking a canvas rather than SVG markup is deliberate. The first version
 * serialised the on-screen <svg> and loaded it through an Image, which
 * fails in the browser: React does not put an `xmlns` on the element it
 * renders, so `outerHTML` is not a standalone SVG document and the image
 * load errors out. A canvas is already pixels — toDataURL cannot fail
 * that way, and there is no async image load to go wrong at all.
 */
export async function buildQrCardPdf(opts: {
  canvas: HTMLCanvasElement;
  title: string;
  subtitle?: string;
  url: string;
}): Promise<Blob> {
  const jpeg = canvasToJpeg(opts.canvas);
  const qrPx = opts.canvas.width;

  // ── Page geometry ──────────────────────────────────────────────────
  const qrSize = 62 * MM;
  const qrX = (PAGE_W - qrSize) / 2;
  const qrY = PAGE_H - 52 * MM - qrSize;

  const titleSize = 30;
  const subSize = 12;
  const urlSize = 7;

  const title = pdfText(opts.title);
  const subtitle = pdfText(opts.subtitle ?? "Scan to order");
  const url = pdfText(opts.url);

  const content = [
    "q",
    // Image XObject, placed by the current transformation matrix.
    `${qrSize.toFixed(2)} 0 0 ${qrSize.toFixed(2)} ${qrX.toFixed(2)} ${qrY.toFixed(2)} cm`,
    "/Im0 Do",
    "Q",
    "BT",
    `/F1 ${titleSize} Tf`,
    `${((PAGE_W - approxWidth(title, titleSize)) / 2).toFixed(2)} ${(PAGE_H - 30 * MM).toFixed(2)} Td`,
    `(${title}) Tj`,
    "ET",
    "BT",
    `/F1 ${subSize} Tf`,
    `${((PAGE_W - approxWidth(subtitle, subSize)) / 2).toFixed(2)} ${(PAGE_H - 38 * MM).toFixed(2)} Td`,
    `(${subtitle}) Tj`,
    "ET",
    "BT",
    `/F1 ${urlSize} Tf`,
    "0.6 0.6 0.6 rg",
    `${((PAGE_W - approxWidth(url, urlSize)) / 2).toFixed(2)} ${(22 * MM).toFixed(2)} Td`,
    `(${url}) Tj`,
    "ET",
  ].join("\n");

  return assemblePdf(content, jpeg, qrPx);
}

/**
 * Canvas → JPEG bytes. A QR is pure black-on-white, so JPEG's chroma loss
 * is invisible and 0.92 keeps the modules crisp at print resolution.
 *
 * The source canvas is copied onto a white one first: qrcode.react leaves
 * the quiet zone transparent, and JPEG has no alpha, so drawing it
 * directly would turn the margin black and make the code unscannable.
 */
function canvasToJpeg(src: HTMLCanvasElement): Uint8Array {
  const flat = document.createElement("canvas");
  flat.width = src.width;
  flat.height = src.height;
  const ctx = flat.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(src, 0, 0);

  const dataUrl = flat.toDataURL("image/jpeg", 0.92);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Stitch the objects into a valid PDF. Offsets in the xref table must be
 * byte offsets, so the whole file is built as bytes and measured as it
 * goes — counting characters would break the moment a non-ASCII glyph
 * appeared in a table name.
 */
function assemblePdf(
  content: string,
  jpeg: Uint8Array,
  qrPx: number,
): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;

  const push = (chunk: Uint8Array | string) => {
    const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const startObject = () => offsets.push(length);

  push("%PDF-1.4\n");

  startObject();
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  startObject();
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

  startObject();
  push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W.toFixed(2)} ${PAGE_H.toFixed(2)}] ` +
      `/Resources << /Font << /F1 5 0 R >> /XObject << /Im0 6 0 R >> >> /Contents 4 0 R >>\nendobj\n`,
  );

  startObject();
  const contentBytes = enc.encode(content);
  push(`4 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
  push(contentBytes);
  push("\nendstream\nendobj\n");

  startObject();
  push(
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n",
  );

  startObject();
  push(
    `6 0 obj\n<< /Type /XObject /Subtype /Image /Width ${qrPx} /Height ${qrPx} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  push(jpeg);
  push("\nendstream\nendobj\n");

  const xrefStart = length;
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(
    `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );

  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}
