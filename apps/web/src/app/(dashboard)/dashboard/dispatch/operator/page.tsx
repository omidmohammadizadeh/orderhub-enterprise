"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Loader2,
  Truck,
  CheckCircle2,
  AlertTriangle,
  Users,
  Activity,
  XCircle,
} from "lucide-react";
import {
  getOperatorDashboard,
  getDispatchFeed,
  reassignOrder,
  unassignOrder,
  type OperatorDriverRow,
  type OperatorOrderRow,
} from "@/lib/api/dispatch.client";
import { DispatchChatWidget } from "@/components/dispatch/chat-widget";

// Phase AX-3b — Operator Dashboard. Live delivery ops: analytics, overdue
// attention, out-for-delivery, per-driver active jobs + cash-up, reassignment,
// and recent failed/cancelled.
export default function OperatorDashboardPage() {
  const queryClient = useQueryClient();
  const [location, setLocation] = useState("all");
  const [busyOrder, setBusyOrder] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["operator-dashboard", location],
    queryFn: () => getOperatorDashboard(location),
    refetchInterval: 10_000,
  });

  const optionsQuery = useQuery({
    queryKey: ["dispatch-locations"],
    queryFn: () => getDispatchFeed("all"),
    staleTime: 60_000,
  });
  const locationOptions = optionsQuery.data?.locations ?? [];
  // Scope to the user's accessible locations: one location → pinned (no "All");
  // multiple → picker with an "All" view.
  const multiLocation = locationOptions.length > 1;
  useEffect(() => {
    if (!multiLocation && locationOptions[0] && location === "all") {
      setLocation(locationOptions[0].id);
    }
  }, [multiLocation, locationOptions, location]);

  const onlineDrivers = (data?.drivers ?? []).filter((d) => d.status === "ONLINE");

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["operator-dashboard"] });
  }

  async function handleReturn(orderId: string) {
    setBusyOrder(orderId);
    try {
      await unassignOrder(orderId);
      refresh();
    } finally {
      setBusyOrder(null);
    }
  }
  async function handleReassign(orderId: string, driverId: string) {
    if (!driverId) return;
    setBusyOrder(orderId);
    try {
      await reassignOrder(orderId, driverId);
      refresh();
    } finally {
      setBusyOrder(null);
    }
  }

  const stats = data?.stats;

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/dispatch"
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
          >
            <ArrowLeft className="h-4 w-4" /> Dispatch
          </Link>
          <div>
            <h1 className="text-xl font-semibold">Operator dashboard</h1>
            <p className="text-sm text-muted-foreground">Live delivery operations.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          {multiLocation ? (
            <select
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="rounded-md border bg-background px-3 py-1.5 text-sm"
            >
              <option value="all">All locations</option>
              {locationOptions.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          ) : locationOptions[0] ? (
            <span className="rounded-md border bg-background px-3 py-1.5 text-sm">
              {locationOptions[0].name}
            </span>
          ) : null}
        </div>
      </div>

      {isError && <div className="text-sm text-red-600">Failed to load the dashboard.</div>}

      {/* Stat strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Stat icon={<Users className="h-4 w-4" />} label="Online" value={stats?.online ?? 0} tone="green" />
        <Stat icon={<Activity className="h-4 w-4" />} label="On a job" value={stats?.busy ?? 0} tone="amber" />
        <Stat icon={<Truck className="h-4 w-4" />} label="Out for delivery" value={stats?.outForDelivery ?? 0} tone="blue" />
        <Stat icon={<CheckCircle2 className="h-4 w-4" />} label="Delivered today" value={stats?.deliveredToday ?? 0} tone="green" />
        <Stat icon={<AlertTriangle className="h-4 w-4" />} label="Needs attention" value={stats?.attention ?? 0} tone="red" />
        <Stat icon={<XCircle className="h-4 w-4" />} label="Failed / cancelled" value={stats?.failedToday ?? 0} tone="slate" />
      </div>

      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Left column — attention + out for delivery */}
        <div className="flex flex-col gap-4">
          <Section title="Needs attention" count={data?.attention.length ?? 0} accent="red">
            {(data?.attention ?? []).length === 0 ? (
              <Empty>No overdue deliveries.</Empty>
            ) : (
              (data?.attention ?? []).map((o) => <OrderRow key={o.id} o={o} late />)
            )}
          </Section>

          <Section title="Out for delivery" count={data?.outForDelivery.length ?? 0} accent="blue">
            {(data?.outForDelivery ?? []).length === 0 ? (
              <Empty>Nothing out for delivery right now.</Empty>
            ) : (
              (data?.outForDelivery ?? []).map((o) => <OrderRow key={o.id} o={o} />)
            )}
          </Section>
        </div>

        {/* Right column — drivers */}
        <div className="flex flex-col gap-4">
          <Section title="Drivers" count={data?.drivers.length ?? 0} accent="slate">
            {(data?.drivers ?? []).length === 0 ? (
              <Empty>No active drivers.</Empty>
            ) : (
              <div className="space-y-3">
                {(data?.drivers ?? []).map((d) => (
                  <DriverCard
                    key={d.id}
                    d={d}
                    onlineDrivers={onlineDrivers}
                    busyOrder={busyOrder}
                    onReturn={handleReturn}
                    onReassign={handleReassign}
                  />
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>

      {/* Recent failed / cancelled */}
      <Section title="Recent failed / cancelled (today)" count={data?.recentFailed.length ?? 0} accent="slate">
        {(data?.recentFailed ?? []).length === 0 ? (
          <Empty>No failed or cancelled deliveries today.</Empty>
        ) : (
          <div className="divide-y">
            {(data?.recentFailed ?? []).map((o) => (
              <div key={o.id} className="flex items-center justify-between py-2 text-sm">
                <span className="font-medium">
                  {o.ref} · {o.customerName ?? "Customer"}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {o.reason && <span className="italic">{o.reason}</span>}
                  <span className="rounded bg-red-100 px-2 py-0.5 font-medium text-red-700">
                    {humanize(o.status)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Floating driver chat */}
      <DispatchChatWidget />
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────────

const TONES: Record<string, string> = {
  green: "text-green-600",
  amber: "text-amber-600",
  blue: "text-blue-600",
  red: "text-red-600",
  slate: "text-slate-600",
};

function Stat({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className={`flex items-center gap-1.5 text-xs font-medium ${TONES[tone] ?? "text-slate-600"}`}>
        {icon} {label}
      </div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}

const ACCENTS: Record<string, string> = {
  red: "bg-red-500",
  blue: "bg-blue-500",
  slate: "bg-slate-400",
};

function Section({
  title,
  count,
  accent,
  children,
}: {
  title: string;
  count: number;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <span className={`h-2 w-2 rounded-full ${ACCENTS[accent] ?? "bg-slate-400"}`} />
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {count}
        </span>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-4 text-center text-xs text-muted-foreground">{children}</p>;
}

function OrderRow({ o, late }: { o: OperatorOrderRow; late?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b py-2 text-sm last:border-0">
      <div className="min-w-0">
        <div className="truncate font-medium">
          {o.ref} · {o.customerName ?? "Customer"}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {o.address ?? "No address"}
          {o.driverName ? ` · ${o.driverName}` : ""}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <span className="rounded bg-muted px-2 py-0.5 text-[11px] font-medium">{humanize(o.status)}</span>
        {late && o.minutesLate != null && (
          <span className="mt-1 text-[11px] font-semibold text-red-600">{o.minutesLate}m late</span>
        )}
      </div>
    </div>
  );
}

function DriverCard({
  d,
  onlineDrivers,
  busyOrder,
  onReturn,
  onReassign,
}: {
  d: OperatorDriverRow;
  onlineDrivers: OperatorDriverRow[];
  busyOrder: string | null;
  onReturn: (orderId: string) => void;
  onReassign: (orderId: string, driverId: string) => void;
}) {
  const dot =
    d.status === "ONLINE" ? "bg-green-500" : d.status === "ON_JOB" ? "bg-amber-500" : "bg-slate-300";
  const statusLabel = d.status === "ON_JOB" ? "On a job" : d.status === "ONLINE" ? "Online" : "Offline";

  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
          <span className="font-semibold">{d.name}</span>
          <span className="text-xs text-muted-foreground">{statusLabel}</span>
        </div>
        <div className="text-right text-xs">
          <span className="font-semibold">{d.delivered}</span>
          <span className="text-muted-foreground"> today · £{d.total}</span>
        </div>
      </div>

      {/* Cash-up split */}
      <div className="mt-2 flex gap-2 text-[11px]">
        <span className="rounded bg-green-50 px-2 py-0.5 text-green-700">Cash £{d.cashTotal}</span>
        <span className="rounded bg-blue-50 px-2 py-0.5 text-blue-700">Card £{d.cardTotal}</span>
      </div>

      {/* Active jobs */}
      {d.activeJobs.length > 0 && (
        <div className="mt-3 space-y-2 border-t pt-2">
          {d.activeJobs.map((j) => {
            const others = onlineDrivers.filter((o) => o.id !== d.id);
            const busy = busyOrder === j.orderId;
            return (
              <div key={j.orderId} className="rounded-md bg-muted/40 p-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {j.sequence ? `${j.sequence}. ` : ""}
                    {j.ref} · {j.customerName ?? "Customer"}
                  </span>
                  <span className="rounded bg-background px-1.5 py-0.5 text-[10px] font-medium">
                    {humanize(j.status)}
                  </span>
                </div>
                {j.address && <div className="mt-0.5 truncate text-muted-foreground">{j.address}</div>}
                <div className="mt-1.5 flex items-center gap-2">
                  <button
                    disabled={busy}
                    onClick={() => onReturn(j.orderId)}
                    className="rounded border px-2 py-1 font-medium hover:bg-muted disabled:opacity-40"
                  >
                    {busy ? "…" : "Return to board"}
                  </button>
                  <select
                    disabled={busy || others.length === 0}
                    value=""
                    onChange={(e) => onReassign(j.orderId, e.target.value)}
                    className="rounded border bg-background px-2 py-1 disabled:opacity-40"
                  >
                    <option value="">{others.length === 0 ? "No other drivers" : "Reassign to…"}</option>
                    {others.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function humanize(s: string): string {
  return s
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
