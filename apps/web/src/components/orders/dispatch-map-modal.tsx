"use client";

// Every delivery on one map, from the orders board, with bulk dispatch on it.
//
// The per-order Map button answers "where is THIS one going". This answers
// the question that comes next during a rush: "which of these go together?"
// — the shop, every live delivery as a house with its minutes left inside,
// and the drivers. Tap houses to pick a run; the pick IS the board's bulk
// pick (same state, same stop order, same BulkDispatchModal and the same
// eligibility rule), so picking on the map and on the list never disagree.
//
// The pins come from the dispatch feed, not the board's own rows: that is
// where coordinates are resolved (and lazily geocoded), so this map and the
// Dispatch console can never disagree about where an order is.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bike, Loader2, X } from "lucide-react";
import { DispatchMap } from "@/components/dispatch/dispatch-map";
import { getDispatchFeed } from "@/lib/api/dispatch.client";
import type { Order } from "@/lib/api/orders.client";
import { canBulkDispatch, isDeliveryFulfillment } from "./bulk-dispatch-eligibility";

interface Props {
  /** The board's location, or undefined for "all locations". */
  locationId?: string;
  /** The live board rows — the source of truth for what can be dispatched. */
  orders: Order[];
  /** The board's bulk pick, in tap order. */
  pickedIds: string[];
  onTogglePick: (orderId: string) => void;
  onClearPicks: () => void;
  /** Open the board's BulkDispatchModal with the current pick. */
  onDispatch: () => void;
  onClose: () => void;
}

const orderRef = (o: Order) =>
  `#${(o as any).displayId ?? (o as any).orderNumber ?? o.id.slice(-5)}`;

/** Why a tapped house can't join the run — said out loud, because a tap that
 *  does nothing reads as a broken map. */
function whyNotPickable(o: Order | undefined): string {
  if (!o) return "That order isn't on this board any more.";
  if (!isDeliveryFulfillment(o.fulfillmentType)) return `${orderRef(o)} isn't a delivery.`;
  if ((o as any).deliveryType === "PLATFORM")
    return `${orderRef(o)} is delivered by the marketplace's own rider.`;
  if ((o as any).courierJobId) return `${orderRef(o)} is already with a courier.`;
  return `${orderRef(o)} can be dispatched once it's accepted, preparing or ready.`;
}

export function DispatchMapModal({
  locationId,
  orders,
  pickedIds,
  onTogglePick,
  onClearPicks,
  onDispatch,
  onClose,
}: Props) {
  const scope = locationId ?? "all";
  const { data: feed, isLoading, error } = useQuery({
    queryKey: ["dispatch", "feed", scope],
    queryFn: () => getDispatchFeed(scope),
    // Same cadence as the Dispatch console: drivers move, orders land.
    refetchInterval: 10_000,
  });

  // The countdown inside each house, and its colour, move every second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const orderById = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders]);

  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(t);
  }, [notice]);

  const onSelectOrder = (id: string) => {
    const o = orderById.get(id);
    if (o && canBulkDispatch(o)) {
      onTogglePick(id);
      setNotice(null);
    } else {
      setNotice(whyNotPickable(o));
    }
  };

  // Board deliveries the map can't place, so nobody hunts for a missing pin.
  const unplaced = useMemo(() => {
    if (!feed) return 0;
    const placed = new Set(
      feed.orders.filter((p) => p.lat != null && p.lng != null).map((p) => p.id),
    );
    return orders.filter((o) => canBulkDispatch(o) && !placed.has(o.id)).length;
  }, [feed, orders]);

  const onlineDrivers = feed?.drivers.filter((d) => d.status === "ONLINE").length ?? 0;
  const busyDrivers = feed?.drivers.filter((d) => d.status === "ON_JOB").length ?? 0;
  const liveOrders = feed?.orders.filter((o) => !o.done).length ?? 0;

  // Escape closes; focus goes back to the opener. Mount-only, like the
  // per-order map — the board re-renders this on every live update.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // A BulkDispatchModal open on top owns Escape.
      if (e.key === "Escape" && !document.querySelector("[data-bulk-dispatch-open]"))
        onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex bg-black/40 sm:p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Dispatch map"
        tabIndex={-1}
        className="relative flex h-full w-full flex-col overflow-hidden bg-white shadow-xl outline-none sm:rounded-2xl"
      >
        <div className="flex items-center gap-3 border-b border-zinc-100 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-zinc-900">Dispatch map</h3>
            <p className="truncate text-xs text-zinc-500">
              {liveOrders} {liveOrders === 1 ? "delivery" : "deliveries"} ·{" "}
              {onlineDrivers} driver{onlineDrivers === 1 ? "" : "s"} free
              {busyDrivers > 0 ? ` · ${busyDrivers} on a job` : ""} · tap houses to
              pick a run
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dispatch map"
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="relative min-h-0 flex-1 bg-zinc-100">
          {error ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-zinc-700">
              {(error as any)?.response?.data?.message ??
                (error as any)?.message ??
                "Could not load the map"}
            </div>
          ) : isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-zinc-300" />
            </div>
          ) : (
            // DispatchMap sizes itself to 100% of this box (min 70vh).
            <div className="absolute inset-0 [&>div]:!min-h-0">
              <DispatchMap
                feed={feed}
                now={now}
                focusKey={scope}
                selecting
                selectedIds={pickedIds}
                onSelectOrder={onSelectOrder}
              />
            </div>
          )}

          {notice && (
            <div
              role="status"
              className="absolute inset-x-3 top-3 mx-auto max-w-md rounded-lg bg-zinc-900/90 px-3 py-2 text-center text-xs text-white shadow-lg"
            >
              {notice}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-100 px-4 py-2 text-[11px] text-zinc-600">
          <Legend color="#16a34a" label="15+ min" />
          <Legend color="#f97316" label="≤15 min" />
          <Legend color="#dc2626" label="≤5 min / late" />
          <Legend color="#2563eb" label="Picked (stop #)" />
          <Legend color="#9ca3af" label="With a driver / done" />
          <span>🚗 green free · red busy</span>
          {unplaced > 0 && (
            <span className="text-amber-700">
              {unplaced} {unplaced === 1 ? "delivery has" : "deliveries have"} no
              address we can place — pick {unplaced === 1 ? "it" : "them"} on the
              board.
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-zinc-200 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <p className="min-w-0 flex-1 text-sm text-zinc-700" aria-live="polite">
            {pickedIds.length === 0 ? (
              "Tap deliveries to add them — your driver goes in the order you tap"
            ) : (
              <>
                <span className="font-semibold tabular-nums text-zinc-900">
                  {pickedIds.length}
                </span>{" "}
                {pickedIds.length === 1 ? "order" : "orders"} picked
              </>
            )}
          </p>
          {pickedIds.length > 0 && (
            <button
              type="button"
              onClick={onClearPicks}
              className="rounded-lg px-2 py-1.5 text-xs font-semibold text-zinc-500 hover:text-zinc-800"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onDispatch}
            disabled={pickedIds.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-40"
          >
            <Bike className="h-4 w-4" aria-hidden="true" />
            Dispatch {pickedIds.length > 0 ? pickedIds.length : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        aria-hidden
        className="inline-block h-2.5 w-2.5 rounded-sm"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}
