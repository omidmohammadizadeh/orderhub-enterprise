"use client";

// Phase AS-6 — public brand storefront.
//
// Resolves a brand by its public `onlineOrderingSlug`, then redirects
// to the existing location storefront (`/order/<locationSlug>`) with a
// query param marking the brand context. The location storefront reads
// `?brand=<brandId>` to filter the menu down to that brand's items and
// to tag the placed Order with brandId — that way one tablet can serve
// "pizza uno pelton" and "greek gyros" as two distinct customer-facing
// URLs without us duplicating the entire storefront UI.

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api/client";

interface Props {
  params: Promise<{ slug: string }>;
}

interface BrandPublic {
  brand: {
    id: string;
    name: string;
    about: string | null;
    logoUrl: string | null;
    directOrderingEnabled: boolean;
  };
  location: {
    id: string;
    onlineOrderingSlug: string | null;
  };
}

export default function BrandStorefrontPage({ params }: Props) {
  const { slug } = use(params);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<BrandPublic | null>(`/v1/brands/public/by-slug/${slug}`)
      .then((res: { data: BrandPublic | null }) => {
        if (cancelled) return;
        const data = res.data;
        if (!data || !data.brand.directOrderingEnabled) {
          setError("This brand is not currently accepting online orders.");
          return;
        }
        if (!data.location.onlineOrderingSlug) {
          setError(
            "The shop running this brand hasn't published its menu yet. Please check back later.",
          );
          return;
        }
        // Forward to the existing location storefront with brand context.
        // Using replace() so the brand URL stays in history but the
        // address bar shows /order/<slug>?brand=<id>.
        router.replace(
          `/order/${data.location.onlineOrderingSlug}?brand=${data.brand.id}`,
        );
      })
      .catch((err: any) => {
        if (cancelled) return;
        setError(
          err?.response?.status === 404
            ? "This brand link is invalid or has been removed."
            : "Could not load this brand right now. Try again in a moment.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [slug, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 py-12 text-center">
      <div className="max-w-md">
        {error ? (
          <>
            <h1 className="text-lg font-semibold text-zinc-900">
              We can't open this page
            </h1>
            <p className="mt-2 text-sm text-zinc-600">{error}</p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-zinc-900">Loading…</h1>
            <p className="mt-2 text-sm text-zinc-600">
              Looking up your brand.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
