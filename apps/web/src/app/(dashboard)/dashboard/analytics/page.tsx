import type { Metadata } from "next";
import { TrendingUp, ShoppingBag, Banknote, Star, BarChart3 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Analytics" };

const STATS = [
  { label: "Total Revenue", value: "£0.00", change: "+0%", icon: Banknote, color: "text-emerald-500" },
  { label: "Total Orders", value: "0", change: "+0%", icon: ShoppingBag, color: "text-blue-500" },
  { label: "Avg. Order Value", value: "£0.00", change: "+0%", icon: TrendingUp, color: "text-violet-500" },
  { label: "Customer Rating", value: "—", change: "No data", icon: Star, color: "text-amber-500" },
];

const TIME_RANGES = ["Today", "7 days", "30 days", "90 days", "Custom"];

export default function AnalyticsPage() {
  return (
    <div className="space-y-6">
      {/* Time range selector */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {TIME_RANGES.map((r, i) => (
            <button
              key={r}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                i === 1
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm">Export CSV</Button>
      </div>

      {/* Stats grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STATS.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.label}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-xs font-medium text-zinc-500">{stat.label}</p>
                    <p className="mt-2 text-2xl font-bold text-zinc-900 tabular-nums">
                      {stat.value}
                    </p>
                    <p className="mt-1 text-xs text-zinc-400">{stat.change} vs last period</p>
                  </div>
                  <Icon className={`h-5 w-5 mt-0.5 ${stat.color}`} />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Chart placeholder */}
      <Card>
        <CardHeader>
          <CardTitle>Revenue over time</CardTitle>
          <CardDescription>Connect a platform to see revenue data</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-dashed border-zinc-200 bg-zinc-50">
            <BarChart3 className="h-10 w-10 text-zinc-300" />
            <p className="mt-3 text-sm font-medium text-zinc-500">No data yet</p>
            <p className="mt-1 text-xs text-zinc-400">
              Connect your delivery platforms to see revenue insights
            </p>
            <Button className="mt-4" size="sm">Connect a platform</Button>
          </div>
        </CardContent>
      </Card>

      {/* Secondary charts row */}
      <div className="grid gap-4 md:grid-cols-2">
        {["Orders by platform", "Orders by hour"].map((title) => (
          <Card key={title}>
            <CardHeader>
              <CardTitle>{title}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-zinc-200 bg-zinc-50">
                <p className="text-sm text-zinc-400">No data</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
