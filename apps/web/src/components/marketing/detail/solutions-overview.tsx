"use client";

// Landing page for /solutions — the grid of all six product areas, each a card
// linking to its detail page. Shares the dark chrome + kit with the detail pages.

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { DetailShell } from "./shell";
import { GlassCard, GradientText, GridGlow, Pill, Reveal, SectionHeading } from "./kit";
import { FinalCta } from "./solution-detail";
import { SOLUTIONS } from "./solutions-data";

export function SolutionsOverview() {
  return (
    <DetailShell>
      <section className="relative overflow-hidden border-b border-white/10">
        <GridGlow />
        <div className="mx-auto max-w-3xl px-4 pb-16 pt-20 text-center sm:pt-28">
          <Reveal>
            <Pill>The Order Hub platform</Pill>
          </Reveal>
          <Reveal delay={80}>
            <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-6xl">
              <GradientText>Every order, one hub</GradientText>
            </h1>
          </Reveal>
          <Reveal delay={140}>
            <p className="mx-auto mt-5 max-w-2xl text-[15px] leading-relaxed text-zinc-400">
              POS, direct ordering, menu management, your own delivery fleet, dispatch and
              AI chat ordering — one connected system built for UK takeaways and
              multi-location restaurants.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="py-20">
        <div className="mx-auto max-w-6xl px-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {SOLUTIONS.map((s, i) => (
              <Reveal key={s.slug} delay={(i % 3) * 90}>
                <Link href={`/solutions/${s.slug}`}>
                  <GlassCard className="group h-full p-6 transition-colors hover:border-white/25">
                    <div
                      className="grid h-11 w-11 place-items-center rounded-xl border"
                      style={{ borderColor: `${s.accent}44`, background: `${s.accent}14`, color: s.accent }}
                    >
                      <s.icon className="h-5 w-5" />
                    </div>
                    <h2 className="mt-5 flex items-center gap-1 text-lg font-semibold text-white">
                      {s.name}
                      <ArrowUpRight className="h-4 w-4 text-zinc-500 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                    </h2>
                    <p className="mt-2 text-sm leading-relaxed text-zinc-400">{s.navDescription}</p>
                    <span
                      className="mt-4 inline-block text-xs font-semibold"
                      style={{ color: s.accent }}
                    >
                      Learn more →
                    </span>
                  </GlassCard>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <FinalCta accent="#34d399" />
    </DetailShell>
  );
}
