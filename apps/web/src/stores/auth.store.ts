"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { authClient } from "../lib/api/auth.client";
import { registerAuthCallbacks } from "../lib/api/client";
import type { AuthState, LoginCredentials } from "../types/auth.types";

interface AuthActions {
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  refreshUser: () => Promise<void>;
  setTokens: (accessToken: string, refreshToken: string) => void;
  clearTokens: () => void;
}

type AuthStore = AuthState & AuthActions;

export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      // ── State ───────────────────────────────────────────
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      // ── Actions ──────────────────────────────────────────
      login: async (credentials) => {
        set({ isLoading: true, error: null });
        try {
          const { tokens, user } = await authClient.login(credentials);
          set({
            user,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : "Login failed";
          set({ isLoading: false, error: message, isAuthenticated: false });
          throw err; // Re-throw so form components can handle it
        }
      },

      logout: async () => {
        const { refreshToken } = get();
        set({ isLoading: true });
        try {
          if (refreshToken) await authClient.logout(refreshToken);
        } catch {
          // Best-effort — clear local state regardless
        } finally {
          set({
            user: null,
            accessToken: null,
            refreshToken: null,
            isAuthenticated: false,
            isLoading: false,
            error: null,
          });
        }
      },

      logoutAll: async () => {
        set({ isLoading: true });
        try {
          await authClient.logoutAll();
        } finally {
          set({
            user: null,
            accessToken: null,
            refreshToken: null,
            isAuthenticated: false,
            isLoading: false,
            error: null,
          });
        }
      },

      refreshUser: async () => {
        try {
          const user = await authClient.getMe();
          set({ user });
        } catch {
          // If /me fails after a valid token, something is wrong — clear state
          get().clearTokens();
        }
      },

      setTokens: (accessToken, refreshToken) => {
        set({ accessToken, refreshToken, isAuthenticated: true });
      },

      clearTokens: () => {
        set({
          user: null,
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
        });
      },
    }),
    {
      name: "orderhub-auth",
      storage: createJSONStorage(() => localStorage),
      // Only persist tokens and user — not loading/error state
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
);

// Cross-tab token freshness.
//
// Refresh tokens ROTATE server-side: when tab A refreshes, the token tab B
// holds in memory becomes stale, and replaying it used to trip the server's
// theft detection and log the user out of EVERYTHING ("the app randomly
// logs me out"). zustand's persist middleware does not sync between tabs on
// its own, so:
//   1. getRefreshToken reads the freshest persisted value straight from
//      localStorage (another tab may have rotated it after this tab loaded);
//   2. a `storage` listener rehydrates this tab's store whenever another tab
//      writes new tokens, keeping the access token current too.
const PERSIST_KEY = "orderhub-auth";

function freshestRefreshToken(): string | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const persisted = parsed?.state?.refreshToken;
      if (typeof persisted === "string" && persisted) return persisted;
    }
  } catch {
    /* fall through to in-memory state */
  }
  return useAuthStore.getState().refreshToken;
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === PERSIST_KEY) {
      void useAuthStore.persist.rehydrate();
    }
  });
}

// Register Axios token callbacks using live store state.
//
// IMPORTANT: do NOT capture a state snapshot here (e.g. via onRehydrateStorage).
// Snapshots capture the value at hydration time (null on first visit) and never
// reflect tokens written to the store after login — causing every post-login API
// call to go out without an Authorization header and silently failing with 401.
//
// Using useAuthStore.getState() ensures the interceptor always reads the current
// token, whether the user just logged in or the page was reloaded from localStorage.
registerAuthCallbacks({
  getAccessToken: () => useAuthStore.getState().accessToken,
  getRefreshToken: freshestRefreshToken,
  setTokens: (accessToken, refreshToken) =>
    useAuthStore.getState().setTokens(accessToken, refreshToken),
  clearTokens: () => useAuthStore.getState().clearTokens(),
});

// Convenience selector — avoids re-renders when unrelated state changes
export const selectUser = (s: AuthStore) => s.user;
export const selectIsAuthenticated = (s: AuthStore) => s.isAuthenticated;
export const selectPermissions = (s: AuthStore) => s.user?.permissions ?? [];

// Permission helper for conditional rendering
export function useHasPermission(permission: string): boolean {
  const permissions = useAuthStore(selectPermissions);
  const role = useAuthStore((s) => s.user?.role);
  if (role === "PLATFORM_ADMIN") return true;
  return permissions.includes(permission);
}
