// Scheduled Deliveroo orders need a SECOND status call.
//
// Deliveroo's own flow (api-docs.deliveroo.com/docs/scheduled-orders):
// an ASAP order is placed → accepted and that is the end of it, but a
// scheduled order is placed → accepted → CONFIRMED, where "confirmed" means
// the site has confirmed it and is starting to prepare. The payload carries
// `confirm_at`, the time Deliveroo wants that second call by, because a
// scheduled order gets no automatic release — deciding when it reaches the
// kitchen is the integrator's job.
//
// We had never sent it: every scheduled Deliveroo order sat at "accepted"
// from the moment it arrived. Their partner team asked whether we implement
// the PATCH endpoint, which is what turned it up.
//
// Two things can trigger the confirm, whichever comes first:
//   • the kitchen actually starting it (our PREPARING), which is exactly what
//     the status means; or
//   • `confirm_at` arriving, swept by a cron, so an order nobody has touched
//     is still confirmed on Deliveroo's timetable.
// It is sent once — the second attempt 409s on their side, and we mark the
// order so we don't try again.

export const DELIVEROO_CONFIRM_AT_KEY = "deliverooConfirmAt";
export const DELIVEROO_CONFIRMED_AT_KEY = "deliverooConfirmedAt";
export const DELIVEROO_ASAP_KEY = "deliverooAsap";

const asDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

const meta = (metadata: unknown): Record<string, unknown> =>
  metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};

/**
 * Read the scheduled-order fields out of a Deliveroo webhook/order payload.
 * `asap` is the flag Deliveroo sets false on a scheduled order; `confirm_at`
 * is when they want the confirm. Both are read defensively: a payload that
 * carries neither is simply an ASAP order.
 */
export function readDeliverooSchedule(order: any): {
  asap: boolean | null;
  confirmAt: Date | null;
} {
  const asap =
    typeof order?.asap === "boolean"
      ? order.asap
      : typeof order?.is_asap === "boolean"
        ? order.is_asap
        : null;
  const confirmAt =
    asDate(order?.confirm_at) ??
    asDate(order?.confirmAt) ??
    asDate(order?.scheduled?.confirm_at);
  return { asap, confirmAt };
}

/** What we store on the order, so the confirm can be driven later. */
export function scheduleMetadata(order: any): Record<string, unknown> {
  const { asap, confirmAt } = readDeliverooSchedule(order);
  return {
    ...(asap !== null ? { [DELIVEROO_ASAP_KEY]: asap } : {}),
    ...(confirmAt ? { [DELIVEROO_CONFIRM_AT_KEY]: confirmAt.toISOString() } : {}),
  };
}

/** Already confirmed — never send it twice. */
export function isDeliverooConfirmed(metadata: unknown): boolean {
  return !!meta(metadata)[DELIVEROO_CONFIRMED_AT_KEY];
}

/**
 * Is this a scheduled Deliveroo order that still needs confirming?
 *
 * A confirm_at is the signal: Deliveroo only sends one on a scheduled order.
 * `asap === false` alone also counts, so an order whose confirm_at we never
 * captured is still confirmed when the kitchen starts it rather than never.
 */
export function needsDeliverooConfirm(order: {
  metadata?: unknown;
  scheduledFor?: Date | null;
}): boolean {
  const m = meta(order.metadata);
  if (isDeliverooConfirmed(m)) return false;
  return (
    !!m[DELIVEROO_CONFIRM_AT_KEY] || m[DELIVEROO_ASAP_KEY] === false || !!order.scheduledFor
  );
}

/**
 * Is the confirm due yet, for the cron that sweeps untouched orders?
 *
 * Only ever at or after `confirm_at` — never early, because confirming says
 * the kitchen is starting, and on a scheduled order that may be hours away.
 * With no confirm_at there is nothing to sweep: those are confirmed when the
 * kitchen starts instead.
 */
export function confirmDueAt(metadata: unknown): Date | null {
  const raw = meta(metadata)[DELIVEROO_CONFIRM_AT_KEY];
  return asDate(raw);
}

export function isConfirmDue(metadata: unknown, now: Date): boolean {
  const due = confirmDueAt(metadata);
  return !!due && now.getTime() >= due.getTime();
}
