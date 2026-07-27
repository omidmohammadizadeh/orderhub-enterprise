"use client";

// Phase AM — Platform badge upgraded to use the shared PlatformLogo
// tile so order cards, menu publish targets, and integration rows all
// share one consistent visual identity.

import { PlatformLogo, platformLabel } from "@/components/ui/platform-logo";

const FULFILLMENT_CONFIG: Record<string, { label: string; color: string }> = {
  PICKUP: { label: "Pickup", color: "bg-sky-100 text-sky-700" },
  DELIVERY: { label: "Delivery", color: "bg-emerald-100 text-emerald-700" },
  DINE_IN: { label: "Dine in", color: "bg-amber-100 text-amber-700" },
  // MERCHANT_DELIVERY previously rendered "Own delivery" here, which read as a
  // third order type next to Delivery/Pickup. The order TYPE is simply
  // Delivery — who runs it (own driver vs platform courier) is already carried
  // by the separate MERCHANT/PLATFORM delivery badge column.
  MERCHANT_DELIVERY: { label: "Delivery", color: "bg-emerald-100 text-emerald-700" },
  PLATFORM_COURIER: { label: "Delivery", color: "bg-emerald-100 text-emerald-700" },
};

// Pill-style badge with the brand logo tile on the left and the
// platform name on the right. Compact enough for order card headers.
export function PlatformBadge({ platform }: { platform: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-md bg-white border border-zinc-200 pr-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-700">
      <PlatformLogo platform={platform} size={28} title={false} />
      {platformLabel(platform)}
    </span>
  );
}

export function FulfillmentBadge({ type }: { type: string }) {
  const cfg = FULFILLMENT_CONFIG[type] ?? { label: type, color: "bg-zinc-100 text-zinc-600" };
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}
