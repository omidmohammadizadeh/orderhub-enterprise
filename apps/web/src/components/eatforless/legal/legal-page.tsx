import Link from "next/link";
import { eflHref, type EflBase } from "@/lib/efl-site";
import { FOCUS } from "../efl-styles";
import { SiteHeader } from "../site-header";

/** Shell for the readable pages: privacy, terms, help. */
export function LegalPage({
  base,
  title,
  intro,
  updated,
  draft,
  children,
}: {
  base: EflBase;
  title: string;
  intro?: string;
  updated?: string;
  draft?: boolean;
  children: React.ReactNode;
}) {
  const others = [
    { label: "Privacy", href: eflHref(base, "/privacy") },
    { label: "Terms", href: eflHref(base, "/terms") },
    { label: "Help", href: eflHref(base, "/help") },
  ];
  return (
    <>
      <SiteHeader base={base} />
      <main id="main" className="px-4 pb-24 pt-10 sm:px-6 sm:pt-16">
        <article className="mx-auto flex max-w-[720px] flex-col gap-6">
          {draft ? (
            <p role="note" className="m-0 rounded-2xl border-2 border-[#0B0B0B] bg-[#D4FF3F] px-4 py-3 text-[15px] font-bold">
              Draft — being reviewed before launch.
            </p>
          ) : null}
          <header className="flex flex-col gap-3">
            <h1 className="m-0 text-[40px] font-extrabold leading-[1.02] tracking-[-0.03em] sm:text-[56px]">{title}</h1>
            {intro ? <p className="m-0 text-lg leading-relaxed text-[#5E5E5E]">{intro}</p> : null}
            {updated ? <p className="m-0 text-sm text-[#5E5E5E]">Last updated {updated}</p> : null}
          </header>
          <div className="efl-prose flex flex-col gap-4 text-[17px] leading-[1.65] text-[#1F1F1F]">{children}</div>
          <nav aria-label="Other pages" className="mt-6 flex flex-wrap gap-2 border-t border-[#E2E2E2] pt-6">
            {others.map((o) => (
              <Link
                key={o.label}
                href={o.href}
                className={`efl-press inline-flex min-h-[44px] items-center rounded-full bg-[#F3F3F3] px-4 text-sm font-bold hover:bg-[#E2E2E2] ${FOCUS}`}
              >
                {o.label}
              </Link>
            ))}
          </nav>
        </article>
      </main>
    </>
  );
}

export function H2({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="m-0 mt-6 scroll-mt-6 text-[24px] font-extrabold leading-tight tracking-[-0.02em] text-[#0B0B0B]">
      {children}
    </h2>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return <p className="m-0">{children}</p>;
}

export function UL({ children }: { children: React.ReactNode }) {
  return <ul className="m-0 flex list-disc flex-col gap-2 pl-6 marker:text-[#5E5E5E]">{children}</ul>;
}

export function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className={`font-semibold text-[#0B0B0B] underline underline-offset-4 ${FOCUS}`}>
      {children}
    </a>
  );
}
