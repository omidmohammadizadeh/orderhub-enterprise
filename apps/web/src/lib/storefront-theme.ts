// A storefront wears its brand's colour, not ours.
//
// The brand's colour is the accent: active tab underline, focus rings, the
// basket bar. Text sits on it, and a brand colour is chosen for a logo, not
// for contrast — white on a bright orange or yellow fails WCAG. So the fill
// behind text (`--sf-cta`) is the accent darkened just enough for white text
// to reach 4.5:1. It keeps the hue — it still reads as the brand — and no
// brand can pick a colour that makes its own checkout button unreadable.

import type { CSSProperties } from "react";

/** What a storefront looks like when its brand has no colour of its own. */
export const DEFAULT_STOREFRONT_ACCENT = "#f97316";

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

type Rgb = [number, number, number];

const parseHex = (hex: string): Rgb | null => {
  const match = HEX.exec(hex.trim());
  if (!match?.[1]) return null;
  const digits =
    match[1].length === 3
      ? match[1].split("").map((d) => d + d).join("")
      : match[1];
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as Rgb;
};

const toHex = ([r, g, b]: Rgb) =>
  `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: Rgb) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

const contrastWithWhite = (rgb: Rgb) => 1.05 / (luminance(rgb) + 0.05);

/** The accent, darkened until white text on it passes AA (4.5:1). */
const ctaFill = (rgb: Rgb): Rgb => {
  let fill = rgb;
  for (let step = 0; step < 20 && contrastWithWhite(fill) < 4.5; step++) {
    fill = fill.map((c) => c * 0.92) as Rgb;
  }
  return fill;
};

/** First usable hex colour out of whatever the payload carried. */
export const pickBrandColour = (
  ...candidates: Array<string | null | undefined>
): string | null =>
  candidates.find((c): c is string => !!c && HEX.test(c.trim())) ?? null;

/** CSS variables for the storefront root: `--sf-accent`, `--sf-cta`. */
export const storefrontThemeStyle = (
  brandColour: string | null | undefined,
): CSSProperties => {
  const accent =
    parseHex(brandColour ?? "") ?? (parseHex(DEFAULT_STOREFRONT_ACCENT) as Rgb);
  return {
    "--sf-accent": toHex(accent),
    "--sf-cta": toHex(ctaFill(accent)),
  } as CSSProperties;
};
