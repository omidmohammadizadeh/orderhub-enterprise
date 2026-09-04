"use client";

// ── Pending caller-ID fill ──────────────────────────────────────────────────
//
// The caller the operator tapped "Start order" on, waiting for the POS screen
// to pick it up.
//
// This used to travel in sessionStorage, read once inside POS's mount effect.
// That made it dependent on mount ORDER: "Start order" also switches the
// selected location, and if POS mounts, eats the key, and is then remounted by
// that location change, the second mount starts empty and the key is already
// gone — the caller vanishes and the operator types the number in by hand.
// Reading it on POS while already on POS worked, which is exactly why the bug
// looked like "only fills when you're on the POS tab".
//
// Held in memory instead, and cleared by the consumer once applied. POS reacts
// to the VALUE rather than to its own mount, so it no longer matters how many
// times POS mounts or in what order the two state updates land.
//
// Deliberately NOT persisted: a caller is only interesting for the seconds
// between the call and the order. Reloading tomorrow must not prefill a
// stranger's number.

import { create } from "zustand";
import type { CallerIdFill } from "@/components/pos/caller-id-popup";

interface PendingCallerState {
  pending: CallerIdFill | null;
  setPendingCaller: (fill: CallerIdFill | null) => void;
}

export const usePendingCallerStore = create<PendingCallerState>((set) => ({
  pending: null,
  setPendingCaller: (fill) => set({ pending: fill }),
}));
