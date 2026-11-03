"use client";

// The link in the sign-up email lands here: confirm the address, sign them
// in, and send them on to their basket (or the home page if it's empty).

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { eflCustomerApi, EflApiError } from "@/lib/api/efl-customer";
import { useEflHref } from "../efl-base-context";
import { FOCUS } from "../efl-styles";
import { basketCount, useBasket } from "./basket";
import { useBasketReady } from "./basket-drawer";
import { Shell } from "./checkout-page";
import { useEflSession } from "./session";

export function ConfirmEmail() {
  useBasketReady();
  const href = useEflHref();
  const token = useSearchParams().get("token");
  const signIn = useEflSession((s) => s.signIn);
  const hasBasket = useBasket((s) => basketCount(s.lines) > 0);
  const [state, setState] = useState<{ kind: "working" } | { kind: "done" } | { kind: "failed"; message: string }>({ kind: "working" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) {
      setState({ kind: "failed", message: "This link is missing its code. Open the link from the email again." });
      return;
    }
    eflCustomerApi
      .verifyEmail(token)
      .then((res) => {
        signIn(res);
        setState({ kind: "done" });
      })
      .catch((err) =>
        setState({
          kind: "failed",
          message: err instanceof EflApiError ? err.message : "We couldn't confirm your email. Please try the link again.",
        }),
      );
  }, [token, signIn]);

  return (
    <Shell>
      <div className="mx-auto flex max-w-[480px] flex-col items-center gap-3 px-4 py-24 text-center">
        {state.kind === "working" ? (
          <p role="status" className="m-0 flex items-center gap-2 text-[#5E5E5E]">
            <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" /> Confirming your email…
          </p>
        ) : state.kind === "done" ? (
          <>
            <CheckCircle2 aria-hidden="true" className="h-12 w-12" />
            <h1 className="m-0 text-[28px] font-extrabold tracking-[-0.02em]">You&rsquo;re in</h1>
            <p className="m-0 text-[#5E5E5E]">Your email is confirmed and you&rsquo;re signed in. You can sign in to the app with it too.</p>
            <Link
              href={href(hasBasket ? "/checkout" : "/")}
              className={`efl-press mt-2 inline-flex min-h-[48px] items-center rounded-full bg-[#0B0B0B] px-6 font-bold text-white ${FOCUS}`}
            >
              {hasBasket ? "Back to checkout" : "Find food"}
            </Link>
          </>
        ) : (
          <>
            <XCircle aria-hidden="true" className="h-12 w-12" />
            <h1 className="m-0 text-[28px] font-extrabold tracking-[-0.02em]">That link didn&rsquo;t work</h1>
            <p className="m-0 text-[#5E5E5E]">{state.message}</p>
            <Link
              href={href("/")}
              className={`efl-press mt-2 inline-flex min-h-[48px] items-center rounded-full bg-[#0B0B0B] px-6 font-bold text-white ${FOCUS}`}
            >
              Go to Eat For Less
            </Link>
          </>
        )}
      </div>
    </Shell>
  );
}
