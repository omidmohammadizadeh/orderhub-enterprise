// The Eat For Less wordmark: lime "£" mark + lowercase extra-bold name.

export function EflMark({ size = 32, inverted = false }: { size?: number; inverted?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center font-extrabold ${
        inverted ? "bg-[#0B0B0B] text-[#D4FF3F]" : "bg-[#D4FF3F] text-[#0B0B0B]"
      }`}
      style={{ width: size, height: size, borderRadius: "10px 50% 50% 50%", fontSize: Math.round(size * 0.55) }}
    >
      £
    </span>
  );
}

/** `onLime`: the mark turns black so it still reads on a lime background. */
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
      className={`inline-flex items-center gap-2 font-extrabold tracking-[-0.03em] ${
        tone === "dark" ? "text-[#0B0B0B]" : "text-white"
      }`}
      style={{ fontSize: Math.round(size * 0.62) }}
    >
      <EflMark size={size} inverted={onLime} />
      eat for less
    </span>
  );
}
