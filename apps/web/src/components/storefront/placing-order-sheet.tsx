"use client";

// The moment between tapping Place order and the kitchen hearing about it.
//
// The order is NOT created while this is on screen. That's the whole point:
// creating it and cancelling afterwards would fire the kitchen printer and
// flash a ticket on the orders board that then vanishes — worse for the shop
// than having no cancel at all. So the countdown runs client-side and only
// calls checkout when it reaches zero.
//
// Sized in seconds, not minutes: long enough to catch "wrong address" or
// "forgot the drink", short enough that nobody thinks the app has hung.

import { useEffect, useRef, useState } from "react";

const HOLD_SECONDS = 8;

export function PlacingOrderSheet({
  summary,
  onCommit,
  onCancel,
}: {
  /** What they're about to buy — shown so a mistake is catchable here. */
  summary: {
    brandName: string;
    fulfilment: string;
    addressLine?: string | null;
    when?: string | null;
    lines: Array<{ quantity: number; name: string }>;
    total: number;
  };
  /** Fired once the hold expires, or when they tap to skip the wait. */
  onCommit: () => void;
  onCancel: () => void;
}) {
  const [remaining, setRemaining] = useState(HOLD_SECONDS);
  // Guard against the timer and a tap both committing — a double order is the
  // one outcome worse than a slow one.
  const committed = useRef(false);

  const commitOnce = () => {
    if (committed.current) return;
    committed.current = true;
    onCommit();
  };

  useEffect(() => {
    // setInterval, not rAF: this must keep counting if the customer switches
    // apps mid-order, which on a phone they routinely do.
    const id = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(id);
          commitOnce();
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pct = ((HOLD_SECONDS - remaining) / HOLD_SECONDS) * 100;
  const mmss = `00:0${Math.max(0, remaining)}`.slice(-5);

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 sm:items-center">
      <div className="w-full rounded-t-2xl bg-white p-5 shadow-2xl sm:max-w-md sm:rounded-2xl">
        <h2 className="text-xl font-bold text-zinc-900">Placing order…</h2>

        <dl className="mt-4 space-y-3 text-[14px]">
          <div className="border-b border-zinc-100 pb-3">
            <dt className="font-semibold text-zinc-900">{summary.brandName}</dt>
            <dd className="text-zinc-500">{summary.fulfilment}</dd>
            {summary.addressLine && (
              <dd className="text-zinc-500">{summary.addressLine}</dd>
            )}
          </div>
          {summary.when && (
            <div className="border-b border-zinc-100 pb-3 text-zinc-700">
              {summary.when}
            </div>
          )}
          <div className="border-b border-zinc-100 pb-3">
            {summary.lines.slice(0, 4).map((l, i) => (
              <dd key={i} className="flex gap-3 text-zinc-700">
                <span className="tabular-nums text-zinc-400">{l.quantity}x</span>
                <span className="truncate">{l.name}</span>
              </dd>
            ))}
            {summary.lines.length > 4 && (
              <dd className="text-zinc-400">
                + {summary.lines.length - 4} more
              </dd>
            )}
          </div>
          <div className="flex justify-between font-semibold text-zinc-900">
            <dt>Total</dt>
            <dd className="tabular-nums">£{summary.total.toFixed(2)}</dd>
          </div>
        </dl>

        {/* The bar doubles as the confirm button: waiting sends it, and
            tapping sends it now. Nothing here can cancel by accident. */}
        <button
          type="button"
          onClick={commitOnce}
          className="relative mt-5 w-full overflow-hidden rounded-xl bg-zinc-800 px-4 py-3.5 text-[15px] font-semibold text-white"
        >
          <span
            className="absolute inset-y-0 left-0 bg-black transition-[width] duration-1000 ease-linear"
            style={{ width: `${pct}%` }}
            aria-hidden
          />
          <span className="relative">Looks good ({mmss})</span>
        </button>

        <button
          type="button"
          onClick={onCancel}
          className="mt-2 w-full rounded-xl px-4 py-3 text-[15px] font-semibold text-zinc-700 active:bg-zinc-100"
        >
          Go back
        </button>
      </div>
    </div>
  );
}
