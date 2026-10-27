"use client";

import { useEffect, useRef, useState } from "react";
import { Phone } from "lucide-react";
import { DeliveryTrackingMap } from "@/components/order/delivery-tracking-map";
import { CustomerDriverChat } from "@/components/order/customer-driver-chat";
import { type LatLng, agoLabel, etaMinutes, milesBetween } from "@/lib/maps/tracking-style";

export type LiveDeliveryOrder = {
  status: string;
  outForDeliveryAt?: string | null;
  estimatedReadyAt?: string | null;
  location?: { name?: string | null } | null;
  destination?: LatLng | null;
  shop?: LatLng | null;
  driver?: {
    name?: string | null;
    phone?: string | null;
    lat?: number | null;
    lng?: number | null;
    lastPingAt?: string | null;
  } | null;
};

const timeOf = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * The driver's leg of a delivery, the same as the restaurant apps show it:
 * live indicator, a big arrival time, progress from the shop to the door, the
 * map, the driver with a Call button, then chat. Before pickup it's just the
 * driver card (they're on their way to the shop, not to the customer).
 */
export function LiveDeliveryPanel({ order, orderId }: { order: LiveDeliveryOrder; orderId: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const d = order.driver;
  if (!d) return null;
  // RIDER_ARRIVED before pickup means "at the shop"; only once the food has
  // left (outForDeliveryAt) is the driver on the way or at the door.
  const onTheWay =
    order.status === "OUT_FOR_DELIVERY" || (order.status === "RIDER_ARRIVED" && !!order.outForDeliveryAt);
  const arrived = order.status === "RIDER_ARRIVED" && !!order.outForDeliveryAt;
  const driverPos = d.lat != null && d.lng != null ? { lat: d.lat, lng: d.lng } : null;
  const destination = order.destination ?? null;
  const name = d.name?.trim() || "Your driver";

  return (
    <div className="space-y-4">
      {onTheWay ? (
        <LiveHeader
          arrived={arrived}
          driverPos={driverPos}
          destination={destination}
          lastPingAt={d.lastPingAt}
          estimatedReadyAt={order.estimatedReadyAt}
          shopName={order.location?.name ?? "Restaurant"}
        />
      ) : null}

      {onTheWay && (driverPos || destination) ? (
        <DeliveryTrackingMap driver={driverPos} destination={destination} shop={order.shop ?? null} arrived={arrived} />
      ) : null}

      <div className="flex items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-lg font-extrabold text-white">
          {name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-bold text-zinc-900">{name}</p>
          <p className="text-sm text-zinc-500">
            {arrived ? "Has arrived with your order" : onTheWay ? "Delivering your order" : "Is collecting your order"}
          </p>
        </div>
        {d.phone ? (
          <a
            href={`tel:${d.phone}`}
            className="inline-flex items-center gap-1.5 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          >
            <Phone className="h-4 w-4" aria-hidden /> Call
          </a>
        ) : null}
      </div>

      <CustomerDriverChat orderId={orderId} driverName={d.name ?? null} />
    </div>
  );
}

function LiveHeader({
  arrived,
  driverPos,
  destination,
  lastPingAt,
  estimatedReadyAt,
  shopName,
}: {
  arrived: boolean;
  driverPos: LatLng | null;
  destination: LatLng | null;
  lastPingAt?: string | null;
  estimatedReadyAt?: string | null;
  shopName: string;
}) {
  // Progress: how much of the first measured distance is done.
  const startMiles = useRef<number | null>(null);
  const miles = driverPos && destination ? milesBetween(driverPos, destination) : null;
  if (miles != null && (startMiles.current == null || miles > startMiles.current)) startMiles.current = miles;
  const done = arrived
    ? 1
    : miles != null && startMiles.current
      ? Math.min(0.97, Math.max(0.05, 1 - miles / startMiles.current))
      : 0.15;
  const mins = !arrived && driverPos && destination ? etaMinutes(driverPos, destination) : null;
  const arriveAt = mins != null ? new Date(Date.now() + mins * 60_000) : estimatedReadyAt ? new Date(estimatedReadyAt) : null;
  const ago = agoLabel(lastPingAt);
  const fresh = lastPingAt ? Date.now() - new Date(lastPingAt).getTime() < 2 * 60_000 : false;

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5">
      <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-zinc-500">
        <span
          className={`h-2 w-2 rounded-full ${arrived || (driverPos && fresh) ? "bg-emerald-600" : "bg-zinc-400"} ${
            driverPos && fresh && !arrived ? "animate-pulse" : ""
          }`}
          aria-hidden
        />
        {arrived
          ? "At your door"
          : driverPos && fresh
            ? `Live · updated ${ago}`
            : driverPos && ago
              ? `Last seen ${ago}`
              : "On its way"}
      </p>
      <p className={`mt-2 text-3xl font-extrabold tracking-tight ${arrived ? "text-emerald-700" : "text-zinc-900"}`}>
        {arrived ? "Your driver is outside" : mins != null ? `Arriving in ${mins} min` : "On its way to you"}
      </p>
      {arrived ? (
        <p className="mt-1 text-sm text-zinc-500">Head to the door to collect your order.</p>
      ) : arriveAt ? (
        <p className="mt-1 text-sm text-zinc-500">
          Estimated arrival <span className="font-semibold text-zinc-900">{timeOf(arriveAt)}</span>
          {miles != null ? ` · ${miles < 0.1 ? "nearby" : `${miles.toFixed(1)} mi away`}` : ""}
        </p>
      ) : null}
      <div
        className="mt-4 h-2 overflow-hidden rounded-full bg-zinc-200"
        role="progressbar"
        aria-label="Delivery progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(done * 100)}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-700 ${arrived ? "bg-emerald-600" : "bg-zinc-900"}`}
          style={{ width: `${Math.round(done * 100)}%` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-xs font-semibold text-zinc-500">
        <span className="truncate">{shopName}</span>
        <span>You</span>
      </div>
    </div>
  );
}
