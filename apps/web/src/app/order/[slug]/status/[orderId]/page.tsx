"use client";

// Phase AP-5 follow-up — standalone order-tracking page.
//
// The storefront's just-placed-an-order flow renders <AcceptedScreen>
// inline in /order/[slug]. That's great immediately after checkout but
// useless for someone who closed the tab and wants to come back later
// — there was no canonical URL to bookmark or share.
//
// /order/[slug]/status/[orderId] is that canonical URL. The "Track"
// button on every My Orders active card points at it, the Stripe
// success_url could too, and customers can land here directly. It
// polls the same /v1/ordering/orders/:orderId/status endpoint the
// inline tracker uses and renders the same step-timeline pattern.

import { useEffect, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import {
  CheckCircle2,
  Bike,
  XCircle,
  ChevronLeft,
  ShoppingBag,
  Phone,
} from "lucide-react";
import { DeliveryTrackingMap } from "@/components/order/delivery-tracking-map";
import { CustomerDriverChat } from "@/components/order/customer-driver-chat";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  "https://orderhub-api-0re6.onrender.com/api";

interface StatusPayload {
  id: string;
  displayId?: string | null;
  orderNumber?: number | null;
  status: string;
  fulfillmentType: string;
  receivedAt?: string | null;
  acceptedAt?: string | null;
  preparingAt?: string | null;
  readyAt?: string | null;
  outForDeliveryAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  estimatedReadyAt?: string | null;
  total?: number | null;
  location?: { name?: string | null } | null;
  destination?: { lat: number; lng: number } | null;
  driver?: {
    name?: string | null;
    phone?: string | null;
    lat?: number | null;
    lng?: number | null;
    lastPingAt?: string | null;
  } | null;
  items?: Array<{
    id: string;
    menuItemId?: string | null;
    name: string;
    unitPrice: number | string;
    quantity: number;
    modifiers?: Array<{ name: string; price: number | string; quantity?: number }>;
    notes?: string | null;
  }>;
}

export default function OrderStatusPage() {
  const params = useParams<{ slug: string; orderId: string }>();
  const router = useRouter();

  // Poll every 3s while non-terminal so the customer sees real-time
  // progress without needing socket auth on the storefront.
  const statusQuery = useQuery({
    queryKey: ["ordering", "order-status", params.orderId],
    queryFn: () =>
      axios
        .get<StatusPayload>(
          `${API_BASE}/v1/ordering/orders/${params.orderId}/status`,
        )
        .then((r) => r.data),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      const terminal =
        s === "COMPLETED" || s === "CANCELLED" || s === "REJECTED" || s === "FAILED";
      if (terminal) return false;
      // Poll faster once the driver is moving so the live map keeps up.
      return s === "OUT_FOR_DELIVERY" || s === "RIDER_ARRIVED" ? 2000 : 3000;
    },
  });

  const data = statusQuery.data;
  const isCancelled =
    data?.status === "CANCELLED" ||
    data?.status === "REJECTED" ||
    data?.status === "FAILED";

  const isDelivery = data?.fulfillmentType === "DELIVERY";
  const steps = useMemo(() => {
    if (!data) return [];
    return [
      { key: "RECEIVED", label: "Order received", at: data.receivedAt },
      { key: "ACCEPTED", label: "Confirmed by restaurant", at: data.acceptedAt },
      { key: "PREPARING", label: "Preparing your food", at: data.preparingAt },
      {
        key: "READY",
        label: isDelivery ? "Ready for driver" : "Ready to collect",
        at: data.readyAt,
      },
      ...(isDelivery
        ? [
            {
              key: "OUT_FOR_DELIVERY",
              label: "Out for delivery",
              at: data.outForDeliveryAt,
            },
            { key: "DELIVERED", label: "Delivered", at: data.deliveredAt },
          ]
        : [{ key: "COLLECTED", label: "Collected", at: data.deliveredAt }]),
    ];
  }, [data, isDelivery]);

  // Phase AW-30 — prefer the 5-char displayId so the tracker matches
  // the receipt + the orders board + the My Orders list. Falls back to
  // the internal orderNumber for legacy orders without a short code.
  const orderRef = data?.displayId
    ? `#${data.displayId}`
    : data?.orderNumber
      ? `#${data.orderNumber}`
      : params.orderId.slice(0, 8);

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
          <button
            onClick={() => router.push(`/order/${params.slug}/my-orders`)}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-700 hover:text-zinc-900"
          >
            <ChevronLeft className="h-4 w-4 text-zinc-400" />
            My orders
          </button>
          <a
            href={`/order/${params.slug}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            <ShoppingBag className="h-3.5 w-3.5" />
            Menu
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-10">
        {statusQuery.isLoading && !data ? (
          <p className="text-center text-sm text-zinc-400">Loading order…</p>
        ) : !data ? (
          <p className="text-center text-sm text-red-600">
            Couldn&apos;t load order {orderRef}.
          </p>
        ) : (
          <>
            <div
              className={`mx-auto grid h-20 w-20 place-items-center rounded-full ${
                isCancelled ? "bg-red-100 text-red-600" : "bg-emerald-100 text-emerald-600"
              }`}
            >
              {isCancelled ? (
                <XCircle className="h-9 w-9" />
              ) : (
                <CheckCircle2 className="h-9 w-9" />
              )}
            </div>

            <h1 className="mt-5 text-center text-2xl font-bold text-zinc-900">
              {isCancelled
                ? "Your order was cancelled"
                : data.driver
                  ? "Your order is on the way 🛵"
                  : "Tracking your order"}
            </h1>
            <p className="mt-2 text-center text-sm text-zinc-600">
              {data.location?.name ?? "Your restaurant"}{" "}
              {isCancelled
                ? "couldn't accept this order."
                : "— this page updates automatically as your order progresses."}
            </p>

            <div className="mt-6 flex items-center justify-center">
              <span className="rounded-full border border-zinc-200 bg-white px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-700">
                Order number {orderRef}
              </span>
            </div>

            {/* Live delivery tracking — shown front-and-centre the moment the
                driver starts the job (status → out for delivery). */}
            {!isCancelled && data.driver && (
              <div className="mt-6 space-y-4">
                <div className="flex items-center justify-between rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <div>
                    <p className="text-xs font-medium text-emerald-700">Your driver</p>
                    <p className="text-sm font-bold text-zinc-900">{data.driver.name ?? "On the way"}</p>
                  </div>
                  {data.driver.phone && (
                    <a
                      href={`tel:${data.driver.phone}`}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
                    >
                      <Phone className="h-4 w-4" /> Call
                    </a>
                  )}
                </div>

                {(data.driver.lat != null && data.driver.lng != null) || data.destination ? (
                  <DeliveryTrackingMap
                    driver={
                      data.driver.lat != null && data.driver.lng != null
                        ? { lat: data.driver.lat, lng: data.driver.lng }
                        : null
                    }
                    destination={data.destination ?? null}
                  />
                ) : (
                  <p className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-center text-xs text-zinc-500">
                    Waiting for your driver&apos;s location…
                  </p>
                )}

                <CustomerDriverChat orderId={params.orderId} driverName={data.driver.name} />
              </div>
            )}

            {isCancelled ? (
              <div className="mt-8 rounded-2xl border border-red-100 bg-red-50 p-6 text-center">
                <p className="text-sm text-red-700">
                  {data.cancelReason ?? "No reason given."}
                </p>
              </div>
            ) : (
              <ol className="mt-8 space-y-3">
                {steps.map((step, i) => {
                  const done = Boolean(step.at);
                  const active = !done && steps.slice(0, i).every((s) => Boolean(s.at));
                  const time = step.at
                    ? new Date(step.at).toLocaleTimeString("en-GB", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "";
                  return (
                    <li key={step.key} className="flex items-center gap-4">
                      <span
                        className={`grid h-8 w-8 flex-shrink-0 place-items-center rounded-full text-xs font-bold ${
                          done
                            ? "bg-emerald-500 text-white"
                            : active
                              ? "bg-emerald-100 text-emerald-700 ring-2 ring-emerald-300"
                              : "bg-zinc-200 text-zinc-500"
                        }`}
                      >
                        {done ? (
                          <CheckCircle2 className="h-4 w-4" />
                        ) : (
                          i + 1
                        )}
                      </span>
                      <div className="flex flex-1 items-center justify-between">
                        <p
                          className={`text-sm font-semibold ${
                            done ? "text-zinc-900" : active ? "text-zinc-900" : "text-zinc-400"
                          }`}
                        >
                          {step.label}
                        </p>
                        {time && (
                          <p className="text-xs text-zinc-500">{time}</p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}

            <div className="mt-10 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => {
                  // Phase AR — match the sessionStorage hand-off used
                  // by My Orders. Without this the storefront opens
                  // with an empty cart and the customer has to rebuild
                  // their order from scratch.
                  const items = (data?.items ?? []).map((it) => ({
                    menuItemId: it.menuItemId ?? it.id,
                    displayName: it.name,
                    unitPrice: Number(it.unitPrice),
                    quantity: it.quantity,
                    modifiers: (it.modifiers ?? []).map((m) => ({
                      name: m.name,
                      price: Number(m.price),
                      quantity: m.quantity ?? 1,
                    })),
                    notes: it.notes ?? undefined,
                  }));
                  try {
                    window.sessionStorage.setItem(
                      `orderhub.reorder.${params.slug}`,
                      JSON.stringify({
                        items,
                        restoredFromOrderId: params.orderId,
                        stashedAt: Date.now(),
                      }),
                    );
                  } catch {
                    /* private mode / quota — proceed anyway, the
                       storefront just lands empty */
                  }
                  router.push(`/order/${params.slug}?reorder=1`);
                }}
                disabled={!data?.items?.length}
                className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Bike className="h-4 w-4" />
                Order again
              </button>
              <button
                onClick={() => router.push(`/order/${params.slug}/my-orders`)}
                className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
              >
                Back to My orders
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
