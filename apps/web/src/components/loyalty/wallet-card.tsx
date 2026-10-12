"use client";

// The walk-in loyalty card as the customer sees it — the same layout as the
// Apple/Google Wallet pass (shop name, row of cups, reward, QR), so the card
// page, the dashboard preview and the pass on their phone all look alike.

import { QRCodeSVG } from "qrcode.react";
import { REWARD_ICON_SVG, stampIconSvg } from "@orderhub/shared";

export function readableOn(hex: string): "#111111" | "#FFFFFF" {
  const c = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#1F2937";
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#111111" : "#FFFFFF";
}

/** One stamp picture from the shared set (coffee, pizza, scissors…). */
export function StampIcon({ icon, className }: { icon?: string | null; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      stroke="currentColor"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: stampIconSvg(icon) }}
    />
  );
}

export function RewardIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      stroke="currentColor"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: REWARD_ICON_SVG }}
    />
  );
}

export function CupIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" stroke="currentColor" aria-hidden>
      <path d="M4 9h12v5.5A5.5 5.5 0 0 1 10.5 20h-1A5.5 5.5 0 0 1 4 14.5V9z" />
      <path d="M16 10.5h1.5a2.75 2.75 0 0 1 0 5.5H16" fill="none" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8 3.5c-.8 1 .8 1.8 0 3M12 3.5c-.8 1 .8 1.8 0 3" fill="none" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function GiftIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" stroke="currentColor" aria-hidden>
      <path d="M3.5 9.5h17v3h-17zM5 12.5h14V20H5z" />
      <path d="M12 9.5V20" fill="none" strokeWidth="1.6" />
      <path
        d="M12 9.5C10 5 6.5 5.5 7.5 8c.4 1 2.5 1.5 4.5 1.5zM12 9.5c2-4.5 5.5-4 4.5-1.5-.4 1-2.5 1.5-4.5 1.5z"
        fill="none"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function StampRow({
  stamps,
  required,
  fg,
  bg,
  size = "md",
  highlightLast = false,
  icon,
}: {
  stamps: number;
  required: number;
  fg: string;
  bg: string;
  size?: "sm" | "md";
  /** Pop the newest stamp in (card page, right after a visit). */
  highlightLast?: boolean;
  /** STAMP_ICONS key; coffee cup when unset. */
  icon?: string | null;
}) {
  const dim = size === "sm" ? "h-7 w-7" : "h-10 w-10 sm:h-11 sm:w-11";
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${Math.min(required, required > 10 ? Math.ceil(required / 2) : required)}, minmax(0, 1fr))` }}
      role="img"
      aria-label={`${stamps} of ${required} stamps`}
    >
      {Array.from({ length: required }, (_, i) => {
        const on = i < stamps;
        const last = i === required - 1;

        return (
          <span
            key={i}
            className={`mx-auto flex ${dim} items-center justify-center rounded-full transition-transform ${
              on && highlightLast && i === stamps - 1 ? "animate-[stamp-pop_600ms_ease-out]" : ""
            }`}
            style={
              on
                ? { background: fg, color: bg }
                : {
                    border: `2px ${last ? "solid" : "dashed"} ${fg === "#FFFFFF" ? "rgba(255,255,255,.4)" : "rgba(0,0,0,.25)"}`,
                    color: fg === "#FFFFFF" ? "rgba(255,255,255,.4)" : "rgba(0,0,0,.25)",
                    background: fg === "#FFFFFF" ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.04)",
                  }
            }
          >
            {last ? <RewardIcon className="h-[62%] w-[62%]" /> : <StampIcon icon={icon} className="h-[62%] w-[62%]" />}
          </span>
        );
      })}
    </div>
  );
}

export interface WalletCardProps {
  title: string;
  color: string;
  /** STAMP_ICONS key; coffee cup when unset. */
  stampIcon?: string | null;
  logoUrl?: string | null;
  stamps: number;
  stampsRequired: number;
  rewardLabel: string;
  rewardsReady?: number;
  firstName?: string | null;
  /** What the QR encodes ("OHL:XXXXXXXX"). Omit to hide the QR (preview). */
  scan?: string | null;
  code?: string | null;
  highlightLast?: boolean;
}

export function WalletCard({
  title,
  color,
  stampIcon,
  logoUrl,
  stamps,
  stampsRequired,
  rewardLabel,
  rewardsReady = 0,
  firstName,
  scan,
  code,
  highlightLast,
}: WalletCardProps) {
  const bg = /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#1F2937";
  const fg = readableOn(bg);
  const soft = fg === "#FFFFFF" ? "rgba(255,255,255,.7)" : "rgba(0,0,0,.6)";
  return (
    <div
      className="relative w-full overflow-hidden rounded-[22px] shadow-[0_20px_50px_-20px_rgba(0,0,0,.55)]"
      style={{ background: `linear-gradient(145deg, ${bg} 0%, ${bg} 55%, rgba(0,0,0,.18) 140%), ${bg}`, color: fg }}
    >
      {/* Sheen, so it reads as a card rather than a coloured box. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-24 h-56 w-56 rounded-full opacity-20 blur-2xl"
        style={{ background: fg }}
      />

      <div className="relative flex items-center justify-between gap-3 px-5 pt-5">
        <div className="flex min-w-0 items-center gap-2.5">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="h-9 w-9 shrink-0 rounded-lg bg-white object-contain p-0.5" />
          ) : (
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={{ background: fg, color: bg }}
            >
              <StampIcon icon={stampIcon} className="h-5 w-5" />
            </span>
          )}
          <span className="truncate text-base font-semibold tracking-tight">{title}</span>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: soft }}>
            Rewards
          </p>
          <p className="text-lg font-semibold leading-none tabular-nums">{rewardsReady}</p>
        </div>
      </div>

      <div className="relative px-5 pb-1 pt-5">
        <StampRow stamps={stamps} required={stampsRequired} fg={fg} bg={bg} highlightLast={highlightLast} icon={stampIcon} />
      </div>

      <div className="relative grid grid-cols-2 gap-3 px-5 pb-5 pt-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: soft }}>
            Stamps
          </p>
          <p className="text-sm font-semibold tabular-nums">
            {stamps} of {stampsRequired}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: soft }}>
            {rewardsReady > 0 ? "Ready to claim" : "Reward"}
          </p>
          <p className="truncate text-sm font-semibold">{rewardLabel}</p>
        </div>
        {firstName && (
          <div className="col-span-2 -mt-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: soft }}>
              Member
            </p>
            <p className="text-sm font-semibold">{firstName}</p>
          </div>
        )}
      </div>

      {scan && (
        <div className="relative flex flex-col items-center gap-1.5 px-5 pb-6">
          <div className="rounded-2xl bg-white p-3 shadow-sm">
            <QRCodeSVG value={scan} size={168} level="M" marginSize={0} />
          </div>
          {code && (
            <p className="font-mono text-xs tracking-[0.3em]" style={{ color: soft }}>
              {code.slice(0, 4)} {code.slice(4)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
