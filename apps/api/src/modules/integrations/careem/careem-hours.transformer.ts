// Phase CA-4 — our opening hours → Careem's operational hours.
//
// ── The rule that makes this non-obvious ────────────────────────────────────
//
// Careem has no concept of a shift crossing midnight. Their docs spell it out:
// "When we say that a branch is operational from 11 AM to 2 AM on day X, we
// actually include two days" — day X 11:00 to end-of-day, and day X+1 00:00 to
// 02:00. So one of our overnight slots becomes two of their shifts, on
// different days, and a Thursday-night slot puts a shift on Friday even for a
// shop that is "closed Fridays". Their own worked example makes exactly that
// point.
//
// End-of-day is 23:59, not 00:00: they state `end_at` cannot be 00:00, and
// their sample payload uses 23:59. Sending 00:00 is rejected, which is an
// unhelpful error for what is really a modelling difference.
//
// ── day_of_week is NOT documented ───────────────────────────────────────────
//
// Their examples show 1 and 5 and never say which day is 1. Values start at 1,
// so the JavaScript convention (0 = Sunday) is out, leaving Monday=1 (ISO) or
// Sunday=1. We default to ISO and make it configurable, because unlike the
// price unit there is no way to detect being wrong locally — a shop's hours
// would simply land on the wrong days. Verify it on one test branch before
// trusting it anywhere.

export type CareemWeekStart = "monday" | "sunday";

export interface CareemShift {
  start_time: string;
  end_time: string;
}

export interface CareemOperationalHour {
  shifts: CareemShift[];
  active: boolean;
  day_of_week: number;
}

/** Our map shape is keyed by these, in JavaScript's order (0 = Sunday). */
const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** Careem's end-of-day sentinel. Not 00:00 — they reject that. */
export const END_OF_DAY = "23:59";

const toMinutes = (s: string): number => {
  const [h = 0, m = 0] = String(s).split(":").map(Number);
  return h * 60 + m;
};

/** JS day index (0 = Sunday) → Careem's number, under the chosen convention. */
export function careemDayNumber(jsDay: number, weekStart: CareemWeekStart): number {
  return weekStart === "sunday"
    ? jsDay + 1 // Sunday = 1 … Saturday = 7
    : ((jsDay + 6) % 7) + 1; // Monday = 1 … Sunday = 7
}

interface Slot {
  from?: string;
  to?: string;
}

/** Pull the slots for one day out of either shape we store hours in. */
function slotsFor(hours: unknown, key: string): Slot[] {
  const map = hours as Record<string, unknown> | null;
  const day = map?.[key];
  if (!day) return [];
  if (Array.isArray(day)) return day as Slot[];
  const obj = day as { enabled?: boolean; slots?: Slot[] };
  if (obj.enabled === false) return [];
  return Array.isArray(obj.slots) ? obj.slots : [];
}

/**
 * Convert our week into Careem's.
 *
 * A day with no slots is emitted as `active: false` rather than omitted, so a
 * shop that closes on a day actually closes there — leaving the day out would
 * let whatever Careem already held stand.
 */
export function transformCareemHours(
  openingHours: unknown,
  weekStart: CareemWeekStart = "monday",
): CareemOperationalHour[] {
  // Collected per JS day index first, because an overnight slot writes into
  // the NEXT day and that is easier to reason about before renumbering.
  const byDay = new Map<number, CareemShift[]>();
  for (let d = 0; d < 7; d++) byDay.set(d, []);

  for (let day = 0; day < 7; day++) {
    for (const slot of slotsFor(openingHours, DAY_KEYS[day]!)) {
      if (!slot.from || !slot.to) continue;
      const from = toMinutes(slot.from);
      const to = toMinutes(slot.to);

      if (to > from) {
        byDay.get(day)!.push({ start_time: slot.from, end_time: slot.to });
        continue;
      }
      if (to === from) continue; // zero-length — nothing to publish

      // Crosses midnight. Two shifts on two days, per their clarification.
      byDay.get(day)!.push({ start_time: slot.from, end_time: END_OF_DAY });
      const next = (day + 1) % 7;
      // A midnight-to-midnight tail would be an empty shift.
      if (to > 0) {
        byDay.get(next)!.push({ start_time: "00:00", end_time: slot.to });
      }
    }
  }

  const out: CareemOperationalHour[] = [];
  for (let day = 0; day < 7; day++) {
    const shifts = byDay
      .get(day)!
      .sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));
    out.push({
      shifts,
      // Closed days must be SENT as closed, not omitted.
      active: shifts.length > 0,
      day_of_week: careemDayNumber(day, weekStart),
    });
  }
  return out.sort((a, b) => a.day_of_week - b.day_of_week);
}
