"use client";

import { useState } from "react";
import { Sandwich } from "lucide-react";
import { useAssemblyChartKeys } from "@/lib/api/assembly-charts.client";
import { ChartViewerModal } from "./chart-viewer-modal";

interface Props {
  orderId: string;
  itemNames: Array<string | null | undefined>;
  orderLabel?: string;
  focusLineName?: string;
  variant?: "card" | "kds" | "inline";
}

const STYLES: Record<NonNullable<Props["variant"]>, string> = {
  card:
    "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-pink-200 bg-pink-50 px-2 py-1.5 text-xs font-semibold text-pink-700 hover:bg-pink-100",
  kds:
    "inline-flex items-center gap-1.5 rounded-md bg-pink-500/15 px-2 py-1 text-xs font-bold text-pink-300 ring-1 ring-pink-500/40 hover:bg-pink-500/25",
  inline:
    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold text-pink-600 hover:bg-pink-50",
};

/** "Chart" — sits next to "How to build"; only shows when a line has a chart. */
export function ChartButton({ orderId, itemNames, orderLabel, focusLineName, variant = "card" }: Props) {
  const { hasChart } = useAssemblyChartKeys();
  const [open, setOpen] = useState(false);
  if (!itemNames.some((n) => hasChart(n))) return null;
  return (
    <>
      <button
        type="button"
        className={STYLES[variant]}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Sandwich className={variant === "inline" ? "h-3 w-3" : "h-3.5 w-3.5"} />
        Chart
      </button>
      <ChartViewerModal
        open={open}
        orderId={orderId}
        orderLabel={orderLabel}
        focusLineName={focusLineName}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
