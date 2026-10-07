/**
 * Auto-publish schedule maths: "Mon/Wed/Fri at 10:45 and 17:00, London time"
 * → the next UTC instant to fire. No timezone library in the API, so this
 * leans on Intl (full ICU in Node) and resolves the wall-clock → UTC offset
 * twice so a time on a clock-change day still lands on the right instant.
 */

export const AUTO_PUBLISH_CHANNELS = ["JUST_EAT", "DELIVEROO", "UBER_EATS", "HUBRISE"] as const;
export type AutoPublishChannel = (typeof AUTO_PUBLISH_CHANNELS)[number];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTime(t: string): boolean {
  return TIME_RE.test(t);
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a zone. */
function partsIn(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(date)) p[x.type] = x.value;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!);
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    mi: Number(p.minute),
    s: Number(p.second),
    weekday: wd,
  };
}

/** Offset (ms) of `tz` from UTC at the given instant. */
function offsetAt(date: Date, tz: string): number {
  const p = partsIn(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant when the wall clock in `tz` reads y-m-d h:mi. */
export function zonedWallTimeToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offsetAt(new Date(guess), tz);
  // Second pass: the offset at the real instant can differ on a clock-change day.
  t = guess - offsetAt(new Date(t), tz);
  return new Date(t);
}

/**
 * The first scheduled instant strictly after `after`, or null when the
 * schedule has no day or no time. Looks 8 days ahead, which always covers a
 * weekly schedule.
 */
export function nextRunAfter(
  after: Date,
  schedule: { days: number[]; times: string[]; timezone: string },
): Date | null {
  const days = new Set(schedule.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  const times = [...new Set(schedule.times.filter(isValidTime))].sort();
  if (!days.size || !times.length) return null;
  const tz = isValidTimezone(schedule.timezone) ? schedule.timezone : "Europe/London";

  const start = partsIn(after, tz);
  for (let i = 0; i <= 8; i++) {
    // Calendar date i days after `after`'s local date (UTC arithmetic on the
    // date only, so DST never shifts which day it is).
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const weekday = day.getUTCDay();
    if (!days.has(weekday)) continue;
    for (const t of times) {
      const [hh, mm] = t.split(":").map(Number) as [number, number];
      const at = zonedWallTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz);
      if (at.getTime() > after.getTime()) return at;
    }
  }
  return null;
}
