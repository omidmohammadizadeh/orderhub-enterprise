// The Eat For Less logo: the words themselves — "eat for" with "less" on a
// lime tag — exactly as the app shows them. No currency sign: the brand is
// meant to travel. apps/eatforless/scripts/make-logos.py draws the same
// thing as PNGs for the app icon, Play Store and Stripe.

/** The square version (app icon, small tiles): the words stacked on black. */
export function EflMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className="shrink-0"
      style={{ borderRadius: size * 0.22 }}
    >
      <rect width="100" height="100" fill="#0B0B0B" />
      <g fontFamily="inherit" fontWeight={800} fontSize="25" letterSpacing="-1">
        <text x="24" y="35" fill="#FFFFFF">eat</text>
        <text x="24" y="57" fill="#FFFFFF">for</text>
        <rect x="21" y="62" width="56" height="25" rx="4.5" fill="#D4FF3F" />
        <text x="24" y="81" fill="#0B0B0B">less</text>
      </g>
    </svg>
  );
}

/**
 * One line, as on the app's welcome screen. `size` is the cap height the
 * old mark used, kept so existing call sites stay the same size.
 * `onLime`: the tag turns black so it still stands out on a lime background.
 */
export function EflWordmark({
  tone = "dark",
  size = 32,
  onLime = false,
}: {
  tone?: "dark" | "light";
  size?: number;
  onLime?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap font-extrabold tracking-[-0.04em] ${
        tone === "dark" ? "text-[#0B0B0B]" : "text-white"
      }`}
      style={{ fontSize: Math.round(size * 0.66) }}
      aria-label="Eat For Less"
      role="img"
    >
      <span aria-hidden="true">eat for&nbsp;</span>
      <span
        aria-hidden="true"
        className={onLime ? "bg-[#0B0B0B] text-[#D4FF3F]" : "bg-[#D4FF3F] text-[#0B0B0B]"}
        style={{ borderRadius: "0.2em", padding: "0 0.12em" }}
      >
        less
      </span>
    </span>
  );
}
