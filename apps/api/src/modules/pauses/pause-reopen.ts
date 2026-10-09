// When a timed pause ends, who reopens the shop?
//
// Every channel we push a pause to is told when it ends — except two:
//
//   Uber Eats  is_offline_until = resumeAt   → Uber reopens the store itself
//   Just Eat   onlineAt         = resumeAt   → JET reopens it itself
//   Glovo      until            = resumeAt   → ditto
//   Talabat    resumeAt                      → ditto
//   DELIVEROO  — the status call has no end-time field at all
//   Keeta      — we send no end time either
//
// Our own side needs no sweep: storefront, POS and HubRise all call
// isPaused() at read time, and an expired row stops counting on its own.
// Deliveroo is different because it is PUSHED state. We closed the site and
// nothing ever told it when to come back, and the reconcile only runs when
// an operator presses pause, resume or clear.
//
// So "stop taking orders for 1 hour" came back everywhere after an hour —
// and left Deliveroo closed until somebody happened to pause and resume
// again, with nothing in the log to say why the orders stopped.
//
// The trap in fixing it: a site can also be closed because the operator
// closed it by hand from the Deliveroo panel, and reopening THAT would be
// worse than the bug. The two are told apart by time. When a pause closed
// the site, the connection row was written when the pause started, which is
// before the pause's end; a manual close happens afterwards.

export interface ReopenCandidate {
  /** When we last wrote this connection's status — i.e. when it was closed. */
  connectionUpdatedAt: Date;
  /** resumeAt of every pause covering this scope that has already ended. */
  expiredResumeAts: Date[];
  /** Is some other pause still covering this scope right now? */
  stillPaused: boolean;
}

/** Ignore pauses that ended long ago — those are history, not a stuck shop. */
export const REOPEN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Should this closed store be reopened now?
 *
 * Yes only when an expired pause can account for the closure:
 *   • nothing else is keeping the scope paused, and
 *   • a pause ended recently, and
 *   • the store was closed BEFORE that pause ended.
 *
 * The last condition is what protects a hand-closed site: if someone closed
 * it after the pause ran out, the closure is theirs and we leave it alone.
 */
export function shouldReopenAfterPause(
  candidate: ReopenCandidate,
  now: Date = new Date(),
): boolean {
  if (candidate.stillPaused) return false;
  const floor = now.getTime() - REOPEN_LOOKBACK_MS;
  return candidate.expiredResumeAts.some((resumeAt) => {
    const t = resumeAt.getTime();
    return (
      t <= now.getTime() &&
      t >= floor &&
      candidate.connectionUpdatedAt.getTime() <= t
    );
  });
}
