"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth.store";
import { authClient } from "@/lib/api/auth.client";

// Full-screen spinner shown while determining auth state
function AuthLoadingScreen() {
  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 rounded-full border-2 border-orange-500 border-t-transparent animate-spin" />
        <p className="text-sm text-zinc-400">Loading workspace…</p>
      </div>
    </div>
  );
}

// AuthGuard wraps the entire dashboard layout.
//
// Auth check sequence:
//   1. Wait for Zustand to hydrate from localStorage (mounted state)
//   2. If not authenticated → redirect to /login immediately
//   3. If authenticated → hit /auth/me to validate the token is still live
//      (the access token may have expired while the browser was closed)
//   4. Render children only when we have a confirmed valid session
//
// This prevents:
//   - Flash of dashboard content for unauthenticated users
//   - Stale token acceptance (token expired but still in localStorage)
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [verified, setVerified] = useState(false);

  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const setUser = useAuthStore((s) => s.setUser);
  const clearTokens = useAuthStore((s) => s.clearTokens);
  const router = useRouter();

  // Step 1: Wait for Zustand hydration from localStorage.
  // Without this, isAuthenticated is always false on first render (SSR default).
  useEffect(() => {
    setMounted(true);
  }, []);

  // Step 2 + 3: Once hydrated, check auth state and validate with API.
  useEffect(() => {
    if (!mounted) return;

    if (!isAuthenticated || !accessToken) {
      router.replace("/login");
      return;
    }

    // Token exists in store — validate it's still accepted by the server.
    // Write the fresh profile back into the store so role/permissions
    // changes (e.g. an admin promotion done in the DB) take effect on the
    // next load without a full re-login — /auth/me reads the role from the
    // DB, not the possibly-stale JWT claim.
    authClient
      .getMe()
      .then((profile) => {
        setUser(profile as any);
        setVerified(true);
      })
      .catch(() => {
        // /me returned 401 — token is invalid or expired beyond refresh window.
        // Clear state and redirect. The Axios interceptor may have already
        // attempted a refresh; if we're here, it also failed.
        clearTokens();
        router.replace("/login");
      });
  }, [mounted, isAuthenticated, accessToken, router, clearTokens, setUser]);

  if (!mounted || !verified) {
    return <AuthLoadingScreen />;
  }

  return <>{children}</>;
}
