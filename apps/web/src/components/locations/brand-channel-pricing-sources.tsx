"use client";

// Phase BF — per-channel pricing source, set once per brand.
//
// Mirrors how HubRise already resolves per-brand pricing in one shared
// catalog: a named pricing variant is already tagged with its own brandId
// + channelKey, so once a "source menu" is picked for a channel here, the
// correct variant is found automatically on every future publish — no
// re-picking a menu+variant each time you publish, and no separate variant
// dropdown (the channel IS the channelKey).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import toast from "react-hot-toast";
import { brandsClient } from "@/lib/api/locations.client";
import { menusClient } from "@/lib/api/menus.client";

const CHANNEL_LABELS: Record<string, string> = {
  ONLINE: "Online ordering",
  WHATSAPP: "WhatsApp",
  JUST_EAT: "Just Eat",
  UBER_EATS: "Uber Eats",
  DELIVEROO: "Deliveroo",
};

interface Props {
  brandId: string;
  locationId: string;
}

export function BrandChannelPricingSources({ brandId, locationId }: Props) {
  const qc = useQueryClient();
  const sourcesQuery = useQuery({
    queryKey: ["brand-channel-sources", brandId],
    queryFn: () => brandsClient.getChannelSources(brandId),
  });
  const menusQuery = useQuery({
    queryKey: ["menus", "location", locationId, "channel-sources"],
    queryFn: () => menusClient.listMenusForLocation(locationId),
  });

  const [savingChannel, setSavingChannel] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: ({ channel, sourceMenuId }: { channel: string; sourceMenuId: string | null }) => {
      setSavingChannel(channel);
      return brandsClient.setChannelSource(brandId, channel, sourceMenuId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brand-channel-sources", brandId] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? e?.message ?? "Couldn't save"),
    onSettled: () => setSavingChannel(null),
  });

  const sources = sourcesQuery.data ?? [];
  const menus = menusQuery.data ?? [];

  return (
    <div className="mt-4 rounded-lg border border-dashed border-violet-200 bg-violet-50/40 p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 text-violet-600" />
        <h3 className="text-xs font-semibold text-zinc-800">
          Channel pricing sources
        </h3>
      </div>
      <p className="mb-2.5 text-[10px] text-zinc-500">
        Pick a menu for each channel and this brand's prices always come
        from that menu's matching variant — set once, applies to every
        future publish, no need to re-pick it.
      </p>
      {sourcesQuery.isLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
        </div>
      ) : (
        <div className="space-y-1.5">
          {sources.map((s) => (
            <div key={s.channel} className="flex items-center gap-2">
              <span className="w-28 flex-shrink-0 text-[11px] font-medium text-zinc-700">
                {CHANNEL_LABELS[s.channel] ?? s.channel}
              </span>
              <select
                value={s.sourceMenuId ?? ""}
                disabled={savingChannel === s.channel || menusQuery.isLoading}
                onChange={(e) =>
                  save.mutate({
                    channel: s.channel,
                    sourceMenuId: e.target.value || null,
                  })
                }
                className="h-7 flex-1 rounded-md border border-zinc-300 bg-white px-2 text-[11px] focus:border-violet-400 focus:outline-none disabled:opacity-50"
              >
                <option value="">
                  Default pricing (this brand's own menu)
                </option>
                {menus.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {savingChannel === s.channel && (
                <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-violet-500" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
