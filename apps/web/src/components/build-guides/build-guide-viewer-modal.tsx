"use client";

// "How to build" pop-up — opened from an order card, the order drawer or a
// KDS ticket. Shows each line of the order that has a guide: its modifiers
// and notes on top (what THIS customer asked for), then the photo steps.
// Dark and large on purpose: it is read from across a kitchen.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ClipboardList, Loader2, Package, Wrench, X } from "lucide-react";
import { buildStepState, type BuildStepState } from "@orderhub/shared";
import { cn } from "@/lib/utils";
import {
  buildGuidesClient,
  type BuildGuideOrderLine,
  type BuildGuideStep,
} from "@/lib/api/build-guides.client";

/**
 * The step cards. With `modifierNames` (a real order line) each conditional
 * step is resolved: an ordered extra is highlighted, an extra not ordered is
 * greyed out, a removable step the customer took off is struck through.
 * Without it (editor preview) the conditions show as plain labels.
 */
export function BuildGuideSteps({
  steps,
  packNote,
  modifierNames,
}: {
  steps: BuildGuideStep[];
  packNote: string | null;
  modifierNames?: string[];
}) {
  const [showInactive, setShowInactive] = useState(false);
  const resolved = steps.map((s, i) => ({
    step: s,
    number: i + 1,
    ...(modifierNames
      ? buildStepState(s, modifierNames)
      : { state: "always" as BuildStepState, matched: [] as string[] }),
  }));
  const inactive = resolved.filter((r) => r.state === "notOrdered");
  const visible = showInactive ? resolved : resolved.filter((r) => r.state !== "notOrdered");

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {visible.map(({ step: s, number, state, matched }) => (
          <div
            key={s.id ?? number}
            className={cn(
              "overflow-hidden rounded-xl border bg-zinc-900",
              state === "added" && "border-amber-400 ring-2 ring-amber-400",
              state === "skipped" && "border-red-800 opacity-60",
              state === "notOrdered" && "border-zinc-800 opacity-40",
              state === "always" && "border-zinc-800",
            )}
          >
            {state === "added" && (
              <div className="bg-amber-400 px-3 py-1 text-xs font-black uppercase tracking-wider text-zinc-950">
                Customer added: {matched.join(", ")}
              </div>
            )}
            {state === "skipped" && (
              <div className="bg-red-700 px-3 py-1 text-xs font-black uppercase tracking-wider text-white">
                Skip — customer chose {matched.join(", ")}
              </div>
            )}
            {state === "notOrdered" && (
              <div className="bg-zinc-800 px-3 py-1 text-xs font-bold uppercase tracking-wider text-zinc-400">
                Not ordered
              </div>
            )}
            {s.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={s.imageUrl}
                alt={`Step ${number}`}
                className={cn("aspect-[4/3] w-full object-cover", state === "skipped" && "grayscale")}
              />
            ) : null}
            <div className="space-y-2 p-3">
              <div className="flex items-start gap-3">
                <span
                  className={cn(
                    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base font-black text-white",
                    state === "added" ? "bg-amber-500" : state === "skipped" ? "bg-red-700" : "bg-orange-500",
                  )}
                >
                  {number}
                </span>
                <p
                  className={cn(
                    "whitespace-pre-line pt-1 text-base font-medium leading-snug text-zinc-100",
                    state === "skipped" && "line-through decoration-red-500 decoration-2",
                  )}
                >
                  {s.text}
                </p>
              </div>
              {(s.amount || (s.tools?.length ?? 0) > 0) && (
                <div className="flex flex-wrap gap-1.5 pl-11">
                  {s.amount && (
                    <span className="rounded-md bg-amber-400 px-2 py-0.5 text-xs font-bold text-zinc-950">
                      {s.amount}
                    </span>
                  )}
                  {s.tools?.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-300"
                    >
                      <Wrench className="h-3 w-3" /> {t}
                    </span>
                  ))}
                </div>
              )}
              {!modifierNames && ((s.onlyWith?.length ?? 0) > 0 || (s.skipWith?.length ?? 0) > 0) && (
                <div className="space-y-1 pl-11 text-xs">
                  {(s.onlyWith?.length ?? 0) > 0 && (
                    <p className="font-semibold text-amber-300">Only with: {s.onlyWith!.join(", ")}</p>
                  )}
                  {(s.skipWith?.length ?? 0) > 0 && (
                    <p className="font-semibold text-red-300">Skip if: {s.skipWith!.join(", ")}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {inactive.length > 0 && (
        <button
          type="button"
          onClick={() => setShowInactive((v) => !v)}
          className="text-sm font-medium text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
        >
          {showInactive
            ? "Hide extras not on this order"
            : `${inactive.length} optional step${inactive.length === 1 ? "" : "s"} not on this order — show`}
        </button>
      )}
      {packNote && (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-700 bg-emerald-950/60 p-3 text-emerald-100">
          <Package className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-emerald-400">Pack</div>
            <p className="whitespace-pre-line text-base">{packNote}</p>
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  open: boolean;
  orderId: string;
  /** e.g. "#1042" — shown in the header */
  orderLabel?: string;
  /** Open on this line's guide (by line name) when it has one */
  focusLineName?: string;
  onClose: () => void;
}

export function BuildGuideViewerModal({ open, orderId, orderLabel, focusLineName, onClose }: Props) {
  const q = useQuery({
    queryKey: ["build-guides-order", orderId],
    queryFn: () => buildGuidesClient.forOrder(orderId),
    enabled: open && !!orderId,
    staleTime: 30_000,
  });

  const withGuide = useMemo<BuildGuideOrderLine[]>(
    () => (q.data?.lines ?? []).filter((l) => l.guide),
    [q.data],
  );
  const without = (q.data?.lines ?? []).filter((l) => !l.guide);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) return;
    const idx = focusLineName ? withGuide.findIndex((l) => l.name === focusLineName) : -1;
    setActive(idx >= 0 ? idx : 0);
  }, [open, focusLineName, withGuide]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;
  const line = withGuide[active];

  // Portalled: order cards sit inside transformed/clickable containers, which
  // would both trap a fixed overlay and treat its clicks as "open the order".
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex flex-col bg-zinc-950/95 text-zinc-100"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <ClipboardList className="h-5 w-5 text-orange-400" />
          How to build {orderLabel ? <span className="text-zinc-400">· {orderLabel}</span> : null}
        </h2>
        <button
          onClick={onClose}
          className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          title="Close"
        >
          <X className="h-6 w-6" />
        </button>
      </div>

      {withGuide.length > 1 && (
        <div className="flex gap-2 overflow-x-auto border-b border-zinc-800 px-4 py-2">
          {withGuide.map((l, i) => (
            <button
              key={l.orderItemId}
              onClick={() => setActive(i)}
              className={`shrink-0 rounded-lg px-3 py-2 text-sm font-semibold ${
                i === active ? "bg-orange-500 text-white" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              {l.quantity}× {l.name}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {q.isLoading ? (
          <div className="flex items-center justify-center py-24 text-zinc-400">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading guide…
          </div>
        ) : q.isError ? (
          <p className="py-24 text-center text-red-400">Could not load the guides for this order.</p>
        ) : !line ? (
          <p className="py-24 text-center text-zinc-400">No item in this order has a build guide yet.</p>
        ) : (
          <div className="mx-auto max-w-6xl space-y-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
              <div className="text-xl font-black">
                {line.quantity}× {line.name}
              </div>
              {line.modifiers.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {line.modifiers.map((m, i) => (
                    <li
                      key={i}
                      className="text-base font-semibold text-amber-300"
                      style={{ paddingLeft: `${(m.depth ?? 0) * 16}px` }}
                    >
                      + {(m.quantity ?? 1) > 1 ? `${m.quantity}× ` : ""}
                      {m.name}
                    </li>
                  ))}
                </ul>
              )}
              {line.notes && (
                <p className="mt-2 rounded-md bg-red-950/60 px-2 py-1 text-base font-semibold text-red-300">
                  Note: {line.notes}
                </p>
              )}
            </div>
            <BuildGuideSteps
              key={line.orderItemId}
              steps={line.guide!.steps}
              packNote={line.guide!.packNote}
              modifierNames={line.modifiers.map((m) => m.name)}
            />
          </div>
        )}

        {!q.isLoading && without.length > 0 && withGuide.length > 0 && (
          <p className="mx-auto mt-6 max-w-6xl text-sm text-zinc-500">
            No guide yet: {without.map((l) => `${l.quantity}× ${l.name}`).join(", ")}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
