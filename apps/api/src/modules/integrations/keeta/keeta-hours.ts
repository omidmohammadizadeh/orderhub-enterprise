import type { WeekHours } from "../../../common/opening-hours.util";

// Phase KT-5 — our opening hours → Keeta's businessHourOfTheWeek.
//
//   { mon: [{ startTime: 36000, endTime: 79200 }], tue: [...], … }
//
// Times are SECONDS FROM MIDNIGHT (36000 = 10:00), end may be 86400
// (= midnight), no two slots in a day may overlap, and a day with no slots is
// sent as startTime 0 / endTime 0 ("full-day closure" in their words).
//
// Not documented, so decided here and flagged in docs/keeta-integration.md:
//
//   • TIMEZONE. Keeta never say. The store is in one country and every
//     example reads as local wall-clock, so local it is. (Their Brazilian
//     Open Delivery API mandates UTC — a different API.)
//   • CROSSING MIDNIGHT. Their endTime description says "must be >= startTime
//     except for cross-day periods" and never shows one. We split instead —
//     day X until 86400, day X+1 from 0 — which is valid under every reading.

export const KEETA_DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const OUR_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

export type KeetaWeek = Record<(typeof KEETA_DAY_KEYS)[number], Array<{ startTime: number; endTime: number }>>;

const toSeconds = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(hhmm ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 3600 + min * 60;
};

export function keetaBusinessHours(week: WeekHours): KeetaWeek {
  const slots: Array<Array<[number, number]>> = KEETA_DAY_KEYS.map(() => []);
  OUR_DAYS.forEach((day, i) => {
    for (const s of week[day] ?? []) {
      const from = toSeconds(s.from);
      let to = toSeconds(s.to);
      if (from == null || to == null) continue;
      if (to === 0) to = 86400; // "until midnight"
      if (to > from) {
        slots[i]!.push([from, to]);
      } else if (to < from) {
        // Overnight: the rest of today, and the start of tomorrow.
        slots[i]!.push([from, 86400]);
        slots[(i + 1) % 7]!.push([0, to]);
      }
      // to === from: a zero-length slot is no opening at all.
    }
  });

  const out = {} as KeetaWeek;
  KEETA_DAY_KEYS.forEach((key, i) => {
    const merged: Array<[number, number]> = [];
    for (const [a, b] of slots[i]!.sort((x, y) => x[0] - y[0])) {
      const last = merged[merged.length - 1];
      // Keeta reject overlaps; touching or overlapping slots become one.
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    out[key] = merged.length
      ? merged.map(([startTime, endTime]) => ({ startTime, endTime }))
      : [{ startTime: 0, endTime: 0 }];
  });
  return out;
}

/** Open all day, every day — for a shop with no hours set (matches the till). */
export const KEETA_ALL_WEEK_OPEN: KeetaWeek = Object.fromEntries(
  KEETA_DAY_KEYS.map((k) => [k, [{ startTime: 0, endTime: 86400 }]]),
) as KeetaWeek;
