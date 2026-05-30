"use client";

// Phase AM — Scheduled Orders strip shown above the main Orders board.
//
// Lists POS orders with a future scheduledAt that have NOT been started yet
// (they are still PENDING with no PrinterJob fired). Each card shows the
// customer, type, total, scheduled time, a countdown until "go", and a
// "Start preparing now" button that flips the order into the normal ACCEPTED
// flow (which triggers the print pipeline).

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Calendar, Clock, Loader2, PlayCircle, Bike, ShoppingBag } from "lucide-react";
import { apiClient } from "@/lib/api/client";

interface ScheduledOrder {
  id: string;
  displayId: string | null;
  customerName: string | null;
  fulfillmentType: string;
  status: string;
  total: string;
  scheduledAt: string | null;
  scheduledFor: string | null;
  createdAt: string;
  items?: Array<{ name: string; quantity: number }>;
}

export function ScheduledOrdersStrip({ locationId }: { locationId?: string }) {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<ScheduledOrder[]>({
    queryKey: ["orders", "scheduled", locationId ?? "all"],
    queryFn: async () =>
      (
        await apiClient.get<ScheduledOrder[]>("/v1/orders/scheduled", {
          params: locationId ? { locationId } : undefined,
        })
      ).data,
    refetchInterval: 30_000,
  });

  const startMutation = useMutation({
    mutationFn: async (orderId: string) =>
      apiClient.post(`/v1/orders/${orderId}/start-preparing`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders", "scheduled"] });
      qc.invalidateQueries({ queryKey: ["orders", "live"] });
    },
  });

  if (isLoading) {
    return (
      <div className="mb-4 rounded-lg border border-dashed border-zinc-200 px-4 py-3 text-xs text-zinc-400">
        Loading scheduled orders…
      </div>
    );
  }

  const orders = data ?? [];
  if (orders.length === 0) return null;

  return (
    <section className="mb-4 rounded-lg border border-amber-200 bg-amber-50/50 p-3">
      <header className="mb-2 flex items-center gap-2">
        <Calendar className="h-4 w-4 text-amber-700" />
        <h2 className="text-sm font-semibold text-amber-900">
          Scheduled orders
        </h2>
        <span className="rounded-full bg-amber-200/60 px-2 py-0.5 text-[10px] font-medium text-amber-900">
          {orders.length}
        </span>
      </header>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {orders.map((o) => (
          <ScheduledOrderCard
            key={o.id}
            order={o}
            onStart={() => startMutation.mutate(o.id)}
            starting={startMutation.isPending && startMutation.variables === o.id}
          />
        ))}
      </div>
    </section>
  );
}

function ScheduledOrderCard({
  order,
  onStart,
  starting,
}: {
  order: ScheduledOrder;
  onStart: () => void;
  starting: boolean;
}) {
  const scheduledAt = order.scheduledAt ?? order.scheduledFor;
  const countdown = useCountdown(scheduledAt);
  const isDelivery = order.fulfillmentType === "DELIVERY";

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-amber-200 bg-white p-2.5 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-zinc-900">
            {order.customerName ?? "Walk-in"}
          </p>
          <p className="text-[10px] text-zinc-500">
            {order.displayId ?? `#${order.id.slice(-6)}`}
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] ${
            isDelivery
              ? "bg-blue-50 text-blue-700"
              : "bg-emerald-50 text-emerald-700"
          }`}
        >
          {isDelivery ? <Bike className="h-3 w-3" /> : <ShoppingBag className="h-3 w-3" />}
          {isDelivery ? "Delivery" : "Collection"}
        </span>
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-zinc-700">
        <Clock className="h-3 w-3 text-amber-700" />
        <span>{formatScheduled(scheduledAt)}</span>
      </div>

      {countdown && (
        <p className="text-[11px] font-medium text-amber-900">
          Starts in {countdown}
        </p>
      )}

      {order.items && order.items.length > 0 && (
        <ul className="space-y-0.5 text-[10px] text-zinc-600">
          {order.items.slice(0, 3).map((it, idx) => (
            <li key={idx}>
              {it.quantity}× {it.name}
            </li>
          ))}
          {order.items.length > 3 && (
            <li className="text-zinc-400">…+{order.items.length - 3} more</li>
          )}
        </ul>
      )}

      <div className="flex items-center justify-between border-t border-zinc-100 pt-1.5">
        <span className="text-xs font-semibold">£{Number(order.total).toFixed(2)}</span>
        <button
          type="button"
          onClick={onStart}
          disabled={starting}
          className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
        >
          {starting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <PlayCircle className="h-3 w-3" />
          )}
          Start now
        </button>
      </div>
    </div>
  );
}

function useCountdown(iso: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const handle = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(handle);
  }, [iso]);

  return useMemo(() => {
    if (!iso) return null;
    const ms = new Date(iso).getTime() - now;
    if (ms < 0) return "now";
    const mins = Math.round(ms / 60_000);
    if (mins < 60) return `${mins} min`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return remMins === 0 ? `${hours}h` : `${hours}h ${remMins}m`;
  }, [iso, now]);
}

function formatScheduled(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
