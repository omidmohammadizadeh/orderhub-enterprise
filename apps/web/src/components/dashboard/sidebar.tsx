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
  PhoneCall,
  Printer,
  Smartphone,
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
 MonitorCheck,
  FileSignature,
  ScrollText,
  Wallet,
  Banknote,
  MessageSquare,
  Clapperboard,
  CalendarDays,
  MonitorSmartphone,
  Bot,
  Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { SidebarLocationSwitcher } from "./sidebar-location-switcher";
import { Badge } from "@/components/ui/badge";
import { useAuthStore } from "@/stores/auth.store";
import { deviceHomeFor } from "@/components/dashboard/kiosk-route-guard";
import { humaniseRole } from "@/lib/api/team.client";
import { getInitials } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { leadsClient } from "@/lib/api/leads.client";
import { locationsClient } from "@/lib/api/locations.client";
import { queryKeys } from "@/lib/api/query-keys";
import { useSelectedLocationStore } from "@/stores/selected-location.store";

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  badge?: string;
  roles?: string[];
  /** Hidden unless the selected location has dine-in table service on. */
  requiresTableService?: boolean;
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
// MANAGER's remit is deliberately narrow: the running of one shop. Anything
// that shapes the business — menu, pricing, marketing, team, hardware,
// locations — stays with owners. Kept as its own list rather than bolted onto
// STAFF_TIER so the boundary is visible in one place instead of inferred from
// a dozen scattered role arrays.
const MANAGER_TIER_PLUS = [...MANAGER_TIER, "MANAGER"];
const DRIVER_TIER = [...STAFF_TIER, "DRIVER"];
// Money features — SMS Marketing, Wallet, Payments, Subscription. Visible only
// to platform admin, tenant/location owners, and financial agents. NOT managers
// or general staff. (DARK_KITCHEN_MANAGER excluded — it's an operations role.)
const FINANCE_ROLES = ["PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT"];

// Kept separate from FINANCE_ROLES even though the members currently match, so
// widening SMS/Wallet access later doesn't quietly hand someone the card and
// invoice screens too.
const BILLING_ROLES = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "FINANCIAL_AGENT",
];

const primaryNav: NavItem[] = [
  { href: "/dashboard/orders", label: "Orders", icon: ShoppingBag, badge: "0", roles: DRIVER_TIER },
  { href: "/dashboard/pos", label: "POS", icon: ShoppingBag, roles: STAFF_TIER },
  { href: "/dashboard/tables", label: "Tables", icon: UtensilsCrossed, roles: STAFF_TIER },
  // Reservations only make sense once dine-in is switched on for this
  // location. Tables itself stays unconditional on purpose — it's where
  // the table-service toggle lives, so gating it would hide the only way
  // to turn the feature on.
  {
    href: "/dashboard/reservations",
    label: "Reservations",
    icon: CalendarDays,
    roles: STAFF_TIER,
    requiresTableService: true,
  },
  // Self-service kiosk screens. Not gated on table service — a takeaway
  // with no dine-in can still stand a kiosk in the doorway.
  {
    href: "/dashboard/kiosk",
    label: "Kiosk",
    icon: MonitorSmartphone,
    // The kiosk device signs in as a KIOSK user, which reaches this and
    // nothing else — see the filter below.
    roles: [...MANAGER_TIER, "STAFF", "KIOSK"],
  },
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
  { href: "/dashboard/signage", label: "Digital Signage", icon: Monitor, roles: MANAGER_TIER },
  // Admin-only business co-pilot (read-only, Phase 1).
  { href: "/dashboard/assistant", label: "AI Assistant", icon: Bot, roles: ["PLATFORM_ADMIN"] },
  { href: "/dashboard/store-status", label: "Store Status", icon: Activity, roles: [...MANAGER_TIER, "STAFF"] },
  { href: "/dashboard/customers", label: "Customers", icon: Users, roles: MANAGER_TIER },
  { href: "/dashboard/marketing", label: "Marketing", icon: Megaphone, roles: MANAGER_TIER },
  { href: "/dashboard/marketing/sms", label: "SMS Marketing", icon: MessageSquare, roles: FINANCE_ROLES },
  { href: "/dashboard/video-studio", label: "AI Studio", icon: Clapperboard, roles: MANAGER_TIER },
  // Drivers consolidated into the Dispatch console (Fleet tab) — Phase AX.
  { href: "/dashboard/reviews", label: "Reviews", icon: Star, roles: MANAGER_TIER },
  { href: "/dashboard/analytics", label: "Analytics", icon: BarChart3, roles: MANAGER_TIER_PLUS },
  { href: "/dashboard/inventory", label: "Inventory", icon: Package, roles: MANAGER_TIER_PLUS },
  { href: "/dashboard/team", label: "Team Roles", icon: UserCog, roles: MANAGER_TIER },
  // Managers keep Printers: a jammed or offline printer is a mid-service
  // problem, and the person on shift is the one who has to clear it.
  { href: "/dashboard/printers", label: "Printers", icon: Printer, roles: MANAGER_TIER_PLUS },
  { href: "/dashboard/card-readers", label: "Card Readers", icon: Smartphone, roles: MANAGER_TIER },
  // Diagnostics for the Comet USB box. Lives next to Printers because it is
  // the same job: "is the hardware on this counter actually working?"
  { href: "/dashboard/caller-id", label: "Caller ID", icon: PhoneCall, roles: MANAGER_TIER_PLUS },
  { href: "/dashboard/locations", label: "Locations", icon: MapPin, roles: MANAGER_TIER },
  // Phase LG — activity feed: menu publishes, order pushes, stock changes,
  // store status — the HubRise-style "what did the system do" timeline.
  { href: "/dashboard/logs", label: "Logs", icon: ScrollText, roles: MANAGER_TIER },
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
  // E-signature contracts. Platform-admin only — these are OUR agreements
  // with clients, so a client owner must never see the list.
  {
    href: "/dashboard/contracts",
    label: "Contracts",
    icon: FileSignature,
    roles: ["PLATFORM_ADMIN"],
  },
];

const operationsNav: NavItem[] = [
  // The kitchen screen signs in as a KITCHEN_DISPLAY user, which reaches
  // this and nothing else — see DEVICE_HOME.
  {
    href: "/dashboard/orders/kitchen",
    label: "Kitchen Display",
    icon: ChefHat,
    roles: [...MANAGER_TIER, "KITCHEN_DISPLAY"],
  },
  { href: "/dashboard/dispatch", label: "Dispatch", icon: Truck, roles: MANAGER_TIER_PLUS },
  { href: "/dashboard/orders/cashier", label: "Cashier", icon: ShoppingBag, roles: MANAGER_TIER },
];

const financeNav: NavItem[] = [
  // Phase AR — finance is reserved for top-of-tenant ownership +
  // platform admin. Operators (OWNER) don't get finance unless we
  // later add a finance-delegate role.
  { href: "/dashboard/payments", label: "Payments", icon: DollarSign, roles: FINANCE_ROLES },
  // Separate from Payments on purpose: an owner hunting for "when do I get
  // paid" looks for the word Payouts, not a ledger.
  { href: "/dashboard/payouts", label: "Payouts", icon: Banknote, roles: FINANCE_ROLES },
  { href: "/dashboard/wallet", label: "Wallet", icon: Wallet, roles: FINANCE_ROLES },
  { href: "/dashboard/subscription", label: "Subscription", icon: CreditCard, roles: BILLING_ROLES },
];

const secondaryNav: NavItem[] = [
  { href: "/dashboard/settings/kitchen", label: "Kitchen screens", icon: MonitorCheck, roles: MANAGER_TIER },
  // Security / Branding / Sandbox are platform-admin-only — internal tooling
  // and cross-tenant settings that client owners/managers should never see.
  { href: "/dashboard/settings/security", label: "Security", icon: Shield, roles: ["PLATFORM_ADMIN"] },
  { href: "/dashboard/settings/branding", label: "Branding", icon: Palette, roles: ["PLATFORM_ADMIN"] },
  { href: "/dashboard/sandbox", label: "Sandbox", icon: FlaskConical, roles: ["PLATFORM_ADMIN"] },
];

import { useLayoutStore } from "@/stores/layout.store";

export function Sidebar() {
  // Phase AW-28 — In fullscreen mode the layout hides the rail
  // entirely (more horizontal real estate for the Orders table).
  // Topbar owns the toggle; we just opt out of rendering.
  //
  // Render the inner component as JSX (not a function call) so it
  // gets its own component instance with its own hook list. Calling
  // _Sidebar() inlines its hooks into Sidebar's hook order, and the
  // collapsed→expanded toggle would then change the hook count
  // between renders → React error #300.
  const collapsed = useLayoutStore((s) => s.sidebarCollapsed);
  if (collapsed) return null;
  return <_Sidebar />;
}

function _Sidebar() {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  // Non-null only for device accounts (kiosk tablet, kitchen screen), in
  // which case it is the sole page they may see a link to.
  const deviceHome = deviceHomeFor(user?.role);

  // Phase AR — live unread-leads count for the sidebar badge. Only
  // PLATFORM_ADMIN + ONBOARDING_AGENT see the Leads entry; everyone
  // else short-circuits the query via `enabled: false`. A lead badge is
  // low-urgency: a 2-minute refresh (down from 30s — this polled on every
  // dashboard page and fed the 429 storm) plus an immediate refresh when
  // the tab regains focus keeps it feeling live.
  const canSeeLeads =
    !!user && ["PLATFORM_ADMIN", "ONBOARDING_AGENT"].includes(user.role);
  const leadsCountQuery = useQuery({
    queryKey: ["leads", "unread-count"],
    queryFn: leadsClient.unreadCount,
    enabled: canSeeLeads,
    refetchInterval: 120_000,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const unreadLeads = leadsCountQuery.data ?? 0;

  // Dine-in nav (Reservations) only appears when the selected location has
  // table service switched on. Shares the canonical location-detail cache
  // with the pages themselves; no polling (this renders on every dashboard
  // page), just a 1-minute staleness so switching the feature on shows up
  // shortly after without a reload.
  const selectedLocationId = useSelectedLocationStore(
    (s) => s.selectedLocationId,
  );
  const locationQuery = useQuery({
    queryKey: queryKeys.locationDetail(selectedLocationId ?? ""),
    queryFn: () => locationsClient.get(selectedLocationId!),
    enabled: !!selectedLocationId,
    staleTime: 60_000,
  });
  const tableServiceOn = !!(locationQuery.data as any)?.settings?.tableService
    ?.enabled;

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
              // A device account gets exactly one destination. This is
              // belt-and-braces with the route guard in the dashboard
              // layout — a customer at a kiosk, or anyone walking past the
              // kitchen screen, must never be one stray tap away from
              // takings or the menu editor.
              (!deviceHome || item.href === deviceHome) &&
              // Phase AP — items with a `roles` array are hidden from
              // users without that role. Server enforces too — this is
              // UI cleanliness.
              (!item.roles ||
                (user?.role && item.roles.includes(user.role))) &&
              (!item.requiresTableService || tableServiceOn),
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
                (!deviceHome || i.href === deviceHome) &&
                (!i.roles ||
                  (user?.role && i.roles.includes(user.role))),
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
                        pathname.startsWith(item.href)
                      }
                    />
                  ))}
                </>
              )}
            </>
          );
        })()}

        {!deviceHome && (
          <SidebarNavItem
            item={{ href: "#", label: "Help & Support", icon: HelpCircle }}
            isActive={false}
          />
        )}
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
              <p className="text-[10px] text-zinc-500 truncate">
                {humaniseRole(user.role)}
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
