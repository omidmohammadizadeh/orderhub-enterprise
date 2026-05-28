"use client";

// ── Selected-Location Store ─────────────────────────────────────────────────
// The current location filter applied to the dashboard. Base44 stored this
// in localStorage under "selected_locations" and broadcast a
// `selectedLocationsChanged` window event. We use Zustand persist for the
// same outcome with cleaner ergonomics — components subscribe with the
// useSelectedLocation hook and re-render automatically.
//
// `null` means "all locations" (only useful for PLATFORM_ADMIN — regular
// roles always have a default location). The store does not enforce the
// permission boundary; that's the API's job. The store is purely UI state.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface SelectedLocationState {
  selectedLocationId: string | null;
  setSelectedLocationId: (id: string | null) => void;
}

export const useSelectedLocationStore = create<SelectedLocationState>()(
  persist(
    (set) => ({
      selectedLocationId: null,
      setSelectedLocationId: (id) => set({ selectedLocationId: id }),
    }),
    {
      name: "orderhub-selected-location",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

export const selectSelectedLocationId = (s: SelectedLocationState) =>
  s.selectedLocationId;
