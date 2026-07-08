"use client";

// Landing page for /integrations — every platform grouped by category, each a
// card linking to its detail page. Shares the dark chrome + kit.

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { BrandLogo } from "../brand-logo";
import { DetailShell } from "./shell";
import { GlassCard, GradientText, GridGlow, Pill, Reveal } from "./kit";
import { FinalCta } from "./solution-detail";
import { integrationsForBrand, type Integration } from "./integrations-data";
import { useSiteBrand } from "@/lib/use-site-brand";

const CATEGORIES: Integration["category"][] = [
  "Marketplace",
  "Courier",
  "Payments",
  "Platform",
];

const STATUS_TINT: Record<Integration["status"], string> = {
  live: "#34d399",
  beta: "#38bdf8",
  soon: "#fbbf24",
};

export function IntegrationsOverview() {
  const brand = useSiteBrand();
  const integrations = integrationsForBrand(brand.key);
  return (
    <DetailShell>
      <section className="relative overflow-hidden border-b border-white/10">
        <GridGlow />
        <div className="mx-auto max-w-3xl px-4 pb-16 pt-20 text-center sm:pt-28">
          <Reveal>
            <Pill>Built to connect with every channel</Pill>
          </Reveal>
          <Reveal delay={80}>
            <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-6xl">
              <GradientText>Plug in every channel</GradientText>
            </h1>
          </Reveal>
          <Reveal delay={140}>
            <p className="mx-auto mt-5 max-w-2xl text-[15px] leading-relaxed text-zinc-400">
              Marketplaces, on-demand couriers, payments and your own POS — connected
              directly into one board. Click any platform to see exactly what it does.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="py-20">
        <div className="mx-auto max-w-6xl space-y-14 px-4">
          {CATEGORIES.map((cat) => {
            const items = integrations.filter((i) => i.category === cat);
            if (!items.length) return null;
            return (
              <div key={cat}>
                <Reveal>
                  <h2 className="mb-5 text-sm font-semibold uppercase tracking-[0.2em] text-zinc-500">
                    {cat}
                  </h2>
                </Reveal>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {items.map((i, idx) => (
                    <Reveal key={i.slug} delay={(idx % 3) * 80}>
                      <Link href={`/integrations/${i.slug}`}>
                        <GlassCard className="group flex h-full items-start gap-4 p-5 transition-colors hover:border-white/25">
                          <BrandLogo brand={i.brand} size={44} rounded />
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <h3 className="flex items-center gap-1 text-[15px] font-semibold text-white">
                                {i.name}
                                <ArrowUpRight className="h-3.5 w-3.5 text-zinc-500 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                              </h3>
                              <span
                                className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase"
                                style={{ background: `${STATUS_TINT[i.status]}1f`, color: STATUS_TINT[i.status] }}
                              >
                                {i.status === "soon" ? "Soon" : i.status}
                              </span>
                            </div>
                            <p className="mt-1.5 text-sm text-zinc-400">{i.navDescription}</p>
                          </div>
                        </GlassCard>
                      </Link>
                    </Reveal>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <FinalCta accent="#34d399" />
    </DetailShell>
  );
}
