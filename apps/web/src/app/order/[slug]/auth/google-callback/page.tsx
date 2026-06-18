"use client";

// Phase AP-AUTH increment 2b — Google OAuth landing page.
//
// The API redirects here with ?token=<jwt> after a successful Google
// sign-in. We store the token in localStorage so useCustomerAuth
// picks it up, then bounce the customer back to the storefront menu.

import { useEffect, Suspense } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { CheckCircle2, XCircle } from "lucide-react";

const TOKEN_KEY = "orderhub.customerToken";

export default function GoogleCallbackPage() {
  return (
    <Suspense fallback={<div className="grid min-h-screen place-items-center" />}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const router = useRouter();
  const params = useParams<{ slug: string }>();
  const sp = useSearchParams();
  const token = sp.get("token");
  const brand = sp.get("brand");

  useEffect(() => {
    if (!token) return;
    if (typeof window !== "undefined") {
      // eslint-disable-next-line no-console
      console.log(
        `[customer-auth] callback origin=${window.location.origin} writing token=${token.slice(0, 20)}...`,
      );
      window.localStorage.setItem(TOKEN_KEY, token);
      // Sanity check: read it straight back so we catch the case where
      // localStorage is blocked (private-window / quota / extension).
      const verify = window.localStorage.getItem(TOKEN_KEY);
      // eslint-disable-next-line no-console
      console.log(
        `[customer-auth] callback verify read=${verify ? "ok" : "FAILED"}`,
      );
    }
    // Tiny delay so the customer sees the green tick before the
    // redirect — feels intentional, not like a flicker.
    const t = setTimeout(() => {
      router.replace(
        `/order/${params.slug}${brand ? `?brand=${encodeURIComponent(brand)}` : ""}`,
      );
    }, 800);
    return () => clearTimeout(t);
  }, [token, params.slug, brand, router]);

  return (
    <div className="grid min-h-screen place-items-center bg-zinc-50 p-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 text-center shadow-sm">
        {token ? (
          <>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-500 text-white">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <h1 className="mt-4 text-lg font-bold text-zinc-900">
              You&apos;re signed in
            </h1>
            <p className="mt-2 text-sm text-zinc-600">Taking you to the menu…</p>
          </>
        ) : (
          <>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-red-100 text-red-600">
              <XCircle className="h-6 w-6" />
            </div>
            <h1 className="mt-4 text-lg font-bold text-zinc-900">
              Google sign-in didn&apos;t complete
            </h1>
            <p className="mt-2 text-sm text-zinc-600">
              No token came back. Please try again from the sign-in screen.
            </p>
            <button
              onClick={() =>
                router.replace(
                  `/order/${params.slug}${brand ? `?brand=${encodeURIComponent(brand)}` : ""}`,
                )
              }
              className="mt-5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white"
            >
              Back to menu
            </button>
          </>
        )}
      </div>
    </div>
  );
}
