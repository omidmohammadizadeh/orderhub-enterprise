"use client";

// Phase AZ — pricing variants manager. Define the named price lists for a
// menu (channel presets like Uber Eats / Deliveroo + custom ones such as
// "Kiosk" or "Brand A"). Each item, size and modifier can then carry a
// per-variant price; on HubRise publish these become catalog variants +
// price_overrides. One menu, every channel/brand its own price.

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Plus, Trash2, Sparkles } from "lucide-react";
import {
  CHANNEL_VARIANT_PRESETS,
  type PricingVariant,
} from "@orderhub/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { menusClient } from "@/lib/api/menus.client";

interface Props {
  open: boolean;
  menuId: string;
  variants: PricingVariant[];
  onClose: () => void;
}

function customRef(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  return `var_${slug || "x"}_${Date.now().toString(36).slice(-4)}`;
}

export function VariantsManagerModal({ open, menuId, variants, onClose }: Props) {
  const qc = useQueryClient();
  const [list, setList] = useState<PricingVariant[]>([]);
  const [customName, setCustomName] = useState("");

  useEffect(() => {
    if (open) setList(variants ?? []);
  }, [open, variants]);

  const save = useMutation({
    mutationFn: () =>
      menusClient.updateMenu(menuId, {
        pricingVariants: list
          .filter((v) => v.ref && v.name.trim())
          .map((v) => ({
            ref: v.ref,
            name: v.name.trim(),
            ...(v.channelKey ? { channelKey: v.channelKey } : {}),
          })),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["menu", menuId] });
      qc.invalidateQueries({ queryKey: ["menus"] });
      onClose();
    },
  });

  if (!open) return null;

  const usedRefs = new Set(list.map((v) => v.ref));
  const availablePresets = CHANNEL_VARIANT_PRESETS.filter(
    (p) => !usedRefs.has(p.ref),
  );

  const addPreset = (p: (typeof CHANNEL_VARIANT_PRESETS)[number]) =>
    setList([...list, { ref: p.ref, name: p.name, channelKey: p.channelKey }]);

  const addCustom = () => {
    const name = customName.trim();
    if (!name) return;
    setList([...list, { ref: customRef(name), name }]);
    setCustomName("");
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="my-8 w-full max-w-xl rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 p-5">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-violet-100 text-violet-700">
              <Sparkles className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-base font-semibold text-zinc-900">
                Pricing variants
              </h2>
              <p className="text-[11px] text-zinc-500">
                One menu, a different price per channel or brand.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {/* Current variants */}
          {list.length === 0 ? (
            <p className="rounded-md border border-dashed border-zinc-200 bg-zinc-50 px-3 py-6 text-center text-xs text-zinc-500">
              No variants yet. Add a channel preset or a custom variant below.
            </p>
          ) : (
            <ul className="space-y-2">
              {list.map((v, i) => (
                <li
                  key={v.ref}
                  className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white p-2"
                >
                  <Input
                    value={v.name}
                    onChange={(e) =>
                      setList(
                        list.map((row, idx) =>
                          idx === i ? { ...row, name: e.target.value } : row,
                        ),
                      )
                    }
                    className="h-8 flex-1 text-sm"
                  />
                  {v.channelKey ? (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] font-bold uppercase text-emerald-700">
                      Channel
                    </span>
                  ) : (
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[9px] font-bold uppercase text-zinc-500">
                      Custom
                    </span>
                  )}
                  <code className="max-w-[120px] truncate font-mono text-[10px] text-zinc-400">
                    {v.ref}
                  </code>
                  <button
                    onClick={() => setList(list.filter((_, idx) => idx !== i))}
                    className="text-zinc-300 hover:text-red-600"
                    aria-label="Remove variant"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Add presets */}
          {availablePresets.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {availablePresets.map((p) => (
                <button
                  key={p.ref}
                  onClick={() => addPreset(p)}
                  className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:border-violet-300 hover:bg-violet-50"
                >
                  <Plus className="h-3 w-3" /> {p.name}
                </button>
              ))}
            </div>
          )}

          {/* Add custom */}
          <div className="flex gap-2 border-t border-zinc-100 pt-3">
            <Input
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCustom()}
              placeholder="Custom variant name (e.g. Kiosk, Brand A)"
              className="h-9 flex-1 text-sm"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={addCustom}
              disabled={!customName.trim()}
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> Add
            </Button>
          </div>

          <p className="rounded-md bg-zinc-50 px-3 py-2 text-[11px] text-zinc-500">
            Set the actual prices per item, size and modifier from each
            product's <span className="font-medium">Channel pricing</span>{" "}
            button. On HubRise publish these become catalog variants — choose
            which variant each connection uses in HubRise.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-100 p-4">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {save.isPending ? "Saving…" : "Save variants"}
          </Button>
        </div>
      </div>
    </div>
  );
}
