// Phase AP marketing — sticky top nav with hover-revealed mega menus.
//
// Pure CSS dropdowns via `peer-hover` / `group-hover` so we don't need
// to ship a state machine to the client. Items in each menu link to
// homepage anchors or `/login` (no broken pages).

import Link from "next/link";
import { ArrowRight, ChevronDown } from "lucide-react";
import { PlatformLogo } from "@/components/ui/platform-logo";

interface MenuItem {
  label: string;
  description?: string;
  href: string;
  /** Optional brand mark — used by Integrations menu. */
  platform?: string;
}

const SOLUTIONS: MenuItem[] = [
  {
    label: "POS",
    description: "Walk-in tills and phone orders, one shared printer queue",
    href: "/login",
  },
  {
    label: "Direct online ordering",
    description: "Your own storefront, 100% margin kept",
    href: "/login",
  },
  {
    label: "Menu Manager",
    description: "One menu source, every channel",
    href: "/login",
  },
  {
    label: "Live order tracking",
    description: "Customers see what your kitchen sees",
    href: "/login",
  },
];

const INTEGRATIONS: MenuItem[] = [
  { label: "Uber Eats", href: "/login", platform: "UBER_EATS" },
  { label: "Deliveroo", href: "/login", platform: "DELIVEROO" },
  { label: "HubRise", href: "/login", platform: "HUBRISE" },
  { label: "Just Eat (coming soon)", href: "/login", platform: "JUST_EAT" },
  { label: "Order Hub POS", href: "/login", platform: "POS" },
  { label: "Stripe", href: "/login" },
];

const RESOURCES: MenuItem[] = [
  { label: "How it works", description: "Three steps to live", href: "/#how" },
  { label: "Features", description: "What's in the box", href: "/#features" },
  { label: "Contact sales", description: "hello@orderhub.io", href: "mailto:hello@orderhub.io" },
];

export function SiteNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-zinc-100 bg-white/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-4 py-3">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 text-sm font-bold text-white shadow-sm">
            OH
          </span>
          <span className="font-bold tracking-tight">Order Hub</span>
        </Link>

        <nav className="hidden items-center gap-1 sm:flex">
          <MegaMenu label="Solutions" items={SOLUTIONS} />
          <MegaMenu label="Integrations" items={INTEGRATIONS} grid />
          <Link
            href="#pricing"
            className="rounded-md px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Pricing
          </Link>
          <MegaMenu label="Resources" items={RESOURCES} />
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Log in
          </Link>
          <Link
            href="/login"
            className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
          >
            Get started
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </header>
  );
}

// Pure-CSS hover dropdown. Reveals via group-hover + focus-within so it
// works for keyboard users too. The small `pt-2` on the panel keeps it
// connected to the trigger so hovering the gap doesn't dismiss.
function MegaMenu({
  label,
  items,
  grid = false,
}: {
  label: string;
  items: MenuItem[];
  grid?: boolean;
}) {
  return (
    <div className="relative group">
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 focus:bg-zinc-50 focus:outline-none"
      >
        {label}
        <ChevronDown className="h-3.5 w-3.5 text-zinc-400 transition-transform group-hover:rotate-180" />
      </button>
      <div className="invisible absolute left-0 top-full z-50 pt-2 opacity-0 transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        <div
          className={`min-w-[320px] overflow-hidden rounded-xl border border-zinc-100 bg-white shadow-xl ${
            grid ? "p-2" : "p-1"
          }`}
        >
          {grid ? (
            <ul className="grid grid-cols-2 gap-1">
              {items.map((it) => (
                <li key={it.label}>
                  <Link
                    href={it.href}
                    className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-zinc-50"
                  >
                    {it.platform && (
                      <PlatformLogo platform={it.platform} size={24} rounded />
                    )}
                    <span className="text-sm text-zinc-800">{it.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <ul>
              {items.map((it) => (
                <li key={it.label}>
                  <Link
                    href={it.href}
                    className="flex flex-col rounded-lg px-3 py-2 hover:bg-zinc-50"
                  >
                    <span className="text-sm font-semibold text-zinc-900">
                      {it.label}
                    </span>
                    {it.description && (
                      <span className="mt-0.5 text-xs text-zinc-500">
                        {it.description}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
