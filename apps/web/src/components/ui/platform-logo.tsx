"use client";

// Phase AM — branded square logo tile for each publish target.
//
// We render each brand mark as inline SVG so:
//   1. No external image assets / licensing entanglements.
//   2. Vector-crisp at any size (16px badge → 44px publish card).
//   3. Brand colours travel inside the SVG and survive Tailwind purge.
//
// Marks are deliberate simplifications of each platform's wordmark:
//   Just Eat   — orange house + white fork/knife glyph
//   Deliveroo  — teal tile + white "d." wordmark stub
//   Uber Eats  — black tile + white "Uber" / green "Eats" wordmark
//   Order Hub  — black bordered frame + "ORDER HUB POS" stack
//   Online     — orange tile + globe (our own brand)

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
  return (
    <svg
      viewBox="0 0 100 100"
      style={tileStyle(size, rounded)}
      aria-label="Just Eat"
    >
      <rect width="100" height="100" fill="#ff8000" />
      {/* House silhouette */}
      <path
        d="M 18 55 L 50 22 L 82 55 L 82 84 L 18 84 Z"
        fill="white"
      />
      {/* Fork (3 tines stem + base) on left of door */}
      <g fill="#ff8000">
        <rect x="32" y="40" width="3" height="32" />
        <rect x="28" y="40" width="2" height="14" />
        <rect x="37" y="40" width="2" height="14" />
        <rect x="27" y="51" width="13" height="3" />
      </g>
      {/* Knife on right */}
      <g fill="#ff8000">
        <path d="M 60 40 L 68 40 L 64 56 L 64 72 L 62 72 L 62 56 Z" />
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
      {/* Kangaroo-V mark — two diagonal strokes meeting at the bottom */}
      <path
        d="M 24 28 L 50 74 L 76 28 L 64 28 L 50 52 L 36 28 Z"
        fill="white"
      />
      {/* Two black eye dots */}
      <circle cx="42" cy="40" r="3.5" fill="#0b1f1d" />
      <circle cx="58" cy="40" r="3.5" fill="#0b1f1d" />
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
      <text
        x="50"
        y="46"
        textAnchor="middle"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontWeight="800"
        fontSize="24"
        fill="white"
      >
        Uber
      </text>
      <text
        x="50"
        y="74"
        textAnchor="middle"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontWeight="800"
        fontSize="24"
        fill="#06c167"
      >
        Eats
      </text>
    </svg>
  );
}

function OrderHubLogo({ size, rounded = true }: LogoProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      style={tileStyle(size, rounded)}
      aria-label="Order Hub"
    >
      <rect width="100" height="100" fill="black" />
      {/* Bag silhouette behind text */}
      <path
        d="M 28 28 L 28 22 Q 28 14 38 14 L 62 14 Q 72 14 72 22 L 72 28"
        stroke="white"
        strokeWidth="2.5"
        fill="none"
      />
      {/* Checkmark in tag */}
      <circle cx="62" cy="22" r="5" fill="white" />
      <path
        d="M 59 22 L 61 24 L 65 20"
        stroke="black"
        strokeWidth="2"
        fill="none"
      />
      <text
        x="50"
        y="55"
        textAnchor="middle"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontWeight="900"
        fontSize="14"
        fill="white"
        letterSpacing="-0.5"
      >
        ORDER
      </text>
      <text
        x="50"
        y="72"
        textAnchor="middle"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontWeight="900"
        fontSize="14"
        fill="white"
        letterSpacing="-0.5"
      >
        HUB
      </text>
      <text
        x="50"
        y="88"
        textAnchor="middle"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontWeight="700"
        fontSize="9"
        fill="white"
      >
        POS
      </text>
    </svg>
  );
}

function OnlineLogo({ size, rounded = true }: LogoProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      style={tileStyle(size, rounded)}
      aria-label="Online"
    >
      <rect width="100" height="100" fill="#f97316" />
      {/* Stylised globe (longitudes + equator) */}
      <circle
        cx="50"
        cy="50"
        r="28"
        stroke="white"
        strokeWidth="4"
        fill="none"
      />
      <ellipse
        cx="50"
        cy="50"
        rx="14"
        ry="28"
        stroke="white"
        strokeWidth="3"
        fill="none"
      />
      <line
        x1="22"
        y1="50"
        x2="78"
        y2="50"
        stroke="white"
        strokeWidth="3"
      />
    </svg>
  );
}

function HubRiseLogo({ size, rounded = true }: LogoProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      style={tileStyle(size, rounded)}
      aria-label="HubRise"
    >
      <rect width="100" height="100" fill="#7c3aed" />
      <text
        x="50"
        y="68"
        textAnchor="middle"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontWeight="900"
        fontSize="56"
        fill="white"
      >
        H
      </text>
    </svg>
  );
}

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
  const wrap = (child: React.ReactNode) => (
    <span title={title ? LABELS[platform] ?? platform : undefined}>
      {child}
    </span>
  );

  switch (platform) {
    case "JUST_EAT":
      return wrap(<JustEatLogo size={size} rounded={rounded} />);
    case "DELIVEROO":
      return wrap(<DeliverooLogo size={size} rounded={rounded} />);
    case "UBER_EATS":
      return wrap(<UberEatsLogo size={size} rounded={rounded} />);
    case "POS":
    case "DIRECT":
      return wrap(<OrderHubLogo size={size} rounded={rounded} />);
    case "ONLINE":
      return wrap(<OnlineLogo size={size} rounded={rounded} />);
    case "HUBRISE":
      return wrap(<HubRiseLogo size={size} rounded={rounded} />);
    default:
      return wrap(
        <span
          className="grid place-items-center bg-zinc-300 text-zinc-600 font-bold text-[10px]"
          style={tileStyle(size, rounded)}
        >
          {platform.slice(0, 2)}
        </span>,
      );
  }
}

export function platformLabel(platform: string): string {
  return LABELS[platform] ?? platform;
}
