"use client";

// Phase AM — Platform badge upgraded to use the shared PlatformLogo
// tile so order cards, menu publish targets, and integration rows all
// share one consistent visual identity.

import { Utensils } from "lucide-react";
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

/**
 * What the table chip should read, or null when there is no table.
 *
 * Operators name tables anything from "4" to "Table 4" to "Window 2". A bare
 * number gets the word in front of it, so a chip next to a quantity can't be
 * misread as one; anything the operator spelled out is left exactly as they
 * wrote it, because that is what is painted on the actual table.
 */
export function tableBadgeLabel(name?: string | null): string | null {
  const label = String(name ?? "").trim();
  if (!label) return null;
  return /^\d+$/.test(label) ? `Table ${label}` : label;
}

/**
 * Which table this order belongs to.
 *
 * Deliberately its own chip rather than a line of text in the customer
 * cell. A dine-in ticket is the one kind where staff have to walk the food
 * somewhere specific, and "Omid Mohammadizadeh" does not tell anybody which
 * table that is. It used to, by accident: a QR round took the TABLE's name
 * as the customer name when the guest didn't give one, so the board read
 * "Table 4". The moment pay-at-the-table started asking for a real name,
 * that disappeared — hence this, which doesn't depend on what the guest
 * typed. Amber and a cover icon, matching the chip the kitchen screen has
 * always shown, so the two read the same way across the room.
 */
export function TableBadge({ name }: { name?: string | null }) {
  const text = tableBadgeLabel(name);
  if (!text) return null;
  return (
    <span
      title={`Dine-in — ${text}`}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-900"
    >
      <Utensils className="h-3 w-3" aria-hidden />
      {text}
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
