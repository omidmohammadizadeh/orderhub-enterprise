"use client";

// Shared template for an Integrations detail page. Brand-led hero with a status
// badge, capability grid, a connect flow and cross-links to other integrations.

import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check } from "lucide-react";
import { BrandLogo } from "../brand-logo";
import { DetailShell } from "./shell";
import {
  CapabilityCard,
  GlassCard,
  GradientText,
  GridGlow,
  Reveal,
  SectionHeading,
} from "./kit";
import { FinalCta } from "./solution-detail";
import {
  integrationForBrand,
  integrationsForBrand,
  type IntegrationStatus,
} from "./integrations-data";
import { useSiteBrand } from "@/lib/use-site-brand";

const STATUS_META: Record<IntegrationStatus, { label: string; tint: string }> = {
  live: { label: "Live", tint: "#34d399" },
  beta: { label: "Beta", tint: "#38bdf8" },
  soon: { label: "Coming soon", tint: "#fbbf24" },
};

export function IntegrationDetail({ slug }: { slug: string }) {
  const brand = useSiteBrand();
  const integration = integrationForBrand(slug, brand.key);
  if (!integration) return null;
  const accent = integration.accent;
  const status = STATUS_META[integration.status];
  const others = integrationsForBrand(brand.key)
    .filter((i) => i.slug !== integration.slug)
    .slice(0, 4);

  return (
    <DetailShell accent={accent}>
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-white/10">
        <GridGlow accent={accent} />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-20 pt-16 lg:grid-cols-2 lg:pt-24">
          <div>
            <nav className="mb-6 flex items-center gap-1.5 text-xs text-zinc-500">
              <Link href="/integrations" className="hover:text-zinc-300">Integrations</Link>
              <span>/</span>
              <span className="text-zinc-300">{integration.name}</span>
            </nav>
            <Reveal from="up">
              <div className="flex items-center gap-3">
                <BrandLogo brand={integration.brand} size={52} rounded />
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold"
                  style={{ borderColor: `${status.tint}44`, background: `${status.tint}14`, color: status.tint }}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: status.tint }} />
                  {status.label}
                </span>
                <span className="text-xs text-zinc-500">{integration.category}</span>
              </div>
            </Reveal>
            <Reveal from="up" delay={80}>
              <h1 className="mt-6 text-4xl font-bold tracking-tight sm:text-5xl">
                <GradientText accent={accent}>{integration.title}</GradientText>
              </h1>
            </Reveal>
            <Reveal from="up" delay={140}>
              <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-zinc-400">
                {integration.subtitle}
              </p>
            </Reveal>
            <Reveal from="up" delay={200}>
              <ul className="mt-6 flex flex-wrap gap-2">
                {integration.highlights.map((h) => (
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
            <Reveal from="up" delay={260}>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  href="/login"
                  className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-sm font-semibold text-[#04120c] shadow-lg transition-transform hover:-translate-y-0.5"
                  style={{ background: accent }}
                >
                  {integration.status === "soon" ? "Register interest" : "Connect it"}
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  href="/contact"
                  className="rounded-lg border border-white/15 bg-white/[0.03] px-5 py-2.5 text-sm font-semibold text-zinc-200 hover:bg-white/[0.06]"
                >
                  Talk to sales
                </Link>
              </div>
            </Reveal>
          </div>

          <Reveal from="right" delay={120}>
            <div className="relative">
              <div
                className="absolute -inset-6 -z-10 rounded-[2rem] blur-3xl"
                style={{ background: `radial-gradient(circle, ${accent}22, transparent 70%)` }}
              />
              {integration.heroMockup}
            </div>
          </Reveal>
        </div>
      </section>

      {/* Capabilities */}
      <section className="py-24">
        <div className="mx-auto max-w-6xl px-4">
          <Reveal>
            <SectionHeading
              eyebrow="Capabilities"
              title={`What ${integration.name} can do in Order Hub`}
              accent={accent}
              center
            />
          </Reveal>
          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {integration.capabilities.map((c, i) => (
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
            <SectionHeading eyebrow="How it connects" title="From connect to live" accent={accent} center />
          </Reveal>
          <div className="relative mt-16 grid gap-8 md:grid-cols-4">
            <div className="absolute left-0 right-0 top-5 hidden h-px bg-gradient-to-r from-transparent via-white/15 to-transparent md:block" />
            {integration.flow.map((step, i) => (
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

      {/* Cross-links */}
      <section className="py-20">
        <div className="mx-auto max-w-6xl px-4">
          <Reveal>
            <div className="flex items-end justify-between">
              <h2 className="text-2xl font-bold text-white">More integrations</h2>
              <Link href="/integrations" className="text-sm text-zinc-400 hover:text-white">
                View all →
              </Link>
            </div>
          </Reveal>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {others.map((o, i) => (
              <Reveal key={o.slug} delay={i * 70}>
                <Link href={`/integrations/${o.slug}`}>
                  <GlassCard className="group flex h-full items-center gap-3 p-4 transition-colors hover:border-white/25">
                    <BrandLogo brand={o.brand} size={36} rounded />
                    <span className="flex-1">
                      <span className="flex items-center gap-1 text-sm font-semibold text-white">
                        {o.name}
                        <ArrowUpRight className="h-3.5 w-3.5 text-zinc-500 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                      </span>
                      <span className="text-xs text-zinc-500">{o.category}</span>
                    </span>
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
