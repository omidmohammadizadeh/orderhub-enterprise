"use client";

// Phase AP-AUTH — email confirmation landing page.
//
// Customer clicks the link in the email → lands here → we hit
// /v1/customer-auth/verify, store the returned JWT, and bounce back
// to the storefront so they can finish ordering.

import { useEffect, useState, Suspense } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import axios from "axios";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "https://orderhub-api-0re6.onrender.com";
const TOKEN_KEY = "orderhub.customerToken";

export default function ConfirmPage() {
  // useSearchParams needs a Suspense wrapper in the App Router for the
  // static build to succeed (same pattern as AO-FIX-1).
  return (
    <Suspense fallback={<div className="grid min-h-screen place-items-center" />}>
      <ConfirmInner />
    </Suspense>
  );
}

function ConfirmInner() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const sp = useSearchParams();
  const token = sp.get("token");

  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string>("");

  useEffect(() => {
    if (!token) {
      setState("error");
      setErrorMessage("This confirmation link is missing its token.");
      return;
    }
    axios
      .get(`${API_BASE}/v1/customer-auth/verify`, { params: { token } })
      .then((res) => {
        // Persist token + bounce to the storefront. The storefront's
        // useCustomerAuth hook reads this on mount and shows the
        // signed-in state.
        if (typeof window !== "undefined") {
          window.localStorage.setItem(TOKEN_KEY, res.data.accessToken);
        }
        setState("ok");
        // Short delay so the "Email confirmed!" tick is visible.
        setTimeout(() => {
          router.replace(`/order/${params.slug}`);
        }, 1500);
      })
      .catch((err) => {
        setState("error");
        setErrorMessage(
          err?.response?.data?.message ??
            "This confirmation link is no longer valid.",
        );
      });
  }, [token, params.slug, router]);

  return (
    <div className="grid min-h-screen place-items-center bg-zinc-50 p-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 text-center shadow-sm">
        {state === "loading" && (
          <>
            <Loader2 className="mx-auto h-10 w-10 animate-spin text-zinc-400" />
            <p className="mt-4 text-sm text-zinc-600">
              Confirming your account…
            </p>
          </>
        )}
        {state === "ok" && (
          <>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-500 text-white">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <h1 className="mt-4 text-lg font-bold text-zinc-900">
              Email confirmed
            </h1>
            <p className="mt-2 text-sm text-zinc-600">
              Taking you back to the menu…
            </p>
          </>
        )}
        {state === "error" && (
          <>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-red-100 text-red-600">
              <XCircle className="h-6 w-6" />
            </div>
            <h1 className="mt-4 text-lg font-bold text-zinc-900">
              Couldn&apos;t confirm
            </h1>
            <p className="mt-2 text-sm text-zinc-600">{errorMessage}</p>
            <button
              onClick={() => router.replace(`/order/${params.slug}`)}
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
