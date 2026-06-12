"use client";

// Phase AP-AUTH increment 2b — fallback Google-callback landing.
//
// Lives at /auth/google-callback (no storefront slug). The API
// redirects here when the OAuth `state` parameter was missing — i.e.
// someone initiated the Google flow without a storefront slug attached
// (a direct test, an old link, or a bug where the slug got stripped).
//
// We still drop the token in localStorage so they're signed in, then
// take them to the marketing home where they can navigate to a
// storefront. Better than a 404.

import { useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, XCircle } from "lucide-react";
import Link from "next/link";

const TOKEN_KEY = "orderhub.customerToken";

export default function GoogleCallbackFallbackPage() {
  return (
    <Suspense fallback={<div className="grid min-h-screen place-items-center" />}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const router = useRouter();
  const sp = useSearchParams();
  const token = sp.get("token");

  useEffect(() => {
    if (!token) return;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(TOKEN_KEY, token);
    }
    const t = setTimeout(() => {
      router.replace("/");
    }, 1200);
    return () => clearTimeout(t);
  }, [token, router]);

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
            <p className="mt-2 text-sm text-zinc-600">
              Taking you to the home page…
            </p>
          </>
        ) : (
          <>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-red-100 text-red-600">
              <XCircle className="h-6 w-6" />
            </div>
            <h1 className="mt-4 text-lg font-bold text-zinc-900">
              Sign-in didn&apos;t complete
            </h1>
            <p className="mt-2 text-sm text-zinc-600">
              No token came back. Please try again from your restaurant&apos;s
              order page.
            </p>
            <Link
              href="/"
              className="mt-5 inline-block rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white"
            >
              Back to home
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
