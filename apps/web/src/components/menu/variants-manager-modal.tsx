"use client";

// Phase AZ — pricing variants manager (brand → channels). For a shared
// HubRise catalog serving multiple brands, each variant is a brand×channel
// leaf ("Monster Burgerz — Uber Eats"). The brand tag is what lets HubRise
// (and our publisher's restrictions) keep each brand's products + prices
// apart. Operator: add a brand, then the channels it sells on; set the
// actual prices from each product's "Channel pricing" button.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Plus, Trash2, Sparkles, Store } from "lucide-react";
import {
  CHANNEL_VARIANT_PRESETS,
  brandChannelRef,
  slugifyChannelKey,
  type PricingVariant,
} from "@orderhub/shared";
import { Button } from "@/components/ui/button";
import { brandsClient, menusClient } from "@/lib/api/menus.client";

interface Props {
  open: boolean;
  menuId: string;
  variants: PricingVariant[];
  /**
   * Brands tagged on THIS menu's products. Variants for any other brand are
   * hidden: a tenant accumulates them across every menu, and a list of four
   * brands' worth of channels — most with no product here to price — buries
   * the two that matter.
   */
  brandIds?: string[];
  onClose: () => void;
}

interface BrandGroup {
  brandId: string;
  brandName: string;
}

export function VariantsManagerModal({
  open,
  menuId,
  variants,
  brandIds,
  onClose,
}: Props) {
  const qc = useQueryClient();
  const [leaves, setLeaves] = useState<PricingVariant[]>([]);
  const [groups, setGroups] = useState<BrandGroup[]>([]);
  const [addBrandId, setAddBrandId] = useState("");
  // Free-text custom channel name being typed, per brand (Careem, Talabat,
  // WhatsApp, Online ordering, POS, ...) — not limited to the 3 presets.
  const [customChannel, setCustomChannel] = useState<Record<string, string>>({});

  const { data: brands = [] } = useQuery({
    queryKey: ["brands"],
    queryFn: () => brandsClient.list(),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    // Only this menu's brands. Leaves for other brands stay in `variants` and
    // are merged back on save — hiding them must not delete them.
    const inScope = (id?: string) =>
      !brandIds?.length || (id ? brandIds.includes(id) : false);
    const ls = (variants ?? []).filter((v) => inScope(v.brandId));
    setLeaves(ls);
    // Seed brand groups from the brands that already have leaves. The name
    // comes from the brand list — a variant carries no brandName, so this
    // used to fall back to the raw cuid and every group header read as
    // "cmpu3txr400092kdnh8vagd45".
    const seen = new Map<string, string>();
    for (const v of ls) {
      if (!v.brandId) continue;
      seen.set(
        v.brandId,
        brands.find((b: any) => b.id === v.brandId)?.name ??
          (v as any).brandName ??
          v.brandId,
      );
    }
    setGroups(Array.from(seen, ([brandId, brandName]) => ({ brandId, brandName })));
  }, [open, variants, brands, brandIds]);

  const save = useMutation({
    mutationFn: () => {
      // Variants for brands NOT on this menu are hidden above, so they aren't
      // in `leaves`. Saving `leaves` alone would delete them — another menu's
      // channel prices, silently wiped by opening this modal and pressing
      // Save. Merge them back untouched.
      const shownRefs = new Set(leaves.map((l) => l.ref));
      const hidden = (variants ?? []).filter((v) => !shownRefs.has(v.ref));
      return menusClient.updateMenu(menuId, {
        pricingVariants: [...hidden, ...leaves]
          .filter((v) => v.ref && v.name.trim())
          .map((v) => ({
            ref: v.ref,
            name: v.name.trim(),
            ...(v.channelKey ? { channelKey: v.channelKey } : {}),
            ...(v.brandId ? { brandId: v.brandId } : {}),
            ...(v.brandName ? { brandName: v.brandName } : {}),
          })),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["menu", menuId] });
      qc.invalidateQueries({ queryKey: ["menus"] });
      onClose();
    },
  });

  if (!open) return null;

  const groupedBrandIds = new Set(groups.map((g) => g.brandId));
  const addableBrands = brands.filter((b) => !groupedBrandIds.has(b.id));

  const addBrand = () => {
    const b = brands.find((x) => x.id === addBrandId);
    if (!b) return;
    setGroups([...groups, { brandId: b.id, brandName: b.name }]);
    setAddBrandId("");
  };

  const removeBrand = (brandId: string) => {
    setGroups(groups.filter((g) => g.brandId !== brandId));
    setLeaves(leaves.filter((l) => l.brandId !== brandId));
  };

  const addChannel = (g: BrandGroup, channelKey: string, name: string) => {
    const ref = brandChannelRef(g.brandId, channelKey);
    if (leaves.some((l) => l.ref === ref)) return;
    setLeaves([
      ...leaves,
      {
        ref,
        name: `${g.brandName} — ${name}`,
        channelKey,
        brandId: g.brandId,
        brandName: g.brandName,
      },
    ]);
  };

  const removeLeaf = (ref: string) =>
    setLeaves(leaves.filter((l) => l.ref !== ref));

  const addCustomChannel = (g: BrandGroup) => {
    const name = (customChannel[g.brandId] ?? "").trim();
    const channelKey = slugifyChannelKey(name);
    if (!name || !channelKey) return;
    if (leaves.some((l) => l.brandId === g.brandId && l.channelKey === channelKey)) {
      setCustomChannel({ ...customChannel, [g.brandId]: "" });
      return;
    }
    addChannel(g, channelKey, name);
    setCustomChannel({ ...customChannel, [g.brandId]: "" });
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
                One menu, a price per brand and channel.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {groups.length === 0 ? (
            <p className="rounded-md border border-dashed border-zinc-200 bg-zinc-50 px-3 py-6 text-center text-xs text-zinc-500">
              No brands added yet. Add a brand below, then the channels it sells
              on.
            </p>
          ) : (
            <div className="space-y-3">
              {groups.map((g) => {
                const brandLeaves = leaves.filter((l) => l.brandId === g.brandId);
                const usedChannels = new Set(
                  brandLeaves.map((l) => l.channelKey),
                );
                const addableChannels = CHANNEL_VARIANT_PRESETS.filter(
                  (c) => !usedChannels.has(c.channelKey),
                );
                return (
                  <div
                    key={g.brandId}
                    className="rounded-lg border border-zinc-200 bg-white"
                  >
                    <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
                      <span className="flex items-center gap-1.5 text-sm font-semibold text-zinc-800">
                        <Store className="h-3.5 w-3.5 text-zinc-400" />
                        {g.brandName}
                      </span>
                      <button
                        onClick={() => removeBrand(g.brandId)}
                        className="text-zinc-300 hover:text-red-600"
                        aria-label="Remove brand"
                        title="Remove brand + its channels"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="space-y-1.5 p-2.5">
                      {brandLeaves.length === 0 && (
                        <p className="px-1 text-[11px] text-zinc-400">
                          Add the channels this brand sells on.
                        </p>
                      )}
                      {brandLeaves.map((l) => (
                        <div
                          key={l.ref}
                          className="flex items-center gap-2 rounded-md bg-zinc-50 px-2.5 py-1.5"
                        >
                          <span className="flex-1 text-sm text-zinc-700">
                            {l.name}
                          </span>
                          <button
                            onClick={() => removeLeaf(l.ref)}
                            className="text-zinc-300 hover:text-red-600"
                            aria-label="Remove channel"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                      {addableChannels.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {addableChannels.map((c) => (
                            <button
                              key={c.channelKey}
                              onClick={() => addChannel(g, c.channelKey, c.name)}
                              className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:border-violet-300 hover:bg-violet-50"
                            >
                              <Plus className="h-3 w-3" /> {c.name}
                            </button>
                          ))}
                        </div>
                      )}
                      {/* Any other channel — Careem, Talabat, WhatsApp,
                          Online ordering, POS, etc. Not limited to presets. */}
                      <div className="flex items-center gap-1.5 pt-1">
                        <input
                          value={customChannel[g.brandId] ?? ""}
                          onChange={(e) =>
                            setCustomChannel({ ...customChannel, [g.brandId]: e.target.value })
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              addCustomChannel(g);
                            }
                          }}
                          placeholder="Other channel (Careem, Talabat, WhatsApp…)"
                          className="h-7 flex-1 rounded-full border border-dashed border-zinc-200 bg-white px-3 text-xs focus:border-violet-400 focus:outline-none"
                        />
                        <button
                          onClick={() => addCustomChannel(g)}
                          disabled={!(customChannel[g.brandId] ?? "").trim()}
                          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:border-violet-300 hover:bg-violet-50 disabled:opacity-40"
                        >
                          <Plus className="h-3 w-3" /> Add
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Add brand */}
          <div className="flex gap-2 border-t border-zinc-100 pt-3">
            <select
              value={addBrandId}
              onChange={(e) => setAddBrandId(e.target.value)}
              className="h-9 flex-1 rounded-md border border-zinc-200 bg-white px-3 text-sm"
            >
              <option value="">Add a brand…</option>
              {addableBrands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              onClick={addBrand}
              disabled={!addBrandId}
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> Add brand
            </Button>
          </div>

          <p className="rounded-md bg-zinc-50 px-3 py-2 text-[11px] text-zinc-500">
            On HubRise publish each brand×channel becomes a catalog variant,
            and every product is restricted to its brand's variants — so Brand
            A's Uber connector only sees Brand A's items at Brand A's price.
            Tag each product's brand on the product form for the scoping to work.
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
