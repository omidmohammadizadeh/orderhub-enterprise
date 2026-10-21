"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Banknote,
  CheckCircle2,
  CreditCard,
  Loader2,
  MapPin,
  Radio,
  Settings2,
  Truck,
  Undo2,
  Users,
  WifiOff,
  XCircle,
} from "lucide-react";
import { useCurrency } from "@/hooks/use-currency";
import {
  getDispatchFeed,
  getOperatorDashboard,
  reassignOrder,
  unassignOrder,
  type DriverAssignmentStatus,
  type OperatorDriverRow,
  type OperatorOrderRow,
} from "@/lib/api/dispatch.client";
import { DispatchChatWidget } from "@/components/dispatch/chat-widget";
import { DispatchMap } from "@/components/dispatch/dispatch-map";
import { DriverManageModal } from "@/components/dispatch/driver-manage-modal";
import { cn } from "@/lib/utils";

// Phase AX-3b — Operator Dashboard. Live delivery ops: KPIs, the live map,
// overdue attention, out-for-delivery, per-driver active jobs + cash-up,
// reassignment, and recent failed/cancelled.

// The driver app re-sends its position at least once a minute while online
// (movement pings plus a heartbeat), so an online driver silent for this long
// has most likely lost signal or had the app closed. Generous on purpose:
// builds from before the heartbeat only ping when they move.
const STALE_PING_MS = 5 * 60_000;

type FleetFilter = "all" | "active" | "online" | "offline";

// Presence only flips to ON_JOB once a stop is started, so a driver holding a
// freshly dispatched run still reads ONLINE. For the operator that driver is
// busy: anyone with a stop in hand counts as on a job.
function workState(d: OperatorDriverRow): "ON_JOB" | "ONLINE" | "OFFLINE" {
  if (d.status === "OFFLINE") return "OFFLINE";
  return d.activeJobs.length > 0 ? "ON_JOB" : d.status;
}
type OpsTab = "attention" | "out" | "failed";

export default function OperatorDashboardPage() {
  const queryClient = useQueryClient();
  const [location, setLocation] = useState("all");
  const [busyOrder, setBusyOrder] = useState<string | null>(null);
  const [manageDriver, setManageDriver] = useState<OperatorDriverRow | null>(null);
  const [fleetFilter, setFleetFilter] = useState<FleetFilter>("all");
  const [opsTab, setOpsTab] = useState<OpsTab>("attention");
  const [now, setNow] = useState(() => Date.now());

  // 1s clock: "seen 12s ago", the live indicator and the map's countdown pins.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ["operator-dashboard", location],
    queryFn: () => getOperatorDashboard(location),
    refetchInterval: 10_000,
  });

  const feedQuery = useQuery({
    queryKey: ["dispatch-feed", location],
    queryFn: () => getDispatchFeed(location),
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

  const drivers = useMemo(() => {
    const rank = { ON_JOB: 0, ONLINE: 1, OFFLINE: 2 } as const;
    return [...(data?.drivers ?? [])].sort(
      (a, b) => rank[workState(a)] - rank[workState(b)] || a.name.localeCompare(b.name),
    );
  }, [data?.drivers]);

  // Anyone working can take a stop — a driver already on a run gets it added
  // as another drop, same as Bulk dispatch on the board.
  const assignable = drivers.filter((d) => d.status !== "OFFLINE");
  const visibleDrivers = drivers.filter((d) =>
    fleetFilter === "all"
      ? true
      : fleetFilter === "active"
        ? workState(d) === "ON_JOB"
        : fleetFilter === "online"
          ? workState(d) === "ONLINE"
          : workState(d) === "OFFLINE",
  );

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["operator-dashboard"] });
    queryClient.invalidateQueries({ queryKey: ["dispatch-feed"] });
  }

  function apiError(err: unknown, fallback: string): string {
    const msg = (err as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
    return Array.isArray(msg) ? msg.join(", ") : msg || fallback;
  }

  async function handleReturn(orderId: string, ref: string) {
    if (!window.confirm(`Take ${ref} off this driver and put it back on the board?`)) return;
    setBusyOrder(orderId);
    try {
      await unassignOrder(orderId);
      toast.success(`${ref} is back on the board`);
      refresh();
    } catch (err) {
      toast.error(apiError(err, `Couldn't return ${ref}`));
    } finally {
      setBusyOrder(null);
    }
  }

  async function handleReassign(orderId: string, ref: string, driver: OperatorDriverRow) {
    setBusyOrder(orderId);
    try {
      await reassignOrder(orderId, driver.id);
      toast.success(`${ref} sent to ${driver.name}`);
    } catch (err) {
      // reassign = unassign then assign; if the second half fails the order is
      // on the board, not lost — say so.
      toast.error(apiError(err, `Couldn't reassign ${ref} — check the board`));
    } finally {
      setBusyOrder(null);
      refresh();
    }
  }

  const stats = data?.stats;
  const freeCount = drivers.filter((d) => workState(d) === "ONLINE").length;
  const busyCount = drivers.filter((d) => workState(d) === "ON_JOB").length;
  const updatedAgo = dataUpdatedAt ? Math.max(0, Math.round((now - dataUpdatedAt) / 1000)) : null;
  const lost = drivers.filter(
    (d) => d.status !== "OFFLINE" && (!d.lastPingAt || now - new Date(d.lastPingAt).getTime() > STALE_PING_MS),
  ).length;

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto bg-zinc-50 p-4 dark:bg-zinc-950">
      {/* Control-room header */}
      <section className="relative overflow-hidden rounded-2xl bg-zinc-950 p-5 text-white shadow-xl ring-1 ring-white/10">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.6) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
        />
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-emerald-500/20 blur-3xl" />

        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard/dispatch"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-sm font-medium text-white/90 ring-1 ring-white/10 transition hover:bg-white/15"
            >
              <ArrowLeft className="h-4 w-4" /> Dispatch
            </Link>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Operator dashboard</h1>
              <p className="flex items-center gap-2 text-xs text-white/60">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                </span>
                Live delivery operations
                {updatedAgo != null && <span className="tabular-nums">· updated {updatedAgo}s ago</span>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(isLoading || feedQuery.isFetching) && <Loader2 className="h-4 w-4 animate-spin text-white/50" />}
            {multiLocation ? (
              <select
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className="h-9 rounded-lg border-0 bg-white/10 px-3 text-sm text-white ring-1 ring-white/15 focus:outline-none focus:ring-2 focus:ring-emerald-400 [&>option]:text-zinc-900"
              >
                <option value="all">All locations</option>
                {locationOptions.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            ) : locationOptions[0] ? (
              <span className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-sm ring-1 ring-white/15">
                <MapPin className="h-3.5 w-3.5 text-emerald-400" />
                {locationOptions[0].name}
              </span>
            ) : null}
          </div>
        </div>

        {/* KPI strip */}
        <div className="relative mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
          <Kpi icon={<Users className="h-4 w-4" />} label="Free drivers" value={data ? freeCount : undefined} tone="emerald" />
          <Kpi icon={<Activity className="h-4 w-4" />} label="On a job" value={data ? busyCount : undefined} tone="amber" />
          <Kpi icon={<Truck className="h-4 w-4" />} label="Out for delivery" value={stats?.outForDelivery} tone="sky" />
          <Kpi icon={<CheckCircle2 className="h-4 w-4" />} label="Delivered today" value={stats?.deliveredToday} tone="emerald" />
          <Kpi
            icon={<AlertTriangle className="h-4 w-4" />}
            label="Needs attention"
            value={stats?.attention}
            tone="rose"
            alert={(stats?.attention ?? 0) > 0}
          />
          <Kpi icon={<XCircle className="h-4 w-4" />} label="Failed / cancelled" value={stats?.failedToday} tone="zinc" />
        </div>
      </section>

      {isError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          Failed to load the dashboard. Retrying every 10 seconds.
        </div>
      )}
      {lost > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <WifiOff className="h-4 w-4 shrink-0" />
          {lost === 1 ? "1 driver is" : `${lost} drivers are`} online but haven&apos;t sent a location for over 5
          minutes — check their phone has signal and the app is open.
        </div>
      )}

      <div className="grid flex-1 grid-cols-1 gap-4 xl:grid-cols-12">
        {/* Left — live map + ops lists */}
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-7">
          <Panel
            title="Live map"
            icon={<Radio className="h-4 w-4 text-emerald-500" />}
            right={
              <span className="text-xs text-zinc-500">
                {feedQuery.data?.drivers.filter((d) => d.lat != null).length ?? 0} drivers ·{" "}
                {feedQuery.data?.orders.filter((o) => !o.done).length ?? 0} orders
              </span>
            }
            bodyClassName="p-0"
          >
            <div className="h-[440px] overflow-hidden rounded-b-2xl">
              <DispatchMap feed={feedQuery.data} now={now} focusKey={location} minHeight="440px" />
            </div>
          </Panel>

          <Panel
            title="Orders"
            icon={<Truck className="h-4 w-4 text-sky-500" />}
            right={
              <div className="flex rounded-lg bg-zinc-100 p-0.5 text-xs font-medium dark:bg-zinc-800">
                <TabBtn on={opsTab === "attention"} onClick={() => setOpsTab("attention")} count={data?.attention.length} danger>
                  Needs attention
                </TabBtn>
                <TabBtn on={opsTab === "out"} onClick={() => setOpsTab("out")} count={data?.outForDelivery.length}>
                  Out for delivery
                </TabBtn>
                <TabBtn on={opsTab === "failed"} onClick={() => setOpsTab("failed")} count={data?.recentFailed.length}>
                  Failed
                </TabBtn>
              </div>
            }
          >
            {opsTab === "attention" &&
              ((data?.attention ?? []).length === 0 ? (
                <Empty icon={<CheckCircle2 className="h-5 w-5 text-emerald-500" />}>Nothing overdue. Nice.</Empty>
              ) : (
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {(data?.attention ?? []).map((o) => (
                    <OrderRow key={o.id} o={o} late />
                  ))}
                </div>
              ))}
            {opsTab === "out" &&
              ((data?.outForDelivery ?? []).length === 0 ? (
                <Empty icon={<Truck className="h-5 w-5 text-zinc-400" />}>Nothing out for delivery right now.</Empty>
              ) : (
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {(data?.outForDelivery ?? []).map((o) => (
                    <OrderRow key={o.id} o={o} />
                  ))}
                </div>
              ))}
            {opsTab === "failed" &&
              ((data?.recentFailed ?? []).length === 0 ? (
                <Empty icon={<CheckCircle2 className="h-5 w-5 text-emerald-500" />}>
                  No failed or cancelled deliveries today.
                </Empty>
              ) : (
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {(data?.recentFailed ?? []).map((o) => (
                    <div key={o.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          <span className="font-mono text-xs text-zinc-500">{o.ref}</span> · {o.customerName ?? "Customer"}
                        </div>
                        {o.reason && <div className="truncate text-xs italic text-zinc-500">{o.reason}</div>}
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-xs">
                        <span className="tabular-nums text-zinc-400">
                          {new Date(o.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                        <span className="rounded-md bg-rose-100 px-2 py-0.5 font-medium text-rose-700 dark:bg-rose-950 dark:text-rose-300">
                          {humanize(o.status)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
          </Panel>
        </div>

        {/* Right — fleet roster */}
        <div className="min-w-0 xl:col-span-5">
          <Panel
            title="Fleet"
            icon={<Users className="h-4 w-4 text-violet-500" />}
            right={
              <div className="flex gap-1 text-xs font-medium">
                {(
                  [
                    ["all", "All", drivers.length],
                    ["active", "On a job", drivers.filter((d) => workState(d) === "ON_JOB").length],
                    ["online", "Free", drivers.filter((d) => workState(d) === "ONLINE").length],
                    ["offline", "Offline", drivers.filter((d) => workState(d) === "OFFLINE").length],
                  ] as const
                ).map(([key, label, n]) => (
                  <button
                    key={key}
                    onClick={() => setFleetFilter(key)}
                    className={cn(
                      "rounded-full px-2.5 py-1 transition",
                      fleetFilter === key
                        ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
                        : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800",
                    )}
                  >
                    {label} <span className="tabular-nums opacity-60">{n}</span>
                  </button>
                ))}
              </div>
            }
          >
            {visibleDrivers.length === 0 ? (
              <Empty icon={<Users className="h-5 w-5 text-zinc-400" />}>
                {drivers.length === 0 ? "No drivers at this location yet." : "No drivers in this view."}
              </Empty>
            ) : (
              <div className="space-y-3">
                {visibleDrivers.map((d) => (
                  <DriverCard
                    key={d.id}
                    d={d}
                    now={now}
                    assignable={assignable}
                    busyOrder={busyOrder}
                    onReturn={handleReturn}
                    onReassign={handleReassign}
                    onManage={() => setManageDriver(d)}
                  />
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>

      {/* Floating driver chat. Same shop scope as the rest of this page. "all"
          means every location the user can reach, which the API resolves from
          their assignments. */}
      <DispatchChatWidget locationId={location === "all" ? undefined : location} />

      {manageDriver && (
        <DriverManageModal
          driver={manageDriver}
          locations={locationOptions}
          open={!!manageDriver}
          onClose={() => setManageDriver(null)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────────

const KPI_TONES = {
  emerald: "text-emerald-400",
  amber: "text-amber-400",
  sky: "text-sky-400",
  rose: "text-rose-400",
  zinc: "text-zinc-400",
} as const;

function Kpi({
  icon,
  label,
  value,
  tone,
  alert,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | undefined;
  tone: keyof typeof KPI_TONES;
  alert?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl bg-white/[0.04] p-3 ring-1 ring-white/10 backdrop-blur",
        alert && "bg-rose-500/10 ring-rose-400/40",
      )}
    >
      <div className={cn("flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider", KPI_TONES[tone])}>
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1.5 text-3xl font-semibold tabular-nums tracking-tight">{value ?? "–"}</div>
    </div>
  );
}

function Panel({
  title,
  icon,
  right,
  children,
  bodyClassName,
}: {
  title: string;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  bodyClassName?: string;
}) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        {icon}
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="ml-auto">{right}</div>
      </header>
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

function TabBtn({
  on,
  onClick,
  count,
  danger,
  children,
}: {
  on: boolean;
  onClick: () => void;
  count?: number;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1 transition",
        on ? "bg-white shadow-sm dark:bg-zinc-700" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
      )}
    >
      {children}
      <span
        className={cn(
          "rounded-full px-1.5 text-[10px] tabular-nums",
          danger && (count ?? 0) > 0 ? "bg-rose-500 text-white" : "bg-zinc-200 dark:bg-zinc-600",
        )}
      >
        {count ?? 0}
      </span>
    </button>
  );
}

function Empty({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center text-xs text-zinc-500">
      {icon}
      {children}
    </div>
  );
}

function OrderRow({ o, late }: { o: OperatorOrderRow; late?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
      <div className="min-w-0">
        <div className="truncate font-medium">
          <span className="font-mono text-xs text-zinc-500">{o.ref}</span> · {o.customerName ?? "Customer"}
        </div>
        <div className="truncate text-xs text-zinc-500">
          {o.address ?? "No address"}
          {o.driverName ? ` · ${o.driverName}` : " · unassigned"}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-[11px] font-medium dark:bg-zinc-800">
          {humanize(o.status)}
        </span>
        {late && o.minutesLate != null && (
          <span className="rounded-md bg-rose-500 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white">
            {o.minutesLate}m late
          </span>
        )}
      </div>
    </div>
  );
}

const JOB_STEPS: DriverAssignmentStatus[] = ["ASSIGNED", "ACCEPTED", "PICKED_UP", "DELIVERED"];
const JOB_LABEL: Record<string, string> = {
  ASSIGNED: "Sent",
  ACCEPTED: "Accepted",
  PICKED_UP: "On the way",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

function DriverCard({
  d,
  now,
  assignable,
  busyOrder,
  onReturn,
  onReassign,
  onManage,
}: {
  d: OperatorDriverRow;
  now: number;
  assignable: OperatorDriverRow[];
  busyOrder: string | null;
  onReturn: (orderId: string, ref: string) => void;
  onReassign: (orderId: string, ref: string, driver: OperatorDriverRow) => void;
  onManage: () => void;
}) {
  const { money } = useCurrency();
  const pingAge = d.lastPingAt ? now - new Date(d.lastPingAt).getTime() : null;
  const stale = d.status !== "OFFLINE" && (pingAge == null || pingAge > STALE_PING_MS);
  const state = workState(d);
  const ring =
    state === "ON_JOB" ? "ring-amber-400" : state === "ONLINE" ? "ring-emerald-400" : "ring-zinc-300 dark:ring-zinc-700";
  const pill =
    state === "ON_JOB"
      ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
      : state === "ONLINE"
        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
        : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  const statusLabel =
    state === "ON_JOB" ? `On a job · ${d.activeJobs.length}` : state === "ONLINE" ? "Free" : "Offline";
  const initials = d.name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      className={cn(
        "rounded-xl border border-zinc-200 bg-white p-3.5 transition hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950",
        d.status === "OFFLINE" && "opacity-75",
      )}
    >
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-full bg-zinc-900 text-sm font-semibold text-white ring-2 ring-offset-2 ring-offset-white dark:ring-offset-zinc-950",
            ring,
          )}
        >
          {initials || "D"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{d.name}</span>
            <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", pill)}>
              {statusLabel}
            </span>
          </div>
          <div className={cn("mt-0.5 flex items-center gap-1 text-xs", stale ? "text-amber-600" : "text-zinc-500")}>
            {stale && <WifiOff className="h-3 w-3" />}
            {d.status === "OFFLINE"
              ? d.lastPingAt
                ? `Last seen ${ago(pingAge!)}`
                : "Not seen yet"
              : stale
                ? pingAge == null
                  ? "No position yet"
                  : `No update · ${ago(pingAge)}`
                : `Live · ${ago(pingAge!)}`}
          </div>
        </div>
        <button
          onClick={onManage}
          className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          <Settings2 className="h-3.5 w-3.5" /> Manage
        </button>
      </div>

      {/* Today: deliveries, takings split, driver pay */}
      <div className="mt-3 grid grid-cols-4 gap-1.5 text-center">
        <Mini label="Delivered" value={String(d.delivered)} />
        <Mini label="Cash" value={money(d.cashTotal)} icon={<Banknote className="h-3 w-3" />} />
        <Mini label="Card" value={money(d.cardTotal)} icon={<CreditCard className="h-3 w-3" />} />
        <Mini label="Earned" value={money(d.earningToday)} accent />
      </div>

      {/* Active run */}
      {d.activeJobs.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          {d.activeJobs.map((j) => {
            const others = assignable.filter((o) => o.id !== d.id);
            const busy = busyOrder === j.orderId;
            const step = Math.max(0, JOB_STEPS.indexOf(j.status));
            return (
              <div key={j.orderId} className="rounded-lg bg-zinc-50 p-2.5 text-xs dark:bg-zinc-900">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 font-medium">
                    {j.sequence != null && (
                      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-zinc-900 text-[10px] font-bold text-white dark:bg-white dark:text-zinc-900">
                        {j.sequence}
                      </span>
                    )}
                    <span className="truncate">
                      <span className="font-mono text-zinc-500">{j.ref}</span> · {j.customerName ?? "Customer"}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                    {JOB_LABEL[j.status] ?? humanize(j.status)}
                  </span>
                </div>
                {j.address && <div className="mt-0.5 truncate text-zinc-500">{j.address}</div>}
                <div className="mt-2 flex gap-1" aria-hidden>
                  {JOB_STEPS.slice(0, 3).map((s, i) => (
                    <span
                      key={s}
                      className={cn("h-1 flex-1 rounded-full", i <= step ? "bg-emerald-500" : "bg-zinc-200 dark:bg-zinc-700")}
                    />
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    disabled={busy}
                    onClick={() => onReturn(j.orderId, j.ref)}
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 font-medium hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-800"
                  >
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
                    Return to board
                  </button>
                  <select
                    disabled={busy || others.length === 0}
                    value=""
                    onChange={(e) => {
                      const target = others.find((o) => o.id === e.target.value);
                      if (target) onReassign(j.orderId, j.ref, target);
                    }}
                    className="min-w-0 flex-1 rounded-md border border-zinc-200 bg-white px-2 py-1 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-950"
                  >
                    <option value="">{others.length === 0 ? "No other drivers working" : "Reassign to…"}</option>
                    {others.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                        {workState(o) === "ON_JOB" ? ` (on a run · ${o.activeJobs.length})` : " (free)"}
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

function Mini({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={cn("rounded-lg bg-zinc-50 px-1 py-1.5 dark:bg-zinc-900", accent && "bg-violet-50 dark:bg-violet-950/40")}>
      <div className={cn("truncate text-sm font-semibold tabular-nums", accent && "text-violet-700 dark:text-violet-300")}>
        {value}
      </div>
      <div className="flex items-center justify-center gap-1 text-[10px] text-zinc-500">
        {icon}
        {label}
      </div>
    </div>
  );
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function humanize(s: string): string {
  return s
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
