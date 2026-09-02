"use client";

// Order history — completed orders over a date or date range.
//
// Deliberately NOT a second live board. It fetches once per query and pages
// through the results; nothing here polls. The live board polls because a
// kitchen needs to see a new order within seconds, but history is a question
// asked and answered, and putting it on a timer is how a reporting screen
// left open on a back-office tab turns into thousands of requests a day.
//
// The API caps `limit` at 200 and we ask for 50, so one page is one query.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Calendar, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { apiClient } from "@/lib/api/client";

interface HistoryOrder {
  id: string;
  displayId: string | null;
  orderNumber: number | null;
  status: string;
  platform: string;
  orderSource: string | null;
  customerName: string | null;
  total: string | number;
  createdAt: string;
  location?: { name?: string | null } | null;
  brand?: { name?: string | null } | null;
}

interface HistoryResponse {
  total: number;
  page: number;
  limit: number;
  orders: HistoryOrder[];
}

const PAGE_SIZE = 50;

/** Local YYYY-MM-DD, so "today" means the operator's today, not UTC's. */
function isoDay(d: Date): string {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return x.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDay(d);
}

const PRESETS: Array<{ label: string; from: () => string; to: () => string }> = [
  { label: "Today", from: () => daysAgo(0), to: () => daysAgo(0) },
  { label: "Yesterday", from: () => daysAgo(1), to: () => daysAgo(1) },
  { label: "Last 7 days", from: () => daysAgo(6), to: () => daysAgo(0) },
  { label: "Last 30 days", from: () => daysAgo(29), to: () => daysAgo(0) },
];

const money = (v: string | number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(
    Number(v) || 0,
  );

export function OrderHistoryModal({
  open,
  onClose,
  locationId,
}: {
  open: boolean;
  onClose: () => void;
  /** Follows the page's shop scope. Undefined = every shop the user can see. */
  locationId?: string;
}) {
  const [from, setFrom] = useState(() => daysAgo(6));
  const [to, setTo] = useState(() => daysAgo(0));
  const [page, setPage] = useState(1);
  const [completedOnly, setCompletedOnly] = useState(true);

  const params = useMemo(
    () => ({
      // The whole of the end day, not midnight at the start of it — a range
      // that silently drops today's trade is worse than no range at all.
      from: `${from}T00:00:00.000`,
      to: `${to}T23:59:59.999`,
      page,
      limit: PAGE_SIZE,
      ...(completedOnly ? { status: "COMPLETED" } : {}),
      ...(locationId ? { locationId } : {}),
    }),
    [from, to, page, completedOnly, locationId],
  );

  const query = useQuery({
    queryKey: ["order-history", params],
    queryFn: async () =>
      (await apiClient.get<HistoryResponse>("/v1/orders", { params })).data,
    enabled: open,
    // Asked and answered — no refetch on focus, no interval. Reopening the
    // same range inside five minutes reuses what we already have.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  if (!open) return null;

  const data = query.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setFrom(p.from());
    setTo(p.to());
    setPage(1);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
            <Calendar className="h-4 w-4" /> Order history
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Range picker */}
        <div className="flex flex-wrap items-end gap-3 border-b border-zinc-100 px-5 py-3">
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => {
              const active = from === p.from() && to === p.to();
              return (
                <button
                  key={p.label}
                  onClick={() => applyPreset(p)}
                  className={`rounded-md border px-2.5 py-1.5 text-xs font-medium ${
                    active
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 text-zinc-600 hover:bg-zinc-50"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-end gap-2">
            <label className="flex flex-col text-[10px] font-medium uppercase tracking-wide text-zinc-500">
              From
              <input
                type="date"
                value={from}
                max={to}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPage(1);
                }}
                className="mt-1 rounded-md border border-zinc-200 px-2 py-1.5 text-sm text-zinc-900"
              />
            </label>
            <label className="flex flex-col text-[10px] font-medium uppercase tracking-wide text-zinc-500">
              To
              <input
                type="date"
                value={to}
                min={from}
                max={daysAgo(0)}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPage(1);
                }}
                className="mt-1 rounded-md border border-zinc-200 px-2 py-1.5 text-sm text-zinc-900"
              />
            </label>
          </div>
          <label className="flex items-center gap-1.5 pb-1.5 text-xs text-zinc-600">
            <input
              type="checkbox"
              checked={completedOnly}
              onChange={(e) => {
                setCompletedOnly(e.target.checked);
                setPage(1);
              }}
            />
            Completed only
          </label>
        </div>

        {/* Results */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {query.isLoading ? (
            <div className="grid place-items-center py-16 text-zinc-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : query.isError ? (
            <p className="px-5 py-16 text-center text-sm text-red-600">
              {(query.error as any)?.response?.data?.message ??
                "Couldn't load order history."}
            </p>
          ) : !data || data.orders.length === 0 ? (
            <p className="px-5 py-16 text-center text-sm text-zinc-400">
              No orders in this range.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-5 py-2 text-left font-semibold">Date</th>
                  <th className="px-3 py-2 text-left font-semibold">Order</th>
                  <th className="px-3 py-2 text-left font-semibold">Channel</th>
                  <th className="px-3 py-2 text-left font-semibold">Customer</th>
                  <th className="px-3 py-2 text-left font-semibold">Status</th>
                  <th className="px-5 py-2 text-right font-semibold">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id} className="border-t border-zinc-100">
                    <td className="whitespace-nowrap px-5 py-2 text-zinc-600">
                      {new Date(o.createdAt).toLocaleString("en-GB", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-3 py-2 font-medium text-zinc-900">
                      {o.displayId ?? (o.orderNumber ? `#${o.orderNumber}` : "—")}
                    </td>
                    <td className="px-3 py-2 text-zinc-600">
                      {o.platform ?? o.orderSource ?? "—"}
                    </td>
                    <td className="max-w-[180px] truncate px-3 py-2 text-zinc-600">
                      {o.customerName ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-zinc-600">{o.status}</td>
                    <td className="px-5 py-2 text-right tabular-nums text-zinc-900">
                      {money(o.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pager */}
        <div className="flex items-center justify-between border-t border-zinc-100 px-5 py-3 text-xs text-zinc-600">
          <span>
            {data
              ? `${data.total} order${data.total === 1 ? "" : "s"} · page ${data.page} of ${totalPages}`
              : ""}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || query.isFetching}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || query.isFetching}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 disabled:opacity-40"
            >
              Next <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
