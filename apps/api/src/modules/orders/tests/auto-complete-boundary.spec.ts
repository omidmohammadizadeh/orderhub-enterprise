import { OrdersAutoCompleteCron } from "../orders-auto-complete.cron";

// When a stale order actually gets rolled over.
//
// Reported from a live board: an order sat on the dispatch map all day as an
// ever-later red pin ("351 min late · READY"). It had not been auto-completed
// at all. Cause: the sweep ran once, at 05:00, and skips anything touched in
// the previous hour — so an order placed between 04:00 and 05:00 was passed
// over and nothing looked at it again until 05:00 the NEXT morning.
//
// It now runs hourly against two rules that must BOTH hold: the order belongs
// to a business day that has ended (before the last 05:00), and nobody has
// touched it for an hour. The second is what stops an order the shop is
// actively working on being completed underneath them.

const at = (iso: string) => new Date(iso);

/** The cutoff the sweep uses: an order is swept when updatedAt is before it. */
function cutoffAt(now: Date): Date {
  const boundary = OrdersAutoCompleteCron.businessDayBoundary(now);
  const grace = new Date(now.getTime() - 60 * 60 * 1000);
  return new Date(Math.min(boundary.getTime(), grace.getTime()));
}

const sweeps = (orderUpdatedAt: string, now: string) =>
  at(orderUpdatedAt) < cutoffAt(at(now));

describe("business-day boundary", () => {
  it("is the most recent 05:00 UTC", () => {
    expect(
      OrdersAutoCompleteCron.businessDayBoundary(at("2026-09-24T11:00:00Z")).toISOString(),
    ).toBe("2026-09-24T05:00:00.000Z");
  });

  it("is yesterday's 05:00 when the clock has not reached today's", () => {
    expect(
      OrdersAutoCompleteCron.businessDayBoundary(at("2026-09-24T03:30:00Z")).toISOString(),
    ).toBe("2026-09-23T05:00:00.000Z");
  });

  it("is exact at 05:00 itself", () => {
    expect(
      OrdersAutoCompleteCron.businessDayBoundary(at("2026-09-24T05:00:00Z")).toISOString(),
    ).toBe("2026-09-24T05:00:00.000Z");
  });
});

describe("what the hourly sweep completes", () => {
  it("catches the 04:50 order the 05:00 run had to skip", () => {
    // The reported case. At 05:00 it is ten minutes old, so the grace protects
    // it — and before this fix nothing looked again for 24 hours.
    expect(sweeps("2026-09-24T04:50:00Z", "2026-09-24T05:00:00Z")).toBe(false);
    expect(sweeps("2026-09-24T04:50:00Z", "2026-09-24T06:00:00Z")).toBe(true);
  });

  it("leaves today's trade alone all day", () => {
    // Placed after the boundary: it is today's business, however late it runs.
    for (const now of [
      "2026-09-24T10:00:00Z",
      "2026-09-24T16:00:00Z",
      "2026-09-24T23:00:00Z",
    ]) {
      expect(sweeps("2026-09-24T09:00:00Z", now)).toBe(false);
    }
    // And is swept once its own business day has ended.
    expect(sweeps("2026-09-24T09:00:00Z", "2026-09-25T05:00:00Z")).toBe(true);
  });

  it("never completes an order someone just touched", () => {
    // Yesterday's order, but a staff member moved it five minutes ago.
    expect(sweeps("2026-09-24T10:55:00Z", "2026-09-24T11:00:00Z")).toBe(false);
  });

  it("still behaves exactly as before at the 05:00 run", () => {
    // Yesterday evening's order: swept at 05:00, as it always was.
    expect(sweeps("2026-09-23T20:30:00Z", "2026-09-24T05:00:00Z")).toBe(true);
    // An order from 04:30 is not — the hour's grace is the tighter rule at 05:00.
    expect(sweeps("2026-09-24T04:30:00Z", "2026-09-24T05:00:00Z")).toBe(false);
  });
});
