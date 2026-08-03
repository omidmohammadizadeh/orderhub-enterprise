"use client";

// Phase AW-24 — Enterprise analytics dashboard.
//
// One page, one /v1/analytics/overview call, with filters across
// date range / location / brand / channel / fulfilment type. The
// response carries a "previous period" snapshot of the same span
// ending right before the current `from` so every KPI shows a
// vs-prev delta and the revenue chart can overlay last week's line
// on top of this week's.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Utensils,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Building2,
  Calendar,
  Download,
  Loader2,
  MapPin,
  PoundSterling,
  ShoppingBag,
  Sparkles,
  Tag,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  PieChart,
  Pie,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  analyticsClient,
  type AnalyticsOverview,
} from "@/lib/api/analytics.client";
import { brandsClient, locationsClient } from "@/lib/api/locations.client";

const CHANNELS = ["POS", "DIRECT", "ONLINE", "JUST_EAT", "UBER_EATS", "DELIVEROO", "HUBRISE"];
const CHART_COLORS = [
  "#f97316", // orange
  "#8b5cf6", // violet
  "#10b981", // emerald
  "#3b82f6", // blue
  "#ec4899", // pink
  "#f59e0b", // amber
  "#06b6d4", // cyan
];

type DatePreset = "today" | "yesterday" | "7d" | "30d" | "thisMonth" | "lastMonth" | "custom";

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
    case "yesterday": {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { from: start(y), to: end(y) };
    }
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

const PRESETS: Array<{ id: DatePreset; label: string }> = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "thisMonth", label: "This month" },
  { id: "lastMonth", label: "Last month" },
  { id: "custom", label: "Custom" },
];

const fmtGBP = (n: number) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 2,
  }).format(n);

const fmtNum = (n: number) => new Intl.NumberFormat("en-GB").format(n);

function pctDelta(curr: number, prev: number): number {
  if (prev === 0) return curr > 0 ? 100 : 0;
  return ((curr - prev) / prev) * 100;
}

export default function AnalyticsPage() {
  const [preset, setPreset] = useState<DatePreset>("7d");
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo] = useState<string>("");
  const [locationId, setLocationId] = useState<string>("");
  const [brandId, setBrandId] = useState<string>("");
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [tab, setTab] = useState<"revenue" | "orders" | "aov" | "breakdown">(
    "revenue",
  );

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
    brandId: brandId || undefined,
    channels: selectedChannels.length ? selectedChannels : undefined,
  };

  const overviewQuery = useQuery({
    queryKey: ["analytics", "overview", filters],
    queryFn: () => analyticsClient.overview(filters),
  });

  const brandsQuery = useQuery({
    queryKey: ["analytics", "brands"],
    queryFn: () => brandsClient.list(),
  });
  const locationsQuery = useQuery({
    queryKey: ["analytics", "locations"],
    queryFn: () => locationsClient.list(),
  });

  const data = overviewQuery.data;
  const loading = overviewQuery.isLoading;

  function exportCsv() {
    if (!data) return;
    const rows: string[] = [];
    rows.push("Section,Key,Value");
    const s = data.summary;
    rows.push(`Summary,Gross revenue,${s.grossRevenue.toFixed(2)}`);
    rows.push(`Summary,Net revenue,${s.netRevenue.toFixed(2)}`);
    rows.push(`Summary,Discount,${s.discount.toFixed(2)}`);
    rows.push(`Summary,Delivery fees,${s.deliveryFees.toFixed(2)}`);
    rows.push(`Summary,Tax,${s.taxAmount.toFixed(2)}`);
    rows.push(`Summary,Successful orders,${s.successfulOrders}`);
    rows.push(`Summary,Cancelled orders,${s.cancelledOrders}`);
    rows.push(`Summary,Avg order value,${s.avgOrderValue.toFixed(2)}`);
    rows.push("");
    rows.push("By channel,Name,Revenue,Orders");
    for (const c of data.byChannel)
      rows.push(`,${c.name},${c.revenue.toFixed(2)},${c.orders}`);
    rows.push("");
    rows.push("By brand,Name,Revenue,Orders");
    for (const b of data.byBrand)
      rows.push(`,${b.name},${b.revenue.toFixed(2)},${b.orders}`);
    rows.push("");
    rows.push("Top products,Name,Quantity,Revenue");
    for (const p of data.topProducts)
      rows.push(`,${p.name.replace(/,/g, " ")},${p.quantity},${p.revenue.toFixed(2)}`);
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `analytics-${data.window.from.slice(0, 10)}-to-${data.window.to.slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="px-6 py-6 space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 flex items-center gap-2">
            <Activity className="h-5 w-5" /> Analytics
          </h1>
          <p className="text-sm text-zinc-500 mt-1">
            Revenue, sales mix, hot products, hot postcodes — with a
            same-length prior-period comparison for every KPI.
          </p>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          disabled={!data}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" /> Export CSV
        </button>
      </header>

      {/* Filter bar */}
      <section className="rounded-lg border border-zinc-200 bg-white p-3 space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPreset(p.id)}
              className={`rounded-md border px-3 py-1 text-xs font-medium ${
                preset === p.id
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
              }`}
            >
              {p.label}
            </button>
          ))}
          {preset === "custom" && (
            <div className="flex items-center gap-2">
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="rounded-md border border-zinc-200 px-2 py-1.5 text-xs"
          >
            <option value="">All locations</option>
            {(locationsQuery.data ?? []).map((l: any) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <select
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            className="rounded-md border border-zinc-200 px-2 py-1.5 text-xs"
          >
            <option value="">All brands</option>
            {(brandsQuery.data ?? []).map((b: any) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-1">
            {CHANNELS.map((c) => {
              const on = selectedChannels.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() =>
                    setSelectedChannels((prev) =>
                      prev.includes(c)
                        ? prev.filter((x) => x !== c)
                        : [...prev, c],
                    )
                  }
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                    on
                      ? "border-orange-500 bg-orange-50 text-orange-900"
                      : "border-zinc-200 text-zinc-600 hover:border-zinc-300"
                  }`}
                >
                  {c.replace(/_/g, " ")}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : !data ? (
        <p className="text-sm text-zinc-500">No data for this filter set.</p>
      ) : (
        <>
          {/* KPI tiles */}
          <section className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
            <KpiCard
              label="Gross revenue"
              value={fmtGBP(data.summary.grossRevenue)}
              hint="Subtotal + delivery + tax"
              delta={pctDelta(
                data.summary.grossRevenue,
                data.summary.prevGrossRevenue,
              )}
              icon={<PoundSterling className="h-4 w-4" />}
            />
            <KpiCard
              label="Net revenue"
              value={fmtGBP(data.summary.netRevenue)}
              hint="After discounts"
              delta={pctDelta(
                data.summary.netRevenue,
                data.summary.prevNetRevenue,
              )}
              icon={<Sparkles className="h-4 w-4" />}
              tone="primary"
            />
            <KpiCard
              label="Successful orders"
              value={fmtNum(data.summary.successfulOrders)}
              hint="Completed"
              delta={pctDelta(
                data.summary.successfulOrders,
                data.summary.prevSuccessfulOrders,
              )}
              icon={<ShoppingBag className="h-4 w-4" />}
            />
            <KpiCard
              label="Avg order value"
              value={fmtGBP(data.summary.avgOrderValue)}
              delta={pctDelta(
                data.summary.avgOrderValue,
                data.summary.prevAvgOrderValue,
              )}
              icon={<Tag className="h-4 w-4" />}
            />
            <KpiCard
              label="Cancelled / failed"
              value={fmtNum(
                data.summary.cancelledOrders + data.summary.failedOrders,
              )}
              hint={`${fmtGBP(data.summary.cancelledRevenue + data.summary.failedRevenue)} lost`}
              icon={<AlertTriangle className="h-4 w-4" />}
              tone="danger"
            />
            <KpiCard
              label="Discount given"
              value={fmtGBP(data.summary.discount)}
              icon={<TrendingDown className="h-4 w-4" />}
            />
            <KpiCard
              label="Delivery fees"
              value={fmtGBP(data.summary.deliveryFees)}
              icon={<MapPin className="h-4 w-4" />}
            />
            <KpiCard
              label="Tax collected"
              value={fmtGBP(data.summary.taxAmount)}
              icon={<Building2 className="h-4 w-4" />}
            />
          </section>

          {/* Main chart + tab strip */}
          <section className="rounded-lg border border-zinc-200 bg-white">
            {/* Phone: tabs on their own line, scrolling sideways inside the
                card; the window summary sits beneath. Side by side, four tab
                labels and two date ranges were each squeezed into a column a
                word wide. */}
            <header className="flex flex-col gap-1.5 border-b border-zinc-100 px-4 py-2 md:flex-row md:items-center md:justify-between">
              <nav className="-mx-4 flex items-center gap-3 overflow-x-auto px-4 md:mx-0 md:px-0">
                {[
                  { id: "revenue", label: "Revenue" },
                  { id: "orders", label: "Orders" },
                  { id: "aov", label: "Avg order value" },
                  { id: "breakdown", label: "Revenue breakdown" },
                ].map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTab(t.id as any)}
                    className={`shrink-0 whitespace-nowrap pb-1 text-sm font-medium ${
                      tab === t.id
                        ? "border-b-2 border-emerald-600 text-zinc-900"
                        : "text-zinc-500 hover:text-zinc-800"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </nav>
              <span className="shrink-0 whitespace-nowrap text-[11px] text-zinc-400">
                <Calendar className="inline h-3 w-3 mr-1" />
                {new Date(data.window.from).toLocaleDateString()} →{" "}
                {new Date(data.window.to).toLocaleDateString()}
                {/* The comparison window is context, not the headline — on a
                    phone it doubles the length of the line for something you
                    can already see plotted. */}
                <span className="hidden md:inline">
                  {" "}· vs prior{" "}
                  {new Date(data.window.prevFrom).toLocaleDateString()} →{" "}
                  {new Date(data.window.prevTo).toLocaleDateString()}
                </span>
              </span>
            </header>
            <div className="p-4">
              {tab === "revenue" && <RevenueChart data={data.revenueTimeline} />}
              {tab === "orders" && <OrdersChart data={data.revenueTimeline} />}
              {tab === "aov" && (
                <AovChart
                  data={data.revenueTimeline.map((d) => ({
                    date: d.date,
                    aov: d.orders > 0 ? d.revenue / d.orders : 0,
                  }))}
                />
              )}
              {tab === "breakdown" && (
                <BreakdownPie data={data.byChannel} />
              )}
            </div>
          </section>

          {/* Dine-in service report — floor numbers, not sales ones. */}
          <section>
            <WalkInPanel filters={filters} />
            <DineInPanel
              filters={{
                from: filters.from,
                to: filters.to,
                locationId: filters.locationId,
              }}
            />
          </section>

          {/* Channel + Brand + Location */}
          <section className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <Card title="Sales by channel" subtitle="Revenue and order count">
              {data.byChannel.length === 0 ? (
                <Empty />
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={data.byChannel} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
                    <XAxis type="number" tick={{ fontSize: 10 }} />
                    <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 11 }} />
                    <Tooltip
                      formatter={(value: number, key: string) =>
                        key === "revenue"
                          ? [fmtGBP(value), "Revenue"]
                          : [fmtNum(value), "Orders"]
                      }
                    />
                    <Bar dataKey="revenue" fill="#f97316" />
                  </BarChart>
                </ResponsiveContainer>
              )}
              <SmallTable
                rows={data.byChannel.map((c) => [
                  c.name,
                  fmtGBP(c.revenue),
                  fmtNum(c.orders),
                ])}
                headers={["Channel", "Revenue", "Orders"]}
              />
            </Card>
            <Card title="Sales by brand" subtitle="Top → bottom">
              {data.byBrand.length === 0 ? (
                <Empty />
              ) : (
                <SmallTable
                  rows={data.byBrand.map((b) => [
                    b.name,
                    fmtGBP(b.revenue),
                    fmtNum(b.orders),
                  ])}
                  headers={["Brand", "Revenue", "Orders"]}
                />
              )}
            </Card>
            <Card title="Sales by location" subtitle="Top → bottom">
              {data.byLocation.length === 0 ? (
                <Empty />
              ) : (
                <SmallTable
                  rows={data.byLocation.map((l) => [
                    l.name,
                    fmtGBP(l.revenue),
                    fmtNum(l.orders),
                  ])}
                  headers={["Location", "Revenue", "Orders"]}
                />
              )}
            </Card>
          </section>

          {/* Products + postcodes */}
          <section className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <Card title="Best selling products" subtitle="By revenue">
              {data.topProducts.length === 0 ? (
                <Empty />
              ) : (
                <SmallTable
                  rows={data.topProducts.map((p) => [
                    p.name,
                    fmtNum(p.quantity),
                    fmtGBP(p.revenue),
                  ])}
                  headers={["Product", "Qty", "Revenue"]}
                />
              )}
            </Card>
            <Card title="Best postcodes" subtitle="Delivery orders only">
              {data.topPostcodes.length === 0 ? (
                <Empty />
              ) : (
                <SmallTable
                  rows={data.topPostcodes.map((p) => [
                    p.postcode,
                    fmtNum(p.orders),
                    fmtGBP(p.revenue),
                  ])}
                  headers={["Outer", "Orders", "Revenue"]}
                />
              )}
            </Card>
            <Card title="Weakest postcodes" subtitle="Smallest delivery revenue">
              {data.weakestPostcodes.length === 0 ? (
                <Empty />
              ) : (
                <SmallTable
                  rows={data.weakestPostcodes.map((p) => [
                    p.postcode,
                    fmtNum(p.orders),
                    fmtGBP(p.revenue),
                  ])}
                  headers={["Outer", "Orders", "Revenue"]}
                />
              )}
            </Card>
          </section>

          {/* Heatmap */}
          <section className="rounded-lg border border-zinc-200 bg-white p-4">
            <header className="mb-3">
              <h2 className="text-sm font-semibold text-zinc-900">
                Order hours by day
              </h2>
              <p className="text-[11px] text-zinc-500">
                Darker = more orders. Helps spot peak windows.
              </p>
            </header>
            <Heatmap data={data.hourlyHeatmap} />
          </section>
        </>
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  hint,
  delta,
  icon,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: number;
  icon?: React.ReactNode;
  tone?: "primary" | "danger";
}) {
  const ring =
    tone === "primary"
      ? "border-emerald-200 bg-emerald-50"
      : tone === "danger"
        ? "border-rose-200 bg-rose-50"
        : "border-zinc-200 bg-white";
  const up = (delta ?? 0) >= 0;
  return (
    <div className={`rounded-lg border ${ring} p-3`}>
      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        <span>{label}</span>
        {icon}
      </div>
      <p className="text-xl font-bold mt-1 text-zinc-900">{value}</p>
      {hint && <p className="text-[10px] text-zinc-500 mt-0.5">{hint}</p>}
      {delta !== undefined && (
        <p
          className={`mt-1 inline-flex items-center gap-0.5 text-[10px] font-semibold ${
            up ? "text-emerald-700" : "text-rose-700"
          }`}
        >
          {up ? (
            <ArrowUpRight className="h-3 w-3" />
          ) : (
            <ArrowDownRight className="h-3 w-3" />
          )}
          {Math.abs(delta).toFixed(1)}% vs prior period
        </p>
      )}
    </div>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3">
      <header className="mb-2">
        <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
        {subtitle && <p className="text-[11px] text-zinc-500">{subtitle}</p>}
      </header>
      {children}
    </div>
  );
}

function Empty() {
  return (
    <p className="py-8 text-center text-xs text-zinc-400">
      No data in this window.
    </p>
  );
}

function SmallTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: Array<Array<string | number>>;
}) {
  return (
    <div className="overflow-x-auto mt-2">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="border-b border-zinc-100 text-zinc-500">
            {headers.map((h, i) => (
              <th
                key={h}
                className={`px-2 py-1.5 font-semibold uppercase tracking-wider text-[10px] ${
                  i === 0 ? "text-left" : "text-right"
                }`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={idx} className="border-b border-zinc-50 last:border-0">
              {r.map((c, i) => (
                <td
                  key={i}
                  className={`px-2 py-1.5 ${i === 0 ? "text-left text-zinc-800" : "text-right text-zinc-600"}`}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Dine-in service report. Separate from the revenue charts on purpose —
 * these are floor-management numbers, not sales ones. Spend per head is the
 * one that actually tells a manager something: revenue alone can't
 * distinguish a busy night from an expensive one.
 */
// Counter trade — POS walk-ins and kiosk orders. Kept apart from phone and
// online because it behaves differently: no delivery cost, no marketing
// consent, and it is the number that says whether a kiosk earns its space.
function WalkInPanel({
  filters,
}: {
  filters: { from: string; to: string; locationId?: string };
}) {
  const q = useQuery({
    queryKey: ["walk-in-report", filters.from, filters.to, filters.locationId],
    queryFn: () =>
      analyticsClient.walkIn({
        startDate: filters.from,
        endDate: filters.to,
        locationId: filters.locationId,
      }),
  });
  const d = q.data;
  const money = (n: number) => `£${Number(n ?? 0).toFixed(2)}`;

  if (q.isLoading) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-5 text-sm text-zinc-500">
        Loading walk-in report…
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-5 text-sm text-red-600">
        Couldn&rsquo;t load the walk-in report.
      </div>
    );
  }
  if (!d || d.orders === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-zinc-900">Walk-in</h3>
        <p className="mt-1 text-sm text-zinc-500">
          No walk-in orders in this period. Counter sales appear here when
          staff use the Walk-in button on the POS, and every kiosk order is
          counted automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5">
      <h3 className="text-sm font-semibold text-zinc-900">
        Walk-in <span className="font-normal text-zinc-400">counter + kiosk</span>
      </h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <WalkInCell label="Walk-in revenue" value={money(d.revenue)} hint={`${d.orders} order${d.orders === 1 ? "" : "s"}`} />
        <WalkInCell label="Average order" value={money(d.avgOrderValue)} />
        <WalkInCell label="Paid" value={String(d.paidOrders)} />
        <WalkInCell
          label="Unpaid"
          value={String(d.unpaid)}
          hint={d.unpaid > 0 ? "Waiting to be settled at the counter" : undefined}
        />
      </div>
      {!!d.byPaymentMethod.length && (
        <div className="mt-4 border-t border-zinc-100 pt-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            How it was paid
          </p>
          <ul className="space-y-1">
            {d.byPaymentMethod.map((m) => (
              <li key={m.method} className="flex justify-between text-xs text-zinc-600">
                <span>
                  {m.method === "CASH"
                    ? "Cash / at the counter"
                    : m.method === "CARD"
                      ? "Card"
                      : m.method}
                  <span className="ml-1.5 text-zinc-400">× {m.count}</span>
                </span>
                <span className="font-medium">{money(m.revenue)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function WalkInCell({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg bg-zinc-50 p-3">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-bold text-zinc-900">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-zinc-400">{hint}</div>}
    </div>
  );
}

function DineInPanel({
  filters,
}: {
  filters: { from: string; to: string; locationId?: string };
}) {
  const q = useQuery({
    queryKey: ["dine-in-report", filters.from, filters.to, filters.locationId],
    queryFn: () =>
      analyticsClient.dineIn({
        startDate: filters.from,
        endDate: filters.to,
        locationId: filters.locationId,
      }),
  });
  const d = q.data;
  const money = (n: number) => `£${Number(n ?? 0).toFixed(2)}`;

  if (q.isLoading) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-5 text-sm text-zinc-500">
        Loading dine-in report…
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-5 text-sm text-red-600">
        Couldn&rsquo;t load the dine-in report.
      </div>
    );
  }
  if (!d || d.orders === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-zinc-900">Dine-in</h3>
        <p className="mt-1 text-sm text-zinc-500">
          No dine-in orders in this period. Table service has to be switched on
          for a location, and tabs opened from the Tables page, before anything
          appears here.
        </p>
      </div>
    );
  }

  const cells: Array<[string, string, string?]> = [
    ["Covers", String(d.covers), `${d.ordersWithCovers} of ${d.orders} tabs recorded a guest count`],
    ["Spend per head", money(d.spendPerHead), "Only tabs with covers counted"],
    ["Dine-in revenue", money(d.revenue), `${d.orders} tab${d.orders === 1 ? "" : "s"}`],
    ["Average tab", money(d.avgOrderValue)],
    ["Service charge", money(d.serviceCharge)],
    ["Avg table time", `${d.avgTableMinutes}m`, "Opened to last touched"],
  ];

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-zinc-200 bg-white p-5">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-900">
          <Utensils className="h-4 w-4" /> Dine-in service
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {cells.map(([label, value, hint]) => (
            <div key={label} className="rounded-lg bg-zinc-50 p-3">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">
                {label}
              </div>
              <div className="text-lg font-semibold text-zinc-900">{value}</div>
              {hint && (
                <div className="mt-0.5 text-[10px] text-zinc-400">{hint}</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Write-offs. Voids and comps are shown apart because they mean
          different things — a void is a training problem, a comp is a
          decision someone made. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-zinc-200 bg-white p-4">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">
            Voided (rung in by mistake)
          </div>
          <div className="text-lg font-semibold text-zinc-900">
            {money(d.voids.value)}
          </div>
          <div className="text-[11px] text-zinc-400">
            {d.voids.count} line{d.voids.count === 1 ? "" : "s"}
          </div>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-4">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">
            Comped (given away)
          </div>
          <div className="text-lg font-semibold text-zinc-900">
            {money(d.comps.value)}
          </div>
          <div className="text-[11px] text-zinc-400">
            {d.comps.count} line{d.comps.count === 1 ? "" : "s"}
          </div>
        </div>
      </div>

      {d.unpaid > 0 && (
        <p className="rounded-md bg-amber-50 p-3 text-[12px] text-amber-800">
          {d.unpaid} dine-in {d.unpaid === 1 ? "tab is" : "tabs are"} still
          unpaid in this period.
        </p>
      )}
    </div>
  );
}

/**
 * Recharts sizes its tooltip from the content, with no upper bound. At a
 * phone width "Day 2026-08-01 / This period : £1,079.90" is wider than the
 * plot area, so the box hangs outside the card. Capping the width and
 * shrinking the text keeps it inside; allowEscapeViewBox is spelled out
 * rather than left to the default so a future Recharts upgrade can't quietly
 * change it.
 */
const TOOLTIP_PROPS = {
  allowEscapeViewBox: { x: false, y: false },
  wrapperStyle: { maxWidth: "min(260px, 70vw)", zIndex: 10 },
  contentStyle: { fontSize: 11, padding: "6px 8px", borderRadius: 8 },
  labelStyle: { fontSize: 11, marginBottom: 2 },
} as const;

function RevenueChart({ data }: { data: AnalyticsOverview["revenueTimeline"] }) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity={0.45} />
            <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
        <XAxis dataKey="date" tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `£${v}`} />
        <Tooltip
          {...TOOLTIP_PROPS}
          formatter={(v: number) => fmtGBP(v)}
          labelFormatter={(label) => `Day ${label}`}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Area
          type="monotone"
          dataKey="revenue"
          name="This period"
          stroke="#10b981"
          fill="url(#rev)"
        />
        <Line
          type="monotone"
          dataKey="prevRevenue"
          name="Prior period"
          stroke="#a1a1aa"
          strokeDasharray="4 4"
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function OrdersChart({ data }: { data: AnalyticsOverview["revenueTimeline"] }) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
        <XAxis dataKey="date" tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 10 }} />
        <Tooltip {...TOOLTIP_PROPS} />
        <Bar dataKey="orders" name="Orders" fill="#f97316" />
      </BarChart>
    </ResponsiveContainer>
  );
}

function AovChart({ data }: { data: Array<{ date: string; aov: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id="aov" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.45} />
            <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
        <XAxis dataKey="date" tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `£${v}`} />
        <Tooltip {...TOOLTIP_PROPS} formatter={(v: number) => fmtGBP(v)} />
        <Area
          type="monotone"
          dataKey="aov"
          name="Avg order value"
          stroke="#8b5cf6"
          fill="url(#aov)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function BreakdownPie({ data }: { data: AnalyticsOverview["byChannel"] }) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <PieChart>
        <Tooltip {...TOOLTIP_PROPS} formatter={(v: number) => fmtGBP(v)} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Pie
          data={data}
          dataKey="revenue"
          nameKey="name"
          cx="50%"
          cy="50%"
          outerRadius={110}
          label={(entry: any) => `${entry.name}: ${fmtGBP(entry.revenue)}`}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}

function Heatmap({
  data,
}: {
  data: AnalyticsOverview["hourlyHeatmap"];
}) {
  const max = Math.max(1, ...data.map((d) => d.orders));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // Render as a 7x24 grid, day rows
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[40px_repeat(24,minmax(0,1fr))] gap-0.5 text-[9px] text-zinc-400">
        <div />
        {Array.from({ length: 24 }).map((_, h) => (
          <div key={h} className="text-center">
            {h}
          </div>
        ))}
      </div>
      {days.map((label, d) => (
        <div
          key={d}
          className="grid grid-cols-[40px_repeat(24,minmax(0,1fr))] gap-0.5"
        >
          <div className="text-[10px] text-zinc-500 self-center">{label}</div>
          {Array.from({ length: 24 }).map((_, h) => {
            const cell = data.find(
              (x) => x.dayOfWeek === d && x.hour === h,
            ) ?? { orders: 0, revenue: 0 };
            const opacity = cell.orders / max;
            return (
              <div
                key={h}
                title={`${label} ${h}:00 · ${cell.orders} orders · ${fmtGBP(cell.revenue)}`}
                className="aspect-square rounded-sm"
                style={{
                  background:
                    opacity > 0
                      ? `rgba(16, 185, 129, ${Math.max(0.08, opacity)})`
                      : "rgb(244, 244, 245)",
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
