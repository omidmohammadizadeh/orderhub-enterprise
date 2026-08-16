"use client";

// Channel pricing — one percentage per channel, applied to a whole menu.
//
// A marketplace takes commission, so the same dish has to list higher there
// than on the operator's own site. The per-product Channel pricing modal can
// already express that, but only one product at a time — unusable across a
// 600-product menu, which is why menus get imported FROM a marketplace with
// the uplift baked into their base prices instead. That hides the markup in
// the numbers, where nobody can see it or take it back out.
//
// This sets the same thing in bulk and stores it the same way: a per-channel
// OVERRIDE, never folded into the base price. Base stays true for POS and the
// operator's own site; the markup stays visible and reversible.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Percent, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import {
  CHANNEL_VARIANT_PRESETS,
  slugifyChannelKey,
} from "@orderhub/shared";
import { Button } from "@/components/ui/button";
import { menusClient } from "@/lib/api/menus.client";

/** The uplifts an operator actually uses. 0 = list at the base price. */
const PERCENT_CHOICES = [0, 10, 15, 20, 25, 30] as const;

interface Props {
  open: boolean;
  menuId: string;
  /** Shown in the header — this is a menu-level setting, so name the menu. */
  menuName: string;
  /**
   * The menu's own brand. Not a choice the operator makes: channel prices are
   * stored against brand×channel refs (the same ones the per-product modal and
   * every publisher already use), so the brand is a consequence of which menu
   * you opened, not a decision.
   */
  brandId: string;
  onClose: () => void;
}

export function ChannelPricingModal({
  open,
  menuId,
  menuName,
  brandId,
  onClose,
}: Props) {
  const qc = useQueryClient();
  // channelKey → { display name, uplift % }. A channel absent from this map is
  // simply not sold on, and is left completely alone. The name is carried
  // because a custom channel has no preset to look it up in.
  const [picked, setPicked] = useState<
    Record<string, { name: string; percent: number }>
  >({});
  const [customName, setCustomName] = useState("");

  const apply = useMutation({
    mutationFn: () =>
      menusClient.applyChannelPricing(menuId, {
        brandId,
        channels: Object.entries(picked).map(([channelKey, v]) => ({
          channelKey,
          name: v.name,
          percent: v.percent,
        })),
      }),
    onSuccess: (r: any) => {
      toast.success(
        `Applied to ${r.itemsUpdated} products` +
          (r.skusUpdated ? `, ${r.skusUpdated} sizes` : "") +
          (r.optionsUpdated ? `, ${r.optionsUpdated} options` : ""),
      );
      qc.invalidateQueries({ queryKey: ["menu", menuId] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.message ?? "Could not apply channel pricing"),
  });

  if (!open) return null;

  const toggle = (key: string, name: string) =>
    setPicked((p) => {
      const next = { ...p };
      if (key in next) delete next[key];
      // 20% is roughly what the marketplaces actually charge, so it's the
      // least surprising starting point.
      else next[key] = { name, percent: 20 };
      return next;
    });

  const addCustom = () => {
    const name = customName.trim();
    const key = slugifyChannelKey(name);
    // slugify strips everything non-alphanumeric, so a name of only symbols
    // yields an empty key — refuse rather than write a variant nothing can
    // ever be matched against.
    if (!name || !key) return;
    setPicked((p) => ({ ...p, [key]: { name, percent: 20 } }));
    setCustomName("");
  };

  const chosen = Object.keys(picked);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-zinc-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              Channels pricing — {menuName}
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Set one uplift per channel and it applies to every product, size
              and option in this menu. Your base prices are not changed.
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-zinc-100">
            <X className="h-4 w-4 text-zinc-500" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Channels
            </label>
            <p className="mt-1 text-xs text-zinc-500">
              Pick the channels this brand sells on. Anything you don&apos;t
              pick is left exactly as it is.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {CHANNEL_VARIANT_PRESETS.map((p) => (
                <button
                  key={p.channelKey}
                  onClick={() => toggle(p.channelKey, p.name)}
                  className={`rounded-lg border px-3 py-1.5 text-sm ${
                    p.channelKey in picked
                      ? "border-orange-500 bg-orange-50 text-orange-800"
                      : "border-zinc-200 text-zinc-700 hover:border-zinc-300"
                  }`}
                >
                  {p.channelKey in picked ? "✓ " : "+ "}
                  {p.name}
                </button>
              ))}
            </div>
            {/* Anything beyond the presets — Careem, Talabat, a new
                marketplace next year. Same free-text pattern the per-product
                modal already uses, and the same slugified key, so a channel
                added in either place is the same channel. */}
            <div className="mt-2 flex gap-2">
              <input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
                placeholder="Other channel (Careem, Talabat, Just Eat Pay…)"
                className="flex-1 rounded-lg border border-dashed border-zinc-300 px-3 py-1.5 text-sm placeholder:text-zinc-400 focus:border-zinc-900 focus:outline-none"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={addCustom}
                disabled={!customName.trim()}
              >
                + Add
              </Button>
            </div>
          </div>

          {chosen.length > 0 && (
            <div className="space-y-3 rounded-xl border border-zinc-200 p-4">
              {chosen.map((key) => {
                return (
                  <div key={key} className="flex items-center justify-between gap-4">
                    <button
                      onClick={() => toggle(key, picked[key]!.name)}
                      title="Remove this channel"
                      className="text-sm font-medium text-zinc-900 hover:text-zinc-500"
                    >
                      {picked[key]!.name} <span className="text-zinc-300">×</span>
                    </button>
                    <div className="flex flex-wrap gap-1.5">
                      {PERCENT_CHOICES.map((pct) => (
                        <button
                          key={pct}
                          onClick={() =>
                            setPicked((p) => ({
                              ...p,
                              [key]: { ...p[key]!, percent: pct },
                            }))
                          }
                          className={`min-w-[3.25rem] rounded-lg border px-2 py-1 text-xs font-medium ${
                            picked[key]?.percent === pct
                              ? "border-zinc-900 bg-zinc-900 text-white"
                              : "border-zinc-200 text-zinc-700 hover:border-zinc-300"
                          }`}
                        >
                          {pct === 0 ? "Same" : `+${pct}%`}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
              <p className="border-t border-zinc-100 pt-3 text-[11px] leading-relaxed text-zinc-500">
                <strong>Same</strong> means this channel lists at your base
                price and clears any uplift already set — not that it freezes
                at today&apos;s number. Example: a £10.00 dish at +20% lists at
                £12.00 on that channel while POS and your own site keep
                charging £10.00.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-zinc-200 bg-zinc-50 px-6 py-4">
          <span className="text-xs text-zinc-500">
            {chosen.length === 0
              ? "Pick at least one channel"
              : `${chosen.length} channel${chosen.length === 1 ? "" : "s"} — applies to every product in this menu`}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={chosen.length === 0 || !brandId || apply.isPending}
              onClick={() => apply.mutate()}
              className="gap-1.5 bg-zinc-900 text-white hover:bg-zinc-800"
            >
              {apply.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Percent className="h-4 w-4" />
              )}
              Apply to menu
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
