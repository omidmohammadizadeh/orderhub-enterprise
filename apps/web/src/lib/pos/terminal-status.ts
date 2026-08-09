"use client";

// Reader setup progress, pushed from the native app.
//
// Apple's Tap to Pay App Review checklist asks for two things the POS can
// only show if it knows what the SDK is doing:
//   • 3.9.1 — a configuration progress indicator while the reader is being
//     set up, so the operator knows it isn't stuck.
//   • 5.7   — an "initializing" state if they hit Charge before it's ready.
//
// The native side publishes these (see apps/mobile/src/services/terminal.ts
// and the PosWebView bridge) into window.__ohTerminalStatus. On the plain
// desktop dashboard none of this exists, so every export here degrades to a
// harmless no-op.

export type TerminalStage =
  | "idle"
  | "connecting"
  | "discovering"
  | "updating"
  | "connected"
  | "disconnected";

export interface TerminalStatus {
  stage: TerminalStage;
  /** 0..1 while reader software is installing. */
  progress?: number;
  message?: string;
}

type Listener = (s: TerminalStatus) => void;

interface StatusWindow {
  __ohTerminalStatusListeners?: Listener[];
  __ohTerminalStatus?: (s: TerminalStatus) => void;
  OrderHubTerminal?: { lastStatus?: TerminalStatus };
}

function w(): StatusWindow | null {
  return typeof window === "undefined" ? null : (window as StatusWindow);
}

/** Latest known stage — safe to read on mount, before any event arrives. */
export function getTerminalStatus(): TerminalStatus {
  return w()?.OrderHubTerminal?.lastStatus ?? { stage: "idle" };
}

/** Subscribe to setup progress. Returns an unsubscribe function. */
export function subscribeTerminalStatus(cb: Listener): () => void {
  const win = w();
  if (!win) return () => {};
  // The native bridge installs __ohTerminalStatus and fans out to this array.
  // Create it here too so a listener that mounts BEFORE the bridge script has
  // run still gets wired up rather than silently missing every event.
  const list = (win.__ohTerminalStatusListeners ??= []);
  list.push(cb);
  return () => {
    const i = list.indexOf(cb);
    if (i >= 0) list.splice(i, 1);
  };
}

/** True while the reader is still being configured — the moment Apple wants
 *  an "initializing", not a dead spinner or a silently disabled button. */
export function isPreparing(s: TerminalStatus): boolean {
  return s.stage === "connecting" || s.stage === "discovering" || s.stage === "updating";
}
