"use client";

// Phase LG — Logs page (HubRise-style activity feed).
//
// One place to see what the system did for each action — menu publishes,
// order pushes to platforms, stock (86) changes, store pauses/resumes —
// without opening Render. Tabs: All / Menu / Orders / Inventory / Status /
// Connections. Auto-refreshes every 10s; "Load more" pages by cursor.

import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  CreditCard,
  ChevronDown,
  ChevronRight,
  Info,
  MapPin,
  Loader2,
  Plug,
  Package,
  Printer,
  RefreshCw,
  ScrollText,
  ShoppingBag,
  UtensilsCrossed,
  XCircle,
} from "lucide-react";
import toast from "react-hot-toast";
import { apiClient } from "@/lib/api/client";
import { locationsClient } from "@/lib/api/locations.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";

const REFRESH_MS = 10_000;

/**
 * Render the loaded feed as plain text for pasting into a support ticket.
 *
 * Written for the reader on the other end — Uber, Deliveroo and JET all ask
 * for log evidence, and what they need is a timestamp they can match against
 * their own records plus the HTTP result. So: **UTC ISO timestamps** (never
 * the browser's local time, which is unmatchable to a platform's logs), and
 * the `details` blob included verbatim because that is where the order ids,
 * event ids and HTTP statuses live.
 *
 * The header states the scope explicitly. A pasted log with no scope line
 * invites the reader to assume it covers everything, and "no activity" then
 * reads as "the integration is dead" rather than "wrong location selected".
 */
export function buildLogExport(
  entries: LogEntry[],
  scope: {
    locationName: string | null;
    locationId: string | null;
    category: string;
    channel: string;
    status: string;
  },
): string {
  const head = [
    "OrderHub activity log export",
    `Scope     : ${
      scope.locationId
        ? `${scope.locationName ?? "location"} (${scope.locationId})`
        : "All locations this account can access"
    }`,
    `Filters   : category=${scope.category || "all"} channel=${scope.channel || "all"} status=${scope.status || "any"}`,
    `Exported  : ${new Date().toISOString()}`,
    `Entries   : ${entries.length} (newest first)`,
    "",
  ];
  const lines = entries.map((e) => {
    const when = new Date(e.createdAt).toISOString();
    const head =
      `[${when}] ${e.status.padEnd(7)} ${(e.channel ?? "-").padEnd(10)} ` +
      `${e.action} — ${e.message}`;
    // Details carry the platform order ids and HTTP statuses — the part a
    // support reviewer actually cross-references. Never truncate them.
    const detail =
      e.details && Object.keys(e.details).length
        ? `\n    ${JSON.stringify(e.details)}`
        : "";
    return head + detail;
  });
  return head.concat(lines).join("\n");
}

type LogEntry = {
  id: string;
  category: string;
  channel: string | null;
  action: string;
  status: "SUCCESS" | "ERROR" | "INFO" | "WARNING";
  message: string;
  details: Record<string, unknown> | null;
  locationId: string | null;
  brandId: string | null;
  brandName: string | null;
  createdAt: string;
};

type LogsPage = { entries: LogEntry[]; nextCursor: string | null };

const TABS = [
  { key: "", label: "All", icon: ScrollText },
  { key: "MENU", label: "Menu", icon: UtensilsCrossed },
  { key: "ORDERS", label: "Orders", icon: ShoppingBag },
  { key: "INVENTORY", label: "Inventory", icon: Package },
  { key: "STATUS", label: "Status", icon: Activity },
  { key: "PAYMENTS", label: "Payments", icon: CreditCard },
  { key: "PRINTING", label: "Printing", icon: Printer },
  { key: "CONNECTION", label: "Connections", icon: Plug },
] as const;

// Channel dropdown — value is the comma-separated platform tags the API
// matches (Online ordering covers both ONLINE and DIRECT).
const CHANNEL_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All channels" },
  { value: "UBER_EATS", label: "Uber Eats" },
  { value: "DELIVEROO", label: "Deliveroo" },
  { value: "JUST_EAT", label: "Just Eat" },
  { value: "HUBRISE", label: "HubRise" },
  { value: "ONLINE,DIRECT", label: "Online ordering" },
  { value: "POS", label: "POS" },
  { value: "WHATSAPP", label: "WhatsApp" },
  { value: "STRIPE", label: "Stripe" },
  { value: "STUART", label: "Stuart" },
  { value: "UBER_DIRECT", label: "Uber Direct" },
];

const CHANNEL_LABEL: Record<string, string> = {
  UBER_EATS: "Uber Eats",
  DELIVEROO: "Deliveroo",
  HUBRISE: "HubRise",
  JUST_EAT: "Just Eat",
  DIRECT: "Direct",
  ONLINE: "Online",
  POS: "POS",
  WHATSAPP: "WhatsApp",
  STRIPE: "Stripe",
  STUART: "Stuart",
  UBER_DIRECT: "Uber Direct",
  ALL: "All channels",
};

const CHANNEL_COLOR: Record<string, string> = {
  UBER_EATS: "bg-emerald-100 text-emerald-700",
  DELIVEROO: "bg-cyan-100 text-cyan-700",
  HUBRISE: "bg-violet-100 text-violet-700",
  JUST_EAT: "bg-orange-100 text-orange-700",
  DIRECT: "bg-blue-100 text-blue-700",
  ONLINE: "bg-blue-100 text-blue-700",
  POS: "bg-zinc-200 text-zinc-700",
  WHATSAPP: "bg-green-100 text-green-700",
  STRIPE: "bg-indigo-100 text-indigo-700",
  STUART: "bg-sky-100 text-sky-700",
  UBER_DIRECT: "bg-zinc-200 text-zinc-700",
};

function statusBadge(status: LogEntry["status"]) {
  switch (status) {
    case "SUCCESS":
      return {
        icon: CheckCircle2,
        cls: "text-emerald-600",
        chip: "bg-emerald-100 text-emerald-700",
      };
    case "ERROR":
      return {
        icon: XCircle,
        cls: "text-red-600",
        chip: "bg-red-100 text-red-700",
      };
    case "WARNING":
      return {
        icon: AlertTriangle,
        cls: "text-amber-600",
        chip: "bg-amber-100 text-amber-700",
      };
    default:
      return {
        icon: Info,
        cls: "text-sky-600",
        chip: "bg-sky-100 text-sky-700",
      };
  }
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}

function Row({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false);
  const badge = statusBadge(entry.status);
  const Icon = badge.icon;
  const hasDetails =
    entry.details && Object.keys(entry.details as object).length > 0;

  const httpStatus = (entry.details as any)?.uberHttpStatus as
    | number
    | null
    | undefined;

  return (
    <div className="border-b border-zinc-100 last:border-0">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((v) => !v)}
        className={`flex w-full items-start gap-3 px-4 py-3 text-left ${hasDetails ? "hover:bg-zinc-50" : "cursor-default"}`}
      >
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${badge.cls}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-zinc-900">
              {entry.message}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
            {entry.channel && (
              <span
                className={`rounded px-1.5 py-0.5 font-medium ${CHANNEL_COLOR[entry.channel] ?? "bg-zinc-200 text-zinc-700"}`}
              >
                {CHANNEL_LABEL[entry.channel] ?? entry.channel}
              </span>
            )}
            {typeof httpStatus === "number" && (
              <span
                className={`rounded px-1.5 py-0.5 font-mono font-semibold ${httpStatus < 300 ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}
              >
                HTTP {httpStatus}
              </span>
            )}
            {entry.brandName && (
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-700">
                {entry.brandName}
              </span>
            )}
            <span className="font-mono">{entry.action}</span>
            <span>·</span>
            <span title={new Date(entry.createdAt).toLocaleString()}>
              {timeAgo(entry.createdAt)}
            </span>
          </div>
        </div>
        {hasDetails &&
          (open ? (
            <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-zinc-400" />
          ) : (
            <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-zinc-300" />
          ))}
      </button>
      {open && hasDetails && (
        <pre className="mx-4 mb-3 overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-[11px] leading-relaxed text-zinc-700">
          {JSON.stringify(entry.details, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function LogsPage() {
  const [tab, setTab] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [channelFilter, setChannelFilter] = useState<string>("");
  const [copied, setCopied] = useState(false);

  // The sidebar location switcher is the single source of truth for scope, so
  // the feed follows it exactly like Orders and Inventory do. null = "all
  // locations", which the API reads as "everything this user may see" — it
  // never widens to the whole tenant (see activity-log-scope.spec.ts).
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);

  // Name only, for the scope chip and the pasted header. The switcher already
  // lists only accessible locations, so this is a display lookup, not a check.
  const locationsQuery = useQuery({
    queryKey: ["locations"],
    queryFn: () => locationsClient.list(),
    staleTime: 5 * 60_000,
  });
  const locationName =
    locationsQuery.data?.find((l) => l.id === locationId)?.name ?? null;

  const {
    data,
    isLoading,
    isFetching,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<LogsPage>({
    queryKey: ["activity-logs", tab, statusFilter, channelFilter, locationId],
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      if (tab) params.set("category", tab);
      if (statusFilter) params.set("status", statusFilter);
      if (channelFilter) params.set("channel", channelFilter);
      if (locationId) params.set("locationId", locationId);
      if (pageParam) params.set("cursor", String(pageParam));
      params.set("limit", "50");
      const res = await apiClient.get(`/v1/logs?${params.toString()}`);
      return res.data as LogsPage;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: REFRESH_MS,
  });

  const entries = useMemo(
    () => (data?.pages ?? []).flatMap((p) => p.entries),
    [data],
  );

  /**
   * Copy what is on screen — the loaded pages, with the current filters and
   * location applied. Deliberately not a fresh unfiltered fetch: the operator
   * filters down to the thing they are chasing, and the copy should be that,
   * not a surprise dump of everything.
   *
   * "Load more" first if you need more than the last 50.
   */
  const copyLogs = async () => {
    const text = buildLogExport(entries, {
      locationName,
      locationId,
      category: tab,
      channel: channelFilter,
      status: statusFilter,
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(`Copied ${entries.length} log entries`);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // navigator.clipboard is unavailable on insecure origins and in some
      // in-app browsers. Falling back to the old execCommand path means the
      // button still works on a shop tablet rather than silently doing
      // nothing, which is where this gets used.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(true);
        toast.success(`Copied ${entries.length} log entries`);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        toast.error("Couldn't copy — select the entries and copy manually.");
      }
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-1 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900">Logs</h1>
          <p className="text-sm text-zinc-500">
            Everything the system did — menu publishes, order pushes, stock
            changes, store status — without opening server logs.
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
            <MapPin className="h-3.5 w-3.5 text-zinc-400" />
            {locationId ? (
              <>
                Showing{" "}
                <span className="font-medium text-zinc-700">
                  {locationName ?? "selected location"}
                </span>{" "}
                only — switch location in the sidebar to change this.
              </>
            ) : (
              <>Showing every location you have access to.</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={copyLogs}
          disabled={entries.length === 0}
          title="Copy the entries currently shown, with their filters and location, as plain text"
          className="flex items-center gap-2 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          {copied ? (
            <Check className="h-4 w-4 text-emerald-600" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
          {copied ? "Copied" : "Copy logs"}
        </button>
        <button
          type="button"
          onClick={() => refetch()}
          className="flex items-center gap-2 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
        >
          <RefreshCw
            className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {TABS.map((t) => {
          const TIcon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key || "all"}
              type="button"
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition ${
                active
                  ? "bg-orange-500 text-white"
                  : "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              <TIcon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-1.5">
          <select
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value)}
            className="rounded-full border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 focus:outline-none"
          >
            {CHANNEL_FILTERS.map((c) => (
              <option key={c.value || "all"} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          {["", "ERROR", "WARNING", "SUCCESS"].map((sKey) => (
            <button
              key={sKey || "any"}
              type="button"
              onClick={() => setStatusFilter(sKey)}
              className={`rounded-full px-2.5 py-1 text-xs ${
                statusFilter === sKey
                  ? "bg-zinc-900 text-white"
                  : "border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50"
              }`}
            >
              {sKey || "Any status"}
            </button>
          ))}
        </div>
      </div>

      {/* Feed */}
      <div className="mt-4 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-zinc-500">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading activity…
          </div>
        ) : entries.length === 0 ? (
          <div className="py-16 text-center text-sm text-zinc-500">
            No activity yet
            {tab ? ` in ${TABS.find((t) => t.key === tab)?.label}` : ""}
            {locationId ? ` at ${locationName ?? "this location"}` : ""}. Menu
            publishes, order pushes, stock changes and store pauses will show
            up here as they happen.
            {locationId ? " Try another location in the sidebar switcher." : ""}
          </div>
        ) : (
          entries.map((e) => <Row key={e.id} entry={e} />)
        )}
      </div>

      {hasNextPage && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
