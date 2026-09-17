"use client";

// Where a shop owner lands after approving access in Uber Eats.
//
// They came from a link their POS provider sent them, they have no Order Hub
// account, and the dashboard would only show them a login screen. All they
// need is confirmation that it worked and permission to close the tab.

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import Image from "next/image";

function Done() {
  const params = useSearchParams();
  // "connected" — one store, linked automatically. "pick" — several stores,
  // so their provider chooses which one. Either way the owner is finished.
  const status = params.get("status");

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
      <div className="rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm">
        <Image
          src="/orderhub-logo.png"
          alt="Order Hub"
          width={40}
          height={40}
          className="mx-auto mb-5 h-10 w-10 rounded-lg object-contain"
        />
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl text-emerald-600">
          ✓
        </div>
        <h1 className="text-lg font-semibold text-zinc-900">
          Uber Eats connected
        </h1>
        <p className="mt-2 text-sm text-zinc-600">
          {status === "pick"
            ? "Thank you. You have more than one store on this Uber Eats account, so your point-of-sale provider will choose the right one from their end."
            : "Thank you. Your Uber Eats orders will now arrive on your till."}
        </p>
        <p className="mt-5 text-sm text-zinc-500">
          There&apos;s nothing else to do — you can close this page.
        </p>
      </div>

      <p className="mt-5 text-center text-[11px] text-zinc-400">
        Powered by{" "}
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

export default function UberEatsConnectDonePage() {
  // useSearchParams needs a Suspense boundary, or `next build` fails the route.
  return (
    <Suspense fallback={null}>
      <Done />
    </Suspense>
  );
}
