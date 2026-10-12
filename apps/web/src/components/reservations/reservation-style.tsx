// One look for a booking everywhere it appears — list card, calendar block,
// month chip, details drawer — so "amber = waiting, green = sat down" reads
// the same on every view.

import {
  RESERVATION_STATUS_LABELS,
  type ReservationStatus,
} from "@/lib/api/reservations.client";

/** Bookings that still hold a table. Everything else is history. */
export const LIVE_STATUSES: ReservationStatus[] = ["PENDING", "CONFIRMED", "SEATED"];

export const STATUS_PILL: Record<ReservationStatus, string> = {
  PENDING: "bg-amber-100 text-amber-800",
  CONFIRMED: "bg-orange-100 text-orange-800",
  SEATED: "bg-emerald-100 text-emerald-800",
  COMPLETED: "bg-zinc-100 text-zinc-600",
  CANCELLED: "bg-red-100 text-red-700",
  NO_SHOW: "bg-red-100 text-red-700",
};

/** Calendar block: tinted fill + a strong left edge. */
export const STATUS_BLOCK: Record<ReservationStatus, string> = {
  PENDING: "border-amber-400 bg-amber-50 text-amber-950",
  CONFIRMED: "border-orange-500 bg-orange-50 text-orange-950",
  SEATED: "border-emerald-500 bg-emerald-50 text-emerald-950",
  COMPLETED: "border-zinc-300 bg-zinc-50 text-zinc-500",
  CANCELLED: "border-red-300 bg-red-50/60 text-red-400 line-through",
  NO_SHOW: "border-red-300 bg-red-50/60 text-red-400",
};

export const STATUS_DOT: Record<ReservationStatus, string> = {
  PENDING: "bg-amber-400",
  CONFIRMED: "bg-orange-500",
  SEATED: "bg-emerald-500",
  COMPLETED: "bg-zinc-300",
  CANCELLED: "bg-red-300",
  NO_SHOW: "bg-red-300",
};

export function StatusPill({ status }: { status: ReservationStatus }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_PILL[status]}`}
    >
      {RESERVATION_STATUS_LABELS[status]}
    </span>
  );
}

/** Server message from an axios error, or a fallback. */
export function apiMessage(e: unknown, fallback: string): string {
  const m = (e as any)?.response?.data?.message;
  return (Array.isArray(m) ? m.join(", ") : m) || fallback;
}
