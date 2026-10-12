// Salon settings — Location.settings.salon. No columns: the same
// shallow-merged JSON every other per-location feature keeps its switches in.

export interface SalonSettings {
  /** BARBER | HAIR | NAILS | BEAUTY — wording and defaults only. */
  trade: "BARBER" | "HAIR" | "NAILS" | "BEAUTY";
  onlineBookingEnabled: boolean;
  /** Time grid for starts (:00, :15 …). */
  slotStepMins: number;
  /** Guests can't book closer than this to now. */
  leadTimeMins: number;
  maxDaysAhead: number;
  /** Free cancellation / reschedule up to this many hours before. */
  cancellationWindowHours: number;
  /** Guests may change or cancel online from their link. */
  allowGuestChanges: boolean;
  /** A no-show keeps the deposit (the usual rule). */
  forfeitDepositOnNoShow: boolean;
  /** Reminder before the appointment. */
  reminderEnabled: boolean;
  reminderHoursBefore: number;
  /** Also text it (debits the SMS wallet). Email is free. */
  reminderSms: boolean;
  /** "Time for a trim?" N days after a visit; 0 = off. */
  rebookAfterDays: number;
  /** "Thanks — leave us a review" a few hours after a visit (needs the
   *  location's Google review link). */
  reviewRequestEnabled: boolean;
  /** Walk-in queue on for this shop. */
  queueEnabled: boolean;
  /** Customers can join the queue from their phone. */
  queueOnlineJoin: boolean;
  /** Text a walk-in when they're called up (debits the SMS wallet). */
  queueCallSms: boolean;
  /** Shown on the booking page above "Confirm". */
  bookingPolicy: string;
  /** Ask online guests to pick a barber, or offer "Anyone" first. */
  offerAnyStaff: boolean;
}

export const SALON_DEFAULTS: SalonSettings = {
  trade: "BARBER",
  onlineBookingEnabled: false,
  slotStepMins: 15,
  leadTimeMins: 30,
  maxDaysAhead: 60,
  cancellationWindowHours: 24,
  allowGuestChanges: true,
  forfeitDepositOnNoShow: true,
  reminderEnabled: true,
  reminderHoursBefore: 24,
  reminderSms: false,
  rebookAfterDays: 0,
  reviewRequestEnabled: true,
  queueEnabled: true,
  queueOnlineJoin: true,
  queueCallSms: false,
  bookingPolicy: "",
  offerAnyStaff: true,
};

const TRADES = ["BARBER", "HAIR", "NAILS", "BEAUTY"] as const;

function num(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}

/** Read (and clamp) whatever is stored, filling gaps with the defaults. */
export function readSalonSettings(locationSettings: unknown): SalonSettings {
  const raw = ((locationSettings as any)?.salon ?? {}) as Record<string, unknown>;
  const trade = String(raw.trade ?? "").toUpperCase();
  return {
    trade: (TRADES as readonly string[]).includes(trade)
      ? (trade as SalonSettings["trade"])
      : SALON_DEFAULTS.trade,
    onlineBookingEnabled: bool(raw.onlineBookingEnabled, SALON_DEFAULTS.onlineBookingEnabled),
    slotStepMins: [5, 10, 15, 20, 30, 60].includes(Number(raw.slotStepMins))
      ? Number(raw.slotStepMins)
      : SALON_DEFAULTS.slotStepMins,
    leadTimeMins: num(raw.leadTimeMins, 0, 7 * 24 * 60, SALON_DEFAULTS.leadTimeMins),
    maxDaysAhead: num(raw.maxDaysAhead, 1, 365, SALON_DEFAULTS.maxDaysAhead),
    cancellationWindowHours: num(raw.cancellationWindowHours, 0, 168, SALON_DEFAULTS.cancellationWindowHours),
    allowGuestChanges: bool(raw.allowGuestChanges, SALON_DEFAULTS.allowGuestChanges),
    forfeitDepositOnNoShow: bool(raw.forfeitDepositOnNoShow, SALON_DEFAULTS.forfeitDepositOnNoShow),
    reminderEnabled: bool(raw.reminderEnabled, SALON_DEFAULTS.reminderEnabled),
    reminderHoursBefore: num(raw.reminderHoursBefore, 1, 72, SALON_DEFAULTS.reminderHoursBefore),
    reminderSms: bool(raw.reminderSms, SALON_DEFAULTS.reminderSms),
    rebookAfterDays: num(raw.rebookAfterDays, 0, 365, SALON_DEFAULTS.rebookAfterDays),
    reviewRequestEnabled: bool(raw.reviewRequestEnabled, SALON_DEFAULTS.reviewRequestEnabled),
    queueEnabled: bool(raw.queueEnabled, SALON_DEFAULTS.queueEnabled),
    queueOnlineJoin: bool(raw.queueOnlineJoin, SALON_DEFAULTS.queueOnlineJoin),
    queueCallSms: bool(raw.queueCallSms, SALON_DEFAULTS.queueCallSms),
    bookingPolicy: String(raw.bookingPolicy ?? "").slice(0, 2000),
    offerAnyStaff: bool(raw.offerAnyStaff, SALON_DEFAULTS.offerAnyStaff),
  };
}

/** Merge a partial update over what is stored, through the same clamps. */
export function mergeSalonSettings(locationSettings: unknown, patch: Record<string, unknown>): SalonSettings {
  const current = readSalonSettings(locationSettings);
  return readSalonSettings({ salon: { ...current, ...(patch ?? {}) } });
}

/** Trade defaults applied when a location first becomes a salon. */
export function tradeDefaults(trade: string): Partial<SalonSettings> {
  switch (String(trade).toUpperCase()) {
    case "HAIR":
      return { trade: "HAIR", queueEnabled: false, rebookAfterDays: 42, slotStepMins: 15 };
    case "NAILS":
      return { trade: "NAILS", queueEnabled: false, rebookAfterDays: 21, slotStepMins: 15 };
    case "BEAUTY":
      return { trade: "BEAUTY", queueEnabled: false, rebookAfterDays: 28, slotStepMins: 15 };
    default:
      return { trade: "BARBER", queueEnabled: true, rebookAfterDays: 21, slotStepMins: 15 };
  }
}

/** Can a guest still change this appointment themselves, free? */
export function guestCanChange(
  settings: SalonSettings,
  startsAt: Date,
  now: Date = new Date(),
): { allowed: boolean; free: boolean } {
  if (!settings.allowGuestChanges) return { allowed: false, free: false };
  if (startsAt.getTime() <= now.getTime()) return { allowed: false, free: false };
  const hoursLeft = (startsAt.getTime() - now.getTime()) / 3_600_000;
  return { allowed: true, free: hoursLeft >= settings.cancellationWindowHours };
}

export const LIVE_APPOINTMENT_STATUSES = [
  "PENDING_PAYMENT",
  "CONFIRMED",
  "CHECKED_IN",
  "IN_SERVICE",
] as const;

export const APPOINTMENT_STATUSES = [
  ...LIVE_APPOINTMENT_STATUSES,
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/**
 * Which status moves staff may make. Forward through the visit, plus the
 * two ways out (cancel, no-show) and an undo for a mis-tap on check-in.
 */
export function canMoveStatus(from: string, to: string): boolean {
  if (from === to) return false;
  const allowed: Record<string, string[]> = {
    PENDING_PAYMENT: ["CONFIRMED", "CANCELLED"],
    CONFIRMED: ["CHECKED_IN", "IN_SERVICE", "COMPLETED", "CANCELLED", "NO_SHOW"],
    CHECKED_IN: ["CONFIRMED", "IN_SERVICE", "COMPLETED", "CANCELLED", "NO_SHOW"],
    IN_SERVICE: ["CHECKED_IN", "COMPLETED", "CANCELLED"],
    NO_SHOW: ["CONFIRMED"],
    CANCELLED: ["CONFIRMED"],
    COMPLETED: [],
  };
  return (allowed[from] ?? []).includes(to);
}

const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function makeSalonReference(rand: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < 6; i++) out += REF_ALPHABET[Math.floor(rand() * REF_ALPHABET.length)];
  return `S-${out}`;
}
