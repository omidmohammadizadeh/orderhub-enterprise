"use client";

// Phase AM — branded square logo tile for each publish target.
//
// We don't ship the official PNG marks (licensing + bundle weight),
// but we do honour the brand colour + a recognisable mono-tone glyph
// so order cards, the publish modal, and the integrations list all
// share one consistent visual identity. Tailwind classes only — no
// extra image assets in /public.
//
// Each tile renders as a square at the requested size, with a
// platform-coloured background, a white glyph, and (optionally) the
// platform label underneath.

import {
  ShoppingBag,
  Store,
  Calculator,
  Bike,
  Truck,
  House,
  Globe,
} from "lucide-react";

type Platform =
  | "DIRECT"
  | "ONLINE"
  | "POS"
  | "UBER_EATS"
  | "DELIVEROO"
  | "JUST_EAT"
  | "HUBRISE";

interface Config {
  label: string;
  // Background + foreground tailwind classes. We deliberately pick
  // brand-accurate hexes inline (via style) for Deliveroo + JE + Uber
  // so the tile reads as "their" brand instantly.
  bg: string;
  fg: string;
  Icon: React.ComponentType<{ className?: string }>;
  // True brand hex — used inline for the bg so it survives Tailwind
  // purge regardless of arbitrary-value classes.
  bgHex: string;
  fgHex?: string;
}

const CONFIGS: Record<Platform, Config> = {
  // Just Eat — orange brand
  JUST_EAT: {
    label: "Just Eat",
    bg: "bg-[#ff8000]",
    fg: "text-white",
    Icon: House,
    bgHex: "#ff8000",
  },
  // Deliveroo — turquoise brand
  DELIVEROO: {
    label: "Deliveroo",
    bg: "bg-[#00ccbc]",
    fg: "text-white",
    Icon: Bike,
    bgHex: "#00ccbc",
  },
  // Uber Eats — black w/ green accent
  UBER_EATS: {
    label: "Uber Eats",
    bg: "bg-black",
    fg: "text-white",
    Icon: ShoppingBag,
    bgHex: "#000000",
    fgHex: "#06c167",
  },
  // Direct online — our own brand orange
  ONLINE: {
    label: "Online ordering",
    bg: "bg-orange-500",
    fg: "text-white",
    Icon: Globe,
    bgHex: "#f97316",
  },
  DIRECT: {
    label: "Direct",
    bg: "bg-orange-500",
    fg: "text-white",
    Icon: Globe,
    bgHex: "#f97316",
  },
  // POS — our app's signature dark
  POS: {
    label: "POS",
    bg: "bg-zinc-900",
    fg: "text-white",
    Icon: Calculator,
    bgHex: "#18181b",
  },
  // HubRise — violet
  HUBRISE: {
    label: "HubRise",
    bg: "bg-violet-600",
    fg: "text-white",
    Icon: Truck,
    bgHex: "#7c3aed",
  },
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
  const cfg = CONFIGS[platform as Platform];
  if (!cfg) {
    // Unknown platform → grey fallback so nothing renders as broken.
    return (
      <span
        title={title ? platform : undefined}
        className="grid place-items-center bg-zinc-300 text-zinc-600 font-bold text-[10px]"
        style={{
          width: size,
          height: size,
          borderRadius: rounded ? size * 0.18 : 0,
        }}
      >
        {platform.slice(0, 2)}
      </span>
    );
  }
  const Icon = cfg.Icon;
  return (
    <span
      title={title ? cfg.label : undefined}
      className={`relative grid place-items-center flex-shrink-0 ${cfg.bg} ${cfg.fg}`}
      style={{
        width: size,
        height: size,
        borderRadius: rounded ? size * 0.18 : 0,
        backgroundColor: cfg.bgHex,
      }}
    >
      {/* lucide-react icons only expose `className`; size + accent
          colour happen via parent inline-style absolute positioning. */}
      <span
        style={{
          width: size * 0.55,
          height: size * 0.55,
          color: cfg.fgHex ?? "inherit",
          display: "inline-grid",
          placeItems: "center",
        }}
      >
        <Icon className="h-full w-full" />
      </span>
    </span>
  );
}

export function platformLabel(platform: string): string {
  return CONFIGS[platform as Platform]?.label ?? platform;
}
