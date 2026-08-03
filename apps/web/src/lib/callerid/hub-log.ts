"use client";

// What the caller-ID hub is actually doing, kept where a human can read it.
//
// The Comet path is four hops — USB serial → native shell → this web app →
// the API — and until now every one of them was silent. A dead box, a stale
// app build, a denied USB permission, a wrong baud rate and an unselected
// location all produced the same symptom: nothing happens. Diagnosing that
// took a USB cable and adb, which is fine for us and impossible for a
// restaurant.
//
// So the native shell now forwards every reader log (including the raw serial
// lines) as a `native:callerid:log` window event, and the web side records
// its own decisions here too. One buffer, one screen, one answer.

export type HubLogLevel = "info" | "error" | "ring" | "sent" | "dropped";

export interface HubLogEntry {
  at: string;
  level: HubLogLevel;
  message: string;
  /** The untouched serial line, when this entry came from one. */
  raw?: string;
}

/** In memory and capped: this is a live diagnostic, not an audit trail, and a
 *  tablet left running for a week must not accumulate a log of unbounded
 *  size. */
const MAX_ENTRIES = 200;

let entries: HubLogEntry[] = [];
const listeners = new Set<(e: HubLogEntry[]) => void>();

function emit() {
  const snapshot = entries;
  for (const fn of listeners) fn(snapshot);
}

export function hubLog(entry: HubLogEntry) {
  // Newest first — the answer is almost always the most recent line, and it
  // should be at the top without the reader scrolling.
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  emit();
}

/** Record something the WEB side decided, so a ring dropped in the browser is
 *  as visible as one the box never produced. */
export function hubRecord(level: HubLogLevel, message: string, raw?: string) {
  hubLog({ at: new Date().toISOString(), level, message, ...(raw ? { raw } : {}) });
}

export function getHubLog(): HubLogEntry[] {
  return entries;
}

export function clearHubLog() {
  entries = [];
  emit();
}

export function subscribeHubLog(fn: (e: HubLogEntry[]) => void): () => void {
  listeners.add(fn);
  fn(entries);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Start listening for the native shell's reader logs.
 *
 * Safe to call more than once — a second call replaces nothing and adds no
 * second listener, because the dashboard mounts this from a layout that can
 * remount on navigation.
 */
let attached = false;
export function attachHubLogBridge() {
  if (attached || typeof window === "undefined") return;
  attached = true;
  window.addEventListener("native:callerid:log", (e: Event) => {
    const d = (e as CustomEvent).detail as Partial<HubLogEntry> | undefined;
    if (!d?.message) return;
    hubLog({
      at: typeof d.at === "string" ? d.at : new Date().toISOString(),
      level: (d.level as HubLogLevel) ?? "info",
      message: String(d.message),
      ...(d.raw ? { raw: String(d.raw) } : {}),
    });
  });
}
