"use client";

import { create } from "zustand";

// Phase AW-28 — Sidebar visibility state.
//
// Lives in a tiny zustand store so the Topbar toggle and the dashboard
// layout can share state without either becoming a server-component-
// busting client wrapper around the whole tree.
//
// The dashboard always OPENS fullscreen (sidebarCollapsed = true). This
// used to be persisted, which left phones and tills stuck with the rail
// eating half the screen until someone found the arrow button. It is no
// longer persisted on purpose: every load starts fullscreen.
//
// While fullscreen, the logo button in the Topbar slides the sidebar in
// as an overlay (drawerOpen). Picking a page closes it again, so the new
// page is fullscreen too. The Maximize/Minimize button still docks the
// rail beside the content for anyone on a wide screen who wants it.

interface LayoutState {
  sidebarCollapsed: boolean;
  drawerOpen: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  setDrawerOpen: (v: boolean) => void;
}

export const useLayoutStore = create<LayoutState>()((set) => ({
  sidebarCollapsed: true,
  drawerOpen: false,
  toggleSidebar: () =>
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed, drawerOpen: false })),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v, drawerOpen: false }),
  setDrawerOpen: (v) => set({ drawerOpen: v }),
}));
