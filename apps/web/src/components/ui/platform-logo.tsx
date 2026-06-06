"use client";

// Phase AM / AP — branded square logo tile for each publish target.
//
// Strategy: prefer an operator-uploaded PNG from /brand-logos/{slug}.png
// (lives in apps/web/public/brand-logos/). If the file 404s — file
// missing, typo, not yet uploaded — we silently swap to the inline
// SVG fallback so the UI never shows a broken-image icon. This lets
// the operator drop real brand marks once and have them appear on:
//
//   • Marketing site (header / marquee / footer / mega-menu)
//   • POS publish modal
//   • Orders board platform badges
//   • Locations → Brands → platform connection cards
//   • Menu import / publish dialogs
//
// The fallback SVGs are deliberate simplifications of each platform's
// wordmark — Just Eat house, Deliveroo "V", Uber Eats stacked
// wordmark, etc. They keep the UI legible even before the operator
// uploads anything, and they sidestep any image-licensing concerns.

import { useState } from "react";

interface LogoProps {
  size: number;
  rounded?: boolean;
}

function tileStyle(size: number, rounded: boolean) {
  return {
    width: size,
    height: size,
    borderRadius: rounded ? size * 0.18 : 0,
    display: "inline-block",
    flexShrink: 0,
  } as const;
}

function JustEatLogo({ size, rounded = true }: LogoProps) {
  // Just Eat fallback — orange tile + house + cutlery.
  return (
    <svg
      viewBox="0 0 100 100"
      style={tileStyle(size, rounded)}
      aria-label="Just Eat"
    >
      <rect width="100" height="100" fill="#ff8000" />
      <path
        d="M 50 18 L 84 50 L 78 50 L 78 86 L 22 86 L 22 50 L 16 50 Z"
        fill="white"
      />
      <rect x="64" y="26" width="8" height="14" fill="white" />
      <g fill="#ff8000">
        <rect x="34" y="50" width="2" height="10" />
        <rect x="38" y="50" width="2" height="10" />
        <rect x="42" y="50" width="2" height="10" />
        <rect x="33" y="60" width="12" height="3" />
        <rect x="37" y="63" width="4" height="20" />
        <path d="M 56 50 L 64 50 L 60 70 L 60 70 L 60 70 Z" />
        <path d="M 56 50 Q 56 62 60 70 L 60 70 L 64 50 Z" />
        <rect x="58" y="70" width="4" height="14" />
      </g>
    </svg>
  );
}

function DeliverooLogo({ size, rounded = true }: LogoProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      style={tileStyle(size, rounded)}
      aria-label="Deliveroo"
    >
      <rect width="100" height="100" fill="#00ccbc" />
      <path
        fill="white"
        d="M 24 22 Q 24 18 28 18 L 38 18 Q 41 18 42 21 L 50 56 L 58 21 Q 59 18 62 18 L 72 18 Q 76 18 76 22 Q 76 24 75.5 25.5 L 60 74 Q 58 80 52 80 L 48 80 Q 42 80 40 74 L 24.5 25.5 Q 24 24 24 22 Z"
      />
    </svg>
  );
}

function UberEatsLogo({ size, rounded = true }: LogoProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      style={tileStyle(size, rounded)}
      aria-label="Uber Eats"
    >
      <rect width="100" height="100" fill="black" />
      <text x="50" y="46" textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="800" fontSize="24" fill="white">Uber</text>
      <text x="50" y="74" textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="800" fontSize="24" fill="#06c167">Eats</text>
    </svg>
  );
}

function UberDirectLogo({ size, rounded = true }: LogoProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      style={tileStyle(size, rounded)}
      aria-label="Uber Direct"
    >
      <rect width="100" height="100" fill="black" />
      <text x="50" y="46" textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="800" fontSize="22" fill="white">Uber</text>
      <text x="50" y="74" textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="700" fontSize="14" fill="#9ca3af">DIRECT</text>
    </svg>
  );
}

function StuartLogo({ size, rounded = true }: LogoProps) {
  // Stuart courier — orange #ff5a1a with a white "S" wordmark stub.
  return (
    <svg
      viewBox="0 0 100 100"
      style={tileStyle(size, rounded)}
      aria-label="Stuart"
    >
      <rect width="100" height="100" fill="#ff5a1a" />
      <text x="50" y="72" textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="900" fontSize="62" fill="white">S</text>
    </svg>
  );
}

function OrderHubLogo({ size, rounded = true }: LogoProps) {
  // POS / DIRECT fallback — bag silhouette with stacked wordmark.
  return (
    <svg
      viewBox="0 0 100 100"
      style={tileStyle(size, rounded)}
      aria-label="Order Hub"
    >
      <rect width="100" height="100" fill="black" />
      <path d="M 28 28 L 28 22 Q 28 14 38 14 L 62 14 Q 72 14 72 22 L 72 28" stroke="white" strokeWidth="2.5" fill="none" />
      <circle cx="62" cy="22" r="5" fill="white" />
      <path d="M 59 22 L 61 24 L 65 20" stroke="black" strokeWidth="2" fill="none" />
      <text x="50" y="55" textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="900" fontSize="14" fill="white" letterSpacing="-0.5">ORDER</text>
      <text x="50" y="72" textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="900" fontSize="14" fill="white" letterSpacing="-0.5">HUB</text>
      <text x="50" y="88" textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="700" fontSize="9" fill="white">POS</text>
    </svg>
  );
}

function OnlineLogo({ size, rounded = true }: LogoProps) {
  return (
    <svg viewBox="0 0 100 100" style={tileStyle(size, rounded)} aria-label="Online">
      <rect width="100" height="100" fill="#f97316" />
      <circle cx="50" cy="50" r="28" stroke="white" strokeWidth="4" fill="none" />
      <ellipse cx="50" cy="50" rx="14" ry="28" stroke="white" strokeWidth="3" fill="none" />
      <line x1="22" y1="50" x2="78" y2="50" stroke="white" strokeWidth="3" />
    </svg>
  );
}

function HubRiseLogo({ size, rounded = true }: LogoProps) {
  return (
    <svg viewBox="0 0 100 100" style={tileStyle(size, rounded)} aria-label="HubRise">
      <rect width="100" height="100" fill="#7c3aed" />
      <text x="50" y="68" textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="900" fontSize="56" fill="white">H</text>
    </svg>
  );
}

// Map each canonical platform key to:
//   slug  — the PNG filename the operator uploads at /brand-logos/{slug}.png
//   bg    — brand background colour (sits behind the PNG; if the PNG has
//           transparency the colour shows through, giving us a clean
//           branded tile even for cropped PNGs)
//   svg   — fallback element if the PNG 404s
const PLATFORM_META: Record<
  string,
  { slug: string; bg: string; svg: (p: LogoProps) => React.ReactElement }
> = {
  JUST_EAT:    { slug: "justeat",    bg: "#ff8000", svg: (p) => <JustEatLogo {...p} /> },
  DELIVEROO:   { slug: "deliveroo",  bg: "#00ccbc", svg: (p) => <DeliverooLogo {...p} /> },
  UBER_EATS:   { slug: "ubereats",   bg: "#000000", svg: (p) => <UberEatsLogo {...p} /> },
  UBER_DIRECT: { slug: "uberdirect", bg: "#000000", svg: (p) => <UberDirectLogo {...p} /> },
  STUART:      { slug: "stuart",     bg: "#ff5a1a", svg: (p) => <StuartLogo {...p} /> },
  HUBRISE:     { slug: "hubrise",    bg: "#7c3aed", svg: (p) => <HubRiseLogo {...p} /> },
  POS:         { slug: "orderhub",   bg: "#0a0a0a", svg: (p) => <OrderHubLogo {...p} /> },
  DIRECT:      { slug: "orderhub",   bg: "#0a0a0a", svg: (p) => <OrderHubLogo {...p} /> },
  ONLINE:      { slug: "online",     bg: "#f97316", svg: (p) => <OnlineLogo {...p} /> },
};

const LABELS: Record<string, string> = {
  JUST_EAT: "Just Eat",
  DELIVEROO: "Deliveroo",
  UBER_EATS: "Uber Eats",
  POS: "POS",
  DIRECT: "Direct",
  ONLINE: "Online ordering",
  HUBRISE: "HubRise",
  STUART: "Stuart",
  UBER_DIRECT: "Uber Direct",
};

interface Props {
  platform: string;
  /** Pixel size of the square — defaults to 32. */
  size?: number;
  /** Round the tile (default true). */
  rounded?: boolean;
  /** Show the label as a tooltip via title attribute. */
  title?: boolean;
}

export function PlatformLogo({
  platform,
  size = 32,
  rounded = true,
  title = true,
}: Props) {
  // Track whether the PNG asset 404'd so we can fall back to the SVG.
  // useState keyed on platform so swapping the badge between rows
  // resets the failed flag cleanly.
  const [imgFailed, setImgFailed] = useState(false);

  const meta = PLATFORM_META[platform];

  const wrap = (child: React.ReactNode) => (
    <span
      title={title ? LABELS[platform] ?? platform : undefined}
      style={{ display: "inline-flex" }}
    >
      {child}
    </span>
  );

  if (!meta) {
    // Unknown platform — render the two-letter placeholder pill.
    return wrap(
      <span
        className="grid place-items-center bg-zinc-300 text-zinc-600 font-bold text-[10px]"
        style={tileStyle(size, rounded)}
      >
        {platform.slice(0, 2)}
      </span>,
    );
  }

  if (imgFailed) {
    return wrap(meta.svg({ size, rounded }));
  }

  // Show the operator-uploaded PNG inside a brand-coloured tile. The
  // background colour means PNGs with transparency look intentional
  // (logo floats over the brand colour) and PNGs without transparency
  // simply hide the wrapper colour completely.
  return wrap(
    <span
      style={{
        ...tileStyle(size, rounded),
        background: meta.bg,
        overflow: "hidden",
        display: "inline-grid",
        placeItems: "center",
      }}
    >
      <img
        src={`/brand-logos/${meta.slug}.png`}
        alt={LABELS[platform] ?? platform}
        width={size}
        height={size}
        loading="eager"
        onError={() => setImgFailed(true)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          display: "block",
        }}
      />
    </span>,
  );
}

export function platformLabel(platform: string): string {
  return LABELS[platform] ?? platform;
}
