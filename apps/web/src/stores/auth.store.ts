"use client";

import { useEffect, useState } from "react";
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
  setUser: (user: AuthState["user"]) => void;
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

      setUser: (user) => {
        set({ user });
      },

      setTokens: (accessToken, refreshToken) => {
        set({ accessToken, refreshToken, isAuthenticated: true });
        // Keep the native tablet shell's copy in step.
        //
        // The mobile app injects the tokens it holds in SecureStore on EVERY
        // launch. That copy was written once at login and never updated, so
        // after the web app rotated its refresh token a few times, killing
        // and reopening the app replayed a long-revoked token — and the
        // operator landed back on the sign-in page. Rotation happens here,
        // so this is the place to tell native about it.
        pushTokensToNative(accessToken, refreshToken);
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

/**
 * Has the persisted session been read back out of localStorage yet?
 *
 * This matters more than it looks. zustand v5 rehydrates through the
 * storage adapter's getItem, which the middleware always awaits — so
 * hydration completes in a microtask AFTER the store is created, and the
 * very first render sees the SSR defaults (`isAuthenticated: false`).
 *
 * Anything that redirects on "not authenticated" must therefore wait for
 * THIS, not merely for having mounted: a mount flag can win the race on a
 * cold start and bounce a perfectly valid session to /login. That is the
 * "it logs us out when I close and reopen the app" report — reopening is
 * exactly when hydration has to happen and no token is in memory yet.
 *
 * Returns false during SSR and on the first client render (so the server
 * and client agree), then flips once hydration lands.
 */
export function useAuthHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (useAuthStore.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    // Check-then-subscribe: hydration may finish between the check above
    // and the listener being attached, so onFinishHydration alone can miss.
    const unsub = useAuthStore.persist.onFinishHydration(() =>
      setHydrated(true),
    );
    if (useAuthStore.persist.hasHydrated()) setHydrated(true);
    return unsub;
  }, []);
  return hydrated;
}

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

/**
 * Hand the current token pair to the native shell, if we are inside one.
 * A no-op in a normal browser. Failures are swallowed: this is a
 * convenience for the next cold start, never something a running session
 * should depend on.
 */
function pushTokensToNative(accessToken: string, refreshToken: string): void {
  try {
    const rn = (window as any)?.ReactNativeWebView;
    if (!rn?.postMessage) return;
    rn.postMessage(
      JSON.stringify({ type: "tokens", accessToken, refreshToken }),
    );
  } catch {
    /* not in a WebView, or the bridge is gone — nothing to do */
  }
}

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
