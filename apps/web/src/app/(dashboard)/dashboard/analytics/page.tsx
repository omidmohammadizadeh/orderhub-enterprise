"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  TrendingUp,
  DollarSign,
  ShoppingBag,
  Clock,
  Star,
  Users,
  Loader2,
  BarChart3,
  ArrowUpRight,
  ArrowDownRight,
  RefreshCw,
  AlertCircle,
  Package,
  Truck,
} from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { cn } from "@/lib/utils";

interface SalesOverview {
  totalRevenue: string;
  totalOrders: number;
  avgOrderValue: string;
  revenueGrowth: number;
  orderGrowth: number;
  aovGrowth: number;
}

interface PlatformBreakdown {
  platform: string;
  orders: number;
  revenue: string;
  avgValue: string;
  cancellationRate: number;
}

interface ProductPerformance {
  menuItemId: string;
  name: string;
  orders: number;
  revenue: string;
  avgRating: number | null;
}

interface LocationMetrics {
  locationId: string;
  locationName: string;
  orders: number;
  revenue: string;
  avgPrepTime: number;
  avgRating: number | null;
}

interface KitchenMetrics {
  avgPrepTime: number;
  p95PrepTime: number;
  slaBreaches: number;
  slaBreachRate: number;
}

interface DriverMetrics {
  totalDeliveries: number;
  avgDeliveryTime: number;
  onTimeRate: number;
  avgRating: number | null;
}

interface DailySalesPoint {
  date: string;
  revenue: string;
  orders: number;
}

interface AnalyticsSummary {
  overview: SalesOverview;
  platforms: PlatformBreakdown[];
  topProducts: ProductPerformance[];
  locations: LocationMetrics[];
  kitchen: KitchenMetrics;
  drivers: DriverMetrics;
  dailySales: DailySalesPoint[];
  repeatCustomerRate: number;
  newCustomers: number;
}

const RANGE_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

const PLATFORM_COLORS: Record<string, string> = {
  UBER_EATS: "bg-black text-white",
  DELIVEROO: "bg-teal-600 text-white",
  JUST_EAT:  "bg-orange-500 text-white",
  DIRECT:    "bg-violet-600 text-white",
  HUBRRISE:  "bg-blue-600 text-white",
};

function StatCard({
  label, value, sub, growth, icon: Icon, iconClass,
}: {
  label: string; value: string; sub?: string; growth?: number;
  icon: React.ElementType; iconClass?: string;
}) {
  const positive = growth !== undefined ? growth >= 0 : null;
  return (
    <div className="bg-white border border-zinc-200 rounded-2xl p-5">
      <div className="flex items-start justify-between">
        <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center", iconClass ?? "bg-zinc-100")}>
          <Icon className="w-[18px] h-[18px]" />
        </div>
        {growth !== undefined && (
          <span className={cn(
            "flex items-center gap-0.5 text-xs font-medium px-2 py-0.5 rounded-full",
            positive ? "text-emerald-700 bg-emerald-100" : "text-red-600 bg-red-100",
          )}>
            {positive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {Math.abs(growth).toFixed(1)}%
          </span>
        )}
      </div>
      <div className="mt-3">
        <div className="text-2xl font-bold text-zinc-900">{value}</div>
        <div className="text-sm text-zinc-500 mt-0.5">{label}</div>
        {sub && <div className="text-xs text-zinc-400 mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}

function MiniBar({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="w-full bg-zinc-100 rounded-full h-1.5">
      <div className={cn("h-1.5 rounded-full", className ?? "bg-orange-500")} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function AnalyticsPage() {
  const [range, setRange] = useState("30d");

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["analytics-summary", range],
    queryFn: () =>
      apiClient
        .get(`/v1/analytics/summary?range=${range}`)
        .then((r) => r.data as AnalyticsSummary)
        .catch(() => null),
  });

  const maxRevenue = data?.dailySales?.length
    ? Math.max(...data.dailySales.map((d) => parseFloat(d.revenue)))
    : 0;

  const maxOrders = data?.platforms?.length
    ? Math.max(...data.platforms.map((p) => p.orders))
    : 0;

  const maxProductOrders = data?.topProducts?.length
    ? Math.max(...data.topProducts.map((p) => p.orders))
    : 0;

  return (
    <div className="space-y-8 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Analytics</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Sales, performance, and operational insights</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center bg-zinc-100 rounded-xl p-1 gap-0.5">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setRange(opt.value)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
                  range === opt.value
                    ? "bg-white text-zinc-900 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-700",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => refetch()}
            className="p-2 rounded-xl border border-zinc-200 text-zinc-500 hover:text-zinc-700 hover:bg-zinc-50"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
        </div>
      ) : isError || !data ? (
        <div className="flex flex-col items-center justify-center py-24 text-zinc-500 gap-3">
          <AlertCircle className="w-8 h-8 text-zinc-300" />
          <p>Analytics data unavailable.</p>
        </div>
      ) : (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              label="Total revenue"
              value={`£${parseFloat(data.overview.totalRevenue).toLocaleString("en-GB", { minimumFractionDigits: 2 })}`}
              growth={data.overview.revenueGrowth}
              icon={DollarSign}
              iconClass="bg-emerald-100 text-emerald-600"
            />
            <StatCard
              label="Orders"
              value={data.overview.totalOrders.toLocaleString()}
              growth={data.overview.orderGrowth}
              icon={ShoppingBag}
              iconClass="bg-blue-100 text-blue-600"
            />
            <StatCard
              label="Avg order value"
              value={`£${parseFloat(data.overview.avgOrderValue).toFixed(2)}`}
              growth={data.overview.aovGrowth}
              icon={TrendingUp}
              iconClass="bg-orange-100 text-orange-600"
            />
            <StatCard
              label="Repeat customer rate"
              value={`${data.repeatCustomerRate.toFixed(1)}%`}
              sub={`${data.newCustomers.toLocaleString()} new customers`}
              icon={Users}
              iconClass="bg-violet-100 text-violet-600"
            />
          </div>

          {/* Revenue sparkline */}
          {data.dailySales?.length > 0 && (
            <div className="bg-white border border-zinc-200 rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="w-4 h-4 text-zinc-500" />
                <h2 className="font-medium text-zinc-900">Revenue trend</h2>
              </div>
              <div className="flex items-end gap-1 h-24">
                {data.dailySales.map((day) => {
                  const pct = maxRevenue > 0 ? (parseFloat(day.revenue) / maxRevenue) * 100 : 0;
                  return (
                    <div
                      key={day.date}
                      className="group relative flex-1 min-w-0"
                      title={`${day.date}: £${parseFloat(day.revenue).toFixed(2)} · ${day.orders} orders`}
                    >
                      <div
                        className="w-full bg-orange-500 rounded-t hover:bg-orange-400 transition-colors cursor-pointer"
                        style={{ height: `${Math.max(4, pct)}%` }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between mt-1 text-[10px] text-zinc-400">
                <span>{data.dailySales[0]?.date}</span>
                <span>{data.dailySales[data.dailySales.length - 1]?.date}</span>
              </div>
            </div>
          )}

          {/* Platform breakdown + Kitchen/Driver metrics */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white border border-zinc-200 rounded-2xl p-6">
              <h2 className="font-medium text-zinc-900 mb-4">Platform breakdown</h2>
              {data.platforms?.length ? (
                <div className="space-y-3">
                  {data.platforms.map((p) => (
                    <div key={p.platform}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            "text-[10px] font-bold px-1.5 py-0.5 rounded",
                            PLATFORM_COLORS[p.platform] ?? "bg-zinc-200 text-zinc-700",
                          )}>
                            {p.platform.replace(/_/g, " ")}
                          </span>
                          <span className="text-sm text-zinc-700">{p.orders} orders</span>
                        </div>
                        <span className="text-sm font-semibold text-zinc-900">
                          £{parseFloat(p.revenue).toLocaleString("en-GB", { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                      <MiniBar value={p.orders} max={maxOrders} />
                      <div className="flex justify-between text-xs text-zinc-400 mt-0.5">
                        <span>AOV £{parseFloat(p.avgValue).toFixed(2)}</span>
                        <span className={cn(p.cancellationRate > 5 ? "text-red-500" : "")}>
                          {p.cancellationRate.toFixed(1)}% cancelled
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-zinc-400 text-center py-6">No platform data.</p>
              )}
            </div>

            <div className="space-y-4">
              <div className="bg-white border border-zinc-200 rounded-2xl p-6">
                <div className="flex items-center gap-2 mb-4">
                  <Clock className="w-4 h-4 text-zinc-500" />
                  <h2 className="font-medium text-zinc-900">Kitchen SLA</h2>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  {[
                    { label: "Avg prep time", value: `${data.kitchen.avgPrepTime}m` },
                    { label: "P95 prep time", value: `${data.kitchen.p95PrepTime}m` },
                    { label: "SLA breaches", value: data.kitchen.slaBreaches.toLocaleString(), alert: data.kitchen.slaBreachRate > 10 },
                    { label: "Breach rate", value: `${data.kitchen.slaBreachRate.toFixed(1)}%`, alert: data.kitchen.slaBreachRate > 10 },
                  ].map(({ label, value, alert }) => (
                    <div key={label} className="bg-zinc-50 rounded-xl p-3">
                      <div className="text-xs text-zinc-500">{label}</div>
                      <div className={cn("text-lg font-bold mt-0.5", alert ? "text-red-600" : "text-zinc-900")}>
                        {value}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-white border border-zinc-200 rounded-2xl p-6">
                <div className="flex items-center gap-2 mb-4">
                  <Truck className="w-4 h-4 text-zinc-500" />
                  <h2 className="font-medium text-zinc-900">Driver metrics</h2>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  {[
                    { label: "Deliveries", value: data.drivers.totalDeliveries.toLocaleString() },
                    { label: "Avg delivery time", value: `${data.drivers.avgDeliveryTime}m` },
                    { label: "On-time rate", value: `${data.drivers.onTimeRate.toFixed(1)}%` },
                    { label: "Avg rating", value: data.drivers.avgRating ? data.drivers.avgRating.toFixed(1) : "—" },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-zinc-50 rounded-xl p-3">
                      <div className="text-xs text-zinc-500">{label}</div>
                      <div className="text-lg font-bold text-zinc-900 mt-0.5">{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Top products + Location comparison */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-4 border-b border-zinc-100">
                <Package className="w-4 h-4 text-orange-500" />
                <h2 className="font-medium text-zinc-900">Top items</h2>
              </div>
              {data.topProducts?.length ? (
                <div className="divide-y divide-zinc-50">
                  {data.topProducts.slice(0, 8).map((p, i) => (
                    <div key={p.menuItemId} className="px-5 py-3">
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-zinc-400 w-4">{i + 1}</span>
                          <span className="text-sm font-medium text-zinc-800 truncate max-w-[150px]">{p.name}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          {p.avgRating && (
                            <span className="flex items-center gap-0.5 text-xs text-amber-500">
                              <Star className="w-3 h-3 fill-amber-400 stroke-amber-400" />
                              {p.avgRating.toFixed(1)}
                            </span>
                          )}
                          <span className="text-sm font-semibold text-zinc-900">
                            £{parseFloat(p.revenue).toLocaleString("en-GB", { minimumFractionDigits: 2 })}
                          </span>
                        </div>
                      </div>
                      <MiniBar value={p.orders} max={maxProductOrders} className="bg-orange-400" />
                      <div className="text-xs text-zinc-400 mt-0.5">{p.orders} orders</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-10 text-zinc-400 text-sm">No product data.</div>
              )}
            </div>

            <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-4 border-b border-zinc-100">
                <BarChart3 className="w-4 h-4 text-blue-500" />
                <h2 className="font-medium text-zinc-900">Location comparison</h2>
              </div>
              {data.locations?.length ? (
                <div className="divide-y divide-zinc-50">
                  {data.locations.map((loc) => {
                    const maxLocRev = Math.max(...data.locations.map((l) => parseFloat(l.revenue)));
                    return (
                      <div key={loc.locationId} className="px-5 py-3">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-zinc-800 truncate max-w-[150px]">
                            {loc.locationName}
                          </span>
                          <span className="text-sm font-semibold text-zinc-900">
                            £{parseFloat(loc.revenue).toLocaleString("en-GB", { minimumFractionDigits: 2 })}
                          </span>
                        </div>
                        <MiniBar value={parseFloat(loc.revenue)} max={maxLocRev} className="bg-blue-500" />
                        <div className="flex justify-between text-xs text-zinc-400 mt-0.5">
                          <span>{loc.orders} orders · {loc.avgPrepTime}m avg prep</span>
                          {loc.avgRating && (
                            <span className="flex items-center gap-0.5 text-amber-500">
                              <Star className="w-3 h-3 fill-amber-400 stroke-amber-400" />
                              {loc.avgRating.toFixed(1)}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-10 text-zinc-400 text-sm">No location data.</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
