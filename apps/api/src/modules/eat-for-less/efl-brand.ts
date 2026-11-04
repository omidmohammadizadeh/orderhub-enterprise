// The Eat For Less wordmark for emails and pages we render ourselves:
// "eat for" with "less" on a lime tag, as in the app. Plain inline styles,
// so it survives every mail client.

/** `on`: the colour behind it — the words go white on ink, ink on light. */
export function eflWordmarkHtml(px: number, on: "ink" | "light" = "ink"): string {
  const word = on === "ink" ? "#FFFFFF" : "#0B0B0B";
  return (
    `<span style="font-size:${px}px;font-weight:900;letter-spacing:-0.04em;color:${word};white-space:nowrap">eat for ` +
    `<span style="background:#D4FF3F;color:#0B0B0B;border-radius:${Math.round(px * 0.2)}px;padding:0 ${Math.round(px * 0.12)}px">less</span></span>`
  );
}
