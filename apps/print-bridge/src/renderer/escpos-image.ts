// Phase AS-6 — brand logo rasterizer.
//
// Thermal printers don't render colour photos — they're 1-bit per dot.
// To print a brand logo on the receipt header we have to:
//
//   1. Fetch the image URL (or decode a data: URL inline)
//   2. Resize so it fits the paper width (80mm ≈ 512 dots, 58mm ≈ 384)
//   3. Threshold to monochrome (per-pixel: black or white)
//   4. Pack 8 horizontal pixels per byte, MSB-first
//   5. Emit the ESC/POS raster bit-image command
//      GS v 0 m xL xH yL yH d1...dk
//
// Results are cached per URL in-process. A pizza shop reprints the same
// brand logo on every ticket — fetching + decoding it each time is wasted
// CPU and adds latency to the print pipeline. The cache is keyed on URL,
// has no TTL (logos rarely change, and the bridge restarts often enough
// in practice), and uses the rendered byte sequence directly so the hot
// path is a Map lookup.

// Jimp 0.22 ships its API as a default export with a CommonJS-style
// shape, so we import it via the namespace to get the Jimp.read static
// method and bitmap accessors without TS yelling about default-import
// compatibility.
import Jimp from "jimp";

const GS = 0x1d;

// Maximum width in dots we'll resize a logo to. 80mm Epson TM-m30 has
// 576 printable dots; we leave some margin so the logo doesn't span
// edge-to-edge. 58mm printers get a separate path with 256.
const MAX_DOTS_80MM = 384;
const MAX_DOTS_58MM = 256;

const cache = new Map<string, number[]>();

export async function renderLogo(
  url: string,
  paperWidth: 58 | 80,
): Promise<number[] | null> {
  if (!url) return null;
  const cacheKey = `${paperWidth}|${url}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  try {
    const img = await loadImage(url);
    if (!img) return null;

    const maxDots = paperWidth === 58 ? MAX_DOTS_58MM : MAX_DOTS_80MM;
    // Width is rounded DOWN to a multiple of 8 so the bit-packing below
    // produces complete bytes — anything past the last full byte would
    // print as garbage on the right edge.
    let targetW = Math.min(img.bitmap.width, maxDots);
    targetW = targetW - (targetW % 8);
    if (targetW < 8) return null;
    const scale = targetW / img.bitmap.width;
    const targetH = Math.max(1, Math.round(img.bitmap.height * scale));

    // jimp 0.22 uses positional args; the {w,h} object form was added
    // in jimp 1.x. Stuck on 0.22 because it's the last release that
    // still works in plain CommonJS without ESM bundler magic.
    img.resize(targetW, targetH);
    img.greyscale();

    // Floyd–Steinberg-lite (no error diffusion): a plain threshold is
    // fine for line-art logos which is what almost everyone uploads. If
    // we ever see a photographic logo and operators complain about
    // banding, swap in proper dithering — jimp ships an FS implementation
    // we can pull in via img.dither565().
    const threshold = 128;
    const widthBytes = targetW / 8;
    const data: number[] = new Array(widthBytes * targetH).fill(0);
    for (let y = 0; y < targetH; y++) {
      for (let x = 0; x < targetW; x++) {
        const px = img.getPixelColor(x, y);
        // Jimp packs r/g/b/a into one 32-bit int. Greyscale already
        // collapsed r=g=b, so grab the red channel.
        const lum = (px >>> 24) & 0xff;
        if (lum < threshold) {
          const byteIdx = y * widthBytes + (x >>> 3);
          const bit = 7 - (x & 7); // MSB is leftmost dot
          data[byteIdx] |= 1 << bit;
        }
      }
    }

    // GS v 0 m xL xH yL yH d1...dk
    //   m = 0 (normal density)
    //   xL/xH = bytes wide (little-endian)
    //   yL/yH = pixel rows (little-endian)
    const xL = widthBytes & 0xff;
    const xH = (widthBytes >> 8) & 0xff;
    const yL = targetH & 0xff;
    const yH = (targetH >> 8) & 0xff;
    const bytes: number[] = [GS, 0x76, 0x30, 0x00, xL, xH, yL, yH, ...data];

    cache.set(cacheKey, bytes);
    return bytes;
  } catch (err) {
    // Logo printing is a nice-to-have; never fail the receipt over it.
    console.warn(`[logo] render failed for ${url}: ${(err as any)?.message}`);
    return null;
  }
}

async function loadImage(url: string): Promise<any | null> {
  if (url.startsWith("data:")) {
    // data:image/png;base64,xxxx — strip the prefix and decode.
    const match = url.match(/^data:[^;]+;base64,(.+)$/);
    if (!match) return null;
    const buf = Buffer.from(match[1]!, "base64");
    return Jimp.read(buf);
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Jimp.read(Buffer.from(ab));
  }
  return null;
}
