// Eat For Less design tokens — from the approved design canvas
// (claude.ai/artifact/6FvgKmXYEaqEe1R2X3AcHc): black and white, one lime accent.

export const C = {
  ink: "#0B0B0B",
  white: "#FFFFFF",
  lime: "#D4FF3F",
  limeSoft: "#E6FF8A",
  grey50: "#F7F7F7",
  grey100: "#F3F3F3",
  grey200: "#EDEDED",
  line: "#F0F0F0",
  border: "#ECECEC",
  grey300: "#E2E2E2",
  grey400: "#C4C4C4",
  grey500: "#6B6B6B",
  grey600: "#5E5E5E",
  ink2: "#262626",
  ink3: "#1C1C1C",
  red: "#E5352B",
  mapBg: "#EEF0EC",
  scrim: "rgba(11,11,11,0.55)",
} as const;

/** Font families as loaded in App.tsx. Inter Tight 800 for headings, Inter for body. */
export const F = {
  display: "InterTight_800ExtraBold",
  displayBold: "InterTight_700Bold",
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
  heavy: "Inter_800ExtraBold",
} as const;

/** Springs and timings shared across screens so motion feels like one app. */
export const MOTION = {
  press: { damping: 18, stiffness: 420, mass: 0.6 },
  sheet: { damping: 22, stiffness: 220, mass: 0.9 },
  bouncy: { damping: 11, stiffness: 260, mass: 0.7 },
  underline: { damping: 16, stiffness: 240 },
  pressScale: 0.96,
} as const;

export const shadow = {
  card: {
    shadowColor: "#000",
    shadowOpacity: 0.14,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  soft: {
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  lifted: {
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
} as const;
