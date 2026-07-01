"use client";

// Phase AW-16 / AZ — Publish opening hours + prep time.
//
//   • HubRise — one catalog/location for every brand at the site, so its
//     hours are location-level. Click it → publishes straight away, no brand,
//     no channel picker.
//   • A brand — reserved for future DIRECT per-brand pushes (Uber Eats /
//     Deliveroo / Just Eat). Selecting a brand shows those channels.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { X, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { brandsClient, type Brand } from "@/lib/api/locations.client";
import { PlatformLogo } from "@/components/ui/platform-logo";

interface Props {
  open: boolean;
  locationId?: string;
  onClose: () => void;
}

// Direct per-brand channels (HubRise already fans out to these, so these are
// for operators who bypass HubRise). `wired` = the direct push is live;
// otherwise the click only records intent until that channel is built.
const BRAND_CHANNELS = [
  { id: "JUST_EAT", title: "Just Eat", wired: false },
  { id: "UBER_EATS", title: "Uber Eats", wired: false },
  { id: "DELIVEROO", title: "Deliveroo", wired: true },
];

export function PublishHoursModal({ open, locationId, onClose }: Props) {
  const [brand, setBrand] = useState<Brand | null>(null); // null = home step
  const [busy, setBusy] = useState<string | null>(null);

  const brandsQuery = useQuery({
    queryKey: ["brands", locationId ?? "tenant"],
    queryFn: () => brandsClient.list(locationId),
    enabled: open,
  });
  const brands = brandsQuery.data ?? [];

  useEffect(() => {
    if (open) setBrand(null);
  }, [open]);

  const publishHubRise = useMutation({
    mutationFn: () => {
      if (!locationId) throw new Error("No location selected.");
      return brandsClient.publishLocationHoursToHubRise(locationId);
    },
    onMutate: () => setBusy("HUBRISE"),
    onSuccess: () => toast.success("Published this location's hours to HubRise"),
    onError: (err: any) =>
      toast.error(
        `Failed: ${err?.response?.data?.message ?? err?.message ?? "Unknown error"}`,
      ),
    onSettled: () => setBusy(null),
  });

  const publishBrandChannel = useMutation({
    mutationFn: (channel: string) =>
      brandsClient.publishHours(brand!.id, channel),
    onMutate: (channel) => setBusy(channel),
    onSuccess: (res, channel) => {
      const label = BRAND_CHANNELS.find((c) => c.id === channel)?.title ?? channel;
      if (res.status === "pending_integration") {
        toast(`Recorded for ${label} — direct push wires up later`, { icon: "ℹ️" });
      } else {
        toast.success(`Published ${brand?.name} hours to ${label}`);
      }
    },
    onError: (err: any) =>
      toast.error(
        `Failed: ${err?.response?.data?.message ?? err?.message ?? "Unknown error"}`,
      ),
    onSettled: () => setBusy(null),
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
            {brand && (
              <button
                onClick={() => setBrand(null)}
                className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100"
                title="Back"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}
            <div>
              <h2 className="text-base font-semibold text-zinc-900">
                Publish hours
              </h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                {brand
                  ? `Pick a channel for ${brand.name}.`
                  : "Publish to HubRise, or pick a brand for direct channels."}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-2.5">
          {!brand ? (
            <>
              {/* HubRise — direct, no brand/channel needed */}
              <div className="flex items-center gap-3 rounded-xl border border-zinc-200 p-3">
                <PlatformLogo platform="HUBRISE" size={36} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-zinc-900">HubRise</p>
                  <p className="text-xs text-zinc-500">
                    Publishes this location's hours + prep. Fans out to every
                    connected marketplace.
                  </p>
                </div>
                <Button
                  size="sm"
                  disabled={publishHubRise.isPending}
                  onClick={() => publishHubRise.mutate()}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  {busy === "HUBRISE" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    "Publish"
                  )}
                </Button>
              </div>

              <p className="px-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                Direct to a brand's channels (future)
              </p>
              {brandsQuery.isLoading ? (
                <div className="flex h-20 items-center justify-center text-zinc-400">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : brands.length === 0 ? (
                <p className="py-6 text-center text-sm text-zinc-500">
                  No brands at this location yet.
                </p>
              ) : (
                brands.map((b: Brand) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setBrand(b)}
                    className="flex w-full items-center gap-3 rounded-xl border border-zinc-200 p-3 text-left hover:border-zinc-300 hover:bg-zinc-50"
                  >
                    {b.logoUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={b.logoUrl} alt="" className="h-9 w-9 rounded-md object-cover" />
                    ) : (
                      <div className="grid h-9 w-9 place-items-center rounded-md bg-zinc-100 text-sm font-bold text-zinc-500">
                        {b.name.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-zinc-900">{b.name}</p>
                      <p className="text-[11px] text-zinc-500">prep {b.prepTime ?? "—"} min</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-zinc-400" />
                  </button>
                ))
              )}
            </>
          ) : (
            BRAND_CHANNELS.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-3 rounded-xl border border-zinc-200 p-3"
              >
                <PlatformLogo platform={c.id} size={36} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-zinc-900">{c.title}</p>
                  {c.wired ? (
                    <p className="text-[10px] text-emerald-700">
                      Pushes this brand's opening hours + prep time to Deliveroo.
                    </p>
                  ) : (
                    <p className="text-[10px] text-amber-700">
                      Direct push not wired yet — publishing records intent.
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant={c.wired ? "default" : "outline"}
                  disabled={publishBrandChannel.isPending}
                  onClick={() => publishBrandChannel.mutate(c.id)}
                  className={
                    c.wired
                      ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                      : undefined
                  }
                >
                  {busy === c.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    "Publish"
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
