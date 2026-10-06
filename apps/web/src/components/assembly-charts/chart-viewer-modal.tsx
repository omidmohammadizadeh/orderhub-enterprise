"use client";

// The "Chart" pop-up on an order: the board, with one column per line of the
// order that has a chart — exactly what the wall poster shows, but only the
// burgers on THIS ticket, with the customer's changes under each.

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { assemblyChartsClient } from "@/lib/api/assembly-charts.client";
import { BOARD_BG, ChartColumn } from "./chart-column";

interface Props {
  open: boolean;
  orderId: string;
  orderLabel?: string;
  /** Show only this line (from a per-line button); all lines otherwise */
  focusLineName?: string;
  onClose: () => void;
}

export function ChartViewerModal({ open, orderId, orderLabel, focusLineName, onClose }: Props) {
  const q = useQuery({
    queryKey: ["assembly-charts-order", orderId],
    queryFn: () => assemblyChartsClient.forOrder(orderId),
    enabled: open && !!orderId,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;
  const all = q.data?.lines ?? [];
  const charted = all.filter((l) => l.chart && (!focusLineName || l.name === focusLineName));
  const rest = all.filter((l) => !l.chart);

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex flex-col text-white"
      style={{ background: BOARD_BG }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-3 bg-black/20 px-4 py-3">
        <h2 className="text-lg font-black uppercase tracking-wide">
          Assembly chart {orderLabel ? <span className="opacity-70">· {orderLabel}</span> : null}
        </h2>
        <button onClick={onClose} className="rounded-lg p-2 hover:bg-black/20" aria-label="Close">
          <X className="h-6 w-6" />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {q.isLoading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading chart…
          </div>
        ) : q.isError ? (
          <p className="py-24 text-center">Could not load the charts for this order.</p>
        ) : charted.length === 0 ? (
          <p className="py-24 text-center">No item in this order has a chart yet.</p>
        ) : (
          <div className="mx-auto flex w-max min-w-full justify-center gap-5 pb-4">
            {charted.map((l) => (
              <div key={l.orderItemId} className="flex flex-col items-center gap-2">
                <ChartColumn chart={l.chart!} quantity={l.quantity} size="lg" />
                {(l.modifiers.length > 0 || l.notes) && (
                  <div className="w-[260px] rounded-lg bg-[#1d2242] p-2 text-sm">
                    {l.modifiers.map((m, i) => (
                      <p key={i} className="font-semibold text-amber-300" style={{ paddingLeft: `${(m.depth ?? 0) * 12}px` }}>
                        + {(m.quantity ?? 1) > 1 ? `${m.quantity}× ` : ""}
                        {m.name}
                      </p>
                    ))}
                    {l.notes && <p className="mt-1 font-semibold text-red-300">Note: {l.notes}</p>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {!q.isLoading && !focusLineName && rest.length > 0 && charted.length > 0 && (
          <p className="mt-4 text-center text-sm text-white/70">
            No chart: {rest.map((l) => `${l.quantity}× ${l.name}`).join(", ")}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
