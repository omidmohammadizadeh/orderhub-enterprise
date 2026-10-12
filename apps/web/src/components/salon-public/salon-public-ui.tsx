"use client";

// The guest-facing look: gunmetal ink on cool paper, a brass accent, and
// the barber pole — used once, as the progress stripe across the booking
// steps (it's a real sequence, so the stripe means something). Other
// trades get the same stripe in brass and ink instead of red and blue.

import { formatMoney } from "@orderhub/shared";
import { MapPin, Phone } from "lucide-react";
import type { SalonTrade } from "@/lib/api/salon.client";

export const SP = {
  paper: "#F4F5F3",
  card: "#FFFFFF",
  ink: "#1D2327",
  steel: "#5E6B73",
  line: "#DDE1DE",
  brass: "#A97A26",
  brassSoft: "#F3E9D6",
  red: "#B9352C",
  blue: "#2C5698",
};

export const display = "font-[family-name:var(--font-salon)] [font-stretch:72%] font-[750] tracking-[-0.01em]";
export const body = "font-[family-name:var(--font-salon)]";

export function money(n: number, currency: string): string {
  return formatMoney(n, currency);
}

export function PoleStripe({ step, steps, trade }: { step: number; steps: number; trade?: SalonTrade }) {
  const pct = Math.max(0, Math.min(1, step / steps)) * 100;
  const stripes =
    trade === "BARBER" || !trade
      ? `repeating-linear-gradient(-45deg, ${SP.red} 0 10px, #fff 10px 20px, ${SP.blue} 20px 30px, #fff 30px 40px)`
      : `repeating-linear-gradient(-45deg, ${SP.brass} 0 10px, #fff 10px 20px, ${SP.ink} 20px 30px, #fff 30px 40px)`;
  return (
    <div
      className="relative h-2.5 overflow-hidden rounded-full"
      style={{ background: SP.line }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={steps}
      aria-valuenow={step}
      aria-label={`Step ${Math.min(step + 1, steps)} of ${steps}`}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
        style={{ width: `${Math.max(6, pct)}%`, backgroundImage: stripes, backgroundSize: "56.57px 56.57px" }}
      />
    </div>
  );
}

export function ShopHeader({
  name,
  logoUrl,
  address,
  phone,
  compact,
}: {
  name: string;
  logoUrl: string | null;
  address: string | null;
  phone: string | null;
  compact?: boolean;
}) {
  return (
    <header className="flex items-center gap-3">
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" width={52} height={52} className="h-13 w-13 shrink-0 rounded-xl bg-white object-contain p-1" style={{ height: 52, width: 52 }} />
      ) : (
        <span className={`grid h-[52px] w-[52px] shrink-0 place-items-center rounded-xl text-xl text-white ${display}`} style={{ background: SP.ink }}>
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="min-w-0">
        <h1 className={`truncate ${compact ? "text-2xl" : "text-[2rem] leading-none"} ${display}`} style={{ color: SP.ink }}>
          {name}
        </h1>
        {!compact && (address || phone) && (
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px]" style={{ color: SP.steel }}>
            {address && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" aria-hidden /> {address}
              </span>
            )}
            {phone && (
              <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
                <Phone className="h-3.5 w-3.5" aria-hidden /> {phone}
              </a>
            )}
          </p>
        )}
      </div>
    </header>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className={`min-h-screen ${body}`} style={{ background: SP.paper, color: SP.ink }}>
      <div className="mx-auto w-full max-w-xl px-4 pb-28 pt-6 sm:pt-10">{children}</div>
    </main>
  );
}

export function PrimaryButton({
  children,
  disabled,
  loading,
  onClick,
  type = "button",
}: {
  children: React.ReactNode;
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl px-5 text-[15px] font-semibold text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-40"
      style={{ background: SP.ink, outlineColor: SP.brass }}
    >
      {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />}
      {children}
    </button>
  );
}

export function GhostButton({ children, onClick, danger }: { children: React.ReactNode; onClick?: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-semibold transition hover:bg-white focus-visible:outline-none focus-visible:ring-2"
      style={{ borderColor: SP.line, color: danger ? SP.red : SP.ink }}
    >
      {children}
    </button>
  );
}

export const fieldCls =
  "h-12 w-full rounded-xl border bg-white px-3.5 text-[15px] outline-none transition placeholder:text-[#9AA3A8] focus:border-[#A97A26] focus:ring-2 focus:ring-[#F3E9D6]";

export function staffNoun(trade: SalonTrade | undefined): string {
  return trade === "HAIR" ? "stylist" : trade === "NAILS" ? "nail tech" : trade === "BEAUTY" ? "therapist" : "barber";
}
