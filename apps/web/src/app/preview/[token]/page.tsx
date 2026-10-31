import type { Metadata } from "next";
import { apiOrigin } from "@/lib/storefront-metadata";
import { ShopPreview, type ShopPreviewData } from "@/components/preview/shop-preview";

// The private link a shop owner opens from a QR code. Rendered on the server so
// a phone shows the menu on first paint, with nothing to wait for mid-meeting.

// A preview is for one owner, so it must never reach a search engine or a
// shared-link card, and the shop's name stays out of the metadata.
export const metadata: Metadata = {
  title: "Private preview",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

async function loadPreview(token: string): Promise<ShopPreviewData | null> {
  const origin = apiOrigin();
  if (!origin) return null;
  try {
    const res = await fetch(`${origin}/v1/public/prospect-preview/${encodeURIComponent(token)}`, {
      cache: "no-store",
    });
    return res.ok ? ((await res.json()) as ShopPreviewData) : null;
  } catch {
    return null;
  }
}

export default async function PreviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const shop = await loadPreview(token);

  if (!shop) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center bg-[#faf8f5] px-6 text-center text-stone-900">
        <h1 className="text-xl font-semibold">This preview has ended</h1>
        <p className="mt-2 max-w-sm text-sm text-stone-600">
          Ask your OrderHub contact for a new link.
        </p>
      </main>
    );
  }
  return <ShopPreview shop={shop} />;
}
