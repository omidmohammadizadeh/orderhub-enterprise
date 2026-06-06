// Phase AP marketing — auto-scrolling logo strip with REAL brand marks.
//
// Marks come from BrandLogo (simpleicons CDN + brand-coloured tiles +
// hand-rolled Uber Eats wordmark), so what you see on screen matches
// each platform's actual press-kit mark. Just Eat is included but
// flagged with an orange "SOON" pill because the channel isn't live
// yet.
//
// Pure CSS infinite scroll — no JS. Hover anywhere to pause. Edges
// fade so logos drift in and out of view smoothly.

import { BrandLogo, type BrandKey } from "./brand-logo";

const LOGOS: Array<{ brand: BrandKey; name: string; soon?: boolean }> = [
  { brand: "ubereats", name: "Uber Eats" },
  { brand: "deliveroo", name: "Deliveroo" },
  { brand: "justeat", name: "Just Eat", soon: true },
  { brand: "uberdirect", name: "Uber Direct" },
  { brand: "stuart", name: "Stuart" },
  { brand: "hubrise", name: "HubRise" },
  { brand: "orderhub", name: "Order Hub POS" },
  { brand: "stripe", name: "Stripe" },
];

export function MarqueeLogos() {
  return (
    <section className="relative overflow-hidden border-y border-zinc-100 bg-zinc-50/40 py-16">
      <p className="mb-6 text-center text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Built to connect with every channel
      </p>

      <style>{`
        @keyframes marquee-scroll {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }
        .marquee-track {
          animation: marquee-scroll 28s linear infinite;
          width: max-content;
        }
        .marquee:hover .marquee-track { animation-play-state: paused; }
      `}</style>

      <div className="marquee relative">
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-20 bg-gradient-to-r from-zinc-50/95 to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-20 bg-gradient-to-l from-zinc-50/95 to-transparent" />
        <div className="marquee-track flex items-center gap-20">
          {[...LOGOS, ...LOGOS].map((l, i) => (
            <LogoTile key={`${l.brand}-${i}`} logo={l} />
          ))}
        </div>
      </div>
    </section>
  );
}

function LogoTile({
  logo,
}: {
  logo: { brand: BrandKey; name: string; soon?: boolean };
}) {
  return (
    <div className="relative flex flex-col items-center gap-2 transition-transform hover:scale-110">
      <div className="relative">
        <BrandLogo brand={logo.brand} size={96} rounded />
        {logo.soon && (
          <span className="absolute -top-2 -right-2 rounded-full bg-orange-500 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white shadow-md ring-2 ring-white">
            Soon
          </span>
        )}
      </div>
      <span className="whitespace-nowrap text-[13px] font-semibold text-zinc-600">
        {logo.name}
      </span>
    </div>
  );
}
