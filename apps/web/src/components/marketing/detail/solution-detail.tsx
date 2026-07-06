"use client";

// Shared template for a Solutions detail page. Given a Solution config it
// renders the full dark, scroll-animated page: hero + mockup, stats, capability
// grid, a numbered "how it works" flow, showcase sections and cross-links.

import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check } from "lucide-react";
import { DetailShell } from "./shell";
import {
  CountUp,
  CapabilityCard,
  GlassCard,
  GradientText,
  GridGlow,
  Pill,
  Reveal,
  SectionHeading,
} from "./kit";
import { SOLUTIONS, SOLUTIONS_BY_SLUG } from "./solutions-data";

export function SolutionDetail({ slug }: { slug: string }) {
  const solution = SOLUTIONS_BY_SLUG[slug];
  if (!solution) return null;
  const others = SOLUTIONS.filter((s) => s.slug !== solution.slug).slice(0, 3);
  const accent = solution.accent;

  return (
    <DetailShell accent={accent}>
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-white/10">
        <GridGlow accent={accent} />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-20 pt-16 lg:grid-cols-2 lg:pt-24">
          <div>
            <nav className="mb-6 flex items-center gap-1.5 text-xs text-zinc-500">
              <Link href="/solutions" className="hover:text-zinc-300">Solutions</Link>
              <span>/</span>
              <span className="text-zinc-300">{solution.name}</span>
            </nav>
            <Reveal from="up">
              <Pill accent={accent}>{solution.badge}</Pill>
            </Reveal>
            <Reveal from="up" delay={60}>
              <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl">
                <GradientText accent={accent}>{solution.title}</GradientText>
              </h1>
            </Reveal>
            <Reveal from="up" delay={120}>
              <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-zinc-400">
                {solution.subtitle}
              </p>
            </Reveal>
            <Reveal from="up" delay={180}>
              <ul className="mt-6 flex flex-wrap gap-2">
                {solution.highlights.map((h) => (
                  <li
                    key={h}
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-zinc-300"
                  >
                    <Check className="h-3.5 w-3.5" style={{ color: accent }} />
                    {h}
                  </li>
                ))}
              </ul>
            </Reveal>
            <Reveal from="up" delay={240}>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  href="/login"
                  className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-sm font-semibold text-[#04120c] shadow-lg transition-transform hover:-translate-y-0.5"
                  style={{ background: accent }}
                >
                  Get started <ArrowRight className="h-4 w-4" />
                </Link>
                <a
                  href="mailto:hello@orderhub.io"
                  className="rounded-lg border border-white/15 bg-white/[0.03] px-5 py-2.5 text-sm font-semibold text-zinc-200 hover:bg-white/[0.06]"
                >
                  Talk to sales
                </a>
              </div>
            </Reveal>
          </div>

          <Reveal from="right" delay={120}>
            <div className="relative">
              <div
                className="absolute -inset-6 -z-10 rounded-[2rem] blur-3xl"
                style={{ background: `radial-gradient(circle, ${accent}22, transparent 70%)` }}
              />
              {solution.heroMockup}
            </div>
          </Reveal>
        </div>
      </section>

      {/* Stats */}
      <section className="border-b border-white/10 bg-white/[0.015]">
        <div className="mx-auto grid max-w-6xl grid-cols-1 divide-y divide-white/10 px-4 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {solution.stats.map((s, i) => (
            <Reveal key={s.label} delay={i * 80} className="py-8 text-center">
              <p className="text-4xl font-bold text-white">
                <CountUp
                  to={s.value}
                  prefix={s.prefix}
                  suffix={s.suffix}
                  decimals={s.decimals ?? 0}
                />
              </p>
              <p className="mt-1.5 text-xs uppercase tracking-wider text-zinc-500">{s.label}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Capabilities */}
      <section className="relative py-24">
        <div className="mx-auto max-w-6xl px-4">
          <Reveal>
            <SectionHeading
              eyebrow="What it does"
              title={`Everything ${solution.name.toLowerCase()} should do`}
              accent={accent}
              center
            />
          </Reveal>
          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {solution.capabilities.map((c, i) => (
              <Reveal key={c.title} delay={(i % 3) * 90}>
                <CapabilityCard
                  icon={<c.icon className="h-5 w-5" />}
                  title={c.title}
                  body={c.body}
                  accent={accent}
                />
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Flow */}
      <section className="relative overflow-hidden border-y border-white/10 bg-white/[0.015] py-24">
        <div className="mx-auto max-w-6xl px-4">
          <Reveal>
            <SectionHeading eyebrow="How it works" title="Live in four steps" accent={accent} center />
          </Reveal>
          <div className="relative mt-16 grid gap-8 md:grid-cols-4">
            <div className="absolute left-0 right-0 top-5 hidden h-px bg-gradient-to-r from-transparent via-white/15 to-transparent md:block" />
            {solution.flow.map((step, i) => (
              <Reveal key={step.title} delay={i * 120} className="relative">
                <div
                  className="grid h-10 w-10 place-items-center rounded-full border text-sm font-bold"
                  style={{ borderColor: `${accent}66`, background: "#070a12", color: accent }}
                >
                  {i + 1}
                </div>
                <h3 className="mt-4 text-[15px] font-semibold text-white">{step.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{step.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Showcases */}
      <section className="py-24">
        <div className="mx-auto max-w-6xl space-y-24 px-4">
          {solution.showcases.map((sc, idx) => (
            <div
              key={sc.title}
              className={`grid items-center gap-12 lg:grid-cols-2 ${
                idx % 2 === 1 ? "lg:[&>div:first-child]:order-2" : ""
              }`}
            >
              <Reveal from={idx % 2 === 1 ? "right" : "left"}>
                <p className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: accent }}>
                  {sc.eyebrow}
                </p>
                <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
                  {sc.title}
                </h2>
                <p className="mt-4 text-[15px] leading-relaxed text-zinc-400">{sc.body}</p>
                <ul className="mt-6 space-y-3">
                  {sc.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-2.5 text-sm text-zinc-300">
                      <span
                        className="mt-0.5 grid h-5 w-5 flex-shrink-0 place-items-center rounded-full"
                        style={{ background: `${accent}22`, color: accent }}
                      >
                        <Check className="h-3 w-3" />
                      </span>
                      {b}
                    </li>
                  ))}
                </ul>
              </Reveal>
              <Reveal from={idx % 2 === 1 ? "left" : "right"} delay={100}>
                <div className="relative">
                  <div
                    className="absolute -inset-6 -z-10 rounded-[2rem] blur-3xl"
                    style={{ background: `radial-gradient(circle, ${accent}1f, transparent 70%)` }}
                  />
                  {sc.mockup}
                </div>
              </Reveal>
            </div>
          ))}
        </div>
      </section>

      {/* Cross-links */}
      <section className="border-t border-white/10 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <Reveal>
            <div className="flex items-end justify-between">
              <h2 className="text-2xl font-bold text-white">Explore more solutions</h2>
              <Link href="/solutions" className="text-sm text-zinc-400 hover:text-white">
                View all →
              </Link>
            </div>
          </Reveal>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {others.map((o, i) => (
              <Reveal key={o.slug} delay={i * 80}>
                <Link href={`/solutions/${o.slug}`}>
                  <GlassCard className="group h-full p-5 transition-colors hover:border-white/25">
                    <div
                      className="grid h-10 w-10 place-items-center rounded-xl border"
                      style={{ borderColor: `${o.accent}44`, background: `${o.accent}14`, color: o.accent }}
                    >
                      <o.icon className="h-5 w-5" />
                    </div>
                    <h3 className="mt-4 flex items-center gap-1 text-[15px] font-semibold text-white">
                      {o.name}
                      <ArrowUpRight className="h-4 w-4 text-zinc-500 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                    </h3>
                    <p className="mt-1.5 text-sm text-zinc-400">{o.navDescription}</p>
                  </GlassCard>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <FinalCta accent={accent} />
    </DetailShell>
  );
}

export function FinalCta({ accent }: { accent: string }) {
  return (
    <section className="relative overflow-hidden border-t border-white/10 py-24">
      <div
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: `radial-gradient(ellipse 60% 100% at 50% 100%, ${accent}22, transparent 70%)` }}
      />
      <div className="mx-auto max-w-3xl px-4 text-center">
        <Reveal>
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Ready when you are
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-[15px] text-zinc-400">
            Bring every order into one hub. Sign in to get started — we&apos;ll create
            your account on the first sign-in.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/login"
              className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-sm font-semibold text-[#04120c] shadow-lg transition-transform hover:-translate-y-0.5"
              style={{ background: accent }}
            >
              Get started <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href="mailto:hello@orderhub.io"
              className="rounded-lg border border-white/15 bg-white/[0.03] px-5 py-2.5 text-sm font-semibold text-zinc-200 hover:bg-white/[0.06]"
            >
              Talk to sales
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
