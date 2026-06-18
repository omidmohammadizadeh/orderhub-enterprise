"use client";

// Phase AW-25 — Customers section.
//
// Two tabs:
//   1. Insights  — Uber-Eats-style segmentation. Donut + per-group
//                  cards + per-shop table + daily-active trend.
//   2. Customers — the CRM list (search + drill-in).
//
// Promo codes have moved to /dashboard/marketing — there's a single
// banner at the top of the Customers tab pointing operators there.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowUpRight,
  Building2,
  ChevronRight,
  Loader2,
  Mail,
  Megaphone,
  Phone,
  PoundSterling,
  Search,
  ShoppingBag,
  Star,
  Tag,
  Users,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiClient } from "@/lib/api/client";
import { useAuthStore } from "@/stores/auth.store";
import {
  analyticsClient,
  type CustomerInsights,
} from "@/lib/api/analytics.client";
import { locationsClient } from "@/lib/api/locations.client";

type Tab = "insights" | "customers";

type DatePreset = "today" | "7d" | "30d" | "thisMonth" | "lastMonth" | "custom";

const PRESETS: Array<{ id: DatePreset; label: string }> = [
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "thisMonth", label: "This month" },
  { id: "lastMonth", label: "Last month" },
  { id: "custom", label: "Custom" },
];

const GROUP_COLOR = {
  new: "#3b82f6", // blue
  occasional: "#14b8a6", // teal
  frequent: "#f59e0b", // amber
} as const;

function presetRange(p: DatePreset): { from: Date; to: Date } {
  const now = new Date();
  const start = (d: Date) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const end = (d: Date) => {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
  };
  switch (p) {
    case "today":
      return { from: start(now), to: end(now) };
    case "7d": {
      const f = new Date(now);
      f.setDate(f.getDate() - 6);
      return { from: start(f), to: end(now) };
    }
    case "30d": {
      const f = new Date(now);
      f.setDate(f.getDate() - 29);
      return { from: start(f), to: end(now) };
    }
    case "thisMonth": {
      const f = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: start(f), to: end(now) };
    }
    case "lastMonth": {
      const f = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const t = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: start(f), to: end(t) };
    }
    case "custom":
      return { from: start(now), to: end(now) };
  }
}

const fmtGBP = (n: number) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(n);

const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

const fmtDateRange = (a: string, b: string) => {
  const f = new Date(a);
  const t = new Date(b);
  const opts: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
  };
  return `${f.toLocaleDateString("en-GB", opts)} – ${t.toLocaleDateString(
    "en-GB",
    opts,
  )}`;
};

function pctDelta(curr: number, prev: number): number {
  if (prev === 0) return curr > 0 ? 100 : 0;
  return ((curr - prev) / prev) * 100;
}

export default function CustomersPage() {
  const [tab, setTab] = useState<Tab>("insights");

  return (
    <div className="px-6 py-6 space-y-4">
      <header>
        <h1 className="text-xl font-semibold text-zinc-900 flex items-center gap-2">
          <Users className="h-5 w-5" /> Customers
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          See who is ordering from you and their impact on your sales.
        </p>
      </header>

      <nav className="flex items-center gap-3 border-b border-zinc-200">
        {[
          { id: "insights", label: "Insights" },
          { id: "customers", label: "All customers" },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as Tab)}
            className={`px-1 py-2 text-sm font-medium border-b-2 ${
              tab === t.id
                ? "border-zinc-900 text-zinc-900"
                : "border-transparent text-zinc-500 hover:text-zinc-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "insights" && <InsightsTab />}
      {tab === "customers" && <CrmListTab />}
    </div>
  );
}

// ── Insights tab ─────────────────────────────────────────────────────────────

function InsightsTab() {
  const [preset, setPreset] = useState<DatePreset>("7d");
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo] = useState<string>("");
  const [locationId, setLocationId] = useState<string>("");
  const [trendFilter, setTrendFilter] = useState<
    "all" | "new" | "occasional" | "frequent"
  >("all");

  const range = useMemo(() => {
    if (preset !== "custom") return presetRange(preset);
    if (customFrom && customTo) {
      return {
        from: new Date(customFrom + "T00:00:00"),
        to: new Date(customTo + "T23:59:59"),
      };
    }
    return presetRange("7d");
  }, [preset, customFrom, customTo]);

  const filters = {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    locationId: locationId || undefined,
  };

  const query = useQuery({
    queryKey: ["customer-insights", filters],
    queryFn: () => analyticsClient.customerInsights(filters),
  });
  const locationsQuery = useQuery({
    queryKey: ["customer-insights", "locations"],
    queryFn: () => locationsClient.list(),
  });

  const data = query.data;

  return (
    <div className="space-y-5">
      {/* Filter bar */}
      <section className="rounded-lg border border-zinc-200 bg-white p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="rounded-full border border-zinc-200 px-3 py-1.5 text-xs"
          >
            <option value="">All shops</option>
            {(locationsQuery.data ?? []).map((l: any) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPreset(p.id)}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${
                preset === p.id
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
              }`}
            >
              {p.label}
            </button>
          ))}
          {preset === "custom" && (
            <div className="flex items-center gap-1">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="rounded-md border border-zinc-200 px-2 py-1 text-xs"
              />
              <span className="text-xs text-zinc-400">to</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="rounded-md border border-zinc-200 px-2 py-1 text-xs"
              />
            </div>
          )}
        </div>
      </section>

      {query.isLoading ? (
        <div className="flex items-center justify-center py-20 text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : !data ? (
        <p className="text-sm text-zinc-500">No data for this window.</p>
      ) : (
        <>
          {/* Overview: donut + summary */}
          <section className="rounded-lg border border-zinc-200 bg-white p-5">
            <header className="mb-4">
              <h2 className="text-base font-semibold text-zinc-900">
                Customer groups overview
              </h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                {fmtDateRange(data.window.from, data.window.to)} compared to{" "}
                {fmtDateRange(data.window.prevFrom, data.window.prevTo)}
              </p>
            </header>
            <DonutOverview insights={data} />
          </section>

          {/* Per-group cards */}
          <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <GroupCard
              colorKey="new"
              label="New"
              definition="Customers who placed their first order in this window."
              detail={data.groups.new}
              totalRevenue={data.summary.revenue}
            />
            <GroupCard
              colorKey="occasional"
              label="Occasional"
              definition="Customers who ordered once or twice in the last 90 days."
              detail={data.groups.occasional}
              totalRevenue={data.summary.revenue}
            />
            <GroupCard
              colorKey="frequent"
              label="Frequent"
              definition="Customers who ordered 3 or more times in the last 90 days."
              detail={data.groups.frequent}
              totalRevenue={data.summary.revenue}
            />
          </section>

          {/* By shop */}
          <section className="rounded-lg border border-zinc-200 bg-white p-5">
            <header className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-zinc-900">
                  Customer groups by shop
                </h2>
                <p className="text-xs text-zinc-500 mt-0.5">
                  View how customer groups vary across all your shops.
                </p>
              </div>
            </header>
            {data.byShop.length === 0 ? (
              <p className="py-8 text-center text-xs text-zinc-400">
                No customers in this window.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-[11px] uppercase tracking-wider text-zinc-500">
                    <tr className="border-b border-zinc-100">
                      <th className="px-3 py-2 text-left font-semibold">
                        Shop
                      </th>
                      <th className="px-3 py-2 text-right font-semibold">
                        New
                      </th>
                      <th className="px-3 py-2 text-right font-semibold">
                        Occasional
                      </th>
                      <th className="px-3 py-2 text-right font-semibold">
                        Frequent
                      </th>
                      <th className="px-3 py-2 text-right font-semibold">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byShop.map((s) => (
                      <tr
                        key={s.locationId}
                        className="border-b border-zinc-50 last:border-0"
                      >
                        <td className="px-3 py-3 text-zinc-800">
                          <p className="font-medium text-zinc-900">{s.name}</p>
                          {typeof s.address === "string" && s.address && (
                            <p className="text-[11px] text-zinc-500">
                              {s.address}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right text-zinc-700">
                          {s.new}
                        </td>
                        <td className="px-3 py-3 text-right text-zinc-700">
                          {s.occasional}
                        </td>
                        <td className="px-3 py-3 text-right text-zinc-700">
                          {s.frequent}
                        </td>
                        <td className="px-3 py-3 text-right font-semibold text-zinc-900">
                          {s.total}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Trends */}
          <section className="rounded-lg border border-zinc-200 bg-white p-5">
            <header className="mb-3">
              <h2 className="text-base font-semibold text-zinc-900">
                Customer group trends
              </h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                Daily count of unique customers ordering in each group.
              </p>
            </header>
            <div className="flex items-center gap-2 mb-3">
              {[
                { id: "all", label: "All customers" },
                { id: "new", label: "New" },
                { id: "occasional", label: "Occasional" },
                { id: "frequent", label: "Frequent" },
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setTrendFilter(f.id as any)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${
                    trendFilter === f.id
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="text-2xl font-bold text-zinc-900">
              {data.trends.reduce(
                (s, r) => s + (r as any)[trendFilter] || 0,
                0,
              )}
              <span className="ml-2 text-xs font-normal text-zinc-500">
                {trendFilter === "all"
                  ? "Customer-days"
                  : `${capitalize(trendFilter)} customer-days`}
              </span>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data.trends}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(d) =>
                    new Date(d).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "2-digit",
                    })
                  }
                />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip />
                <Bar
                  dataKey={trendFilter}
                  fill={
                    trendFilter === "all"
                      ? "#3b82f6"
                      : GROUP_COLOR[trendFilter]
                  }
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </section>
        </>
      )}
    </div>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function DonutOverview({ insights }: { insights: CustomerInsights }) {
  const total = insights.summary.total;
  const pieData = [
    {
      name: "New",
      value: insights.groups.new.customerCount,
      color: GROUP_COLOR.new,
    },
    {
      name: "Occasional",
      value: insights.groups.occasional.customerCount,
      color: GROUP_COLOR.occasional,
    },
    {
      name: "Frequent",
      value: insights.groups.frequent.customerCount,
      color: GROUP_COLOR.frequent,
    },
  ];
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 items-center gap-6">
      <div className="relative h-40 mx-auto md:mx-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={pieData}
              dataKey="value"
              nameKey="name"
              innerRadius={50}
              outerRadius={75}
              paddingAngle={2}
              startAngle={90}
              endAngle={-270}
            >
              {pieData.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
            </Pie>
            <Tooltip
              formatter={(v: number, n: string) => [`${v} customers`, n]}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500">
            Total
          </p>
          <p className="text-2xl font-bold text-zinc-900">{total}</p>
        </div>
      </div>
      <DonutLegend
        label="New"
        color={GROUP_COLOR.new}
        detail={insights.groups.new}
      />
      <DonutLegend
        label="Occasional"
        color={GROUP_COLOR.occasional}
        detail={insights.groups.occasional}
      />
      <DonutLegend
        label="Frequent"
        color={GROUP_COLOR.frequent}
        detail={insights.groups.frequent}
      />
    </div>
  );
}

function DonutLegend({
  label,
  color,
  detail,
}: {
  label: string;
  color: string;
  detail: { customerCount: number; share: number; prevCustomerCount: number };
}) {
  const delta = pctDelta(detail.customerCount, detail.prevCustomerCount);
  const up = delta >= 0;
  return (
    <div>
      <p className="text-sm font-semibold text-zinc-900 flex items-center gap-1.5">
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ background: color }}
        />
        {label}
      </p>
      <p className="mt-1 text-xl font-bold text-zinc-900">
        {detail.customerCount}{" "}
        <span className="text-xs font-normal text-zinc-500">
          ({fmtPct(detail.share)})
        </span>
      </p>
      <p
        className={`mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-semibold ${
          up ? "text-emerald-700" : "text-rose-700"
        }`}
      >
        {up ? (
          <ArrowUpRight className="h-3 w-3" />
        ) : (
          <ArrowDownRight className="h-3 w-3" />
        )}
        {Math.abs(delta).toFixed(1)}%
      </p>
    </div>
  );
}

function GroupCard({
  colorKey,
  label,
  definition,
  detail,
  totalRevenue,
}: {
  colorKey: "new" | "occasional" | "frequent";
  label: string;
  definition: string;
  detail: {
    revenue: number;
    revenueShare: number;
    avgOrderValue: number;
    customerCount: number;
  };
  totalRevenue: number;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <header className="mb-3 flex items-center gap-2">
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ background: GROUP_COLOR[colorKey] }}
        />
        <h3 className="text-base font-semibold text-zinc-900">{label}</h3>
      </header>
      <p className="text-xs text-zinc-500 mb-3">{definition}</p>
      <ul className="space-y-2 text-sm text-zinc-800">
        <li className="flex items-center gap-2">
          <PoundSterling className="h-3.5 w-3.5 text-zinc-400" />
          <span className="font-semibold">{fmtGBP(detail.revenue)}</span>
          <span className="text-xs text-zinc-500">
            ({fmtPct(detail.revenueShare)} of sales)
          </span>
        </li>
        <li className="flex items-center gap-2">
          <ShoppingBag className="h-3.5 w-3.5 text-zinc-400" />
          <span>
            <strong>{fmtGBP(detail.avgOrderValue)}</strong>{" "}
            <span className="text-xs text-zinc-500">avg order value</span>
          </span>
        </li>
        <li className="flex items-center gap-2">
          <Users className="h-3.5 w-3.5 text-zinc-400" />
          <span>
            <strong>{detail.customerCount}</strong>{" "}
            <span className="text-xs text-zinc-500">
              {detail.customerCount === 1 ? "customer" : "customers"}
            </span>
          </span>
        </li>
      </ul>
    </div>
  );
}

// ── CRM list tab ─────────────────────────────────────────────────────────────

interface Customer {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  totalOrders: number;
  totalSpend: string;
  createdAt: string;
  loyaltyAccount: {
    points: number;
    tier: string;
    lifetimeSpend: string;
  } | null;
}

const TIER_COLORS: Record<string, string> = {
  BRONZE: "text-amber-700 bg-amber-100",
  SILVER: "text-zinc-600 bg-zinc-100",
  GOLD: "text-yellow-700 bg-yellow-100",
  PLATINUM: "text-purple-700 bg-purple-100",
};

function CrmListTab() {
  const { user } = useAuthStore();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useMemo(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data: customers, isLoading } = useQuery({
    queryKey: ["customers", debouncedSearch],
    queryFn: () =>
      apiClient
        .get(
          `/v1/customers${debouncedSearch ? `?search=${encodeURIComponent(debouncedSearch)}` : ""}`,
        )
        .then((r) => r.data as Customer[]),
    enabled: !!user?.tenantId,
  });

  return (
    <div className="space-y-4">
      {/* Promos moved-to-marketing nudge */}
      <Link
        href="/dashboard/marketing"
        className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 hover:bg-amber-100"
      >
        <div className="flex items-center gap-2">
          <Megaphone className="h-4 w-4 text-amber-600" />
          <div>
            <p className="text-sm font-semibold text-amber-900">
              Promotions now live in Marketing
            </p>
            <p className="text-[11px] text-amber-800">
              Build percentage / amount / item / BOGO / free-delivery /
              happy-hour offers from the new Marketing section.
            </p>
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-amber-600" />
      </Link>

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, or phone…"
          className="w-full rounded-md border border-zinc-200 bg-white pl-8 pr-3 py-2 text-sm focus:border-zinc-400 focus:outline-none"
        />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10 text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : !customers || customers.length === 0 ? (
        <p className="text-sm text-zinc-500 py-10 text-center">
          No customers found.
        </p>
      ) : (
        <div className="rounded-lg border border-zinc-200 bg-white overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-zinc-500">
              <tr className="border-b border-zinc-100">
                <th className="px-3 py-2 text-left font-semibold">Customer</th>
                <th className="px-3 py-2 text-left font-semibold">Contact</th>
                <th className="px-3 py-2 text-right font-semibold">Orders</th>
                <th className="px-3 py-2 text-right font-semibold">
                  Total spend
                </th>
                <th className="px-3 py-2 text-left font-semibold">Loyalty</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} className="border-b border-zinc-50 last:border-0">
                  <td className="px-3 py-3 text-zinc-900">
                    <p className="font-medium">
                      {(c.firstName || "") + " " + (c.lastName || "")}
                    </p>
                    <p className="text-[11px] text-zinc-500">
                      Since {new Date(c.createdAt).toLocaleDateString("en-GB")}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-zinc-700 text-xs">
                    {c.email && (
                      <p className="flex items-center gap-1">
                        <Mail className="h-3 w-3 text-zinc-400" />
                        {c.email}
                      </p>
                    )}
                    {c.phone && (
                      <p className="flex items-center gap-1 mt-0.5">
                        <Phone className="h-3 w-3 text-zinc-400" />
                        {c.phone}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right text-zinc-800">
                    {c.totalOrders}
                  </td>
                  <td className="px-3 py-3 text-right text-zinc-800 font-semibold">
                    £{Number(c.totalSpend).toFixed(2)}
                  </td>
                  <td className="px-3 py-3">
                    {c.loyaltyAccount ? (
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          TIER_COLORS[c.loyaltyAccount.tier] ??
                          "bg-zinc-100 text-zinc-700"
                        }`}
                      >
                        <Star className="h-3 w-3" />
                        {c.loyaltyAccount.tier}
                      </span>
                    ) : (
                      <span className="text-[11px] text-zinc-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
