"use client";

// Phase AW-16 / AZ — Publish a brand's opening hours + prep time to HubRise.
//
// One step: pick the brand, publish. HubRise is the only channel that needs a
// push (POS + direct online ordering read the hours live, no publish needed),
// so there's no channel picker — clicking "Publish to HubRise" on a brand row
// sends that brand's hours straight through.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { X, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { brandsClient, type Brand } from "@/lib/api/locations.client";
import { PlatformLogo } from "@/components/ui/platform-logo";

interface Props {
  open: boolean;
  locationId?: string;
  onClose: () => void;
}

export function PublishHoursModal({ open, locationId, onClose }: Props) {
  const [publishingId, setPublishingId] = useState<string | null>(null);

  const brandsQuery = useQuery({
    queryKey: ["brands", locationId ?? "tenant"],
    queryFn: () => brandsClient.list(locationId),
    enabled: open,
  });
  const brands = brandsQuery.data ?? [];

  const publish = useMutation({
    mutationFn: (brandId: string) => brandsClient.publishHours(brandId, "HUBRISE"),
    onMutate: (brandId) => setPublishingId(brandId),
    onSuccess: (_res, brandId) => {
      const name = brands.find((b: Brand) => b.id === brandId)?.name ?? "brand";
      toast.success(`Published ${name} hours to HubRise`);
    },
    onError: (err: any) =>
      toast.error(
        `Failed: ${err?.response?.data?.message ?? err?.message ?? "Unknown error"}`,
      ),
    onSettled: () => setPublishingId(null),
  });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-xl max-h-[88vh] flex-col rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <div className="flex items-center gap-2">
            <PlatformLogo platform="HUBRISE" size={32} />
            <div>
              <h2 className="text-base font-semibold text-zinc-900">
                Publish hours to HubRise
              </h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                Sends each brand's opening hours + prep time. HubRise fans out
                to the connected marketplaces.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-2.5">
          {brandsQuery.isLoading ? (
            <div className="flex h-32 items-center justify-center text-zinc-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : brands.length === 0 ? (
            <p className="py-12 text-center text-sm text-zinc-500">
              No brands at this location yet.
            </p>
          ) : (
            brands.map((b: Brand) => (
              <div
                key={b.id}
                className="flex items-center gap-3 rounded-xl border border-zinc-200 p-3"
              >
                {b.logoUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={b.logoUrl}
                    alt=""
                    className="h-9 w-9 rounded-md object-cover"
                  />
                ) : (
                  <div className="grid h-9 w-9 place-items-center rounded-md bg-zinc-100 text-sm font-bold text-zinc-500">
                    {b.name.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-zinc-900">{b.name}</p>
                  <p className="text-[11px] text-zinc-500">
                    prep {b.prepTime ?? "—"} min
                  </p>
                </div>
                <Button
                  size="sm"
                  disabled={publish.isPending}
                  onClick={() => publish.mutate(b.id)}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  {publishingId === b.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    "Publish to HubRise"
                  )}
                </Button>
              </div>
            ))
          )}
        </div>

        <footer className="flex items-center justify-end border-t border-zinc-100 px-5 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            Done
          </Button>
        </footer>
      </div>
    </div>
  );
}
