// Phase AP-MARKETING follow-up — shared chrome for the /privacy and
// /terms pages. Reuses the marketing SiteNav so visitors keep the
// brand context, wraps each section in a numbered card so the
// document scans like the kind of polished policy page Google's
// OAuth-verification team expects (Stripe, Vercel, Linear all use
// this same numbered-card pattern).

import Link from "next/link";
import { SiteNav } from "./site-nav";
import { getSiteBrand } from "@/lib/site-brand.server";

interface Section {
  id: string;
  title: string;
  /** Pre-rendered React content for the section body. */
  body: React.ReactNode;
}

interface Props {
  /** Big title at the top of the page. */
  title: string;
  /** Single-sentence intro that sits under the title. */
  lede: string;
  /** "Last updated" line — formatted by the caller. */
  lastUpdated: string;
  /** Ordered list of body sections, rendered as numbered cards. */
  sections: Section[];
  /** Top-of-page intro paragraphs — appear above the table of contents. */
  preface?: React.ReactNode;
}

export async function LegalPage({
  title,
  lede,
  lastUpdated,
  sections,
  preface,
}: Props) {
  const brand = await getSiteBrand();
  return (
    <div className="min-h-screen bg-white">
      <SiteNav />

      {/* Header band */}
      <header className="border-b border-zinc-100 bg-gradient-to-b from-zinc-50/60 to-white py-16">
        <div className="mx-auto max-w-3xl px-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600">
            Legal
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            {title}
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-zinc-600 sm:text-base">
            {lede}
          </p>
          <p className="mt-4 text-xs text-zinc-400">
            Last updated {lastUpdated}
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-12">
        {preface && (
          <div className="prose prose-zinc max-w-none text-sm leading-relaxed text-zinc-700 sm:text-[15px]">
            {preface}
          </div>
        )}

        {/* Table of contents — anchor links to each section card. */}
        <nav
          aria-label="Table of contents"
          className="mt-10 rounded-2xl border border-zinc-100 bg-zinc-50/60 p-5"
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Contents
          </p>
          <ol className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm text-zinc-700 sm:grid-cols-2">
            {sections.map((s, i) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="hover:text-emerald-700 hover:underline"
                >
                  <span className="font-mono text-xs text-zinc-400">
                    {String(i + 1).padStart(2, "0")}
                  </span>{" "}
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-10 space-y-6">
          {sections.map((s, i) => (
            <section
              key={s.id}
              id={s.id}
              className="scroll-mt-24 rounded-2xl border border-zinc-100 bg-white p-7 shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
            >
              <div className="flex items-start gap-3">
                <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full bg-emerald-50 text-sm font-bold text-emerald-700">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-bold text-zinc-900 sm:text-xl">
                    {s.title}
                  </h2>
                  <div className="prose prose-zinc mt-3 max-w-none text-sm leading-relaxed text-zinc-700 sm:text-[15px]">
                    {s.body}
                  </div>
                </div>
              </div>
            </section>
          ))}
        </div>

        {/* Back to home */}
        <div className="mt-12 border-t border-zinc-100 pt-8 text-center">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700 hover:text-emerald-900"
          >
            ← Back to {brand.shortName}
          </Link>
        </div>
      </main>

      <footer className="border-t border-zinc-100 bg-zinc-50/60 py-10">
        <div className="mx-auto max-w-3xl px-4 text-center text-xs text-zinc-500">
          <p>
            © {new Date().getFullYear()} {brand.name}. All rights reserved.
          </p>
          <p className="mt-2">
            <Link href="/privacy" className="hover:text-zinc-700">
              Privacy
            </Link>{" "}
            ·{" "}
            <Link href="/terms" className="hover:text-zinc-700">
              Terms
            </Link>{" "}
            ·{" "}
            <a
              href="mailto:support@orderhubpos.com"
              className="hover:text-zinc-700"
            >
              support@orderhubpos.com
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}

// ── Helpers for legal-page content ────────────────────────────────

/**
 * Renders a bullet list inside a section body. Marketing legal pages
 * have a LOT of these so a tiny helper saves repetition.
 */
export function LegalList({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="my-3 list-disc space-y-1.5 pl-5 marker:text-emerald-500">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/**
 * Sub-heading inside a section. Used for numbered sub-clauses
 * ("I. Visiting our website", "II. Demo Requests…").
 */
export function LegalSubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-5 text-[15px] font-semibold text-zinc-900">{children}</h3>
  );
}

/**
 * "Legal basis: …" badge — gives the consent/legitimate-interest
 * footnotes the same visual treatment as Stripe / Vercel legal docs.
 */
export function LegalBasis({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-emerald-100 bg-emerald-50 px-3 py-1 text-[11px] font-semibold text-emerald-800">
      <span className="text-emerald-600">●</span>
      Legal basis: {children}
    </p>
  );
}
