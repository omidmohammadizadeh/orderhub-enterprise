"use client";

// Phase AP marketing — real brand marks for the partner / integrations
// strip and feature blocks.
//
// All brand tiles now load the operator-uploaded PNG from
// /brand-logos/{slug}.png (apps/web/public/brand-logos/). If a file
// 404s — typo or not yet uploaded — we silently fall back to either
// a purpose-built inline SVG (Uber Eats wordmark, HubRise "H") or to
// the simpleicons.org CDN (Stripe). That way the page never shows a
// broken-image icon and the visual identity stays cohesive even mid-
// upload.
//
// The companion BrandLogo lives in /components/ui/platform-logo.tsx
// — same approach, same slugs, same /brand-logos/ folder. Upload one
// PNG per platform and it appears across both surfaces.

import { useState } from "react";

export type BrandKey =
  | "deliveroo"
  | "justeat"
  | "ubereats"
  | "uberdirect"
  | "stuart"
  | "hubrise"
  | "orderhub"
  | "stripe";

interface Props {
  brand: BrandKey;
  /** Pixel size of the square tile. Defaults to 56. */
  size?: number;
  /** Round the tile corners. */
  rounded?: boolean;
  /** Show the brand name underneath the tile. */
  label?: boolean;
}

interface BrandMeta {
  name: string;
  /** Background colour shown behind transparent PNGs. */
  bg: string;
  /** Filename stem under /brand-logos/. Always lowercase. */
  slug: string;
  /** Optional simpleicons.org slug used as a CDN fallback. */
  iconSlug?: string;
}

const BRAND_META: Record<BrandKey, BrandMeta> = {
  deliveroo:  { name: "Deliveroo",     bg: "#00CCBC", slug: "deliveroo",  iconSlug: "deliveroo" },
  justeat:    { name: "Just Eat",      bg: "#FF8000", slug: "justeat",    iconSlug: "justeat" },
  ubereats:   { name: "Uber Eats",     bg: "#000000", slug: "ubereats" },
  uberdirect: { name: "Uber Direct",   bg: "#000000", slug: "uberdirect" },
  stuart:     { name: "Stuart",        bg: "#FF5A1A", slug: "stuart" },
  hubrise:    { name: "HubRise",       bg: "#7C3AED", slug: "hubrise" },
  orderhub:   { name: "Order Hub POS", bg: "#FFFFFF", slug: "orderhub" },
  stripe:     { name: "Stripe",        bg: "#635BFF", slug: "stripe",     iconSlug: "stripe" },
};

export function BrandLogo({ brand, size = 56, rounded = true, label }: Props) {
  const meta = BRAND_META[brand];
  const radius = rounded ? size * 0.18 : 0;
  const [primaryFailed, setPrimaryFailed] = useState(false);
  const [secondaryFailed, setSecondaryFailed] = useState(false);

  // Order Hub uses the existing /orderhub-logo.png the operator already
  // uploaded — keep that working without forcing them to duplicate the
  // file inside /brand-logos/.
  const primarySrc =
    brand === "orderhub"
      ? "/orderhub-logo.png"
      : `/brand-logos/${meta.slug}.png`;

  const secondarySrc =
    meta.iconSlug && !primaryFailed
      ? null
      : meta.iconSlug
        ? `https://cdn.simpleicons.org/${meta.iconSlug}/FFFFFF`
        : null;

  let mark: React.ReactNode;

  // Tier 1 — operator-uploaded PNG
  if (!primaryFailed) {
    mark = (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: meta.bg,
          display: "grid",
          placeItems: "center",
          overflow: "hidden",
          border: brand === "orderhub" ? "1px solid #e4e4e7" : undefined,
        }}
      >
        <img
          src={primarySrc}
          alt={`${meta.name} logo`}
          width={size * 0.88}
          height={size * 0.88}
          loading="eager"
          onError={() => setPrimaryFailed(true)}
          style={{ display: "block", objectFit: "contain" }}
        />
      </div>
    );
  }
  // Tier 2 — simpleicons CDN (only for brands where we have a slug)
  else if (secondarySrc && !secondaryFailed) {
    mark = (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: meta.bg,
          display: "grid",
          placeItems: "center",
        }}
      >
        <img
          src={secondarySrc}
          alt={`${meta.name} logo`}
          width={size * 0.6}
          height={size * 0.6}
          loading="eager"
          onError={() => setSecondaryFailed(true)}
          style={{ display: "block" }}
        />
      </div>
    );
  }
  // Tier 3 — inline SVG fallback (Uber Eats wordmark, HubRise "H",
  // Uber Direct wordmark, Stuart "S") or generic colour tile.
  else if (brand === "ubereats") {
    mark = <UberEatsMark size={size} />;
  } else if (brand === "uberdirect") {
    mark = <UberDirectMark size={size} />;
  } else if (brand === "stuart") {
    mark = <StuartMark size={size} />;
  } else if (brand === "hubrise") {
    mark = <HubRiseMark size={size} />;
  } else {
    mark = (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: meta.bg,
        }}
      />
    );
  }

  if (!label) return <>{mark}</>;
  return (
    <div className="flex flex-col items-center gap-2">
      {mark}
      <span className="whitespace-nowrap text-[11px] font-medium text-zinc-500">
        {meta.name}
      </span>
    </div>
  );
}

/** Uber Eats wordmark — black tile, white "Uber" / Eats-green "Eats". */
function UberEatsMark({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={{ borderRadius: size * 0.18, background: "#000000", display: "block" }} aria-label="Uber Eats">
      <text x="50" y="46" textAnchor="middle" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" fontWeight="800" fontSize="24" fill="#FFFFFF">Uber</text>
      <text x="50" y="74" textAnchor="middle" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" fontWeight="800" fontSize="24" fill="#06C167">Eats</text>
    </svg>
  );
}

/** Uber Direct — black tile, white "Uber" + grey "DIRECT" wordmark. */
function UberDirectMark({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={{ borderRadius: size * 0.18, background: "#000000", display: "block" }} aria-label="Uber Direct">
      <text x="50" y="46" textAnchor="middle" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" fontWeight="800" fontSize="22" fill="#FFFFFF">Uber</text>
      <text x="50" y="74" textAnchor="middle" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" fontWeight="700" fontSize="14" fill="#9CA3AF">DIRECT</text>
    </svg>
  );
}

/** Stuart — orange tile, white "S" wordmark. */
function StuartMark({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={{ borderRadius: size * 0.18, background: "#FF5A1A", display: "block" }} aria-label="Stuart">
      <text x="50" y="72" textAnchor="middle" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" fontWeight="900" fontSize="62" fill="white">S</text>
    </svg>
  );
}

/** HubRise — violet tile, white "H" wordmark. */
function HubRiseMark({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={{ borderRadius: size * 0.18, background: "#7C3AED", display: "block" }} aria-label="HubRise">
      <text x="50" y="72" textAnchor="middle" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" fontWeight="900" fontSize="62" fill="white">H</text>
    </svg>
  );
}
