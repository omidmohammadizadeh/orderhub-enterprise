"use client";

// The Eat For Less Console's frame: a black sidebar with the brand mark, and
// the page beside it. PLATFORM_ADMIN only — the Console decides commission
// and which shops trade, so nobody else gets past the frame.
//
// Sections not built yet are listed (so the team sees what's coming) but
// can't be clicked.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Lock } from "lucide-react";
import { useAuthStore } from "@/stores/auth.store";

const NAV: Array<{ href: string; label: string; soon?: boolean }> = [
  { href: "/efl-console", label: "Overview" },
  { href: "/efl-console/shops", label: "Shops" },
  { href: "/efl-console/applications", label: "Applications" },
  { href: "/efl-console/hygiene", label: "Food hygiene" },
  { href: "#couriers", label: "Couriers", soon: true },
  { href: "#customers", label: "Customers", soon: true },
  { href: "/efl-console/campaigns", label: "Push & email" },
  { href: "/efl-console/ads", label: "Sponsored ads" },
  { href: "/efl-console/statements", label: "Statements" },
  { href: "/efl-console/settings", label: "Settings" },
];

export function EflMark({ size = 36 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.5 }}
      className="flex shrink-0 items-center justify-center rounded-[10px_50%_50%_50%] bg-[#D4FF3F] font-extrabold text-[#0B0B0B]"
    >
      £
    </span>
  );
}

export function ConsoleShell({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const pathname = usePathname();

  if (user && user.role !== "PLATFORM_ADMIN") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#F6F6F4] px-6 text-center">
        <Lock className="mb-3 h-10 w-10 text-zinc-300" aria-hidden="true" />
        <p className="font-semibold text-zinc-700">Eat For Less team only</p>
        <p className="mt-1 max-w-sm text-sm text-zinc-500">
          The Console is for the Eat For Less platform team. Shops manage their listing in OrderHub → Locations →
          Platforms.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#F6F6F4] text-[#0B0B0B] md:flex-row">
      <aside className="flex shrink-0 flex-col gap-5 bg-[#0B0B0B] px-3.5 py-5 text-white md:sticky md:top-0 md:h-screen md:w-60">
        <Link href="/efl-console" className="flex items-center gap-2.5 px-2">
          <EflMark />
          <span className="flex flex-col leading-tight">
            <span className="text-base font-extrabold tracking-tight">eat for less</span>
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400">Console</span>
          </span>
        </Link>
        <nav aria-label="Console" className="-mx-1 flex gap-1 overflow-x-auto px-1 md:mx-0 md:flex-col md:overflow-visible md:px-0">
          {NAV.map((item) => {
            const active =
              !item.soon &&
              (item.href === "/efl-console" ? pathname === item.href : pathname?.startsWith(item.href));
            if (item.soon) {
              return (
                <span
                  key={item.href}
                  aria-disabled="true"
                  className="flex h-10 shrink-0 items-center justify-between gap-3 rounded-lg px-2.5 text-sm font-semibold text-zinc-500"
                >
                  {item.label}
                  <span className="rounded-full border border-zinc-700 px-1.5 text-[10px] font-semibold text-zinc-400">
                    Soon
                  </span>
                </span>
              );
            }
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={
                  "flex h-10 shrink-0 items-center gap-3 rounded-lg px-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D4FF3F] " +
                  (active ? "bg-[#1F1F1F] text-white" : "text-zinc-300 hover:bg-[#1C1C1C] hover:text-white")
                }
              >
                <span
                  aria-hidden="true"
                  className={"h-2 w-2 rounded-full " + (active ? "bg-[#D4FF3F]" : "bg-zinc-700")}
                />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto hidden items-center gap-2.5 border-t border-[#262626] px-2 pt-3 md:flex">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#2A2A2A] text-xs font-bold">
            {(user?.firstName ?? user?.email ?? "?").charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0 truncate text-xs text-zinc-300">{user?.email}</span>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-7 sm:py-7">
        <div className="mx-auto flex max-w-6xl flex-col gap-5">{children}</div>
      </main>
    </div>
  );
}
