// "Trusted by" wall — real merchant brands running on Order Hub, with their
// logos. Server Component: the list comes from the API at request time and is
// curated in Admin Dashboard → Website showcase (nothing shows unless an admin
// switched it on). No brands, or the API unreachable → the section is omitted
// rather than rendering an empty promise.

import { ArrowUpRight } from "lucide-react";
import { InView } from "./in-view";

export interface ShowcaseBrand {
  name: string;
  logoUrl: string;
  city: string | null;
  cuisine: string | null;
  orderUrl: string | null;
}

export async function fetchShowcaseBrands(apiBase: string): Promise<ShowcaseBrand[]> {
  try {
    const res = await fetch(`${apiBase}/v1/public/website-showcase`, {
      cache: "no-store",
      // The homepage must never wait on this for long — a slow API costs the
      // section, not the page.
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json) ? (json as ShowcaseBrand[]) : [];
  } catch {
    return [];
  }
}

export function TrustedBrands({
  brands,
  siteName,
}: {
  brands: ShowcaseBrand[];
  siteName: string;
}) {
  if (brands.length === 0) return null;
  return (
    <section id="trusted" className="relative overflow-hidden bg-white py-20 sm:py-24">
      {/* Soft emerald glow behind the wall — depth without competing with logos. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-24 h-72 w-[720px] -translate-x-1/2 rounded-full bg-emerald-100/50 blur-3xl"
      />
      <div className="relative mx-auto max-w-6xl px-4">
        <InView>
          <div className="mx-auto max-w-2xl text-center">
            <p className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-emerald-700">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75 motion-reduce:animate-none" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              {brands.length} brand{brands.length === 1 ? "" : "s"} live today
            </p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
              Trusted by restaurants already running on {siteName}
            </h2>
            <p className="mt-3 text-base text-zinc-600">
              Takeaways, dark kitchens and restaurant brands taking every order
              — counter, phone, online and delivery apps — through one system.
            </p>
          </div>
        </InView>

        <ul className="mt-12 flex flex-wrap justify-center gap-4 sm:gap-5">
          {brands.map((b, i) => (
            <li key={`${b.name}-${i}`} className="w-[calc(50%-0.5rem)] sm:w-44">
              <InView delayMs={Math.min(i, 12) * 40} className="h-full">
                <BrandCard brand={b} />
              </InView>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function BrandCard({ brand }: { brand: ShowcaseBrand }) {
  const meta = [brand.cuisine, brand.city].filter(Boolean).join(" · ");
  const body = (
    <>
      <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-zinc-100 transition-transform duration-300 group-hover:scale-105">
        <img
          src={brand.logoUrl}
          alt={`${brand.name} logo`}
          loading="lazy"
          className="h-full w-full object-contain p-2"
        />
      </div>
      <p className="mt-4 line-clamp-2 text-center text-sm font-semibold leading-snug text-zinc-900">
        {brand.name}
      </p>
      {meta && (
        <p className="mt-1 line-clamp-1 text-center text-xs text-zinc-500">{meta}</p>
      )}
      {/* Rendered on every card (invisible without a link) so all tiles in a
          row stay the same height. */}
      <span
        aria-hidden={!brand.orderUrl}
        className={`mt-auto inline-flex items-center gap-0.5 pt-3 text-[11px] font-semibold text-emerald-700 opacity-0 transition-opacity duration-200 ${
          brand.orderUrl ? "group-hover:opacity-100 group-focus-visible:opacity-100" : "invisible"
        }`}
      >
        Order online <ArrowUpRight className="h-3 w-3" />
      </span>
    </>
  );
  const cls =
    "group flex h-full flex-col items-center rounded-2xl border border-zinc-200/80 bg-gradient-to-b from-zinc-50 to-white px-4 pb-4 pt-6 transition-all duration-300 hover:-translate-y-1 hover:border-emerald-200 hover:shadow-lg hover:shadow-emerald-900/5";
  return brand.orderUrl ? (
    <a
      href={brand.orderUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`${cls} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500`}
    >
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}
