"use client";

const PLATFORM_CONFIG: Record<string, { label: string; color: string }> = {
  UBER_EATS: { label: "Uber Eats", color: "bg-black text-white" },
  DELIVEROO: { label: "Deliveroo", color: "bg-teal-600 text-white" },
  JUST_EAT: { label: "Just Eat", color: "bg-orange-500 text-white" },
  HUBRISE: { label: "HubRise", color: "bg-violet-600 text-white" },
  DIRECT: { label: "Direct", color: "bg-zinc-700 text-white" },
  ONLINE: { label: "Online", color: "bg-blue-600 text-white" },
  POS: { label: "POS", color: "bg-zinc-600 text-white" },
};

const FULFILLMENT_CONFIG: Record<string, { label: string; color: string }> = {
  PICKUP: { label: "Pickup", color: "bg-sky-100 text-sky-700" },
  DELIVERY: { label: "Delivery", color: "bg-emerald-100 text-emerald-700" },
  DINE_IN: { label: "Dine in", color: "bg-amber-100 text-amber-700" },
  MERCHANT_DELIVERY: { label: "Own delivery", color: "bg-indigo-100 text-indigo-700" },
  PLATFORM_COURIER: { label: "Courier", color: "bg-rose-100 text-rose-700" },
};

export function PlatformBadge({ platform }: { platform: string }) {
  const cfg = PLATFORM_CONFIG[platform] ?? { label: platform, color: "bg-zinc-500 text-white" };
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cfg.color}`}>
      {cfg.label}
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
