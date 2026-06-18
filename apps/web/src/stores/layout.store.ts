"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

// Phase AW-28 — Sidebar visibility state.
//
// Lives in a tiny zustand store (with localStorage persistence) so
// the Topbar toggle and the dashboard layout can share state without
// either becoming a server-component-busting client wrapper around
// the whole tree. Persisting across reloads lets an operator who
// likes the fullscreen view keep it after refresh.

interface LayoutState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (v: boolean) => void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      toggleSidebar: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
    }),
    { name: "orderhub-layout" },
  ),
);
