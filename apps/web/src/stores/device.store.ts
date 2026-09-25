"use client";

// ── Per-DEVICE settings ─────────────────────────────────────────────────────
//
// Which card machine and which receipt printer THIS tablet uses. Not a user
// setting and not a location setting — two tills in the same shop, signed in
// as the same staff, need different answers.
//
// Until this existed, every tablet picked "the first available machine" and
// printed to every printer in the building. In a two-till shop that means till
// B sends its total to the machine standing at till A — where a customer is
// mid-payment — and opens till A's cash drawer. Both are the kind of failure
// that looks like theft on the end-of-day.
//
// Keyed by LOCATION as well as device: a tablet that moves between sites, or
// an owner's laptop switching location in the sidebar, must not carry one
// shop's machine over to another.
//
// localStorage, deliberately: the device is the thing being identified, and
// there is no device identity on the server to hang this off. Clearing site
// data resets it, which is the same as a new tablet — it asks again.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface DeviceState {
  /** locationId → Dojo terminal id this tablet charges to. */
  cardMachineByLocation: Record<string, string>;
  /** locationId → printer id this tablet prints receipts to and kicks. */
  printerByLocation: Record<string, string>;
  setCardMachine: (locationId: string, terminalId: string | null) => void;
  setPrinter: (locationId: string, printerId: string | null) => void;
}

const without = (map: Record<string, string>, key: string) => {
  const next = { ...map };
  delete next[key];
  return next;
};

export const useDeviceStore = create<DeviceState>()(
  persist(
    (set) => ({
      cardMachineByLocation: {},
      printerByLocation: {},
      setCardMachine: (locationId, terminalId) =>
        set((s) => ({
          cardMachineByLocation: terminalId
            ? { ...s.cardMachineByLocation, [locationId]: terminalId }
            : without(s.cardMachineByLocation, locationId),
        })),
      setPrinter: (locationId, printerId) =>
        set((s) => ({
          printerByLocation: printerId
            ? { ...s.printerByLocation, [locationId]: printerId }
            : without(s.printerByLocation, locationId),
        })),
    }),
    { name: "orderhub-device", storage: createJSONStorage(() => localStorage) },
  ),
);

/**
 * Read the pins outside React — the printing helpers are plain functions
 * called from click handlers, not components.
 */
export function pinnedCardMachine(locationId?: string | null): string | null {
  if (!locationId) return null;
  return useDeviceStore.getState().cardMachineByLocation[locationId] ?? null;
}

export function pinnedPrinter(locationId?: string | null): string | null {
  if (!locationId) return null;
  return useDeviceStore.getState().printerByLocation[locationId] ?? null;
}

// ── The two selection rules ────────────────────────────────────────────────
// Kept here, as pure functions, because each has exactly one correct answer
// and two call sites. Inlined separately at each one, they drift — and a drift
// here sends money to the wrong counter or stops the kitchen copy.

/**
 * Which card machine this till charges to.
 *
 * Returns null rather than guessing when the shop has several machines and
 * this tablet hasn't claimed one. The old "first Available" guess is precisely
 * how one till's total reached a customer standing at another till's machine,
 * so not choosing is the safe answer: the UI asks instead.
 */
export function chooseCardMachine<T extends { id: string }>(
  terminals: T[],
  pinned: string | null,
): T | null {
  return (
    terminals.find((t) => t.id === pinned) ??
    (terminals.length === 1 ? terminals[0]! : undefined) ??
    null
  );
}

/**
 * Which printers a receipt goes to.
 *
 * A pin replaces the OTHER front counters and nothing else, so the kitchen,
 * bar and label printers still get their copy. If the pinned printer has been
 * removed we fall back to every reachable printer: a duplicate receipt is a
 * nuisance, no receipt is a lost order.
 */
export function chooseReceiptPrinters<T extends { id: string; kind?: string }>(
  reachable: T[],
  pinned: string | null,
): T[] {
  if (!pinned || !reachable.some((p) => p.id === pinned)) return reachable;
  return reachable.filter((p) => p.id === pinned || p.kind !== "FRONT_COUNTER");
}
