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
    //
    // Sessions must survive until EXPLICIT logout. Only a definitive
    // 401/403 (the interceptor already tried a silent refresh and the
    // server rejected that too — the session chain is genuinely dead)
    // may clear tokens. Anything else — tablet wifi still waking up, a
    // deploy restarting the API, a rate-limit blip — is transient: retry
    // briefly, then proceed with the cached profile from localStorage.
    // Individual API calls will keep self-healing through the interceptor.
    let cancelled = false;
    const cachedUser = useAuthStore.getState().user;

    const validate = async () => {
      const delays = [0, 2_000, 4_000, 8_000];
      for (const delay of delays) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (cancelled) return;
        try {
          const profile = await authClient.getMe();
          if (cancelled) return;
          setUser(profile as any);
          setVerified(true);
          return;
        } catch (e: unknown) {
          const status = (e as { response?: { status?: number } })?.response
            ?.status;
          if (status === 401 || status === 403) {
            // Refresh was attempted and rejected — session is truly dead.
            if (cancelled) return;
            clearTokens();
            router.replace("/login");
            return;
          }
          // transient — loop to the next retry
        }
      }
      // Still unreachable after retries. If we have a cached profile,
      // let the operator in — the dashboard works from cache and every
      // request keeps retrying auth via the interceptor. Never bounce a
      // valid session to /login over connectivity.
      if (cancelled) return;
      if (cachedUser) {
        setVerified(true);
      } else {
        router.replace("/login");
      }
    };
    void validate();
    return () => {
      cancelled = true;
    };
  }, [mounted, isAuthenticated, accessToken, router, clearTokens, setUser]);

  if (!mounted || !verified) {
    return <AuthLoadingScreen />;
  }

  return <>{children}</>;
}
