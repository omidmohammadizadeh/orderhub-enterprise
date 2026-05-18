"use client";

import { usePathname } from "next/navigation";
import { Bell, Search } from "lucide-react";
import { UserMenu } from "./user-menu";
import { cn } from "@/lib/utils";

const PAGE_TITLES: Record<string, { title: string; description?: string }> = {
  "/dashboard/orders": { title: "Orders", description: "Live and recent orders" },
  "/dashboard/menu": { title: "Menu", description: "Manage your menu and pricing" },
  "/dashboard/analytics": { title: "Analytics", description: "Sales and performance insights" },
  "/dashboard/integrations": { title: "Integrations", description: "Connected delivery platforms" },
  "/dashboard/locations": { title: "Locations", description: "Your restaurant locations" },
  "/dashboard/settings": { title: "Settings", description: "Workspace settings" },
};

function getPageMeta(pathname: string) {
  for (const [key, value] of Object.entries(PAGE_TITLES)) {
    if (pathname.startsWith(key)) return value;
  }
  return { title: "Dashboard" };
}

export function Topbar() {
  const pathname = usePathname();
  const { title, description } = getPageMeta(pathname);

  return (
    <header className="flex h-14 flex-shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-6">
      {/* Left: page title */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold text-zinc-900 leading-tight">{title}</h1>
          {description && (
            <p className="text-xs text-zinc-400 leading-tight hidden sm:block">{description}</p>
          )}
        </div>
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-1">
        {/* Search trigger (opens command palette later) */}
        <button
          className={cn(
            "hidden sm:flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm text-zinc-400",
            "hover:border-zinc-300 hover:bg-zinc-100 transition-colors",
          )}
          aria-label="Search"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="text-xs">Search…</span>
          <kbd className="ml-2 hidden lg:inline-flex h-5 items-center gap-1 rounded border border-zinc-200 bg-white px-1.5 font-mono text-[10px] text-zinc-400">
            ⌘K
          </kbd>
        </button>

        {/* Notifications */}
        <button
          className="relative flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 transition-colors"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" />
          {/* Unread dot */}
          <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-orange-500" />
        </button>

        <div className="ml-1 h-6 w-px bg-zinc-200" />

        <UserMenu />
      </div>
    </header>
  );
}
