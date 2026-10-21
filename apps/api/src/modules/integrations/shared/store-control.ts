// One shape for "is this shop trading on that channel, and pause/resume it".
//
// The three direct integrations already do this, each in its own words:
//
//   Uber Eats  setStoreOnline(tenantId, connectionId, online, reason, offlineUntil)
//              → ONLINE / OFFLINE, and Uber REJECTS an OFFLINE without an end time
//   Deliveroo  setStoreOpen(tenantId, connectionId, open)
//              → OPEN / CLOSED, no end time in the call at all
//   Just Eat   setStoreOnline(tenantId, connectionId, online, { onlineAt })
//              → no status getter; omitting onlineAt pauses INDEFINITELY
//
// Same operation, three vocabularies and three different answers to "when
// does the pause end". Anything that wants to act on all channels at once —
// a single Pause button, a holiday closure, a per-shop trading view — has to
// know all three today.
//
// This file is the vocabulary, nothing more: no HTTP, no Prisma, no Nest.
// Each platform keeps its own service exactly as it is and gets a thin
// adapter in its own module, so the existing call paths and their live-
// verified quirks are untouched.

export type StorePlatform = "UBER_EATS" | "DELIVEROO" | "JUST_EAT";

/** Normalised trading state. The platform's own word is kept alongside. */
export type StoreState = "OPEN" | "CLOSED" | "UNKNOWN";

export interface StoreStatus {
  state: StoreState;
  /** Exactly what the platform said, e.g. "ONLINE", "CLOSED". */
  raw: string;
  /** When the pause ends, where the platform tells us. */
  until: string | null;
  reason: string | null;
}

export interface StorePauseOptions {
  /**
   * When the pause ends.
   *
   * Uber requires one (it 400s without it, so its adapter defaults to +24h).
   * Just Eat treats a missing value as indefinite. Deliveroo's status call
   * has no such field and ignores it.
   */
  until?: Date | null;
  reason?: string;
}

export interface StoreControlDriver {
  readonly platform: StorePlatform;
  /** False for Just Eat, which has no read-back endpoint. */
  readonly canReadStatus: boolean;

  setStoreOpen(
    tenantId: string,
    connectionId: string,
    open: boolean,
    options?: StorePauseOptions,
  ): Promise<{ state: StoreState; raw: string }>;

  /** Throws StoreStatusUnavailableError when canReadStatus is false. */
  storeStatus(tenantId: string, connectionId: string): Promise<StoreStatus>;
}

export class StoreStatusUnavailableError extends Error {
  constructor(readonly platform: StorePlatform) {
    super(`${platform} has no store-status endpoint to read back.`);
    this.name = "StoreStatusUnavailableError";
  }
}

const OPEN_WORDS = new Set(["OPEN", "ONLINE", "ACTIVE", "TRADING"]);
const CLOSED_WORDS = new Set([
  "CLOSED",
  "OFFLINE",
  "PAUSED",
  "SUSPENDED",
  "INACTIVE",
]);

/**
 * Map a platform's own word onto OPEN / CLOSED.
 *
 * Unknown words read as UNKNOWN rather than guessing CLOSED: a shop shown as
 * closed when it is trading sends staff hunting for a problem that isn't
 * there, and one shown as open when it is closed is worse. `raw` always
 * carries the original so the UI can show what the platform actually said.
 */
export function normalizeStoreState(raw: unknown): StoreState {
  const word = String(raw ?? "").trim().toUpperCase();
  if (!word) return "UNKNOWN";
  if (OPEN_WORDS.has(word)) return "OPEN";
  if (CLOSED_WORDS.has(word)) return "CLOSED";
  return "UNKNOWN";
}

/**
 * The pause-end time to send, for platforms that insist on one.
 *
 * A time already in the past is the same bug as no time at all — it would
 * either be rejected or read as "resume immediately" — so it falls back to
 * the platform's default window.
 */
export function pauseEndsAt(
  until: Date | null | undefined,
  defaultWindowMs: number,
  now: Date = new Date(),
): Date {
  return until && until.getTime() > now.getTime()
    ? until
    : new Date(now.getTime() + defaultWindowMs);
}
