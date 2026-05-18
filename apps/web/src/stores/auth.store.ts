"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { authClient } from "../lib/api/auth.client";
import { registerAuthCallbacks } from "../lib/api/client";
import type { AuthState, UserProfile, LoginCredentials } from "../types/auth.types";

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
      // After hydration from localStorage, register token callbacks on the
      // Axios client so the interceptor can access the current tokens.
      onRehydrateStorage: () => (state) => {
        if (state) {
          registerAuthCallbacks({
            getAccessToken: () => state.accessToken,
            getRefreshToken: () => state.refreshToken,
            setTokens: state.setTokens,
            clearTokens: state.clearTokens,
          });
        }
      },
    },
  ),
);

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
