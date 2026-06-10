// Phase AP-8 — landing page Stripe sends the customer back to after the
// hosted Checkout flow. We don't render anything elaborate here — the
// existing /order/[slug] page already has a "waiting for restaurant"
// screen that polls /order-status. We just bounce the customer back
// there with the order id in the URL so it knows which one to poll.

"use client";

import { useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

export default function CheckoutConfirmationPage() {
  const router = useRouter();
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const orderId = searchParams.get("orderId");

  useEffect(() => {
    // Bounce to the storefront in tracking mode. The storefront reads
    // ?confirmedOrderId from the query string and shows the "waiting
    // for restaurant / accepted / out for delivery" screen.
    const target = orderId
      ? `/order/${params.slug}?confirmedOrderId=${encodeURIComponent(orderId)}`
      : `/order/${params.slug}`;
    router.replace(target);
  }, [orderId, params.slug, router]);

  return (
    <div className="grid min-h-screen place-items-center bg-zinc-50">
      <div className="flex flex-col items-center gap-3 text-zinc-600">
        <Loader2 className="h-7 w-7 animate-spin" />
        <p className="text-sm">Payment received — taking you back to your order…</p>
      </div>
    </div>
  );
}
