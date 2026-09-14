'use client';

// Where a shared subscription link lands.
//
// The client has no OrderHub login and shouldn't need one — they are here to
// put a card on file, nothing else. The token in the URL is the only
// authority, and the page's whole job is to swap it for a fresh Stripe
// Checkout session and get out of the way.
//
// Minting the session HERE rather than when the link was created is the point:
// a Stripe Checkout URL dies after 24 hours, so a link emailed on Friday would
// be broken by Monday. This one still works weeks later.

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

export default function SubscribeWithLinkPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${API_BASE}/v1/subscriptions/public/checkout/${encodeURIComponent(token)}`,
        );
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !body?.url) {
          // The API's message is written for this reader — an expired link, or
          // a subscription that is already paid for — so show it as given.
          setError(
            body?.message ??
              "This link couldn't be opened. Please ask for a new one.",
          );
          return;
        }
        window.location.href = body.url;
      } catch {
        if (!cancelled) {
          setError('Something went wrong opening the payment page.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 p-6">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
        {error ? (
          <>
            <h1 className="text-lg font-semibold text-zinc-900">
              This link didn&apos;t work
            </h1>
            <p className="mt-2 text-sm text-zinc-600">{error}</p>
          </>
        ) : (
          <>
            <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-900" />
            <h1 className="mt-4 text-lg font-semibold text-zinc-900">
              Taking you to the payment page
            </h1>
            <p className="mt-2 text-sm text-zinc-600">
              Your card details are entered on Stripe&apos;s secure page, not
              here.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
