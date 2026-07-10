"use client";

// Phase BF — "Variant menu" for the channels with no dedicated "Manage"
// modal to host it (Online ordering, WhatsApp, Just Eat — Uber Eats and
// Deliveroo get their own copy of this panel as a "Menu" tab inside their
// existing Manage modal instead, since that's where an operator already
// expects per-connection settings to live).

import { Sparkles } from "lucide-react";
import { ChannelVariantMenuPanel } from "./channel-variant-menu-panel";

const CHANNELS: Array<{ id: string; label: string }> = [
  { id: "ONLINE", label: "Online ordering" },
  { id: "WHATSAPP", label: "WhatsApp" },
  { id: "JUST_EAT", label: "Just Eat" },
];

interface Props {
  brandId: string;
  locationId: string;
}

export function BrandChannelPricingSources({ brandId, locationId }: Props) {
  return (
    <div className="mt-4 space-y-2">
      <div className="flex items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 text-violet-600" />
        <h3 className="text-xs font-semibold text-zinc-800">
          Channel pricing sources
        </h3>
      </div>
      {CHANNELS.map((c) => (
        <div key={c.id}>
          <p className="mb-1 text-[11px] font-medium text-zinc-600">{c.label}</p>
          <ChannelVariantMenuPanel
            brandId={brandId}
            locationId={locationId}
            channel={c.id}
            variant="compact"
          />
        </div>
      ))}
    </div>
  );
}
