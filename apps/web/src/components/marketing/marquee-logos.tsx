// Phase AP marketing — auto-scrolling logo strip with REAL brand marks.
//
// Marks come from BrandLogo (operator-uploaded PNGs in /brand-logos, with
// inline-SVG and simpleicons fallbacks), so what you see on screen matches
// each platform's actual press-kit mark. A channel that isn't live yet can be
// flagged with an orange "SOON" pill.
//
// Two rows drifting in OPPOSITE directions: it shows twice as many channels at
// a readable size and reads as motion rather than a conveyor belt. Pure CSS —
// no JS, no layout thrash. Hover anywhere to pause, and the whole thing holds
// still for anyone who asked their system for reduced motion, because a page
// people are trying to read should not move forever behind the words.

import { BrandLogo, type BrandKey } from "./brand-logo";
import type { SiteBrandKey } from "@/lib/site-brand";

type LogoItem = { brand: BrandKey; name: string; soon?: boolean };

const BASE_LOGOS: LogoItem[] = [
  { brand: "ubereats", name: "Uber Eats" },
  { brand: "deliveroo", name: "Deliveroo" },
  { brand: "justeat", name: "Just Eat" },
  { brand: "careem", name: "Careem" },
  { brand: "talabat", name: "talabat" },
  { brand: "glovo", name: "Glovo", soon: true },
  { brand: "uberdirect", name: "Uber Direct" },
  { brand: "stuart", name: "Stuart" },
  { brand: "hubrise", name: "HubRise" },
  { brand: "orderhub", name: "Order Hub POS" },
  { brand: "stripe", name: "Stripe" },
  { brand: "dojo", name: "Dojo", soon: true },
  { brand: "whatsapp", name: "WhatsApp" },
];

// menumanager.uk shows a different launch story: Uber Eats + Uber Direct as
// "Soon". Glovo carries its "Soon" pill on both sites until it's certified.
function logosForBrand(key: SiteBrandKey): LogoItem[] {
  if (key !== "menumanager") return BASE_LOGOS;
  return BASE_LOGOS.map((l) => {
    if (l.brand === "ubereats" || l.brand === "uberdirect") return { ...l, soon: true };
    return l;
  });
}

// Split into two rows of roughly equal length, alternating so neither row is
// all marketplaces or all payments.
function splitRows(logos: LogoItem[]): [LogoItem[], LogoItem[]] {
  const top: LogoItem[] = [];
  const bottom: LogoItem[] = [];
  logos.forEach((l, i) => (i % 2 === 0 ? top : bottom).push(l));
  return [top, bottom];
}

export function MarqueeLogos({ brandKey }: { brandKey: SiteBrandKey }) {
  const [top, bottom] = splitRows(logosForBrand(brandKey));
  return (
    // Solid zinc-50 so the edge fades below can match the backdrop exactly —
    // over a translucent tint they left a hard-cut logo showing at each edge.
    <section className="relative overflow-hidden border-y border-zinc-100 bg-zinc-50 py-16">
      <p className="mb-8 text-center text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Built to connect with every channel
      </p>

      <style>{`
        @keyframes marquee-left  { from { transform: translateX(0); }    to { transform: translateX(-50%); } }
        @keyframes marquee-right { from { transform: translateX(-50%); } to { transform: translateX(0); } }
        .marquee-track {
          width: max-content;
          animation: marquee-left 46s linear infinite;
        }
        .marquee-track--reverse { animation-name: marquee-right; }
        .marquee:hover .marquee-track { animation-play-state: paused; }
        @media (prefers-reduced-motion: reduce) {
          .marquee-track { animation: none; }
        }
      `}</style>

      <div className="marquee relative">
        <div className="space-y-8">
          <Row logos={top} />
          <Row logos={bottom} reverse />
        </div>
        {/* After the rows, so they sit on top without fighting over z-index,
            and outside space-y so it can't hand them a margin. */}
        {/* Narrow on a phone: at w-28 the two fades covered 224px of a 375px
            screen, leaving barely one logo legible between them. */}
        <div className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-zinc-50 via-zinc-50/80 to-transparent sm:w-28" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-zinc-50 via-zinc-50/80 to-transparent sm:w-28" />
      </div>
    </section>
  );
}

function Row({ logos, reverse }: { logos: LogoItem[]; reverse?: boolean }) {
  // Each half must be WIDER THAN THE SCREEN or the row runs out of logos before
  // the loop comes round — the shorter bottom row left a bare gap after Dojo on
  // a 1280px display. Three passes per half (~2,600px at this tile size) covers
  // any desktop, and the half is then duplicated so the -50% shift lands on an
  // identical frame.
  const half = [...logos, ...logos, ...logos];  // ~2,000px+ per half
  return (
    <div className="overflow-hidden">
      <div className={`marquee-track flex items-center gap-10 sm:gap-16 ${reverse ? "marquee-track--reverse" : ""}`}>
        {[...half, ...half].map((l, i) => (
          <LogoTile key={`${l.brand}-${i}`} logo={l} />
        ))}
      </div>
    </div>
  );
}

function LogoTile({ logo }: { logo: LogoItem }) {
  return (
    <div className="relative flex flex-col items-center gap-2 transition-transform hover:scale-110">
      {/* One size, sized for a phone first — three tiles fit at 375px. */}
      <div className="relative">
        <BrandLogo brand={logo.brand} size={72} rounded />
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
