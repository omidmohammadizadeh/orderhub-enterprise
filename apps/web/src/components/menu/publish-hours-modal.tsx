"use client";

// Phase AW-16 — Publish brand hours + prep time to one channel.
//
// Two-step picker:
//   1. Brand        — scoped to the active location
//   2. Channel      — POS / Online ordering / HubRise (wired)
//                    + Just Eat / Uber Eats / Deliveroo / WhatsApp
//                    (UI stubs; intent recorded, real push later)
//
// Saves via brandsClient.publishHours. Green toast on success;
// pending_integration channels surface as an amber info toast so the
// operator knows the click landed but the direct push isn't live yet.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { X, Check, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { brandsClient, type Brand } from "@/lib/api/locations.client";
import { PlatformLogo } from "@/components/ui/platform-logo";

interface Props {
  open: boolean;
  locationId?: string;
  onClose: () => void;
}

interface ChannelTarget {
  id: string;
  title: string;
  description: string;
  wired: boolean;
}

const CHANNELS: ChannelTarget[] = [
  {
    id: "HUBRISE",
    title: "HubRise",
    description:
      "Push to HubRise — fans out to every connected marketplace from there.",
    wired: true,
  },
  {
    id: "ONLINE",
    title: "Direct online ordering",
    description: "Storefront reads brand hours at load time. No external call.",
    wired: true,
  },
  {
    id: "POS",
    title: "Order Hub POS",
    description: "POS reads brand hours at load time. No external call.",
    wired: true,
  },
  {
    id: "JUST_EAT",
    title: "Just Eat",
    description: "Direct push pending — intent recorded for now.",
    wired: false,
  },
  {
    id: "UBER_EATS",
    title: "Uber Eats",
    description: "Direct push pending — intent recorded for now.",
    wired: false,
  },
  {
    id: "DELIVEROO",
    title: "Deliveroo",
    description: "Direct push pending — intent recorded for now.",
    wired: false,
  },
  {
    id: "WHATSAPP",
    title: "WhatsApp",
    description: "Direct push pending — intent recorded for now.",
    wired: false,
  },
];

type Step = "brand" | "channel";

export function PublishHoursModal({ open, locationId, onClose }: Props) {
  const [step, setStep] = useState<Step>("brand");
  const [brandId, setBrandId] = useState<string>("");
  const [channel, setChannel] = useState<string>("");

  const brandsQuery = useQuery({
    queryKey: ["brands", locationId ?? "tenant"],
    queryFn: () => brandsClient.list(locationId),
    enabled: open,
  });
  const brands = brandsQuery.data ?? [];

  useEffect(() => {
    if (open) {
      setStep("brand");
      setBrandId("");
      setChannel("");
    }
  }, [open]);

  const publishMutation = useMutation({
    mutationFn: () => brandsClient.publishHours(brandId, channel),
    onSuccess: (res) => {
      const brandName =
        brands.find((b: Brand) => b.id === brandId)?.name ?? "brand";
      const channelLabel =
        CHANNELS.find((c) => c.id === channel)?.title ?? channel;
      if (res.status === "pending_integration") {
        toast(`Recorded for ${channelLabel} — direct push wires up later`, {
          icon: "ℹ️",
        });
      } else {
        toast.success(`Published ${brandName} hours to ${channelLabel}`);
      }
      onClose();
    },
    onError: (err: any) =>
      toast.error(
        `Failed: ${err?.response?.data?.message ?? err?.message ?? "Unknown error"}`,
      ),
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
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              Publish hours
            </h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              {step === "brand"
                ? "Pick the brand whose hours + prep time to publish."
                : "Pick the channel to push to."}
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-2.5">
          {step === "brand" ? (
            brandsQuery.isLoading ? (
              <div className="flex h-32 items-center justify-center text-zinc-400">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : brands.length === 0 ? (
              <p className="py-12 text-center text-sm text-zinc-500">
                No brands at this location yet.
              </p>
            ) : (
              brands.map((b: Brand) => {
                const isOn = brandId === b.id;
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => {
                      setBrandId(b.id);
                      setStep("channel");
                    }}
                    className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                      isOn
                        ? "border-violet-300 bg-violet-50"
                        : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50"
                    }`}
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
                      <p className="text-sm font-semibold text-zinc-900">
                        {b.name}
                      </p>
                      <p className="text-[11px] text-zinc-500">
                        prep {b.prepTime ?? "—"} min
                      </p>
                    </div>
                  </button>
                );
              })
            )
          ) : (
            CHANNELS.map((c) => {
              const isOn = channel === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setChannel(c.id)}
                  className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                    isOn
                      ? "border-orange-300 bg-orange-50"
                      : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50"
                  }`}
                >
                  <PlatformLogo platform={c.id} size={36} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-zinc-900">
                      {c.title}
                    </p>
                    <p className="text-xs text-zinc-500">{c.description}</p>
                    {!c.wired && (
                      <p className="mt-1 text-[10px] text-amber-700">
                        Direct push not wired yet — toggling records intent.
                      </p>
                    )}
                  </div>
                  <span
                    className={`grid h-5 w-5 place-items-center rounded-full border-2 flex-shrink-0 ${
                      isOn
                        ? "border-orange-500 bg-orange-500 text-white"
                        : "border-zinc-300 bg-white"
                    }`}
                  >
                    {isOn && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-zinc-100 px-5 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={step === "channel" ? () => setStep("brand") : onClose}
          >
            {step === "channel" ? "Back" : "Cancel"}
          </Button>
          {step === "channel" && (
            <Button
              size="sm"
              disabled={!channel || publishMutation.isPending}
              onClick={() => publishMutation.mutate()}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {publishMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                "Publish"
              )}
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}
