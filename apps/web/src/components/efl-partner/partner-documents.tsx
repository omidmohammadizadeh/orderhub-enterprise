"use client";

// Turns a picked ID or bank statement into the data: URL the API takes.
// Photos are downscaled in the browser (longest side 2000px, JPEG 0.85) so a
// 12 MP phone picture fits; PDFs go as they are. The API refuses anything
// over 3.5 MB decoded, so the same limit is checked here before sending.

export const MAX_DOC_BYTES = 3_500_000;
export const DOC_TOO_BIG = "Each document must be under 3.5 MB. A photo of it is fine.";
export const DOC_WRONG_TYPE = "Documents must be a PDF, JPG or PNG.";

const MAX_SIDE = 2000;
const JPEG_QUALITY = 0.85;

export type PreparedDoc = { name: string; dataUrl: string; bytes: number };

export class DocumentError extends Error {}

function kindOf(file: File): "pdf" | "image" | null {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (type === "image/jpeg" || type === "image/png" || /\.(jpe?g|png)$/.test(name)) return "image";
  return null;
}

/** Bytes a base64 data: URL decodes to. */
export function decodedBytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new DocumentError("We couldn't read that file. Please try another."));
    reader.readAsDataURL(file);
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new DocumentError("We couldn't open that photo. Please try a JPG or PNG."));
    };
    img.src = url;
  });
}

async function downscaleImage(file: File): Promise<string> {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return readAsDataUrl(file);
  // JPEG has no transparency; paint white so a PNG scan doesn't turn black.
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

export async function prepareDocument(file: File): Promise<PreparedDoc> {
  const kind = kindOf(file);
  if (!kind) throw new DocumentError(DOC_WRONG_TYPE);
  let dataUrl = kind === "pdf" ? await readAsDataUrl(file) : await downscaleImage(file);
  // Some browsers hand back an empty type for a .pdf picked by name.
  if (kind === "pdf" && !dataUrl.startsWith("data:application/pdf")) {
    dataUrl = `data:application/pdf;base64,${dataUrl.slice(dataUrl.indexOf(",") + 1)}`;
  }
  const bytes = decodedBytes(dataUrl);
  if (bytes > MAX_DOC_BYTES) throw new DocumentError(DOC_TOO_BIG);
  return { name: file.name, dataUrl, bytes };
}
