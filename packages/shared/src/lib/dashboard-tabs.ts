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
    key: "salon-appointments",
    label: "Appointments",
    href: "/dashboard/salon",
    group: "Main",
    hint: "Barbers / salons: the booking diary. Off also hides Walk-ins and the salon settings beneath it.",
  },
  {
    key: "salon-walk-ins",
    label: "Walk-ins",
    href: "/dashboard/salon/queue",
    group: "Main",
    hint: "Barbers / salons: the walk-in queue.",
  },
  {
    key: "loyalty-scan",
    label: "Scan loyalty card",
    href: "/dashboard/loyalty-scan",
    group: "Main",
    hint: "Scan wallet loyalty cards and give stamps without a sale.",
  },
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
  {
    key: "marketing-promo-codes",
    label: "Promo codes",
    href: "/dashboard/marketing/promo-codes",
    group: "Main",
  },
  {
    key: "marketing-welcome-screen",
    label: "Welcome screen",
    href: "/dashboard/marketing/welcome-screen",
    group: "Main",
    hint: "Storefront splash screen.",
  },
  {
    key: "marketing-email",
    label: "Email Marketing",
    href: "/dashboard/marketing/email",
    group: "Main",
  },
  {
    key: "marketing-push",
    label: "Push Notifications",
    href: "/dashboard/marketing/push",
    group: "Main",
  },
  {
    key: "marketing",
    label: "Marketing",
    href: "/dashboard/marketing",
    group: "Main",
    hint: "Campaigns and offers. Off also hides every Marketing page beneath it.",
  },
  { key: "video-studio", label: "AI Studio", href: "/dashboard/video-studio", group: "Main", hint: "AI marketing videos." },
  { key: "reviews", label: "Reviews", href: "/dashboard/reviews", group: "Main" },
  { key: "analytics", label: "Analytics", href: "/dashboard/analytics", group: "Main" },
  { key: "inventory", label: "Inventory", href: "/dashboard/inventory", group: "Main", hint: "Stock and 86'ing." },
  { key: "stock", label: "Stock & barcodes", href: "/dashboard/stock", group: "Main", hint: "Shops only: barcodes, stock counts, spreadsheet import." },
  { key: "picking", label: "Picking", href: "/dashboard/picking", group: "Main", hint: "Shops only: pick online orders, then hand to the courier." },
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
  {
    key: "training",
    label: "Kitchen training",
    href: "/dashboard/training",
    group: "Operations",
    hint: "How-to-build guides and assembly charts. Off for non-food shops.",
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
 * Every tab that covers a path, most specific first: the owning tab, then
 * the sections it sits inside. A disabled section hides everything beneath
 * it — switching Marketing off must take Promo codes and Email with it, not
 * leave them reachable because they now have toggles of their own.
 */
export function dashboardTabsCoveringPath(pathname: string): DashboardTabDef[] {
  return BY_HREF_DESC.filter(
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
