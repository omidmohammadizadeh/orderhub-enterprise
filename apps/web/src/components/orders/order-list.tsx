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
  Printer,
  Filter as FilterIcon,
  X as XIcon,
  Check,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { OrderDetailDrawer } from "./order-detail-drawer";
import { OrderActions } from "./order-actions";
import { PaymentBadge } from "./order-card";
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

// Phase AR — channel catalog for the Filter popover. Lists every
// platform we ship today plus the integrations on the roadmap so
// operators can see what's planned. `enabled: false` channels render
// as disabled "Coming soon" rows that can't be ticked.
//
// The `match` predicate maps the chip label to the platform string(s)
// each adapter writes onto Order.platform. Some legacy orders came in
// before the ONLINE marker existed and were tagged DIRECT, so the
// "Direct online ordering" chip accepts both.
type Channel = {
  key: string;
  label: string;
  match: (platform: string) => boolean;
  enabled: boolean;
};

const CHANNELS: Channel[] = [
  {
    key: "JUST_EAT",
    label: "Just Eat",
    match: (p) => p === "JUST_EAT" || p === "JUSTEAT",
    enabled: true,
  },
  {
    key: "UBER_EATS",
    label: "Uber Eats",
    match: (p) => p === "UBER_EATS" || p === "UBEREATS",
    enabled: true,
  },
  {
    key: "DELIVEROO",
    label: "Deliveroo",
    match: (p) => p === "DELIVEROO",
    enabled: true,
  },
  {
    key: "HUBRISE",
    label: "HubRise",
    match: (p) => p === "HUBRISE",
    enabled: true,
  },
  {
    key: "DIRECT",
    label: "Direct online ordering",
    match: (p) => p === "DIRECT" || p === "ONLINE",
    enabled: true,
  },
  {
    key: "WHATSAPP",
    label: "WhatsApp",
    match: () => false,
    enabled: false,
  },
  {
    key: "CAREEM",
    label: "Careem",
    match: () => false,
    enabled: false,
  },
  {
    key: "TALABAT",
    label: "Talabat",
    match: () => false,
    enabled: false,
  },
];

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
  // Empty set = "all channels". The filter popover writes the
  // selected channel keys here; live filter narrows orders by
  // matching any selected channel's predicate.
  const [channelFilter, setChannelFilter] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filterOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!filterRef.current?.contains(e.target as Node)) setFilterOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [filterOpen]);

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
    if (channelFilter.size > 0) {
      const matchers = CHANNELS.filter((c) => channelFilter.has(c.key)).map(
        (c) => c.match,
      );
      list = list.filter((o) => matchers.some((m) => m(o.platform)));
    }
    return list;
  }, [orders, bucketFilter, channelFilter]);

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
        {/* Channel filter — Filter button with popover */}
        <div className="ml-auto relative" ref={filterRef}>
          <button
            type="button"
            onClick={() => setFilterOpen((o) => !o)}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${
              channelFilter.size > 0
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
            }`}
          >
            <FilterIcon className="h-3.5 w-3.5" />
            Filter
            {channelFilter.size > 0 && (
              <span className="rounded-full bg-white/15 px-1.5 py-0 text-[10px] tabular-nums">
                {channelFilter.size}
              </span>
            )}
          </button>

          {filterOpen && (
            <div className="absolute right-0 top-full z-40 mt-1 w-64 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl">
              <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Channels
                </span>
                {channelFilter.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setChannelFilter(new Set())}
                    className="text-[11px] font-semibold text-violet-600 hover:text-violet-700"
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="max-h-80 overflow-y-auto py-1">
                {CHANNELS.map((c) => {
                  const checked = channelFilter.has(c.key);
                  return (
                    <button
                      key={c.key}
                      type="button"
                      disabled={!c.enabled}
                      onClick={() => {
                        setChannelFilter((prev) => {
                          const next = new Set(prev);
                          if (next.has(c.key)) next.delete(c.key);
                          else next.add(c.key);
                          return next;
                        });
                      }}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ${
                        c.enabled
                          ? "text-zinc-800 hover:bg-zinc-50"
                          : "cursor-not-allowed text-zinc-400"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={`grid h-4 w-4 place-items-center rounded border ${
                            checked
                              ? "border-zinc-900 bg-zinc-900"
                              : c.enabled
                                ? "border-zinc-300 bg-white"
                                : "border-zinc-200 bg-zinc-50"
                          }`}
                        >
                          {checked && <Check className="h-3 w-3 text-white" />}
                        </span>
                        {c.label}
                      </span>
                      {!c.enabled && (
                        <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-500">
                          Coming soon
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Active channel chips — quick remove without re-opening popover */}
      {channelFilter.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-zinc-500">Filtering by:</span>
          {Array.from(channelFilter).map((key) => {
            const c = CHANNELS.find((x) => x.key === key);
            if (!c) return null;
            return (
              <span
                key={key}
                className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold text-zinc-700"
              >
                {c.label}
                <button
                  type="button"
                  onClick={() =>
                    setChannelFilter((prev) => {
                      const next = new Set(prev);
                      next.delete(key);
                      return next;
                    })
                  }
                  className="text-zinc-400 hover:text-zinc-700"
                  aria-label={`Remove ${c.label} filter`}
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

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
                <Th>Payment</Th>
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
        <PaymentBadge
          method={(order as any).paymentMethod}
          status={(order as any).paymentStatus}
        />
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
        <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-2">
          <OrderActions
            orderId={order.id}
            status={order.status}
            fulfillmentType={order.fulfillmentType}
          />
          <ReprintMenu orderId={order.id} fulfillmentType={order.fulfillmentType} />
        </div>
      </Td>
    </tr>
  );
}

// Phase AS-4 — reprint dropdown. Hits POST /v1/print-jobs/reprint
// which creates fresh PrintJob rows (audit-friendly).
function ReprintMenu({
  orderId,
  fulfillmentType,
}: {
  orderId: string;
  fulfillmentType: string;
}) {
  const [open, setOpen] = useState(false);
  const send = async (types: string[]) => {
    setOpen(false);
    try {
      const { printersClient } = await import("@/lib/api/printers.client");
      await printersClient.reprint(orderId, types);
    } catch (err) {
      console.error("reprint failed", err);
    }
  };
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Reprint"
        className="rounded-md p-1.5 text-zinc-400 hover:bg-violet-50 hover:text-violet-700"
      >
        <Printer className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-48 rounded-md border border-zinc-200 bg-white py-1 text-xs shadow-lg">
          <button
            className="block w-full px-3 py-1.5 text-left hover:bg-zinc-50"
            onClick={() => send(["KITCHEN_TICKET"])}
          >
            Kitchen ticket
          </button>
          <button
            className="block w-full px-3 py-1.5 text-left hover:bg-zinc-50"
            onClick={() => send(["CUSTOMER_RECEIPT"])}
          >
            Customer receipt
          </button>
          {fulfillmentType === "DELIVERY" && (
            <button
              className="block w-full px-3 py-1.5 text-left hover:bg-zinc-50"
              onClick={() => send(["DRIVER_SLIP"])}
            >
              Driver slip
            </button>
          )}
          <button
            className="block w-full border-t border-zinc-100 px-3 py-1.5 text-left font-semibold text-violet-700 hover:bg-zinc-50"
            onClick={() =>
              send([
                "KITCHEN_TICKET",
                "CUSTOMER_RECEIPT",
                ...(fulfillmentType === "DELIVERY" ? ["DRIVER_SLIP"] : []),
              ])
            }
          >
            Reprint everything
          </button>
        </div>
      )}
    </div>
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
