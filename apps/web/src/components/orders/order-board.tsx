"use client";

import { useState, useMemo } from "react";
import { Clock, ChefHat, CheckCircle2, Bike, AlertCircle } from "lucide-react";
import { StatusColumn } from "./status-column";
import { OrderDetailDrawer } from "./order-detail-drawer";
import { useLiveOrders } from "../../hooks/use-live-orders";
import type { Order } from "../../lib/api/orders.client";

// Each column maps to ONE or MORE OrderStatus values. Phase AJ split
// the legacy DISPATCHED state into ASSIGNED_DRIVER / ACCEPTED_BY_DRIVER /
// OUT_FOR_DELIVERY — the board folds the driver-handoff states under a
// single "Out for delivery" column so the staff view stays compact, and
// keeps DISPATCHED in the same column for backward-compatibility with
// integrations that still emit it.
const COLUMNS: Array<{
  key: string;
  title: string;
  matches: string[];
  color: string;
  icon: React.ReactNode;
}> = [
  {
    key: "NEW",
    title: "New",
    matches: ["PENDING"],
    color: "bg-blue-500",
    icon: <Clock className="h-4 w-4" />,
  },
  {
    key: "ACCEPTED",
    title: "Accepted",
    matches: ["ACCEPTED"],
    color: "bg-sky-500",
    icon: <CheckCircle2 className="h-4 w-4" />,
  },
  {
    key: "PREPARING",
    title: "Preparing",
    matches: ["PREPARING"],
    color: "bg-amber-500",
    icon: <ChefHat className="h-4 w-4" />,
  },
  {
    key: "READY",
    title: "Ready",
    matches: ["READY"],
    color: "bg-emerald-500",
    icon: <CheckCircle2 className="h-4 w-4" />,
  },
  {
    key: "OUT",
    title: "Out for delivery",
    matches: ["OUT_FOR_DELIVERY", "DISPATCHED", "ASSIGNED_DRIVER", "ACCEPTED_BY_DRIVER"],
    color: "bg-violet-500",
    icon: <Bike className="h-4 w-4" />,
  },
];

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

  const byStatus = useMemo(
    () =>
      COLUMNS.reduce(
        (acc, col) => ({
          ...acc,
          [col.key]: filteredOrders.filter((o) => col.matches.includes(o.status)),
        }),
        {} as Record<string, Order[]>,
      ),
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
          {filteredOrders.length} active order{filteredOrders.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Board columns */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {COLUMNS.map((col) => (
          <StatusColumn
            key={col.key}
            title={col.title}
            status={col.key}
            orders={byStatus[col.key] ?? []}
            color={col.color}
            icon={col.icon}
            onOrderClick={setSelectedOrder}
          />
        ))}
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
