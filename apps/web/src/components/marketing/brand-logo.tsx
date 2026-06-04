// Phase AP marketing — real brand marks for the partner / integrations
// strip and feature blocks.
//
// Strategy: simpleicons.org's CDN returns a single-color SVG of every
// major brand mark on demand. We render it WHITE inside a tile whose
// background matches the brand's primary colour — so Deliveroo lands
// as the white kangaroo-V on its trademark teal, Just Eat as the
// white house-and-cutlery on orange, etc. That visual style mirrors
// what each platform actually ships in their press kit, while keeping
// us legally clean (the simpleicons project ships under CC0).
//
// Uber Eats is the only mark that can't be reduced to a single
// monochrome shape (white "Uber" + green "Eats" on black), so it gets
// a small purpose-built inline SVG that matches their wordmark.
//
// Order Hub stays on the PlatformLogo SVG we built earlier — it's
// already our own brand, no CDN dependency needed.

import { PlatformLogo } from "@/components/ui/platform-logo";

export type BrandKey =
  | "deliveroo"
  | "justeat"
  | "ubereats"
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

const BRAND_META: Record<
  BrandKey,
  { name: string; bg: string; slug?: string }
> = {
  deliveroo: { name: "Deliveroo", bg: "#00CCBC", slug: "deliveroo" },
  justeat: { name: "Just Eat", bg: "#FF8000", slug: "justeat" },
  ubereats: { name: "Uber Eats", bg: "#000000" }, // custom — see UberEatsMark
  hubrise: { name: "HubRise", bg: "#7C3AED" }, // custom
  orderhub: { name: "Order Hub POS", bg: "#0a0a0a" }, // PlatformLogo
  stripe: { name: "Stripe", bg: "#635BFF", slug: "stripe" },
};

export function BrandLogo({ brand, size = 56, rounded = true, label }: Props) {
  const meta = BRAND_META[brand];
  const radius = rounded ? size * 0.18 : 0;

  let mark: React.ReactNode;
  if (brand === "ubereats") {
    mark = <UberEatsMark size={size} />;
  } else if (brand === "orderhub") {
    // Reuse the existing inline SVG mark — already matches the badge
    // the operator shared as the OrderHub brand image.
    mark = <PlatformLogo platform="POS" size={size} rounded={rounded} />;
  } else if (brand === "hubrise") {
    mark = <HubRiseMark size={size} />;
  } else if (meta.slug) {
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
        {/* SVG is fetched white from simpleicons; tile colour comes
            from the wrapper. eager loading because these sit in the
            hero/feature region and lazy-load was popping logos in
            late as you scroll. */}
        <img
          src={`https://cdn.simpleicons.org/${meta.slug}/FFFFFF`}
          alt={`${meta.name} logo`}
          width={size * 0.6}
          height={size * 0.6}
          loading="eager"
          style={{ display: "block" }}
        />
      </div>
    );
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

/** Uber Eats wordmark — black tile, white "Uber" / Eats-green "Eats"
 *  stacked. Approximates the actual Uber Eats brand mark per their
 *  press kit (white #FFFFFF + green #06C167). */
function UberEatsMark({ size }: { size: number }) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      style={{
        borderRadius: size * 0.18,
        background: "#000000",
        display: "block",
      }}
      aria-label="Uber Eats"
    >
      <text
        x="50"
        y="46"
        textAnchor="middle"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
        fontWeight="800"
        fontSize="24"
        fill="#FFFFFF"
      >
        Uber
      </text>
      <text
        x="50"
        y="74"
        textAnchor="middle"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
        fontWeight="800"
        fontSize="24"
        fill="#06C167"
      >
        Eats
      </text>
    </svg>
  );
}

/** HubRise — violet tile with white H wordmark. */
function HubRiseMark({ size }: { size: number }) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      style={{
        borderRadius: size * 0.18,
        background: "#7C3AED",
        display: "block",
      }}
      aria-label="HubRise"
    >
      <text
        x="50"
        y="72"
        textAnchor="middle"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
        fontWeight="900"
        fontSize="62"
        fill="white"
      >
        H
      </text>
    </svg>
  );
}
