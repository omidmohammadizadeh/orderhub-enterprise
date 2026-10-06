"use client";

import { useState } from "react";
import { ClipboardList } from "lucide-react";
import { useBuildGuideKeys } from "@/lib/api/build-guides.client";
import { BuildGuideViewerModal } from "./build-guide-viewer-modal";

interface Props {
  orderId: string;
  /** Names of the order's lines — the button only shows when one has a guide */
  itemNames: Array<string | null | undefined>;
  orderLabel?: string;
  /** Open straight onto this line's guide */
  focusLineName?: string;
  /** "card" on the light dashboard, "kds" on the dark kitchen screen, "inline" per line */
  variant?: "card" | "kds" | "inline";
}

const STYLES: Record<NonNullable<Props["variant"]>, string> = {
  card:
    "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-orange-200 bg-orange-50 px-2 py-1.5 text-xs font-semibold text-orange-700 hover:bg-orange-100",
  kds:
    "inline-flex items-center gap-1.5 rounded-md bg-orange-500/15 px-2 py-1 text-xs font-bold text-orange-300 ring-1 ring-orange-500/40 hover:bg-orange-500/25",
  inline:
    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold text-orange-600 hover:bg-orange-50",
};

export function HowToBuildButton({ orderId, itemNames, orderLabel, focusLineName, variant = "card" }: Props) {
  const { hasGuide } = useBuildGuideKeys();
  const [open, setOpen] = useState(false);
  if (!itemNames.some((n) => hasGuide(n))) return null;
  return (
    <>
      <button
        type="button"
        className={STYLES[variant]}
        onClick={(e) => {
          // Cards and tickets open/bump on click — this button must not.
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <ClipboardList className={variant === "inline" ? "h-3 w-3" : "h-3.5 w-3.5"} />
        How to build
      </button>
      <BuildGuideViewerModal
        open={open}
        orderId={orderId}
        orderLabel={orderLabel}
        focusLineName={focusLineName}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
