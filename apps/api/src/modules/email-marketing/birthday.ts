import { DEFAULT_TIMEZONE, timezoneForCountry } from "@orderhub/shared";

// Birthday dates, as pure functions so the calendar edge cases are testable
// without a database or a clock.
//
// Everything is the SHOP's calendar day, not the server's: at 23:30 UTC on
// 14 March it is already 15 March in Dubai, and a birthday email that lands
// a day late reads as "we forgot".

export interface LocalDate {
  year: number;
  month: number; // 1–12
  day: number;
}

/**
 * The zone a shop keeps its calendar in. Location.timezone is filled from the
 * country when the shop is created; a row still on the UK default but with a
 * non-UK country predates that, so the country wins there.
 */
export function shopTimezone(loc: { timezone?: string | null; country?: string | null } | null | undefined): string {
  const tz = String(loc?.timezone ?? "").trim();
  const byCountry = timezoneForCountry(loc?.country);
  if (!tz) return byCountry;
  if (tz === DEFAULT_TIMEZONE && byCountry !== DEFAULT_TIMEZONE) return byCountry;
  return tz;
}

/** Today's date in `timeZone`. */
export function localDate(now: Date, timeZone: string): LocalDate {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(now);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: n("year"), month: n("month"), day: n("day") };
}

/** The hour (0–23) it is in `timeZone`. */
export function localHour(now: Date, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone })
      .formatToParts(now)
      .find((p) => p.type === "hour")?.value ?? "12",
  );
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const mmdd = (month: number, day: number) => `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/**
 * Whose birthday is it today, as "MM-DD" keys to match against
 * to_char(dateOfBirth, 'MM-DD'). Someone born on 29 February celebrates on
 * 28 February in a year that has no 29th — never on 1 March, and never not
 * at all.
 */
export function birthdayKeys(today: LocalDate): string[] {
  const keys = [mmdd(today.month, today.day)];
  if (today.month === 2 && today.day === 28 && !isLeapYear(today.year)) keys.push("02-29");
  return keys;
}

/** "23 October" — the last day a birthday offer is good for, counting the
 *  birthday itself as day one. */
export function offerExpiresLabel(today: LocalDate, validDays: number): string {
  const days = Math.max(1, Math.round(validDays) || 1);
  // Noon UTC keeps the date stable whatever zone formats it.
  const last = new Date(Date.UTC(today.year, today.month - 1, today.day + days - 1, 12));
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(last);
}
