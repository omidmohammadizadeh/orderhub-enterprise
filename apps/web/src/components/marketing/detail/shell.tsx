"use client";

// Dark chrome (nav + footer) shared by every Solutions / Integrations detail
// page. The mega-menus are driven by the same SOLUTIONS / INTEGRATIONS data
// that renders the pages, so a new entry shows up in navigation automatically.

import Link from "next/link";
import { ArrowRight, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { BrandLogo } from "../brand-logo";
import { SOLUTIONS } from "./solutions-data";
import { INTEGRATIONS } from "./integrations-data";
import { useSiteBrand } from "@/lib/use-site-brand";

export function DetailShell({
  accent = "#34d399",
  children,
}: {
  accent?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#070a12] text-zinc-200 antialiased">
      <DetailNav />
      <main>{children}</main>
      <DetailFooter accent={accent} />
    </div>
  );
}

function DetailNav() {
  const brand = useSiteBrand();
  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-[#070a12]/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-4 py-3">
        <Link href="/" className="flex items-center gap-2">
          {brand.showLogo && (
            <img
              src="/orderhub-logo.png"
              alt={brand.shortName}
              width={44}
              height={44}
              className="h-10 w-10 rounded-lg bg-white/90 object-contain p-0.5"
            />
          )}
          <span className="font-bold tracking-tight text-white">
            {brand.shortName}
          </span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          <MegaMenu label="Solutions" href="/solutions">
            <ul className="w-[360px] p-2">
              {SOLUTIONS.map((s) => (
                <li key={s.slug}>
                  <Link
                    href={`/solutions/${s.slug}`}
                    className="flex items-start gap-3 rounded-lg px-3 py-2 hover:bg-white/[0.06]"
                  >
                    <span
                      className="mt-0.5 grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg border"
                      style={{ borderColor: `${s.accent}44`, background: `${s.accent}14`, color: s.accent }}
                    >
                      <s.icon className="h-4 w-4" />
                    </span>
                    <span>
                      <span className="block text-sm font-semibold text-white">{s.name}</span>
                      <span className="mt-0.5 block text-xs text-zinc-500">{s.navDescription}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </MegaMenu>

          <MegaMenu label="Integrations" href="/integrations">
            <ul className="grid w-[420px] grid-cols-2 gap-1 p-2">
              {INTEGRATIONS.map((i) => (
                <li key={i.slug}>
                  <Link
                    href={`/integrations/${i.slug}`}
                    className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-white/[0.06]"
                  >
                    <BrandLogo brand={i.brand} size={28} rounded />
                    <span className="flex flex-col">
                      <span className="text-sm font-medium text-white">{i.name}</span>
                      {i.status === "soon" && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-400">
                          Coming soon
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </MegaMenu>

          <Link
            href="/#pricing"
            className="rounded-md px-3 py-2 text-sm font-medium text-zinc-300 hover:bg-white/[0.06]"
          >
            Pricing
          </Link>
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-white/[0.06]"
          >
            Log in
          </Link>
          <Link
            href="/login"
            className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-[#04120c] shadow-sm hover:bg-emerald-400"
          >
            Get started
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </header>
  );
}

function MegaMenu({
  label,
  href,
  children,
}: {
  label: string;
  href: string;
  children: ReactNode;
}) {
  return (
    <div className="group relative">
      <Link
        href={href}
        className="inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium text-zinc-300 hover:bg-white/[0.06]"
      >
        {label}
        <ChevronDown className="h-3.5 w-3.5 text-zinc-500 transition-transform group-hover:rotate-180" />
      </Link>
      <div className="invisible absolute left-0 top-full z-50 pt-2 opacity-0 transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        <div className="overflow-hidden rounded-xl border border-white/10 bg-[#0c1019] shadow-2xl">
          {children}
        </div>
      </div>
    </div>
  );
}

function DetailFooter({ accent }: { accent: string }) {
  const brand = useSiteBrand();
  return (
    <footer className="border-t border-white/10 bg-[#070a12] py-14">
      <div className="mx-auto max-w-6xl px-4">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Link href="/" className="flex items-center gap-2">
              {brand.showLogo && (
                <img
                  src="/orderhub-logo.png"
                  alt={brand.shortName}
                  width={36}
                  height={36}
                  className="h-9 w-9 rounded-lg bg-white/90 object-contain p-0.5"
                />
              )}
              <span className="font-bold tracking-tight text-white">
                {brand.shortName}
              </span>
            </Link>
            <p className="mt-3 text-sm text-zinc-500">
              Omnichannel order management for restaurants and takeaways.
            </p>
          </div>
          <FooterCol
            heading="Solutions"
            items={SOLUTIONS.map((s) => ({ label: s.name, href: `/solutions/${s.slug}` }))}
          />
          <FooterCol
            heading="Integrations"
            items={INTEGRATIONS.map((i) => ({
              label: i.status === "soon" ? `${i.name} (soon)` : i.name,
              href: `/integrations/${i.slug}`,
            }))}
          />
          <FooterCol
            heading={brand.shortName}
            items={[
              { label: "Home", href: "/" },
              { label: "Pricing", href: "/#pricing" },
              { label: "Contact sales", href: "/contact" },
              { label: "Log in", href: "/login" },
            ]}
          />
        </div>
        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-white/10 pt-6 text-xs text-zinc-500 sm:flex-row sm:items-center">
          <p>© {new Date().getFullYear()} {brand.name}. All rights reserved.</p>
          <div className="flex items-center gap-5">
            <Link href="/terms" className="hover:text-zinc-300">Terms</Link>
            <Link href="/privacy" className="hover:text-zinc-300">Privacy</Link>
            <span className="hidden sm:inline" style={{ color: accent }}>
              ●
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({
  heading,
  items,
}: {
  heading: string;
  items: { label: string; href: string }[];
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{heading}</p>
      <ul className="mt-3 space-y-2">
        {items.map((it) => (
          <li key={it.label}>
            <Link href={it.href} className="text-sm text-zinc-400 hover:text-white">
              {it.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
