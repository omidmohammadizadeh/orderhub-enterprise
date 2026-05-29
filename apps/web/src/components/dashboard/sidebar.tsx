"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ShoppingBag,
  UtensilsCrossed,
  BarChart3,
  Plug2,
  MapPin,
  Settings,
  HelpCircle,
  ChevronDown,
  Building2,
  Monitor,
  Rocket,
  Store,
  Users,
  Truck,
  CreditCard,
  DollarSign,
  Package,
  Shield,
  Palette,
  Printer,
  Zap,
  ChefHat,
  FlaskConical,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useAuthStore } from "@/stores/auth.store";
import { getInitials } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  badge?: string;
  roles?: string[];
}

const primaryNav: NavItem[] = [
  { href: "/dashboard/orders", label: "Orders", icon: ShoppingBag, badge: "0" },
  { href: "/dashboard/pos", label: "POS", icon: ShoppingBag },
  { href: "/dashboard/menu", label: "Menu", icon: UtensilsCrossed },
  { href: "/dashboard/store-ops", label: "Store Ops", icon: Store },
  { href: "/dashboard/customers", label: "Customers", icon: Users },
  { href: "/dashboard/drivers", label: "Drivers", icon: Truck },
  { href: "/dashboard/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/dashboard/inventory", label: "Inventory", icon: Package },
  { href: "/dashboard/integrations", label: "Integrations", icon: Plug2 },
  { href: "/dashboard/locations", label: "Locations", icon: MapPin },
];

const operationsNav: NavItem[] = [
  { href: "/dashboard/orders/rush-hour", label: "Rush Hour", icon: Zap },
  { href: "/dashboard/orders/kitchen", label: "Kitchen Display", icon: ChefHat },
  { href: "/dashboard/orders/dispatch", label: "Dispatch", icon: Truck },
  { href: "/dashboard/orders/cashier", label: "Cashier", icon: ShoppingBag },
];

const financeNav: NavItem[] = [
  { href: "/dashboard/payments", label: "Payments", icon: DollarSign },
  { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
];

const secondaryNav: NavItem[] = [
  { href: "/dashboard/onboarding", label: "Setup guide", icon: Rocket },
  { href: "/dashboard/settings/printers", label: "Printers", icon: Printer },
  { href: "/dashboard/settings/security", label: "Security", icon: Shield },
  { href: "/dashboard/settings/branding", label: "Branding", icon: Palette },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
  { href: "/dashboard/sandbox", label: "Sandbox", icon: FlaskConical },
];

export function Sidebar() {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);

  return (
    <aside className="flex h-screen w-[220px] flex-shrink-0 flex-col bg-[#0a0a0b] border-r border-white/[0.06]">
      {/* ── Logo ─────────────────────────────────────── */}
      <div className="flex h-14 items-center gap-2.5 border-b border-white/[0.06] px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-orange-400 to-orange-600 flex-shrink-0">
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-white" aria-hidden="true">
            <path d="M3 7h18M3 12h18M3 17h10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            <circle cx="19" cy="17" r="3" fill="currentColor" opacity="0.9" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white leading-tight truncate">Order Hub</p>
          <p className="text-[10px] font-medium text-zinc-500 leading-tight">Solutions</p>
        </div>
      </div>

      {/* ── Tenant / Brand pill ───────────────────────── */}
      {user && (
        <button className="mx-3 mt-3 flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.04] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.07] group">
          <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-violet-500/20">
            <Building2 className="h-3.5 w-3.5 text-violet-400" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-white truncate">{user.tenantName}</p>
            <p className="text-[10px] text-zinc-500 truncate">All locations</p>
          </div>
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600 group-hover:text-zinc-400 transition-colors" />
        </button>
      )}

      {/* ── Primary navigation ──────────────────────── */}
      <nav className="flex-1 overflow-y-auto sidebar-scroll px-2 pt-4 pb-2 space-y-0.5">
        {primaryNav.map((item) => (
          <SidebarNavItem
            key={item.href}
            item={item}
            isActive={pathname.startsWith(item.href)}
          />
        ))}

        <div className="my-3 mx-1 h-px bg-white/[0.06]" />

        <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">Operations</p>
        {operationsNav.map((item) => (
          <SidebarNavItem
            key={item.href}
            item={item}
            isActive={pathname === item.href}
          />
        ))}

        <div className="my-3 mx-1 h-px bg-white/[0.06]" />

        <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">Finance</p>
        {financeNav.map((item) => (
          <SidebarNavItem
            key={item.href}
            item={item}
            isActive={pathname.startsWith(item.href)}
          />
        ))}

        <div className="my-3 mx-1 h-px bg-white/[0.06]" />

        {secondaryNav.map((item) => (
          <SidebarNavItem
            key={item.href}
            item={item}
            isActive={pathname === item.href || (item.href !== "/dashboard/settings" && pathname.startsWith(item.href))}
          />
        ))}

        <SidebarNavItem
          item={{ href: "#", label: "Help & Support", icon: HelpCircle }}
          isActive={false}
        />
      </nav>

      {/* ── User footer ──────────────────────────────── */}
      {user && (
        <div className="border-t border-white/[0.06] p-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
            <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-orange-600 text-[11px] font-bold text-white">
              {getInitials(user.firstName, user.lastName)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-white truncate">
                {user.firstName} {user.lastName}
              </p>
              <p className="text-[10px] text-zinc-500 truncate capitalize">
                {user.role.replace("_", " ").toLowerCase()}
              </p>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

// ── Nav item ─────────────────────────────────────────────

interface SidebarNavItemProps {
  item: NavItem;
  isActive: boolean;
}

function SidebarNavItem({ item, isActive }: SidebarNavItemProps) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-all duration-100",
        isActive
          ? "bg-white/[0.09] text-white font-medium"
          : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200 font-normal",
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4 flex-shrink-0 transition-colors",
          isActive ? "text-orange-400" : "text-zinc-500 group-hover:text-zinc-300",
        )}
      />
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge && (
        <Badge
          variant="count"
          className={cn(
            "text-[10px] px-1.5 py-0 min-w-[18px] text-center",
            isActive ? "bg-zinc-600 text-zinc-200" : "bg-zinc-800 text-zinc-400",
          )}
        >
          {item.badge}
        </Badge>
      )}
      {isActive && (
        <div className="absolute left-0 h-5 w-0.5 rounded-r-full bg-orange-500" />
      )}
    </Link>
  );
}
