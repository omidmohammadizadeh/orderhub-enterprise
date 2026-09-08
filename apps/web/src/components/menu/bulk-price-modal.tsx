"use client";

// Bulk base price — move every price in a menu by one percentage.
//
// The destructive twin of Channels pricing. That modal writes per-channel
// OVERRIDES and leaves the base alone; this one rewrites the base prices
// themselves, for the day a shop puts the whole menu up 5% or runs a 10%-off
// week. There is no undo, and rounding to the penny means -10% then +10% does
// not land back where it started — so this is admin-only, it shows the
// operator real before/after numbers from their own menu, and it will not fire
// until they confirm on a second screen.

import { useMemo, useState } from "react";
import { useCurrency } from "@/hooks/use-currency";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Loader2, AlertTriangle, ArrowRight } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { menusClient } from "@/lib/api/menus.client";

/**
 * Minus reduces, plus raises. No 0 — "change nothing" is the Cancel button,
 * and unlike channel pricing a 0 here has no second meaning to express.
 */
const PERCENT_CHOICES = [-20, -15, -10, -5, 5, 10, 15, 20] as const;

/** What the preview needs off a product. */
export interface BulkPricePreviewItem {
  id: string;
  name: string;
  basePrice: number;
}

interface Props {
  open: boolean;
  menuId: string;
  menuName: string;
  /**
   * A handful of the menu's actual products, used for the before/after
   * preview. Real prices from the menu in front of them beat any worked
   * example: rounding is where a bulk change surprises people.
   */
  preview: BulkPricePreviewItem[];
  /** Total products in the menu — the number that is about to change. */
  totalItems: number;
  onClose: () => void;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function BulkPriceModal({
  open,
  menuId,
  menuName,
  preview,
  totalItems,
  onClose,
}: Props) {
  const { money } = useCurrency();
  const qc = useQueryClient();
  const [percent, setPercent] = useState<number | null>(null);
  const [includeModifiers, setIncludeModifiers] = useState(false);
  // Second screen. Reset whenever the percentage changes so a confirmed
  // number can never be applied after the operator picked a different one.
  const [confirming, setConfirming] = useState(false);

  const apply = useMutation({
    mutationFn: () =>
      menusClient.applyBulkBasePrice(menuId, {
        percent: percent!,
        includeModifiers,
      }),
    onSuccess: (r) => {
      toast.success(
        `${r.percent > 0 ? "+" : ""}${r.percent}% applied to ${r.itemsUpdated} products` +
          (r.skusUpdated ? `, ${r.skusUpdated} sizes` : "") +
          (r.optionsUpdated ? `, ${r.optionsUpdated} options` : ""),
      );
      qc.invalidateQueries({ queryKey: ["menu", menuId] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.message ?? "Could not change the base prices"),
  });

  const rows = useMemo(
    () =>
      preview.slice(0, 5).map((p) => ({
        ...p,
        next:
          percent === null
            ? p.basePrice
            : Math.max(0, round2(p.basePrice * (1 + percent / 100))),
      })),
    [preview, percent],
  );

  if (!open) return null;

  const pick = (pct: number) => {
    setPercent(pct);
    setConfirming(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-zinc-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              Bulk price change — {menuName}
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Moves the <strong>base price</strong> of every product and size in
              this menu by one percentage. This is the price POS, your own site
              and every channel without an uplift all charge.
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-zinc-100">
            <X className="h-4 w-4 text-zinc-500" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Change by
            </label>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PERCENT_CHOICES.map((pct) => (
                <button
                  key={pct}
                  onClick={() => pick(pct)}
                  className={`min-w-[3.75rem] rounded-lg border px-2.5 py-1.5 text-sm font-medium ${
                    percent === pct
                      ? pct < 0
                        ? "border-red-600 bg-red-600 text-white"
                        : "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 text-zinc-700 hover:border-zinc-300"
                  }`}
                >
                  {pct > 0 ? `+${pct}%` : `${pct}%`}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              A minus reduces every price; a plus raises it. Prices are rounded
              to the nearest penny.
            </p>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-zinc-200 p-4">
            <input
              type="checkbox"
              checked={includeModifiers}
              onChange={(e) => {
                setIncludeModifiers(e.target.checked);
                setConfirming(false);
              }}
              className="mt-0.5 h-4 w-4 accent-zinc-900"
            />
            <span className="text-sm text-zinc-700">
              Also change toppings and extras
              <span className="mt-0.5 block text-xs text-zinc-500">
                Off by default — 5% of a 50p topping is 2p, and most extras are
                priced on a round number worth leaving alone. Free options stay
                free either way.
              </span>
            </span>
          </label>

          {percent !== null && rows.length > 0 && (
            <div className="rounded-xl border border-zinc-200">
              <div className="border-b border-zinc-100 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Before → after
              </div>
              <div className="divide-y divide-zinc-100">
                {rows.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm"
                  >
                    <span className="truncate text-zinc-700">{r.name}</span>
                    <span className="flex shrink-0 items-center gap-2 tabular-nums">
                      <span className="text-zinc-400 line-through">
                        {money(r.basePrice)}
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 text-zinc-300" />
                      <span className="font-semibold text-zinc-900">
                        {money(r.next)}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
              {preview.length > rows.length && (
                <p className="px-4 py-2.5 text-[11px] text-zinc-500">
                  …and {totalItems - rows.length} more product
                  {totalItems - rows.length === 1 ? "" : "s"} in this menu.
                </p>
              )}
            </div>
          )}

          {percent !== null && (
            <div className="flex gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs leading-relaxed text-amber-900">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
              <div>
                <strong>This cannot be undone.</strong> The old prices are
                overwritten, and because everything rounds to the penny,
                applying the opposite percentage afterwards will not restore
                them exactly. Any channel uplift you have set moves by the same
                percentage, so a +20% Uber price stays +20% of the new base.
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-zinc-200 bg-zinc-50 px-6 py-4">
          <span className="text-xs text-zinc-500">
            {percent === null
              ? "Pick a percentage"
              : `${percent > 0 ? "+" : ""}${percent}% on ${totalItems} product${
                  totalItems === 1 ? "" : "s"
                }${includeModifiers ? " + extras" : ""}`}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={confirming ? () => setConfirming(false) : onClose}
            >
              {confirming ? "Back" : "Cancel"}
            </Button>
            <Button
              size="sm"
              disabled={percent === null || apply.isPending}
              onClick={() =>
                confirming ? apply.mutate() : setConfirming(true)
              }
              className={`gap-1.5 text-white ${
                confirming
                  ? "bg-red-600 hover:bg-red-700"
                  : "bg-zinc-900 hover:bg-zinc-800"
              }`}
            >
              {apply.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {confirming
                ? `Yes — change ${totalItems} price${totalItems === 1 ? "" : "s"}`
                : "Change prices"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
