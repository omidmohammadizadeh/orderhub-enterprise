"use client";

// Phase AR — Deliverect-style single-table order list.
//
// Replaces the wide Kanban board: one row per order, status pill +
// action buttons inline so staff can move an order forward without
// dragging it across columns. The full board lives behind a Filter
// strip across the top (All / New / Accepted / Preparing / Ready /
// Out for delivery / Completed / Cancelled).
//
// Clicking the row opens the existing OrderDetailDrawer; the action
// buttons swallow the row click so they don't double-trigger.

import { useMemo, useState } from "react";
import {
  AlertCircle,
  Bike,
  CheckCircle2,
  ChefHat,
  Clock,
  Loader2,
  ShoppingBag,
  XCircle,
  Send,
  Truck,
  Building2,
} from "lucide-react";
import { OrderDetailDrawer } from "./order-detail-drawer";
import { OrderActions } from "./order-actions";
import { PlatformBadge, FulfillmentBadge } from "./platform-badge";
import { useLiveOrders } from "../../hooks/use-live-orders";
import type { Order } from "../../lib/api/orders.client";

// Bucket → matching predicate + chip tone for the status pill.
// One-to-one with the columns the old Kanban board surfaced.
type Bucket = {
  key: string;
  label: string;
  match: (o: Order) => boolean;
  pill: string; // tailwind classes for the status pill
  icon: React.ElementType;
};

const COLLECTION = new Set(["PICKUP", "DINE_IN"]);

const BUCKETS: Bucket[] = [
  {
    key: "PENDING",
    label: "New",
    match: (o) => o.status === "PENDING",
    pill: "bg-blue-50 text-blue-700",
    icon: Clock,
  },
  {
    key: "ACCEPTED",
    label: "Accepted",
    match: (o) => o.status === "ACCEPTED",
    pill: "bg-sky-50 text-sky-700",
    icon: CheckCircle2,
  },
  {
    key: "PREPARING",
    label: "Preparing",
    match: (o) => o.status === "PREPARING",
    pill: "bg-amber-50 text-amber-700",
    icon: ChefHat,
  },
  {
    key: "READY",
    label: "Ready",
    match: (o) => o.status === "READY",
    pill: "bg-emerald-50 text-emerald-700",
    icon: CheckCircle2,
  },
  {
    key: "DISPATCH",
    label: "Dispatch",
    match: (o) =>
      o.status === "PENDING_DISPATCH" ||
      o.status === "ASSIGNED_DRIVER" ||
      o.status === "ACCEPTED_BY_DRIVER" ||
      o.status === "RIDER_ARRIVED" ||
      o.status === "OUT_FOR_DELIVERY" ||
      o.status === "DISPATCHED",
    pill: "bg-orange-50 text-orange-700",
    icon: Truck,
  },
  {
    key: "COMPLETED",
    label: "Completed",
    match: (o) => o.status === "COMPLETED",
    pill: "bg-zinc-100 text-zinc-700",
    icon: CheckCircle2,
  },
  {
    key: "CANCELLED",
    label: "Cancelled",
    match: (o) =>
      o.status === "CANCELLED" ||
      o.status === "REJECTED" ||
      o.status === "FAILED",
    pill: "bg-red-50 text-red-700",
    icon: XCircle,
  },
];

interface Props {
  locationId?: string;
}

export function OrderList({ locationId }: Props) {
  const { orders, isLoading, error } = useLiveOrders(locationId);
  const [selected, setSelected] = useState<Order | null>(null);
  const [bucketFilter, setBucketFilter] = useState<string>("ALL");
  const [platformFilter, setPlatformFilter] = useState<string>("ALL");

  const platforms = useMemo(() => {
    const set = new Set(orders.map((o) => o.platform));
    return ["ALL", ...Array.from(set)];
  }, [orders]);

  // Pre-bucket every order so the filter chip counts stay accurate
  // even when a filter is already applied.
  const counts = useMemo(() => {
    const out: Record<string, number> = { ALL: orders.length };
    for (const b of BUCKETS) out[b.key] = orders.filter(b.match).length;
    return out;
  }, [orders]);

  const filteredOrders = useMemo(() => {
    let list = orders;
    if (bucketFilter !== "ALL") {
      const b = BUCKETS.find((x) => x.key === bucketFilter);
      if (b) list = list.filter(b.match);
    }
    if (platformFilter !== "ALL") {
      list = list.filter((o) => o.platform === platformFilter);
    }
    return list;
  }, [orders, bucketFilter, platformFilter]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-zinc-400">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading orders…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-sm text-red-500">
        <AlertCircle className="h-4 w-4" /> Failed to load orders
      </div>
    );
  }

  return (
    <>
      {/* Status filter chips */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <FilterChip
          label="All"
          count={counts.ALL ?? 0}
          active={bucketFilter === "ALL"}
          onClick={() => setBucketFilter("ALL")}
        />
        {BUCKETS.map((b) => (
          <FilterChip
            key={b.key}
            label={b.label}
            count={counts[b.key] ?? 0}
            active={bucketFilter === b.key}
            onClick={() => setBucketFilter(b.key)}
          />
        ))}
        {/* Platform filter (right side, secondary) */}
        {platforms.length > 2 && (
          <div className="ml-auto flex items-center gap-1.5">
            {platforms.map((p) => (
              <button
                key={p}
                onClick={() => setPlatformFilter(p)}
                className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                  platformFilter === p
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300"
                }`}
              >
                {p === "ALL" ? "All platforms" : p.replace("_", " ")}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* The list */}
      {filteredOrders.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 bg-white px-6 py-12 text-center text-sm text-zinc-500">
          No orders match this filter.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="min-w-full divide-y divide-zinc-200 text-sm">
            <thead className="bg-zinc-50 text-[11px] uppercase tracking-wider text-zinc-500">
              <tr>
                <Th>Time</Th>
                <Th>Order #</Th>
                <Th>Channel</Th>
                <Th>Type</Th>
                <Th>Customer</Th>
                <Th>Items</Th>
                <Th>Total</Th>
                <Th>Status</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {filteredOrders.map((o) => (
                <OrderRow
                  key={o.id}
                  order={o}
                  onOpen={() => setSelected(o)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <OrderDetailDrawer
        order={selected}
        onClose={() => setSelected(null)}
      />
    </>
  );
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
        active
          ? "border-zinc-900 bg-zinc-900 text-white"
          : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
      }`}
    >
      {label}
      <span
        className={`rounded-full px-1.5 py-0 text-[10px] tabular-nums ${
          active ? "bg-white/15 text-white" : "bg-zinc-100 text-zinc-500"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function OrderRow({
  order,
  onOpen,
}: {
  order: Order;
  onOpen: () => void;
}) {
  const itemCount = order.items.reduce((s, i) => s + i.quantity, 0);
  const bucket =
    BUCKETS.find((b) => b.match(order)) ??
    BUCKETS[BUCKETS.length - 1]!;
  const StatusIcon = bucket.icon;

  return (
    <tr
      onClick={onOpen}
      className="cursor-pointer hover:bg-zinc-50/60 transition-colors"
    >
      <Td>
        <div className="flex flex-col">
          <span className="font-medium text-zinc-900">
            {new Date(order.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <span className="text-[11px] text-zinc-500">
            {timeAgo(order.createdAt)}
          </span>
        </div>
      </Td>
      <Td>
        <span className="font-semibold text-zinc-900">
          #{order.displayId ?? order.id.slice(-6)}
        </span>
      </Td>
      <Td>
        <PlatformBadge platform={order.platform} />
      </Td>
      <Td>
        <FulfillmentBadge type={order.fulfillmentType} />
      </Td>
      <Td>
        <div className="max-w-[160px] truncate text-zinc-700">
          {order.customerInfo?.name ?? "—"}
        </div>
      </Td>
      <Td>
        <span className="text-zinc-700 tabular-nums">{itemCount}</span>
      </Td>
      <Td>
        <span className="font-semibold text-zinc-900 tabular-nums">
          £{Number(order.total).toFixed(2)}
        </span>
      </Td>
      <Td>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${bucket.pill}`}
        >
          <StatusIcon className="h-3 w-3" />
          {bucket.label}
        </span>
      </Td>
      <Td>
        {/* OrderActions handles stopPropagation internally so clicks
            here don't reopen the drawer. */}
        <div onClick={(e) => e.stopPropagation()}>
          <OrderActions
            orderId={order.id}
            status={order.status}
            fulfillmentType={order.fulfillmentType}
          />
        </div>
      </Td>
    </tr>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2.5 text-left font-semibold whitespace-nowrap">
      {children}
    </th>
  );
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2.5 align-middle">{children}</td>;
}
