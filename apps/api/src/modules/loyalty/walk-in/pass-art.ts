import sharp from "sharp";
import { REWARD_ICON_SVG, stampIconSvg } from "@orderhub/shared";

// The pictures on a wallet pass, drawn on the server.
//
// The STRIP is the row of stamps across the middle of the pass — the thing a
// customer actually looks at. It depends only on (stamps, stampsRequired,
// colour), so the same picture serves Apple (bundled into the .pkpass) and
// Google (fetched by URL), and it can be cached forever per combination.
//
// No text is drawn: Render's image has no fonts librsvg can rely on, and a
// missing font renders as boxes. Everything here is shapes.

const DEFAULT_COLOR = "#1F2937";

export function safeColor(hex: string | null | undefined): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex ?? "") ? (hex as string).toUpperCase() : DEFAULT_COLOR;
}

/** Black or white text, whichever reads on this background. */
export function foregroundFor(hex: string): string {
  const c = safeColor(hex);
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#111111" : "#FFFFFF";
}

export function rgb(hex: string): string {
  const c = safeColor(hex);
  return `rgb(${parseInt(c.slice(1, 3), 16)}, ${parseInt(c.slice(3, 5), 16)}, ${parseInt(c.slice(5, 7), 16)})`;
}

/** Lighten (amount > 0) or darken (< 0) a colour by mixing with white/black. */
function shade(hex: string, amount: number): string {
  const c = safeColor(hex);
  const mix = amount > 0 ? 255 : 0;
  const t = Math.abs(amount);
  const ch = (i: number) =>
    Math.round(parseInt(c.slice(i, i + 2), 16) * (1 - t) + mix * t)
      .toString(16)
      .padStart(2, "0");
  return `#${ch(1)}${ch(3)}${ch(5)}`;
}

// Stamp pictures come from the shared icon set (STAMP_ICONS) so the pass, the
// card page, the till and the poster draw the same thing; the last slot is
// always the gift.
const GIFT = REWARD_ICON_SVG;

/**
 * The stamp row. `scale` 1/2/3 for Apple's @1x/@2x/@3x (375×123 points);
 * Google displays it as a wide image module and is happy with @3x.
 */
export async function renderStampStrip(
  stamps: number,
  required: number,
  color: string,
  scale = 3,
  icon?: string | null,
): Promise<Buffer> {
  const CUP = stampIconSvg(icon);
  const W = 375;
  const H = 123;
  const bg = safeColor(color);
  const fg = foregroundFor(bg);
  const filled = Math.max(0, Math.min(stamps, required));

  // One row up to 10 stamps, two rows beyond that (the card allows 20).
  const rows = required > 10 ? 2 : 1;
  const perRow = Math.ceil(required / rows);
  const gap = 8;
  const maxD = rows === 1 ? 56 : 44;
  const d = Math.min(maxD, (W - 32 - gap * (perRow - 1)) / perRow);
  const rowW = perRow * d + (perRow - 1) * gap;
  const x0 = (W - rowW) / 2;
  const totalH = rows * d + (rows - 1) * gap;
  const y0 = (H - totalH) / 2;

  const ringEmpty = fg === "#FFFFFF" ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.25)";
  const fillEmpty = fg === "#FFFFFF" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)";

  let slots = "";
  for (let i = 0; i < required; i++) {
    const r = Math.floor(i / perRow);
    const c = i % perRow;
    const cx = x0 + c * (d + gap) + d / 2;
    const cy = y0 + r * (d + gap) + d / 2;
    const on = i < filled;
    const last = i === required - 1;
    const glyph = last ? GIFT : CUP;
    const g = d * 0.62;
    const gx = cx - g / 2;
    const gy = cy - g / 2;
    if (on) {
      slots +=
        `<circle cx="${cx}" cy="${cy}" r="${d / 2}" fill="${fg}"/>` +
        `<g transform="translate(${gx} ${gy}) scale(${g / 24})" fill="${bg}" stroke="${bg}">${glyph}</g>`;
    } else {
      slots +=
        `<circle cx="${cx}" cy="${cy}" r="${d / 2 - 1.25}" fill="${fillEmpty}" stroke="${ringEmpty}" stroke-width="2.5"` +
        `${last ? "" : ' stroke-dasharray="4 4"'}/>` +
        `<g transform="translate(${gx} ${gy}) scale(${g / 24})" fill="${ringEmpty}" stroke="${ringEmpty}" opacity="${last ? 1 : 0.9}">${glyph}</g>`;
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W * scale}" height="${H * scale}" viewBox="0 0 ${W} ${H}">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${shade(bg, 0.08)}"/><stop offset="1" stop-color="${shade(bg, -0.12)}"/>` +
    `</linearGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>` +
    slots +
    `</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Fetch a remote image with a short timeout; null on any failure. */
export async function fetchImage(url: string | null | undefined): Promise<Buffer | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // Make sure sharp can actually read it before anyone relies on it.
    await sharp(buf).metadata();
    return buf;
  } catch {
    return null;
  }
}

/**
 * The square icon (Apple's lock-screen notification icon; Google's programme
 * logo). The shop's logo on white, or a star on the card colour without one.
 */
export async function renderIcon(
  logo: Buffer | null,
  color: string,
  size: number,
  icon?: string | null,
): Promise<Buffer> {
  if (logo) {
    const inner = Math.round(size * 0.84);
    const fitted = await sharp(logo)
      .resize(inner, inner, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .flatten({ background: "#ffffff" })
      .png()
      .toBuffer();
    return sharp({ create: { width: size, height: size, channels: 4, background: "#ffffff" } })
      .composite([{ input: fitted, gravity: "center" }])
      .png()
      .toBuffer();
  }
  const bg = safeColor(color);
  const fg = foregroundFor(bg);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">` +
    `<rect width="24" height="24" fill="${bg}"/>` +
    `<g transform="translate(4.2 4.2) scale(0.65)" fill="${fg}" stroke="${fg}">${stampIconSvg(icon)}</g></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Apple's logo slot: the logo fitted into 160×50 points, transparent. */
export async function renderPassLogo(logo: Buffer, scale: number): Promise<Buffer> {
  const h = 50 * scale;
  const w = 160 * scale;
  return sharp(logo)
    .resize(w, h, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer();
}
