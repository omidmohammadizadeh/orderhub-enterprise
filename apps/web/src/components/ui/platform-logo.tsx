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
  // Just Eat: orange rounded tile + white "house" outline with chimney +
  // vertical orange fork and knife centred on the front of the house.
  // The house is one white shape; cutlery is layered on top in orange.
  return (
    <svg
      viewBox="0 0 100 100"
      style={tileStyle(size, rounded)}
      aria-label="Just Eat"
    >
      <rect width="100" height="100" fill="#ff8000" />
      {/* House silhouette: roof triangle + rectangular base */}
      <path
        d="M 50 18 L 84 50 L 78 50 L 78 86 L 22 86 L 22 50 L 16 50 Z"
        fill="white"
      />
      {/* Chimney on the right side of the roof */}
      <rect x="64" y="26" width="8" height="14" fill="white" />
      {/* Cutlery — fork (left) and knife (right), orange */}
      <g fill="#ff8000">
        {/* Fork tines */}
        <rect x="34" y="50" width="2" height="10" />
        <rect x="38" y="50" width="2" height="10" />
        <rect x="42" y="50" width="2" height="10" />
        {/* Fork base + handle */}
        <rect x="33" y="60" width="12" height="3" />
        <rect x="37" y="63" width="4" height="20" />
        {/* Knife blade */}
        <path d="M 56 50 L 64 50 L 60 70 L 60 70 L 60 70 Z" />
        <path d="M 56 50 Q 56 62 60 70 L 60 70 L 64 50 Z" />
        {/* Knife handle */}
        <rect x="58" y="70" width="4" height="14" />
      </g>
    </svg>
  );
}

function DeliverooLogo({ size, rounded = true }: LogoProps) {
  // Deliveroo: teal #00CCBC tile with the rounded kangaroo "V" mark.
  // No eye dots in the modern mark — the V flares out at the top and
  // tapers to a soft V at the bottom centre. We approximate with a
  // single fill path so it scales cleanly.
  return (
    <svg
      viewBox="0 0 100 100"
      style={tileStyle(size, rounded)}
      aria-label="Deliveroo"
    >
      <rect width="100" height="100" fill="#00ccbc" />
      <path
        fill="white"
        d="
          M 24 22
          Q 24 18 28 18
          L 38 18
          Q 41 18 42 21
          L 50 56
          L 58 21
          Q 59 18 62 18
          L 72 18
          Q 76 18 76 22
          Q 76 24 75.5 25.5
          L 60 74
          Q 58 80 52 80
          L 48 80
          Q 42 80 40 74
          L 24.5 25.5
          Q 24 24 24 22
          Z
        "
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
