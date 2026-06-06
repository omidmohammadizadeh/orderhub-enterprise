"use client";

import { useState, useMemo } from "react";
import type { ReactNode } from "react";
import {
  Clock,
  ChefHat,
  CheckCircle2,
  Bike,
  AlertCircle,
  Send,
  UserCheck,
  Truck,
  BellRing,
  PackageCheck,
  ShoppingBag,
  XCircle,
  Ban,
} from "lucide-react";
import { StatusColumn } from "./status-column";
import { OrderDetailDrawer } from "./order-detail-drawer";
import { useLiveOrders } from "../../hooks/use-live-orders";
import type { Order } from "../../lib/api/orders.client";

// ── Board column model ──────────────────────────────────────────────────────
//
// Each column carries a custom `match(order)` predicate rather than a flat
// list of statuses, so we can split the single COMPLETED status into the two
// columns operators expect — "Delivered" (delivery fulfillment) and
// "Collected" (pickup / dine-in) — without changing the database schema.
//
// Driver-handoff sub-states (PENDING_DISPATCH, ASSIGNED_DRIVER,
// ACCEPTED_BY_DRIVER) each get their own column to surface what stage of
// the platform-driver flow each order is in.
//
// Terminal columns (Delivered, Collected, Cancelled, Denied) only contain
// orders updated in the last 24h — the API enforces that window in
// findLiveOrders so this card list stays bounded as volume grows.

const COLLECTION_FULFILLMENT = new Set(["PICKUP", "DINE_IN"]);

type Column = {
  key: string;
  title: string;
  match: (o: Order) => boolean;
  color: string;
  icon: ReactNode;
};

const COLUMNS: Column[] = [
  {
    key: "NEW",
    title: "New",
    match: (o) => o.status === "PENDING",
    color: "bg-blue-500",
    icon: <Clock className="h-4 w-4" />,
  },
  {
    key: "ACCEPTED",
    title: "Accepted",
    match: (o) => o.status === "ACCEPTED",
    color: "bg-sky-500",
    icon: <CheckCircle2 className="h-4 w-4" />,
  },
  {
    key: "PREPARING",
    title: "Preparing",
    match: (o) => o.status === "PREPARING",
    color: "bg-amber-500",
    icon: <ChefHat className="h-4 w-4" />,
  },
  {
    key: "READY",
    title: "Ready",
    match: (o) => o.status === "READY",
    color: "bg-emerald-500",
    icon: <CheckCircle2 className="h-4 w-4" />,
  },
  {
    key: "PENDING_DISPATCH",
    title: "Pending dispatch",
    match: (o) => o.status === "PENDING_DISPATCH",
    color: "bg-orange-500",
    icon: <Send className="h-4 w-4" />,
  },
  {
    key: "ASSIGNED_DRIVER",
    title: "Assigned driver",
    match: (o) => o.status === "ASSIGNED_DRIVER",
    color: "bg-cyan-500",
    icon: <UserCheck className="h-4 w-4" />,
  },
  {
    key: "ACCEPTED_BY_DRIVER",
    title: "Driver en route",
    match: (o) => o.status === "ACCEPTED_BY_DRIVER",
    color: "bg-teal-500",
    icon: <Truck className="h-4 w-4" />,
  },
  {
    // RIDER_ARRIVED — the platform courier is physically at the shop
    // waiting to collect. Plays the rider-arrived.mp3 alert when it
    // arrives via socket (handled in use-live-orders).
    key: "RIDER_ARRIVED",
    title: "Rider arrived",
    match: (o) => o.status === "RIDER_ARRIVED",
    color: "bg-fuchsia-500",
    icon: <BellRing className="h-4 w-4" />,
  },
  {
    key: "OUT_FOR_DELIVERY",
    title: "Out for delivery",
    // DISPATCHED is the pre-Phase-AJ alias for OUT_FOR_DELIVERY — still
    // emitted by some integrations, fold it into the same column.
    match: (o) => o.status === "OUT_FOR_DELIVERY" || o.status === "DISPATCHED",
    color: "bg-violet-500",
    icon: <Bike className="h-4 w-4" />,
  },
  {
    key: "DELIVERED",
    title: "Delivered",
    match: (o) =>
      o.status === "COMPLETED" && !COLLECTION_FULFILLMENT.has(o.fulfillmentType),
    color: "bg-green-600",
    icon: <PackageCheck className="h-4 w-4" />,
  },
  {
    key: "COLLECTED",
    title: "Collected",
    match: (o) =>
      o.status === "COMPLETED" && COLLECTION_FULFILLMENT.has(o.fulfillmentType),
    color: "bg-lime-600",
    icon: <ShoppingBag className="h-4 w-4" />,
  },
  {
    key: "DENIED",
    title: "Denied",
    // REJECTED = staff denied a new order. FAILED = system / driver issue.
    // Operators conceptually treat both as "we couldn't fulfil it".
    match: (o) => o.status === "REJECTED" || o.status === "FAILED",
    color: "bg-rose-500",
    icon: <Ban className="h-4 w-4" />,
  },
  {
    key: "CANCELLED",
    title: "Cancelled",
    match: (o) => o.status === "CANCELLED",
    color: "bg-zinc-500",
    icon: <XCircle className="h-4 w-4" />,
  },
];

// Statuses considered "active" (i.e. still need staff attention) — used
// for the count badge in the top-right of the board.
const ACTIVE_STATUSES = new Set([
  "PENDING",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "PENDING_DISPATCH",
  "ASSIGNED_DRIVER",
  "ACCEPTED_BY_DRIVER",
  "RIDER_ARRIVED",
  "OUT_FOR_DELIVERY",
  "DISPATCHED",
]);

interface Props {
  locationId?: string;
}

export function OrderBoard({ locationId }: Props) {
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [platformFilter, setPlatformFilter] = useState<string>("ALL");
  const { orders, isLoading, error } = useLiveOrders(locationId);

  const platforms = useMemo(() => {
    const set = new Set(orders.map((o) => o.platform));
    return ["ALL", ...Array.from(set)];
  }, [orders]);

  const filteredOrders = useMemo(
    () =>
      platformFilter === "ALL"
        ? orders
        : orders.filter((o) => o.platform === platformFilter),
    [orders, platformFilter],
  );

  const byColumn = useMemo(
    () =>
      COLUMNS.reduce(
        (acc, col) => ({
          ...acc,
          [col.key]: filteredOrders.filter(col.match),
        }),
        {} as Record<string, Order[]>,
      ),
    [filteredOrders],
  );

  const activeCount = useMemo(
    () => filteredOrders.filter((o) => ACTIVE_STATUSES.has(o.status)).length,
    [filteredOrders],
  );

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-zinc-400">
        Loading orders…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-sm text-red-500">
        <AlertCircle className="h-4 w-4" />
        Failed to load orders
      </div>
    );
  }

  return (
    <>
      {/* Platform filter */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {platforms.map((p) => (
          <button
            key={p}
            onClick={() => setPlatformFilter(p)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              platformFilter === p
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50"
            }`}
          >
            {p === "ALL" ? "All platforms" : p.replace("_", " ")}
          </button>
        ))}
        <span className="ml-auto text-xs text-zinc-400 tabular-nums">
          {activeCount} active order{activeCount !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Board — horizontally scrollable 12-column flex row.
          Columns are 240px wide and the wrapper scrolls when there isn't
          room for all twelve. This mirrors the Base44 layout the operator
          expects without forcing tiny grid cells on the desktop view. */}
      <div className="-mx-1 overflow-x-auto pb-2">
        <div className="flex gap-3 px-1 min-w-max">
          {COLUMNS.map((col) => (
            <div key={col.key} className="w-[240px] flex-shrink-0">
              <StatusColumn
                title={col.title}
                status={col.key}
                orders={byColumn[col.key] ?? []}
                color={col.color}
                icon={col.icon}
                onOrderClick={setSelectedOrder}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Detail drawer */}
      {selectedOrder && (
        <div
          className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm"
          onClick={() => setSelectedOrder(null)}
        />
      )}
      <OrderDetailDrawer
        order={selectedOrder}
        onClose={() => setSelectedOrder(null)}
      />
    </>
  );
}
