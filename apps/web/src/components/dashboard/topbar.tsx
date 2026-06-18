"use client";

import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { UserMenu } from "./user-menu";
import { LiveNotifications } from "./live-notifications";
import { cn } from "@/lib/utils";

const PAGE_TITLES: Record<string, { title: string; description?: string }> = {
  "/dashboard/orders": { title: "Orders", description: "Live and recent orders" },
  "/dashboard/menu": { title: "Menu", description: "Manage your menu and pricing" },
  "/dashboard/store-status": { title: "Store Status", description: "Live view of operational issues across brands, locations, items" },
  "/dashboard/customers": { title: "Customers", description: "CRM, loyalty, and promo codes" },
  "/dashboard/drivers": { title: "Drivers", description: "Dispatch and delivery tracking" },
  "/dashboard/analytics": { title: "Analytics", description: "Sales and performance insights" },
  "/dashboard/integrations": { title: "Integrations", description: "Connected delivery platforms" },
  "/dashboard/locations": { title: "Locations", description: "Your restaurant locations" },
  "/dashboard/inventory":         { title: "Inventory", description: "Stock levels, suppliers, and purchase orders" },
  "/dashboard/payments":          { title: "Payments", description: "Ledger, payouts, and Stripe Connect" },
  "/dashboard/billing":           { title: "Billing", description: "Subscription, plans, and invoices" },
  "/dashboard/settings/printers":  { title: "Printers", description: "Printer diagnostics, heartbeat, and job history" },
  "/dashboard/settings/security":  { title: "Security", description: "MFA, sessions, IP allowlist, and audit log" },
  "/dashboard/settings/branding":  { title: "Branding", description: "White-label customisation and custom domains" },
  "/dashboard/settings":           { title: "Settings", description: "Workspace settings" },
  "/dashboard/orders/rush-hour":   { title: "Rush Hour", description: "High-density order management with keyboard shortcuts" },
  "/dashboard/orders/kitchen":     { title: "Kitchen Display", description: "Full-screen KDS with auto-aging and BUMP" },
  "/dashboard/orders/dispatch":    { title: "Dispatch", description: "Driver dispatch and delivery tracking" },
  "/dashboard/orders/cashier":     { title: "Cashier", description: "Collection and payment at the counter" },
  "/dashboard/sandbox":            { title: "Sandbox", description: "Testing and simulation tools — non-production only" },
};

function getPageMeta(pathname: string) {
  // Exact match first
  if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname];
  // Longest prefix match — handles /dashboard/orders vs /dashboard/orders/rush-hour
  let best: { title: string; description?: string } | null = null;
  let bestLen = 0;
  for (const [key, value] of Object.entries(PAGE_TITLES)) {
    if (pathname.startsWith(key) && key.length > bestLen) {
      best = value;
      bestLen = key.length;
    }
  }
  return best ?? { title: "Dashboard" };
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

        <LiveNotifications />

        <div className="ml-1 h-6 w-px bg-zinc-200" />

        <UserMenu />
      </div>
    </header>
  );
}
