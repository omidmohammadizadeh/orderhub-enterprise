// Salon booking engine — barbers, hair and nail salons.
//
// Pure functions only (no Prisma, no Date.now() unless passed in) so the API,
// the dashboard and the tests all agree on what "free at 10:15" means.
//
// Everything works in epoch milliseconds. The one place a timezone matters is
// turning "Tuesday 09:00–18:00" into real instants, and that is done with
// Intl (plain ECMAScript — packages/shared may not use DOM or Node globals).

import { round2 } from "./menu-pricing";

export interface Interval {
  start: number;
  end: number;
}

export type WeekdayKey =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

export const SALON_WEEKDAYS: WeekdayKey[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** { monday: [{ from: "09:00", to: "18:00" }], … } — a missing/empty day is closed. */
export type SalonWeeklyHours = Partial<Record<WeekdayKey, Array<{ from: string; to: string }>>>;

/** What the barber does for one service, in minutes. */
export interface SalonServiceBlock {
  durationMins: number;
  bufferMins?: number | null;
  /** Hair colour: the stylist is free during the gap and can take someone else. */
  processingStartMins?: number | null;
  processingMins?: number | null;
}

export type SalonTrade = "BARBER" | "HAIR" | "NAILS" | "BEAUTY";

const MIN = 60_000;

// ── Time zones ──────────────────────────────────────────────────────────────

function partsIn(ms: number, tz: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** Minutes the zone is ahead of UTC at that instant (BST = 60). */
export function tzOffsetMins(ms: number, tz: string): number {
  const p = partsIn(ms, tz);
  const asUtc = Date.UTC(
    p.year ?? 1970,
    (p.month ?? 1) - 1,
    p.day ?? 1,
    (p.hour ?? 0) % 24,
    p.minute ?? 0,
    p.second ?? 0,
  );
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MIN);
}

/** "2026-10-13" + "09:30" in Europe/London → epoch ms. */
export function zonedWallToUtc(date: string, time: string, tz: string): number {
  const [y = 1970, mo = 1, d = 1] = date.split("-").map(Number);
  const [h = 0, mi = 0] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes settles the offset on DST-change days.
  let ms = guess - tzOffsetMins(guess, tz) * MIN;
  ms = guess - tzOffsetMins(ms, tz) * MIN;
  return ms;
}

/** The shop's calendar date for an instant: "2026-10-13". */
export function wallDate(ms: number, tz: string): string {
  const p = partsIn(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The shop's wall-clock "HH:MM" for an instant. */
export function wallTime(ms: number, tz: string): string {
  const p = partsIn(ms, tz);
  return `${String((p.hour ?? 0) % 24).padStart(2, "0")}:${String(p.minute ?? 0).padStart(2, "0")}`;
}

/** "2026-10-13" → "tuesday" (calendar arithmetic, no timezone involved). */
export function weekdayOf(date: string): WeekdayKey {
  const [y = 1970, mo = 1, d = 1] = date.split("-").map(Number);
  return SALON_WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()] ?? "monday";
}

/** "2026-10-13" + 1 → "2026-10-14". */
export function addDaysToDate(date: string, n: number): string {
  const [y = 1970, mo = 1, d = 1] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

// ── Working hours ───────────────────────────────────────────────────────────

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function toMins(s: string): number {
  const [h = 0, m = 0] = s.split(":").map(Number);
  return h * 60 + m;
}

/** Keep only well-formed, non-empty, non-overlapping slots per day. */
export function normaliseWeeklyHours(raw: unknown): SalonWeeklyHours {
  const out: SalonWeeklyHours = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const day of SALON_WEEKDAYS) {
    const v = (raw as Record<string, unknown>)[day];
    // Accept the location opening-hours shape too: { enabled, slots: [...] }.
    let list: unknown = v;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as { enabled?: boolean; slots?: unknown };
      list = o.enabled === false ? [] : o.slots;
    }
    if (!Array.isArray(list)) continue;
    const slots = list
      .map((s) => ({ from: String((s as any)?.from ?? ""), to: String((s as any)?.to ?? "") }))
      .filter((s) => HHMM.test(s.from) && HHMM.test(s.to) && toMins(s.to) > toMins(s.from))
      .sort((a, b) => toMins(a.from) - toMins(b.from));
    const merged: Array<{ from: string; to: string }> = [];
    for (const s of slots) {
      const last = merged[merged.length - 1];
      if (last && toMins(s.from) <= toMins(last.to)) {
        if (toMins(s.to) > toMins(last.to)) last.to = s.to;
      } else merged.push({ ...s });
    }
    if (merged.length) out[day] = merged;
  }
  return out;
}

export function hasAnyHours(h: SalonWeeklyHours): boolean {
  return SALON_WEEKDAYS.some((d) => (h[d]?.length ?? 0) > 0);
}

/** A barber's default week when nobody has set one: Mon–Sat 09:00–18:00. */
export const DEFAULT_SALON_HOURS: SalonWeeklyHours = {
  monday: [{ from: "09:00", to: "18:00" }],
  tuesday: [{ from: "09:00", to: "18:00" }],
  wednesday: [{ from: "09:00", to: "18:00" }],
  thursday: [{ from: "09:00", to: "18:00" }],
  friday: [{ from: "09:00", to: "18:00" }],
  saturday: [{ from: "09:00", to: "18:00" }],
};

/** The real instants someone works on one calendar day. */
export function dayWindows(hours: SalonWeeklyHours, date: string, tz: string): Interval[] {
  const slots = hours[weekdayOf(date)] ?? [];
  return slots.map((s) => ({
    start: zonedWallToUtc(date, s.from, tz),
    end: zonedWallToUtc(date, s.to, tz),
  }));
}

/** Intersect two sets of windows (staff hours inside shop hours). */
export function intersectWindows(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start, end });
    }
  }
  return out.sort((p, q) => p.start - q.start);
}

/**
 * Whose hours count for a staff member on a day: their own week when set,
 * otherwise the shop's, otherwise the default. Their own hours are still
 * clipped to the shop's when the shop has hours — nobody is bookable while
 * the door is locked.
 */
export function staffDayWindows(opts: {
  staffHours: SalonWeeklyHours;
  shopHours: SalonWeeklyHours;
  date: string;
  tz: string;
}): Interval[] {
  const shopSet = hasAnyHours(opts.shopHours);
  const shop = dayWindows(shopSet ? opts.shopHours : DEFAULT_SALON_HOURS, opts.date, opts.tz);
  if (!hasAnyHours(opts.staffHours)) return shop;
  const own = dayWindows(opts.staffHours, opts.date, opts.tz);
  return shopSet ? intersectWindows(own, shop) : own;
}

// ── Occupancy ───────────────────────────────────────────────────────────────

/**
 * What a run of services does to the staff member's time, starting at
 * `startMs`. Services run back to back; the clean-down buffer is added once,
 * after the last one (it is between clients, not between a cut and a beard).
 *
 *   endMs  — when the CLIENT is done (what the diary card and email show)
 *   busy   — the intervals the staff member can't take anyone else, which
 *            leaves out any processing gap and includes the buffer.
 */
export function occupancy(
  startMs: number,
  blocks: SalonServiceBlock[],
): { endMs: number; busy: Interval[] } {
  const busy: Interval[] = [];
  let t = startMs;
  let buffer = 0;
  for (const b of blocks) {
    const dur = Math.max(0, Math.round(Number(b.durationMins) || 0));
    const pStart = Math.round(Number(b.processingStartMins) || 0);
    const pLen = Math.round(Number(b.processingMins) || 0);
    if (pLen > 0 && pStart > 0 && pStart + pLen < dur) {
      busy.push({ start: t, end: t + pStart * MIN });
      busy.push({ start: t + (pStart + pLen) * MIN, end: t + dur * MIN });
    } else if (dur > 0) {
      busy.push({ start: t, end: t + dur * MIN });
    }
    t += dur * MIN;
    buffer = Math.max(0, Math.round(Number(b.bufferMins) || 0));
  }
  if (buffer > 0) {
    const last = busy[busy.length - 1];
    if (last && last.end === t) last.end = t + buffer * MIN;
    else busy.push({ start: t, end: t + buffer * MIN });
  }
  return { endMs: t, busy: mergeIntervals(busy) };
}

export function totalMinutes(blocks: SalonServiceBlock[]): number {
  return blocks.reduce((s, b) => s + Math.max(0, Math.round(Number(b.durationMins) || 0)), 0);
}

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

export function overlapsAny(need: Interval[], busy: Interval[]): boolean {
  for (const n of need) {
    for (const b of busy) {
      if (n.start < b.end && b.start < n.end) return true;
    }
  }
  return false;
}

/** The client's time in the chair must sit inside one working window. */
export function fitsWindows(startMs: number, endMs: number, windows: Interval[]): boolean {
  return windows.some((w) => startMs >= w.start && endMs <= w.end);
}

/**
 * Every start time a staff member can take this run of services.
 *
 * Starts are aligned to the step on the CLOCK (:00, :15, :30 …), not to
 * whenever a window happens to begin, so a 09:10 start of day still offers
 * 09:15 rather than 09:10, 09:25.
 */
export function freeStarts(opts: {
  windows: Interval[];
  busy: Interval[];
  blocks: SalonServiceBlock[];
  stepMins: number;
  notBefore?: number;
  notAfter?: number;
  /** The shop's zone, so starts land on ITS :00/:30 (India is UTC+5:30). */
  tz?: string;
}): number[] {
  const step = Math.max(5, Math.round(opts.stepMins || 15)) * MIN;
  const busy = mergeIntervals(opts.busy);
  const out: number[] = [];
  const total = totalMinutes(opts.blocks);
  if (total <= 0) return out;
  for (const w of opts.windows) {
    const off = opts.tz ? tzOffsetMins(w.start, opts.tz) * MIN : 0;
    let t = Math.ceil((w.start + off) / step) * step - off;
    for (; t + total * MIN <= w.end; t += step) {
      if (opts.notBefore !== undefined && t < opts.notBefore) continue;
      if (opts.notAfter !== undefined && t > opts.notAfter) break;
      const occ = occupancy(t, opts.blocks);
      if (!fitsWindows(t, occ.endMs, opts.windows)) continue;
      if (overlapsAny(occ.busy, busy)) continue;
      out.push(t);
    }
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

/** Can this exact start be booked? Same rules as freeStarts, one instant. */
export function canStartAt(opts: {
  startMs: number;
  windows: Interval[];
  busy: Interval[];
  blocks: SalonServiceBlock[];
}): boolean {
  const occ = occupancy(opts.startMs, opts.blocks);
  if (!fitsWindows(opts.startMs, occ.endMs, opts.windows)) return false;
  return !overlapsAny(occ.busy, mergeIntervals(opts.busy));
}

// ── "Anyone" ────────────────────────────────────────────────────────────────

export interface StaffDay {
  staffId: string;
  windows: Interval[];
  busy: Interval[];
  /** Appointments already that day — used to spread the work fairly. */
  bookedCount?: number;
}

/**
 * Slots across a team for a guest who doesn't mind who: each start lists the
 * staff free then, least-booked first, so "anyone" lands on whoever is
 * quietest instead of always the first name on the rota.
 */
export function teamFreeStarts(opts: {
  staff: StaffDay[];
  blocks: SalonServiceBlock[];
  stepMins: number;
  notBefore?: number;
  notAfter?: number;
  tz?: string;
}): Array<{ startMs: number; staffIds: string[] }> {
  const byStart = new Map<number, StaffDay[]>();
  for (const s of opts.staff) {
    for (const t of freeStarts({ ...opts, windows: s.windows, busy: s.busy })) {
      const list = byStart.get(t) ?? [];
      list.push(s);
      byStart.set(t, list);
    }
  }
  return Array.from(byStart.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([startMs, list]) => ({
      startMs,
      staffIds: list
        .slice()
        .sort((a, b) => (a.bookedCount ?? 0) - (b.bookedCount ?? 0))
        .map((s) => s.staffId),
    }));
}

// ── Money ───────────────────────────────────────────────────────────────────

export interface SalonAddon {
  id: string;
  name: string;
  price: number;
  durationMins: number;
}

export interface SalonLine extends SalonServiceBlock {
  serviceId: string;
  name: string;
  price: number;
  addons?: SalonAddon[];
  depositType?: string | null;
  depositValue?: number | null;
}

/** A service line's own minutes, add-ons included. */
export function lineBlock(line: SalonLine): SalonServiceBlock {
  const extra = (line.addons ?? []).reduce((s, a) => s + Math.max(0, Number(a.durationMins) || 0), 0);
  return {
    durationMins: (Number(line.durationMins) || 0) + extra,
    bufferMins: line.bufferMins,
    processingStartMins: line.processingStartMins,
    processingMins: line.processingMins,
  };
}

export function linePrice(line: SalonLine): number {
  const extra = (line.addons ?? []).reduce((s, a) => s + (Number(a.price) || 0), 0);
  return round2((Number(line.price) || 0) + extra);
}

export function linesTotal(lines: SalonLine[]): number {
  return round2(lines.reduce((s, l) => s + linePrice(l), 0));
}

/**
 * The deposit for a booking: each service's own rule, summed.
 *   FIXED   — depositValue pounds (never more than the line)
 *   PERCENT — depositValue % of the line
 *   FULL    — the whole line
 */
export function depositFor(lines: SalonLine[]): number {
  let total = 0;
  for (const l of lines) {
    const price = linePrice(l);
    const v = Number(l.depositValue) || 0;
    switch (String(l.depositType ?? "NONE").toUpperCase()) {
      case "FIXED":
        total += Math.min(price, Math.max(0, v));
        break;
      case "PERCENT":
        total += (price * Math.min(100, Math.max(0, v))) / 100;
        break;
      case "FULL":
        total += price;
        break;
      default:
        break;
    }
  }
  return round2(total);
}

/** Staff commission on service takings (reports only). */
export function commissionOn(amount: number, percent: number | null | undefined): number {
  const p = Number(percent) || 0;
  if (p <= 0) return 0;
  return round2((amount * Math.min(100, p)) / 100);
}


// ── Walk-in queue ───────────────────────────────────────────────────────────

export interface QueueBarber {
  staffId: string;
  /** Working windows left today. */
  windows: Interval[];
  /** Appointments + whoever is in the chair now. */
  busy: Interval[];
}

export interface QueueWaiter {
  id: string;
  mins: number;
  preferredStaffId?: string | null;
}

/**
 * Estimate when each person in the queue gets a chair, in order.
 *
 * Greedy, like a real shop floor: the first in line takes the earliest chair
 * that can fit their cut before that barber's next booking; that time is then
 * spoken for and the next person is placed. Someone waiting for a particular
 * barber only looks at that barber.
 *
 * Returns null for anyone who can't be fitted in today.
 */
export function estimateQueue(opts: {
  now: number;
  barbers: QueueBarber[];
  queue: QueueWaiter[];
  stepMins?: number;
}): Array<{ id: string; startMs: number | null; staffId: string | null; waitMins: number | null }> {
  const step = Math.max(1, opts.stepMins ?? 5);
  const busy = new Map(opts.barbers.map((b) => [b.staffId, mergeIntervals(b.busy)]));
  const out: Array<{ id: string; startMs: number | null; staffId: string | null; waitMins: number | null }> = [];
  for (const w of opts.queue) {
    const blocks = [{ durationMins: Math.max(5, w.mins) }];
    let best: { startMs: number; staffId: string } | null = null;
    for (const b of opts.barbers) {
      if (w.preferredStaffId && b.staffId !== w.preferredStaffId) continue;
      const windows = b.windows
        .map((x) => ({ start: Math.max(x.start, opts.now), end: x.end }))
        .filter((x) => x.end > x.start);
      // Not clock-aligned: a walk-in sits down the minute a chair is free.
      for (const win of windows) {
        let found: number | null = null;
        for (let t = win.start; t + w.mins * MIN <= win.end; t += step * MIN) {
          if (canStartAt({ startMs: t, windows, busy: busy.get(b.staffId) ?? [], blocks })) {
            found = t;
            break;
          }
        }
        if (found !== null) {
          if (!best || found < best.startMs) best = { startMs: found, staffId: b.staffId };
          break;
        }
      }
    }
    if (best) {
      const list = busy.get(best.staffId) ?? [];
      list.push({ start: best.startMs, end: best.startMs + w.mins * MIN });
      busy.set(best.staffId, mergeIntervals(list));
      out.push({
        id: w.id,
        startMs: best.startMs,
        staffId: best.staffId,
        waitMins: Math.max(0, Math.round((best.startMs - opts.now) / MIN)),
      });
    } else {
      out.push({ id: w.id, startMs: null, staffId: null, waitMins: null });
    }
  }
  return out;
}

// ── Wording ─────────────────────────────────────────────────────────────────

/** What a trade calls the people and the thing being booked. */
export function salonWords(trade: string | null | undefined): {
  staff: string;
  staffPlural: string;
  chair: string;
} {
  switch (String(trade ?? "").toUpperCase()) {
    case "HAIR":
      return { staff: "Stylist", staffPlural: "Stylists", chair: "chair" };
    case "NAILS":
      return { staff: "Nail tech", staffPlural: "Nail techs", chair: "station" };
    case "BEAUTY":
      return { staff: "Therapist", staffPlural: "Therapists", chair: "room" };
    default:
      return { staff: "Barber", staffPlural: "Barbers", chair: "chair" };
  }
}

/** "1h 15m", "45 min". */
export function formatMinutes(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}
