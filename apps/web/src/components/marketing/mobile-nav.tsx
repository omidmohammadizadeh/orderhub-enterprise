"use client";

// Mobile slide-in menu for the marketing header. The desktop nav is
// hover-driven mega menus (hidden on small screens), so phones need their
// own tappable panel with every header option. Rendered as a client island
// inside the (server) SiteNav — it receives the same nav data as props.

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Menu, X } from "lucide-react";

interface MenuItem {
  label: string;
  description?: string;
  href: string;
  brand?: string;
}

export function MobileNav({
  solutions,
  integrations,
  resources,
}: {
  solutions: MenuItem[];
  integrations: MenuItem[];
  resources: MenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <>
      <button
        type="button"
        aria-label="Open menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center rounded-md p-2 text-zinc-700 hover:bg-zinc-100 sm:hidden"
      >
        <Menu className="h-6 w-6" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 sm:hidden">
          <div
            className="absolute inset-0 bg-zinc-900/40"
            onClick={close}
            aria-hidden="true"
          />
          <div className="absolute right-0 top-0 flex h-full w-[85%] max-w-sm flex-col overflow-y-auto bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
              <span className="text-sm font-semibold text-zinc-900">Menu</span>
              <button
                type="button"
                aria-label="Close menu"
                onClick={close}
                className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 px-2 py-3">
              <Section title="Solutions" href="/solutions" items={solutions} onNavigate={close} />
              <Section title="Integrations" href="/integrations" items={integrations} onNavigate={close} />
              <Link
                href="/#pricing"
                onClick={close}
                className="block rounded-lg px-3 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-zinc-50"
              >
                Pricing
              </Link>
              <Section title="Resources" items={resources} onNavigate={close} />
            </div>

            <div className="space-y-2 border-t border-zinc-100 p-4">
              <Link
                href="/login"
                onClick={close}
                className="block rounded-md border border-zinc-200 px-3 py-2.5 text-center text-sm font-medium text-zinc-800 hover:bg-zinc-50"
              >
                Log in
              </Link>
              <Link
                href="/login"
                onClick={close}
                className="flex items-center justify-center gap-1 rounded-md bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
              >
                Get started
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Section({
  title,
  href,
  items,
  onNavigate,
}: {
  title: string;
  href?: string;
  items: MenuItem[];
  onNavigate: () => void;
}) {
  return (
    <div className="py-1">
      <div className="px-3 pt-2 pb-1">
        {href ? (
          <Link
            href={href}
            onClick={onNavigate}
            className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-700"
          >
            {title}
          </Link>
        ) : (
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            {title}
          </span>
        )}
      </div>
      <ul>
        {items.map((it) => (
          <li key={it.label}>
            <Link
              href={it.href}
              onClick={onNavigate}
              className="block rounded-lg px-3 py-2 text-sm text-zinc-800 hover:bg-zinc-50"
            >
              {it.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
