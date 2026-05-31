"use client";

// Phase AO — OAuth callback landing.
//
// The API redirects here after a successful Google sign-in with two
// query params (`access` + `refresh`). We pluck them from the URL,
// hand them to the auth store, then send the operator into the
// dashboard. If the API redirected back with `?error=…` instead we
// surface it on the login screen.

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuthStore } from "@/stores/auth.store";
import { authClient } from "@/lib/api/auth.client";
import { Loader2 } from "lucide-react";

export default function OAuthCallbackPage() {
  const router = useRouter();
  const params = useSearchParams();
  const setTokens = useAuthStore((s) => s.setTokens);

  useEffect(() => {
    const accessToken = params.get("access");
    const refreshToken = params.get("refresh");
    const error = params.get("error");

    if (error) {
      router.replace(`/login?error=${encodeURIComponent(error)}`);
      return;
    }
    if (!accessToken || !refreshToken) {
      router.replace("/login?error=oauth_missing_tokens");
      return;
    }

    setTokens(accessToken, refreshToken);

    // Pull the user profile so the dashboard layout has it without a
    // refresh. Best-effort — if it fails we still land the operator on
    // the dashboard and the JwtAuthGuard there will fetch it.
    authClient
      .getMe()
      .then((user) =>
        useAuthStore.setState({
          user,
          accessToken,
          refreshToken,
          isAuthenticated: true,
        }),
      )
      .catch(() => undefined)
      .finally(() => router.replace("/dashboard"));
  }, [params, router, setTokens]);

  return (
    <div className="flex min-h-screen items-center justify-center text-zinc-500">
      <div className="flex flex-col items-center gap-2 text-sm">
        <Loader2 className="h-5 w-5 animate-spin" />
        Signing you in…
      </div>
    </div>
  );
}
