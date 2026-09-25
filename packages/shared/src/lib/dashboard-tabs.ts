// ── Dashboard tab registry ───────────────────────────────────────────────────
//
// The canonical list of dashboard tabs a platform admin can switch OFF for a
// single location (Admin Dashboard → Dashboard access).
//
// Why it lives in @orderhub/shared: the picker, the sidebar filter, the route
// guard and the API validator all have to agree on what a "tab" is. When that
// list was going to live in the sidebar, every other reader would have had to
// re-derive it from hrefs, and the first renamed route would have silently
// turned a disabled tab back on for every location. One array, four readers.
//
// The rule this exists to serve: a disabled tab is invisible to EVERY user at
// that location, whatever their role. A dark kitchen has no tables, so nobody
// there — owner included — should be looking at Tables.
//
// Platform-admin-only pages (Secrets, Leads, Contracts, Sandbox, Security…)
// are deliberately NOT listed. They're never visible to a location's staff in
// the first place, so offering them in the picker would be noise that implies
// a control it doesn't have.

export type DashboardTabGroup = "Main" | "Operations" | "Finance" | "Settings";

export interface DashboardTabDef {
  /** Stable id persisted in Location.settings. Never re-use or rename. */
  key: string;
  label: string;
  /** Dashboard route this tab owns, including everything beneath it. */
  href: string;
  group: DashboardTabGroup;
  /** Shown under the label in the picker — why an operator would switch it off. */
  hint?: string;
  /**
   * Locked tabs can't be switched off. Orders is the dashboard's floor: the
   * route guard redirects there when someone lands on a disabled page, so it
   * has to be somewhere every location can still go.
   */
  locked?: boolean;
}

export const DASHBOARD_TABS: DashboardTabDef[] = [
  // ── Main ──────────────────────────────────────────────────────────────────
  {
    key: "orders",
    label: "Orders",
    href: "/dashboard/orders",
    group: "Main",
    hint: "Always on — every location needs somewhere to land.",
    locked: true,
  },
  { key: "pos", label: "POS", href: "/dashboard/pos", group: "Main", hint: "Till / counter ordering." },
  {
    key: "tables",
    label: "Tables",
    href: "/dashboard/tables",
    group: "Main",
    hint: "Dine-in table service. Off for dark kitchens and takeaways.",
  },
  {
    key: "reservations",
    label: "Reservations",
    href: "/dashboard/reservations",
    group: "Main",
    hint: "Table bookings.",
  },
  { key: "kiosk", label: "Kiosk", href: "/dashboard/kiosk", group: "Main", hint: "Self-service kiosk screens." },
  { key: "products", label: "Products", href: "/dashboard/products", group: "Main", hint: "Master catalog." },
  { key: "menu", label: "Menu", href: "/dashboard/menu", group: "Main", hint: "Per-location menu builder." },
  { key: "signage", label: "Digital Signage", href: "/dashboard/signage", group: "Main", hint: "In-store TV menu boards." },
  { key: "store-status", label: "Store Status", href: "/dashboard/store-status", group: "Main" },
  { key: "customers", label: "Customers", href: "/dashboard/customers", group: "Main" },
  // Listed before "marketing" so longest-prefix resolution is obvious to read;
  // tabForHref sorts by length anyway, so order here is presentation only.
  {
    key: "marketing-sms",
    label: "SMS Marketing",
    href: "/dashboard/marketing/sms",
    group: "Main",
    hint: "Text campaigns (billed from the SMS wallet).",
  },
  { key: "marketing", label: "Marketing", href: "/dashboard/marketing", group: "Main", hint: "Campaigns and offers." },
  { key: "video-studio", label: "AI Studio", href: "/dashboard/video-studio", group: "Main", hint: "AI marketing videos." },
  { key: "reviews", label: "Reviews", href: "/dashboard/reviews", group: "Main" },
  { key: "analytics", label: "Analytics", href: "/dashboard/analytics", group: "Main" },
  { key: "inventory", label: "Inventory", href: "/dashboard/inventory", group: "Main", hint: "Stock and 86'ing." },
  { key: "team", label: "Team Roles", href: "/dashboard/team", group: "Main" },
  { key: "printers", label: "Printers", href: "/dashboard/printers", group: "Main" },
  { key: "card-readers", label: "Card Readers", href: "/dashboard/card-readers", group: "Main", hint: "Terminals and Tap to Pay." },
  { key: "caller-id", label: "Caller ID", href: "/dashboard/caller-id", group: "Main", hint: "Inbound-call pop-ups." },
  { key: "locations", label: "Locations", href: "/dashboard/locations", group: "Main", hint: "Shop settings, brands, opening hours." },
  { key: "logs", label: "Logs", href: "/dashboard/logs", group: "Main", hint: "Activity feed." },

  // ── Operations ────────────────────────────────────────────────────────────
  {
    key: "kitchen-display",
    label: "Kitchen Display",
    href: "/dashboard/orders/kitchen",
    group: "Operations",
    hint: "KDS screens. Hiding this does not sign out a kitchen-screen device.",
  },
  { key: "dispatch", label: "Dispatch", href: "/dashboard/dispatch", group: "Operations", hint: "Driver dispatch console." },
  { key: "cashier", label: "Cashier", href: "/dashboard/orders/cashier", group: "Operations" },

  // ── Finance ───────────────────────────────────────────────────────────────
  { key: "payments", label: "Payments", href: "/dashboard/payments", group: "Finance" },
  { key: "payouts", label: "Payouts", href: "/dashboard/payouts", group: "Finance" },
  { key: "wallet", label: "Wallet", href: "/dashboard/wallet", group: "Finance", hint: "Prepaid SMS balance." },
  { key: "subscription", label: "Subscription", href: "/dashboard/subscription", group: "Finance" },

  // ── Settings ──────────────────────────────────────────────────────────────
  { key: "kitchen-screens", label: "Kitchen screens", href: "/dashboard/settings/kitchen", group: "Settings" },
];

export const DASHBOARD_TAB_GROUPS: DashboardTabGroup[] = [
  "Main",
  "Operations",
  "Finance",
  "Settings",
];

const BY_KEY = new Map(DASHBOARD_TABS.map((t) => [t.key, t]));

/** Longest href first, so /dashboard/orders/kitchen wins over /dashboard/orders. */
const BY_HREF_DESC = [...DASHBOARD_TABS].sort((a, b) => b.href.length - a.href.length);

export function dashboardTabByKey(key: string): DashboardTabDef | undefined {
  return BY_KEY.get(key);
}

/**
 * The tab that owns a dashboard path, or undefined for a page no tab covers
 * (admin pages, the dashboard index). Matches the MOST specific href:
 * /dashboard/orders/kitchen belongs to Kitchen Display, not Orders.
 */
export function dashboardTabForPath(pathname: string): DashboardTabDef | undefined {
  return BY_HREF_DESC.find(
    (t) => pathname === t.href || pathname.startsWith(`${t.href}/`),
  );
}

/**
 * Coerce whatever is on Location.settings into a trustworthy key list:
 * unknown keys dropped (a renamed route must not keep hiding something),
 * locked keys dropped, duplicates collapsed, order stabilised.
 */
export function normaliseDisabledTabs(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const tab = BY_KEY.get(raw);
    if (!tab || tab.locked) continue;
    out.add(tab.key);
  }
  return DASHBOARD_TABS.filter((t) => out.has(t.key)).map((t) => t.key);
}

/** Where the list lives inside Location.settings. */
export const DASHBOARD_ACCESS_SETTINGS_KEY = "dashboardAccess";

/** Read the disabled-tab list out of a Location.settings blob. */
export function disabledTabsFromSettings(settings: unknown): string[] {
  const blob = (settings as Record<string, unknown> | null | undefined)?.[
    DASHBOARD_ACCESS_SETTINGS_KEY
  ] as { disabledTabs?: unknown } | undefined;
  return normaliseDisabledTabs(blob?.disabledTabs);
}
