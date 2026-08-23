"use client";

// The Rewards tab — the loyalty card lives here, and NOWHERE else.
//
// Deliberately not on the menu, not on the home page, not as a banner. The
// whole point of a stamp card is that it belongs to the customer who signed
// in for it: putting "collect 6, get one free" on the public menu turns it
// into an advert everyone sees and nobody owns.
//
// Phase 1 is the shell. The card, the stamps and the claim flow land next.

import { useParams, useSearchParams } from "next/navigation";
import { Heart } from "lucide-react";
import { StorefrontTabBar } from "@/components/storefront/tab-bar";

export default function StorefrontRewardsPage() {
  const params = useParams<{ slug: string }>();
  const brandId = useSearchParams().get("brand");

  return (
    <main className="flex min-h-screen flex-col bg-white">
      <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-100">
          <Heart className="h-7 w-7 text-zinc-300" />
        </div>
        <h1 className="text-lg font-black tracking-tight text-zinc-900">
          Your loyalty card
        </h1>
        <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-zinc-500">
          Collect a stamp every time you order. This is where your card will
          live — we&apos;re building it now.
        </p>
      </div>
      <StorefrontTabBar slug={params.slug} brandId={brandId} />
    </main>
  );
}
