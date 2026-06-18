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
  Monitor,
  Rocket,
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
  Layers,
  Globe,
  KeyRound,
  UserCog,
  Inbox,
  Megaphone,
  Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SidebarLocationSwitcher } from "./sidebar-location-switcher";
import { Badge } from "@/components/ui/badge";
import { useAuthStore } from "@/stores/auth.store";
import { getInitials } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { leadsClient } from "@/lib/api/leads.client";

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  badge?: string;
  roles?: string[];
}

// Phase AR — every NavItem optionally declares which roles see it.
// The visibility logic at render time treats an absent `roles` array
// as "everyone in MANAGER+ tier sees this" (i.e. excluded from
// MANAGER/STAFF/DRIVER unless explicitly listed). This matches the
// operator's spec:
//   • MANAGER + STAFF → Orders + POS only
//   • DRIVER          → Orders only
//   • OWNER / DARK_KITCHEN_MANAGER → full ops nav minus platform pages
//   • TENANT_OWNER / PLATFORM_ADMIN → everything

const MANAGER_TIER = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "DARK_KITCHEN_MANAGER",
];
const STAFF_TIER = [...MANAGER_TIER, "MANAGER", "STAFF"];
const DRIVER_TIER = [...STAFF_TIER, "DRIVER"];

const primaryNav: NavItem[] = [
  { href: "/dashboard/orders", label: "Orders", icon: ShoppingBag, badge: "0", roles: DRIVER_TIER },
  { href: "/dashboard/pos", label: "POS", icon: ShoppingBag, roles: STAFF_TIER },
  // Phase AW — Direct online ordering settings moved into the per-brand
  // settings drawer (Locations → Brands → DIRECT_ONLINE channel →
  // Connect). The settings are now per-brand so a kitchen running two
  // ghost-kitchen brands can give each its own prep times, accepted
  // payment methods, and minimum order. The /dashboard/direct-ordering
  // sidebar entry has been retired.
  // Master catalog (Phase AL). The Menu entry below is the per-location
  // builder that attaches items from this catalog — it does not create
  // duplicate products.
  { href: "/dashboard/products", label: "Products", icon: Layers, roles: MANAGER_TIER },
  { href: "/dashboard/menu", label: "Menu", icon: UtensilsCrossed, roles: MANAGER_TIER },
  { href: "/dashboard/store-status", label: "Store Status", icon: Activity, roles: STAFF_TIER },
  { href: "/dashboard/customers", label: "Customers", icon: Users, roles: MANAGER_TIER },
  { href: "/dashboard/marketing", label: "Marketing", icon: Megaphone, roles: MANAGER_TIER },
  { href: "/dashboard/drivers", label: "Drivers", icon: Truck, roles: MANAGER_TIER },
  { href: "/dashboard/analytics", label: "Analytics", icon: BarChart3, roles: MANAGER_TIER },
  { href: "/dashboard/inventory", label: "Inventory", icon: Package, roles: MANAGER_TIER },
  { href: "/dashboard/integrations", label: "Integrations", icon: Plug2, roles: MANAGER_TIER },
  { href: "/dashboard/team", label: "Team Roles", icon: UserCog, roles: MANAGER_TIER },
  { href: "/dashboard/printers", label: "Printers", icon: Printer, roles: [...MANAGER_TIER, "MANAGER"] },
  { href: "/dashboard/locations", label: "Locations", icon: MapPin, roles: MANAGER_TIER },
  // Phase AP — admin-only secrets vault. Only PLATFORM_ADMIN can see
  // the link AND the page itself; the API also enforces the role.
  {
    href: "/dashboard/secrets",
    label: "Secrets",
    icon: KeyRound,
    roles: ["PLATFORM_ADMIN"],
  },
  // Phase AR — leads inbox. Visible to the platform team + the
  // onboarding agents who own the response workflow.
  {
    href: "/dashboard/leads",
    label: "Leads",
    icon: Inbox,
    roles: ["PLATFORM_ADMIN", "ONBOARDING_AGENT"],
  },
];

const operationsNav: NavItem[] = [
  { href: "/dashboard/orders/rush-hour", label: "Rush Hour", icon: Zap, roles: MANAGER_TIER },
  { href: "/dashboard/orders/kitchen", label: "Kitchen Display", icon: ChefHat, roles: MANAGER_TIER },
  { href: "/dashboard/orders/dispatch", label: "Dispatch", icon: Truck, roles: MANAGER_TIER },
  { href: "/dashboard/orders/cashier", label: "Cashier", icon: ShoppingBag, roles: MANAGER_TIER },
];

const financeNav: NavItem[] = [
  // Phase AR — finance is reserved for top-of-tenant ownership +
  // platform admin. Operators (OWNER) don't get finance unless we
  // later add a finance-delegate role.
  { href: "/dashboard/payments", label: "Payments", icon: DollarSign, roles: ["PLATFORM_ADMIN", "TENANT_OWNER", "FINANCIAL_AGENT"] },
  { href: "/dashboard/billing", label: "Billing", icon: CreditCard, roles: ["PLATFORM_ADMIN", "TENANT_OWNER", "FINANCIAL_AGENT"] },
];

const secondaryNav: NavItem[] = [
  { href: "/dashboard/onboarding", label: "Setup guide", icon: Rocket, roles: [...MANAGER_TIER, "ONBOARDING_AGENT"] },
  { href: "/dashboard/settings/printers", label: "Printers", icon: Printer, roles: MANAGER_TIER },
  { href: "/dashboard/settings/security", label: "Security", icon: Shield, roles: MANAGER_TIER },
  { href: "/dashboard/settings/branding", label: "Branding", icon: Palette, roles: MANAGER_TIER },
  { href: "/dashboard/settings", label: "Settings", icon: Settings, roles: MANAGER_TIER },
  { href: "/dashboard/sandbox", label: "Sandbox", icon: FlaskConical, roles: ["PLATFORM_ADMIN"] },
];

import { useLayoutStore } from "@/stores/layout.store";

export function Sidebar() {
  // Phase AW-28 — In fullscreen mode the layout hides the rail
  // entirely (more horizontal real estate for the Orders table).
  // Topbar owns the toggle; we just opt out of rendering.
  const collapsed = useLayoutStore((s) => s.sidebarCollapsed);
  if (collapsed) return null;
  return _Sidebar();
}

function _Sidebar() {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);

  // Phase AR — live unread-leads count for the sidebar badge. Only
  // PLATFORM_ADMIN + ONBOARDING_AGENT see the Leads entry; everyone
  // else short-circuits the query via `enabled: false`. Poll every
  // 30s so a fresh submission shows up without a hard refresh.
  const canSeeLeads =
    !!user && ["PLATFORM_ADMIN", "ONBOARDING_AGENT"].includes(user.role);
  const leadsCountQuery = useQuery({
    queryKey: ["leads", "unread-count"],
    queryFn: leadsClient.unreadCount,
    enabled: canSeeLeads,
    refetchInterval: 30_000,
  });
  const unreadLeads = leadsCountQuery.data ?? 0;

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

      {/* ── Location switcher (global scope) ─────────── */}
      {user && <SidebarLocationSwitcher />}

      {/* ── Primary navigation ──────────────────────── */}
      <nav className="flex-1 overflow-y-auto sidebar-scroll px-2 pt-4 pb-2 space-y-0.5">
        {primaryNav
          .filter(
            (item) =>
              // Phase AP — items with a `roles` array are hidden from
              // users without that role. Server enforces too — this is
              // UI cleanliness.
              !item.roles ||
              (user?.role && item.roles.includes(user.role)),
          )
          .map((item) => {
            // Phase AR — overlay the live unread-leads count onto
            // the Leads entry so a fresh submission lights up the
            // sidebar without the operator having to open the page.
            const withBadge =
              item.href === "/dashboard/leads" && unreadLeads > 0
                ? { ...item, badge: String(unreadLeads) }
                : item;
            return (
              <SidebarNavItem
                key={item.href}
                item={withBadge}
                isActive={pathname.startsWith(item.href)}
              />
            );
          })}

        {(() => {
          const filterFor = (nav: NavItem[]) =>
            nav.filter(
              (i) =>
                !i.roles ||
                (user?.role && i.roles.includes(user.role)),
            );
          const ops = filterFor(operationsNav);
          const fin = filterFor(financeNav);
          const sec = filterFor(secondaryNav);
          return (
            <>
              {ops.length > 0 && (
                <>
                  <div className="my-3 mx-1 h-px bg-white/[0.06]" />
                  <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
                    Operations
                  </p>
                  {ops.map((item) => (
                    <SidebarNavItem
                      key={item.href}
                      item={item}
                      isActive={pathname === item.href}
                    />
                  ))}
                </>
              )}
              {fin.length > 0 && (
                <>
                  <div className="my-3 mx-1 h-px bg-white/[0.06]" />
                  <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
                    Finance
                  </p>
                  {fin.map((item) => (
                    <SidebarNavItem
                      key={item.href}
                      item={item}
                      isActive={pathname.startsWith(item.href)}
                    />
                  ))}
                </>
              )}
              {sec.length > 0 && (
                <>
                  <div className="my-3 mx-1 h-px bg-white/[0.06]" />
                  {sec.map((item) => (
                    <SidebarNavItem
                      key={item.href}
                      item={item}
                      isActive={
                        pathname === item.href ||
                        (item.href !== "/dashboard/settings" &&
                          pathname.startsWith(item.href))
                      }
                    />
                  ))}
                </>
              )}
            </>
          );
        })()}

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
