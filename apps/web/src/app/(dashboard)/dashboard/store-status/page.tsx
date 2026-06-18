"use client";

// Phase AW-21 — Store Status page.
//
// Operational dashboard for managers + shift leads. Read-only. The
// data comes from a single /v1/store-status/overview call that
// aggregates: pauses, busy-mode rows, item snoozes, hard
// out-of-stock items. Auto-refreshes every 30s.
//
// Actions (resume, unsnooze, restore) intentionally stay on the
// pages that own each domain — we deep-link to those instead of
// duplicating mutation surface here.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Clock,
  ExternalLink,
  Loader2,
  Pause,
  RefreshCw,
  Search,
  ShoppingBag,
  TimerOff,
} from "lucide-react";
import {
  storeStatusClient,
  type BusyEntry,
  type OutOfStockEntry,
  type PausedEntry,
  type SnoozeEntry,
} from "@/lib/api/store-status.client";

const REFRESH_MS = 30_000;

export default function StoreStatusPage() {
  const [query, setQuery] = useState("");

  const { data, isLoading, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ["store-status", "overview"],
    queryFn: () => storeStatusClient.overview(),
    refetchInterval: REFRESH_MS,
  });

  const filter = (s: string | null | undefined) =>
    !query || (s ?? "").toLowerCase().includes(query.toLowerCase());

  const pauses = useMemo(
    () =>
      (data?.pauses ?? []).filter(
        (p) =>
          filter(p.locationName) ||
          filter(p.brandName) ||
          filter(p.channel) ||
          filter(p.reason),
      ),
    [data, query],
  );
  const busyModes = useMemo(
    () =>
      (data?.busyModes ?? []).filter(
        (p) =>
          filter(p.locationName) ||
          filter(p.brandName) ||
          filter(p.channel) ||
          filter(p.reason),
      ),
    [data, query],
  );
  const snoozes = useMemo(
    () =>
      (data?.snoozes ?? []).filter(
        (s) =>
          filter(s.itemName) ||
          filter(s.brandName) ||
          filter(s.channel) ||
          filter(s.reason),
      ),
    [data, query],
  );
  const outOfStock = useMemo(
    () =>
      (data?.outOfStock ?? []).filter(
        (o) => filter(o.itemName) || filter(o.brandName),
      ),
    [data, query],
  );

  if (isLoading) {
    return (
      <div className="px-6 py-12 flex items-center justify-center text-zinc-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const summary = data?.summary ?? {
    paused: 0,
    busy: 0,
    snoozedItems: 0,
    outOfStock: 0,
    issuesTotal: 0,
  };
  const generatedAt = data?.generatedAt
    ? new Date(data.generatedAt)
    : new Date(dataUpdatedAt);

  return (
    <div className="px-6 py-6 space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 flex items-center gap-2">
            <Activity className="h-5 w-5" /> Store status
          </h1>
          <p className="text-sm text-zinc-500 mt-1">
            Live view of every brand, location, channel, and item that
            isn&apos;t running normally right now. Refreshes every 30s.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-[11px] text-zinc-500">
            Updated {generatedAt.toLocaleTimeString()}
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
        </div>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard
          label="Total issues"
          value={summary.issuesTotal}
          icon={<AlertTriangle className="h-4 w-4" />}
          tone={summary.issuesTotal > 0 ? "warning" : "ok"}
        />
        <StatCard
          label="Channels paused"
          value={summary.paused}
          icon={<Pause className="h-4 w-4" />}
          tone={summary.paused > 0 ? "danger" : "ok"}
        />
        <StatCard
          label="In busy mode"
          value={summary.busy}
          icon={<TimerOff className="h-4 w-4" />}
          tone={summary.busy > 0 ? "warning" : "ok"}
        />
        <StatCard
          label="Items snoozed"
          value={summary.snoozedItems}
          icon={<Clock className="h-4 w-4" />}
          tone={summary.snoozedItems > 0 ? "warning" : "ok"}
        />
        <StatCard
          label="Out of stock"
          value={summary.outOfStock}
          icon={<ShoppingBag className="h-4 w-4" />}
          tone={summary.outOfStock > 0 ? "danger" : "ok"}
        />
      </section>

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by brand, location, channel, item, or reason…"
          className="w-full rounded-md border border-zinc-200 bg-white pl-8 pr-3 py-1.5 text-sm focus:border-zinc-400 focus:outline-none"
        />
      </div>

      <Section
        title="Paused"
        subtitle="Brands, locations, or channels actively rejecting orders."
        tone="danger"
        count={pauses.length}
        empty="Nothing paused — every channel is taking orders."
        action={{ href: "/dashboard/orders", label: "Pause / resume on Orders board" }}
      >
        {pauses.length > 0 && <PauseTable rows={pauses} />}
      </Section>

      <Section
        title="Busy mode"
        subtitle="Still accepting orders, but the kitchen is running slower."
        tone="warning"
        count={busyModes.length}
        empty="No busy-mode flags right now."
        action={{ href: "/dashboard/orders", label: "Toggle on Orders board" }}
      >
        {busyModes.length > 0 && <BusyTable rows={busyModes} />}
      </Section>

      <Section
        title="Snoozed items"
        subtitle="Items hidden from selected channels until a timer expires or staff restores them."
        tone="warning"
        count={snoozes.length}
        empty="No items snoozed. The 86 board is empty."
        action={{ href: "/dashboard/inventory", label: "Manage on Inventory" }}
      >
        {snoozes.length > 0 && <SnoozeTable rows={snoozes} />}
      </Section>

      <Section
        title="Out of stock"
        subtitle="Items the POS marked out — they're hidden everywhere until restored."
        tone="danger"
        count={outOfStock.length}
        empty="Nothing out of stock."
        action={{ href: "/dashboard/inventory", label: "Restore on Inventory" }}
      >
        {outOfStock.length > 0 && <OutOfStockTable rows={outOfStock} />}
      </Section>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: "ok" | "warning" | "danger";
}) {
  const toneClasses = {
    ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    danger: "border-rose-200 bg-rose-50 text-rose-900",
  }[tone];
  return (
    <div className={`rounded-lg border ${toneClasses} p-3`}>
      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider opacity-80">
        <span>{label}</span>
        {icon}
      </div>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}

function Section({
  title,
  subtitle,
  tone,
  count,
  empty,
  action,
  children,
}: {
  title: string;
  subtitle: string;
  tone: "warning" | "danger";
  count: number;
  empty: string;
  action: { href: string; label: string };
  children: React.ReactNode;
}) {
  const accent = tone === "danger" ? "text-rose-600" : "text-amber-600";
  return (
    <section className="rounded-lg border border-zinc-200 bg-white overflow-hidden">
      <header className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
            {title}
            {count > 0 && (
              <span
                className={`inline-flex items-center justify-center rounded-full bg-zinc-100 px-1.5 text-[11px] font-semibold ${accent}`}
              >
                {count}
              </span>
            )}
          </h2>
          <p className="text-[11px] text-zinc-500 mt-0.5">{subtitle}</p>
        </div>
        <Link
          href={action.href}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-700 hover:text-zinc-900"
        >
          {action.label} <ExternalLink className="h-3 w-3" />
        </Link>
      </header>
      {count === 0 ? (
        <p className="text-xs text-zinc-400 py-8 text-center">{empty}</p>
      ) : (
        <div className="overflow-x-auto">{children}</div>
      )}
    </section>
  );
}

function PauseTable({ rows }: { rows: PausedEntry[] }) {
  return (
    <table className="min-w-full text-xs">
      <thead className="bg-zinc-50 text-zinc-500">
        <tr>
          <Th>Brand</Th>
          <Th>Location</Th>
          <Th>Channel</Th>
          <Th>Reason</Th>
          <Th>Paused</Th>
          <Th>Resumes</Th>
          <Th>By</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100">
        {rows.map((p) => (
          <tr key={p.id} className="text-zinc-700">
            <Td>{p.brandName ?? "—"}</Td>
            <Td>{p.locationName}</Td>
            <Td>{p.channel ?? "All"}</Td>
            <Td className="max-w-xs truncate" title={p.reason ?? ""}>
              {p.reason ?? "—"}
            </Td>
            <Td>{formatRelative(p.pausedAt)}</Td>
            <Td>{p.resumeAt ? formatTimeUntil(p.resumeAt) : "Manual"}</Td>
            <Td>{p.pausedBy?.name ?? "—"}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BusyTable({ rows }: { rows: BusyEntry[] }) {
  return (
    <table className="min-w-full text-xs">
      <thead className="bg-zinc-50 text-zinc-500">
        <tr>
          <Th>Brand</Th>
          <Th>Location</Th>
          <Th>Channel</Th>
          <Th>Extra prep</Th>
          <Th>Reason</Th>
          <Th>Started</Th>
          <Th>Ends</Th>
          <Th>By</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100">
        {rows.map((p) => (
          <tr key={p.id} className="text-zinc-700">
            <Td>{p.brandName ?? "—"}</Td>
            <Td>{p.locationName}</Td>
            <Td>{p.channel ?? "All"}</Td>
            <Td>{p.extraPrepTime ? `+${p.extraPrepTime} min` : "—"}</Td>
            <Td className="max-w-xs truncate" title={p.reason ?? ""}>
              {p.reason ?? "—"}
            </Td>
            <Td>{formatRelative(p.pausedAt)}</Td>
            <Td>{p.resumeAt ? formatTimeUntil(p.resumeAt) : "Manual"}</Td>
            <Td>{p.pausedBy?.name ?? "—"}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SnoozeTable({ rows }: { rows: SnoozeEntry[] }) {
  return (
    <table className="min-w-full text-xs">
      <thead className="bg-zinc-50 text-zinc-500">
        <tr>
          <Th>Item</Th>
          <Th>Brand</Th>
          <Th>Channel</Th>
          <Th>Reason</Th>
          <Th>Snoozed</Th>
          <Th>Expires</Th>
          <Th>By</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100">
        {rows.map((s) => (
          <tr key={s.id} className="text-zinc-700">
            <Td>{s.itemName}</Td>
            <Td>{s.brandName ?? "—"}</Td>
            <Td>{s.channel}</Td>
            <Td className="max-w-xs truncate" title={s.reason ?? ""}>
              {s.reason ?? "—"}
            </Td>
            <Td>{formatRelative(s.snoozedAt)}</Td>
            <Td>{s.expiresAt ? formatTimeUntil(s.expiresAt) : "Manual"}</Td>
            <Td>{s.snoozedBy?.name ?? "—"}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OutOfStockTable({ rows }: { rows: OutOfStockEntry[] }) {
  return (
    <table className="min-w-full text-xs">
      <thead className="bg-zinc-50 text-zinc-500">
        <tr>
          <Th>Item</Th>
          <Th>Brand</Th>
          <Th>Auto-restore</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100">
        {rows.map((o) => (
          <tr key={o.itemId} className="text-zinc-700">
            <Td>{o.itemName}</Td>
            <Td>{o.brandName}</Td>
            <Td>{o.autoResumeAt ? formatTimeUntil(o.autoResumeAt) : "Manual"}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider text-[10px]">
      {children}
    </th>
  );
}

function Td({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={`px-3 py-2 ${className ?? ""}`} title={title}>
      {children}
    </td>
  );
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatTimeUntil(iso: string): string {
  const d = new Date(iso);
  const diff = d.getTime() - Date.now();
  if (diff <= 0) return "Now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60)
    return `in ${mins}m (${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`;
  const hours = Math.round(mins / 60);
  if (hours < 24)
    return `in ${hours}h (${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`;
  return d.toLocaleString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
