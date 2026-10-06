"use client";

// "How to build" step cards — dark, large, readable from across a kitchen.
// Used by the guide editor's preview. (Guides are read in Kitchen training;
// orders show the assembly chart instead.)

import { useState } from "react";
import { Package, Play, Wrench } from "lucide-react";
import { buildStepState, formatVideoTime, type BuildStepState } from "@orderhub/shared";
import { cn } from "@/lib/utils";
import type { BuildGuideStep } from "@/lib/api/build-guides.client";

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
              {s.videoStart != null && (
                <p className="inline-flex items-center gap-1 pl-11 text-xs font-semibold text-red-300">
                  <Play className="h-3 w-3 fill-red-300" /> Video from {formatVideoTime(s.videoStart)}
                </p>
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
