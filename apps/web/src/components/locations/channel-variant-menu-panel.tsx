"use client";

// Phase BF — "Variant menu" picker for one channel. Tick it, pick a menu,
// pick one of that menu's named pricing variants (e.g. "monster burgerz —
// Deliveroo"), save. From then on this channel publishes ONLY that
// variant's own brand's items, priced from that variant — everything else
// is left out entirely, the same restriction HubRise's shared catalog
// already applies per brand. No re-picking on future publishes.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import toast from "react-hot-toast";
import { brandsClient } from "@/lib/api/locations.client";
import { menusClient } from "@/lib/api/menus.client";

interface Props {
  brandId: string;
  locationId: string;
  channel: string;
  /** Compact = inline row (used in the general Channels panel); full =
   *  bigger layout for a dedicated Manage-modal tab. */
  variant?: "compact" | "full";
}

export function ChannelVariantMenuPanel({
  brandId,
  locationId,
  channel,
  variant = "full",
}: Props) {
  const qc = useQueryClient();
  const sourcesQuery = useQuery({
    queryKey: ["brand-channel-sources", brandId],
    queryFn: () => brandsClient.getChannelSources(brandId),
  });
  const current = sourcesQuery.data?.find((s) => s.channel === channel);

  const menusQuery = useQuery({
    queryKey: ["menus", "location", locationId, "channel-sources"],
    queryFn: () => menusClient.listMenusForLocation(locationId),
  });
  const menus = menusQuery.data ?? [];

  const [enabled, setEnabled] = useState(false);
  const [sourceMenuId, setSourceMenuId] = useState("");
  const [variantRef, setVariantRef] = useState("");

  // Seed local state from the saved config whenever it (re)loads.
  useEffect(() => {
    if (!current) return;
    setEnabled(!!(current.sourceMenuId && current.variantRef));
    setSourceMenuId(current.sourceMenuId ?? "");
    setVariantRef(current.variantRef ?? "");
  }, [current]);

  const sourceMenuQuery = useQuery({
    queryKey: ["menu", sourceMenuId, "variants-only"],
    queryFn: () => menusClient.getMenu(sourceMenuId),
    enabled: !!sourceMenuId,
  });
  const variants = sourceMenuQuery.data?.pricingVariants ?? [];

  const save = useMutation({
    mutationFn: () =>
      brandsClient.setChannelSource(
        brandId,
        channel,
        enabled ? sourceMenuId || null : null,
        enabled ? variantRef || null : null,
      ),
    onSuccess: () => {
      toast.success(enabled ? "Variant menu saved" : "Variant menu cleared");
      qc.invalidateQueries({ queryKey: ["brand-channel-sources", brandId] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? e?.message ?? "Couldn't save"),
  });

  const dirty =
    !!current &&
    (enabled !== !!(current.sourceMenuId && current.variantRef) ||
      sourceMenuId !== (current.sourceMenuId ?? "") ||
      variantRef !== (current.variantRef ?? ""));
  const canSave = !enabled || (!!sourceMenuId && !!variantRef);

  if (sourcesQuery.isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
      </div>
    );
  }

  const compact = variant === "compact";

  return (
    <div
      className={
        compact
          ? "rounded-lg border border-dashed border-violet-200 bg-violet-50/40 p-2.5"
          : "rounded-xl border border-violet-200 bg-violet-50/40 p-4"
      }
    >
      <label className="flex items-center gap-2 text-xs font-semibold text-zinc-800">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-zinc-300 text-violet-600 focus:ring-violet-500"
        />
        <Sparkles className="h-3.5 w-3.5 text-violet-500" />
        Variant menu
      </label>
      <p className="mt-1 text-[10px] text-zinc-500">
        Pick a menu and one of its variants — this channel will publish
        ONLY that variant's brand's items, priced from that variant.
      </p>

      {enabled && (
        <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
          <select
            value={sourceMenuId}
            disabled={menusQuery.isLoading}
            onChange={(e) => {
              setSourceMenuId(e.target.value);
              setVariantRef("");
            }}
            className="h-8 rounded-md border border-zinc-300 bg-white px-2 text-xs focus:border-violet-400 focus:outline-none disabled:opacity-50"
          >
            <option value="">
              {menusQuery.isLoading ? "Loading menus…" : "Pick a menu…"}
            </option>
            {menus.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <select
            value={variantRef}
            disabled={!sourceMenuId || sourceMenuQuery.isLoading}
            onChange={(e) => setVariantRef(e.target.value)}
            className="h-8 rounded-md border border-zinc-300 bg-white px-2 text-xs focus:border-violet-400 focus:outline-none disabled:opacity-50"
          >
            <option value="">
              {sourceMenuQuery.isLoading ? "Loading variants…" : "Pick a variant…"}
            </option>
            {variants.map((v) => (
              <option key={v.ref} value={v.ref}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {(dirty || (enabled && !current?.sourceMenuId)) && (
        <div className="mt-2.5 flex items-center gap-2">
          <button
            onClick={() => save.mutate()}
            disabled={!canSave || save.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {save.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            Save
          </button>
          {enabled && sourceMenuId && !variantRef && (
            <span className="text-[10px] text-amber-700">
              Pick a variant to enable this.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
