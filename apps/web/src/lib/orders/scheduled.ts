// "Is this order for later?"
//
// A pre-order is not a new order. Left in the New bucket it reads as work to
// start now, and the kitchen makes a 9pm delivery at 5pm — so it gets its own
// bucket and is excluded from New until its time comes.
//
// scheduledFor is the canonical field, written by every source: the POS mirrors
// it onto scheduledAt for its own strip, but marketplace pre-orders arriving
// through HubRise only ever set scheduledFor. Matching on scheduledFor is what
// makes a Just Eat or Deliveroo pre-order show up here at all.
//
// Shared by the list view, the board and the print path so all three agree on
// what "scheduled" means.

/** How far ahead an order must be before it counts as a pre-order rather than
 *  an ASAP one. HubRise stamps expected_time on EVERY order, including ASAP
 *  ones (roughly now + prep), so a threshold is what stops the whole board
 *  reading as scheduled. Mirrors SCHEDULED_FUTURE_THRESHOLD_SECONDS in
 *  orders.service.ts. */
const FUTURE_THRESHOLD_MS = 10 * 60 * 1000;

export interface SchedulableOrder {
  status?: string | null;
  scheduledFor?: string | null;
  scheduledAt?: string | null;
}

/** The moment this order is due, or null when it isn't a pre-order. */
export function scheduledWhen(o: SchedulableOrder): Date | null {
  const raw = o.scheduledFor ?? o.scheduledAt;
  if (!raw) return null;
  const when = new Date(raw);
  return Number.isFinite(when.getTime()) ? when : null;
}

/**
 * Waiting for its slot: due comfortably in the future and not yet being made.
 *
 * ACCEPTED counts. A pre-order is auto-accepted and printed on arrival like
 * any other order — that is what the shop wants — so gating this on PENDING
 * alone emptied the bucket seconds after the order landed and dropped it into
 * Accepted among the live work, which is the one place it must not look like.
 *
 * PREPARING onwards does NOT count: somebody has started cooking it, and from
 * that moment the board should show where the work actually is.
 */
const WAITING_STATUSES = new Set(["PENDING", "ACCEPTED"]);

export function isScheduledForLater(o: SchedulableOrder): boolean {
  if (!WAITING_STATUSES.has(String(o.status ?? ""))) return false;
  const when = scheduledWhen(o);
  return !!when && when.getTime() - Date.now() > FUTURE_THRESHOLD_MS;
}

/** "Today 9:20 PM" / "Thu 9:20 PM" — short enough for a bucket pill. */
export function formatScheduledWhen(when: Date): string {
  const today = new Date();
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate();
  const time = when.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return sameDay
    ? `Today ${time}`
    : `${when.toLocaleDateString([], { weekday: "short" })} ${time}`;
}
