"use client";

// Challenge 25 at the till. Shown when an age-restricted product goes into
// the basket; the cashier either confirms they've checked, or refuses the
// sale and the product never lands. One confirmation covers the rest of the
// sale (up to the age confirmed), and the order records that it was given.

import { useEffect, useRef } from "react";
import { IdCard, ShieldAlert } from "lucide-react";

export interface AgePrompt {
  minAge: number;
  productName: string;
}

export function AgeCheckModal({
  prompt,
  onConfirm,
  onRefuse,
}: {
  prompt: AgePrompt;
  onConfirm: () => void;
  onRefuse: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onRefuse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onRefuse]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="age-check-title"
        aria-describedby="age-check-body"
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-center gap-3 bg-amber-400 px-5 py-4 text-zinc-950">
          <ShieldAlert className="h-7 w-7 shrink-0" aria-hidden />
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest">Challenge 25</p>
            <h2 id="age-check-title" className="text-xl font-black leading-tight">
              {prompt.minAge}+ only — check ID
            </h2>
          </div>
        </div>
        <div id="age-check-body" className="space-y-3 px-5 py-4 text-sm text-zinc-700">
          <p>
            <span className="font-semibold text-zinc-950">{prompt.productName}</span> can only be sold to someone{" "}
            {prompt.minAge} or over.
          </p>
          <p className="flex gap-2 rounded-lg bg-zinc-100 p-3 text-[13px]">
            <IdCard className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
            <span>
              If they look under 25, ask for photo ID: passport, photocard driving licence, or a PASS-hologram card.
              No ID, no sale.
            </span>
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 px-5 pb-5 sm:grid-cols-2">
          <button
            type="button"
            onClick={onRefuse}
            className="min-h-12 rounded-xl border border-zinc-300 px-4 text-sm font-semibold text-zinc-800 hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-900"
          >
            Refuse sale
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="min-h-12 rounded-xl bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
          >
            Customer is {prompt.minAge}+
          </button>
        </div>
      </div>
    </div>
  );
}
