"use client";

// The tip step, between the basket and placing the order.
//
// The money goes to the RESTAURANT, not a courier — so the copy says the
// kitchen, and it shows on collection orders too, where there is no driver
// and a courier framing would simply be a lie.
//
// Percentages are of the food, not the bill: tipping on the delivery fee or
// on tax is the kind of quiet padding that customers notice once and never
// forgive.

import { useState } from "react";

const PRESETS = [10, 15, 20, 25];

export function TipStep({
  money,
  symbol,
  tipBase,
  brandName,
  onBack,
  onContinue,
}: {
  /** Bound to the store's currency by the page — never format money here. */
  money: (n: number | string | null | undefined) => string;
  /** Currency symbol for bare prefixes, e.g. the custom-tip input. */
  symbol: string;
  /** Food total the percentages are taken from — excludes delivery and tax. */
  tipBase: number;
  brandName: string;
  onBack: () => void;
  onContinue: (tip: number) => void;
}) {
  // null = "Not now" chosen or nothing chosen yet; a number = that percent.
  const [pct, setPct] = useState<number | null>(null);
  const [custom, setCustom] = useState<string>("");
  const [customOpen, setCustomOpen] = useState(false);

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const fromPct = (p: number) => round2((tipBase * p) / 100);
  const customValue = round2(Math.max(0, Number(custom) || 0));
  const tip = customOpen ? customValue : pct == null ? 0 : fromPct(pct);

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 sm:items-center">
      <div className="w-full rounded-t-2xl bg-white p-5 shadow-2xl sm:max-w-md sm:rounded-2xl">
        <h2 className="text-xl font-bold leading-tight text-zinc-900">
          Add a tip for {brandName}?
        </h2>
        <p className="mt-2 text-[14px] leading-relaxed text-zinc-500">
          100% of your tip goes to the kitchen. It&rsquo;s optional — your order
          is exactly the same either way.
        </p>

        <div className="mt-5 grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => {
              setPct(null);
              setCustomOpen(false);
            }}
            className={`rounded-xl border px-3 py-3 text-center transition ${
              !customOpen && pct == null
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-200 bg-white text-zinc-900"
            }`}
          >
            <span className="block text-[14px] font-semibold">Not now</span>
          </button>

          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                setPct(p);
                setCustomOpen(false);
              }}
              className={`rounded-xl border px-3 py-3 text-center transition ${
                !customOpen && pct === p
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 bg-white text-zinc-900"
              }`}
            >
              <span className="block text-[15px] font-bold">{p}%</span>
              <span
                className={`block text-[12px] tabular-nums ${
                  !customOpen && pct === p ? "text-white/70" : "text-zinc-500"
                }`}
              >
                {money(fromPct(p))}
              </span>
            </button>
          ))}

          <button
            type="button"
            onClick={() => setCustomOpen(true)}
            className={`rounded-xl border px-3 py-3 text-center transition ${
              customOpen
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-200 bg-white text-zinc-900"
            }`}
          >
            <span className="block text-[14px] font-semibold">Other</span>
          </button>
        </div>

        {customOpen && (
          <label className="mt-3 block">
            <span className="text-[12px] font-medium text-zinc-500">
              Tip amount
            </span>
            <div className="mt-1 flex items-center gap-2 rounded-xl border border-zinc-300 px-3 py-2.5">
              <span className="text-[15px] text-zinc-500">{symbol}</span>
              <input
                autoFocus
                inputMode="decimal"
                value={custom}
                onChange={(e) =>
                  setCustom(e.target.value.replace(/[^0-9.]/g, ""))
                }
                placeholder="0.00"
                className="w-full bg-transparent text-[15px] outline-none"
              />
            </div>
          </label>
        )}

        <button
          type="button"
          onClick={() => onContinue(tip)}
          className="mt-5 w-full rounded-xl bg-zinc-900 px-4 py-3.5 text-[15px] font-semibold text-white active:opacity-90"
        >
          {tip > 0 ? `Continue with ${money(tip)} tip` : "Continue"}
        </button>
        <button
          type="button"
          onClick={onBack}
          className="mt-2 w-full rounded-xl px-4 py-3 text-[15px] font-semibold text-zinc-700 active:bg-zinc-100"
        >
          Back to order
        </button>
      </div>
    </div>
  );
}
