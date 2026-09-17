"use client";

// The page a restaurant owner lands on from a connection link.
//
// They have no Order Hub account and may never have heard of us — their POS
// provider sent them a link. So this page does three things and nothing else:
// says who is asking, says exactly what will happen, and gives them one
// button. Everything after the button is Uber's own consent screen and the
// callback that already exists.
//
// It is deliberately plain. A page that asks someone to sign into their Uber
// Eats account should look like a form, not like marketing.

import { use, useEffect, useState } from "react";
import Image from "next/image";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  "https://orderhub-api-0re6.onrender.com/api";

interface InviteView {
  brandName: string | null;
  locationName: string | null;
  alreadyConnected: boolean;
}

export default function UberEatsConnectPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [view, setView] = useState<InviteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/v1/integrations/ubereats/invite/${token}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.message ?? "This link is not valid.");
        return body as InviteView;
      })
      .then((v) => !cancelled && setView(v))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [token]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const r = await fetch(
        `${API_BASE}/v1/integrations/ubereats/invite/${token}/start`,
        { method: "POST" },
      );
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.message ?? "Could not start.");
      // Full-page redirect to Uber's consent screen.
      window.location.assign(body.authorizeUrl);
    } catch (e: any) {
      setError(e.message);
      setStarting(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <Image
          src="/orderhub-logo.png"
          alt="Order Hub"
          width={40}
          height={40}
          className="mb-5 h-10 w-10 rounded-lg object-contain"
        />

        {error ? (
          <>
            <h1 className="text-lg font-semibold text-zinc-900">
              This link can&apos;t be used
            </h1>
            <p className="mt-2 text-sm text-zinc-600">{error}</p>
            <p className="mt-4 text-sm text-zinc-500">
              Please ask whoever sent it to you for a new one — these links
              expire for security.
            </p>
          </>
        ) : !view ? (
          <p className="text-sm text-zinc-500">Checking your link…</p>
        ) : view.alreadyConnected ? (
          <>
            <h1 className="text-lg font-semibold text-zinc-900">
              Already connected
            </h1>
            <p className="mt-2 text-sm text-zinc-600">
              {view.brandName ?? "This shop"} is already connected to Uber
              Eats. There&apos;s nothing more to do here.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-zinc-900">
              Connect Uber Eats
            </h1>
            <p className="mt-2 text-sm text-zinc-600">
              This will connect your Uber Eats store to{" "}
              <span className="font-semibold text-zinc-900">
                {view.brandName ?? "your brand"}
              </span>
              {view.locationName ? (
                <>
                  {" "}
                  at{" "}
                  <span className="font-semibold text-zinc-900">
                    {view.locationName}
                  </span>
                </>
              ) : null}
              , so its orders arrive on your till.
            </p>

            <ul className="mt-5 space-y-2 text-sm text-zinc-600">
              <li>· You&apos;ll sign in to Uber Eats and approve access.</li>
              <li>· You choose which of your stores to connect.</li>
              <li>
                · You can remove access at any time from your Uber Eats account.
              </li>
            </ul>

            <p className="mt-5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Make sure you&apos;re signed in to Uber Eats as the owner of the
              store you want to connect. Whoever is signed in is whose stores
              we&apos;ll see.
            </p>

            <button
              onClick={start}
              disabled={starting}
              className="mt-5 w-full rounded-xl bg-zinc-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-50"
            >
              {starting ? "Taking you to Uber Eats…" : "Continue to Uber Eats"}
            </button>
          </>
        )}
      </div>

      <p className="mt-5 text-center text-[11px] text-zinc-400">
        Sent by your point-of-sale provider · Powered by{" "}
        <a
          href="https://www.orderhubsolutions.com"
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-zinc-500 hover:text-zinc-700"
        >
          Order Hub Solutions
        </a>
      </p>
    </main>
  );
}
