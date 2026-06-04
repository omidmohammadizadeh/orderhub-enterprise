// Phase AP marketing — auto-scrolling logo strip.
//
// Pure CSS infinite-scroll marquee — no JS dependency. Doubling the
// content array gives a seamless loop because the keyframe shifts the
// inner track exactly -50% before snapping back.
//
// Real platform brand marks are pulled from the existing
// components/ui/platform-logo set (built earlier this session).
// Just Eat is wrapped in a "Coming soon" badge per the operator's note
// — channel isn't live yet so we don't want to imply otherwise.

import { PlatformLogo } from "@/components/ui/platform-logo";

const LOGOS = [
  { id: "UBER_EATS", name: "Uber Eats", comingSoon: false },
  { id: "DELIVEROO", name: "Deliveroo", comingSoon: false },
  { id: "JUST_EAT", name: "Just Eat", comingSoon: true },
  { id: "HUBRISE", name: "HubRise", comingSoon: false },
  { id: "POS", name: "Order Hub POS", comingSoon: false },
  { id: "ONLINE", name: "Direct online", comingSoon: false },
];

export function MarqueeLogos() {
  return (
    <section className="border-y border-zinc-100 bg-zinc-50/40 py-12 overflow-hidden">
      <p className="mb-6 text-center text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Built to connect with every channel
      </p>

      {/* Inline keyframes so this stays self-contained. */}
      <style>{`
        @keyframes marquee-scroll {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }
        .marquee-track {
          animation: marquee-scroll 30s linear infinite;
          width: max-content;
        }
        .marquee:hover .marquee-track { animation-play-state: paused; }
      `}</style>

      <div className="marquee relative">
        {/* Soft fade-out edges so logos appear to drift out of view. */}
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-zinc-50/90 to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-zinc-50/90 to-transparent" />
        <div className="marquee-track flex items-center gap-14">
          {[...LOGOS, ...LOGOS].map((l, i) => (
            <LogoTile key={`${l.id}-${i}`} logo={l} />
          ))}
        </div>
      </div>
    </section>
  );
}

function LogoTile({
  logo,
}: {
  logo: { id: string; name: string; comingSoon: boolean };
}) {
  return (
    <div className="relative flex flex-col items-center gap-2">
      <div className="relative">
        <PlatformLogo platform={logo.id} size={56} rounded />
        {logo.comingSoon && (
          <span className="absolute -top-2 -right-2 rounded-full bg-orange-500 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white shadow-sm">
            Soon
          </span>
        )}
      </div>
      <span className="whitespace-nowrap text-[11px] font-medium text-zinc-500">
        {logo.name}
      </span>
    </div>
  );
}
