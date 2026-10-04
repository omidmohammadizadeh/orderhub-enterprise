"use client";

// Where a marketing email's "Unsubscribe" link lands. No login, one click.
// The token in the link is signed by the API, so it can only ever unsubscribe
// the person it was sent to.

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2, MailX } from "lucide-react";
import { emailMarketingClient } from "@/lib/api/email-marketing.client";

type Info = Awaited<ReturnType<typeof emailMarketingClient.unsubscribeInfo>>;

function UnsubscribeInner() {
  const t = useSearchParams().get("t") ?? "";
  const [info, setInfo] = useState<Info | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "done" | "back" | "error">("idle");

  useEffect(() => {
    let cancelled = false;
    emailMarketingClient
      .unsubscribeInfo(t)
      .then((i) => !cancelled && setInfo(i))
      .catch(() => !cancelled && setInfo({ valid: false }));
    return () => {
      cancelled = true;
    };
  }, [t]);

  const act = async (fn: (t: string) => Promise<{ ok: boolean }>, next: "done" | "back") => {
    setState("busy");
    try {
      const r = await fn(t);
      setState(r.ok ? next : "error");
    } catch {
      setState("error");
    }
  };

  if (!info) {
    return <Loader2 className="mx-auto h-6 w-6 animate-spin text-zinc-400" />;
  }
  if (!info.valid) {
    return (
      <>
        <MailX className="mx-auto h-10 w-10 text-zinc-400" />
        <h1 className="mt-4 text-xl font-bold text-zinc-900">This link isn&apos;t valid</h1>
        <p className="mt-2 text-sm text-zinc-600">
          Please use the unsubscribe link in the most recent email you received, or reply to that email and ask to be
          removed.
        </p>
      </>
    );
  }

  const unsubscribed = state === "done" || (info.status && info.status !== "SUBSCRIBED" && state !== "back");
  if (unsubscribed) {
    return (
      <>
        <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
        <h1 className="mt-4 text-xl font-bold text-zinc-900">You&apos;re unsubscribed</h1>
        <p className="mt-2 text-sm text-zinc-600">
          {info.email} won&apos;t receive marketing emails from {info.brandName} any more. You&apos;ll still get receipts
          for orders you place.
        </p>
        {info.status !== "BOUNCED" && info.status !== "COMPLAINED" && !info.test && (
          <button
            onClick={() => act(emailMarketingClient.resubscribe, "back")}
            disabled={state === "busy"}
            className="mt-6 text-sm font-medium text-zinc-500 underline hover:text-zinc-800"
          >
            Unsubscribed by mistake? Subscribe again
          </button>
        )}
      </>
    );
  }

  return (
    <>
      <MailX className="mx-auto h-10 w-10 text-zinc-500" />
      <h1 className="mt-4 text-xl font-bold text-zinc-900">
        {state === "back" ? "Welcome back!" : `Unsubscribe from ${info.brandName}?`}
      </h1>
      <p className="mt-2 text-sm text-zinc-600">
        {state === "back"
          ? `${info.email} is subscribed again.`
          : `${info.email} will stop receiving offers and news by email.`}
        {info.test && " (This is a test email, so nothing will change.)"}
      </p>
      {state !== "back" && (
        <button
          onClick={() => act(emailMarketingClient.unsubscribe, "done")}
          disabled={state === "busy"}
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-60"
        >
          {state === "busy" && <Loader2 className="h-4 w-4 animate-spin" />}
          Unsubscribe
        </button>
      )}
      {state === "error" && <p className="mt-3 text-sm text-rose-600">Something went wrong. Please try again.</p>}
    </>
  );
}

export default function UnsubscribePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white px-6 py-10 text-center shadow-sm">
        <Suspense fallback={<Loader2 className="mx-auto h-6 w-6 animate-spin text-zinc-400" />}>
          <UnsubscribeInner />
        </Suspense>
      </div>
    </main>
  );
}
