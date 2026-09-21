"use client";

// One order on a map: the shop it leaves from, where it is going, and the
// rider carrying it if there is one.
//
// The job this does for an operator mid-service is "where is this going and
// how far is it" — asked while looking at the order, before deciding which
// courier to send. They used to have to leave the board for the dispatch map
// and find the pin among everything else on screen.
//
// The map is the whole point, so it gets the space and everything around it
// stays quiet. Pin vocabulary (🏢 shop, 🏠 destination, 🚗 rider) is lifted
// from the dispatch map deliberately: operators already read it there.

import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { useGoogleMaps } from "@/lib/hooks/use-google-maps";
import { getOrderMap, type OrderMapView } from "@/lib/api/dispatch.client";

interface Props {
  orderId: string;
  orderRef: string;
  onClose: () => void;
}

type LatLng = { lat: number; lng: number };

const isPoint = (p: { lat: number | null; lng: number | null }): p is LatLng =>
  p.lat != null && p.lng != null;

/** Straight-line distance. Labelled "direct" in the UI because it is not the
 *  driving distance — claiming a road distance we have not asked for would be
 *  a lie an operator plans around. */
function directMiles(a: LatLng, b: LatLng): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function seenLabel(ageMinutes: number | null): string {
  if (ageMinutes == null) return "position unknown age";
  if (ageMinutes < 1) return "just now";
  return `${ageMinutes} min ago`;
}

export function OrderMapModal({ orderId, orderRef, onClose }: Props) {
  const { ready, error: mapsError } = useGoogleMaps();
  const [view, setView] = useState<OrderMapView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const divRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null);

  // Always a fresh read: a rider's position is the one thing here that goes
  // stale, so this is deliberately not cached between opens.
  useEffect(() => {
    let cancelled = false;
    getOrderMap(orderId)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((e: any) => {
        if (!cancelled) {
          setLoadError(
            e?.response?.data?.message ?? e?.message ?? "Could not load the map",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  // Escape closes. Focus moves into the panel on open and goes back to
  // whatever opened it on close, so a keyboard user is not left tabbing
  // through the drawer behind the dialog.
  //
  // Mount-only: the drawer passes an inline onClose and re-renders on every
  // live board update. Keyed on it, this re-ran while open and recorded the
  // panel itself as the opener, so closing sent focus nowhere.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, []);

  // Draw once both the API and the data are in.
  useEffect(() => {
    if (!ready || !view || !divRef.current || mapRef.current) return;
    const g = window.google;
    const shop = isPoint(view.shop) ? view.shop : null;
    const dest = isPoint(view.order) ? view.order : null;
    const rider = view.rider ? { lat: view.rider.lat, lng: view.rider.lng } : null;

    const map = new g.maps.Map(divRef.current, {
      center: dest ?? shop ?? { lat: 51.5074, lng: -0.1278 },
      zoom: 13,
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: "greedy",
    });
    mapRef.current = map;

    const pin = (position: LatLng, text: string, title: string, z: number) =>
      new g.maps.Marker({
        map,
        position,
        label: { text, fontSize: "18px" },
        title,
        zIndex: z,
      });

    if (shop) pin(shop, "🏢", view.shop.name, 10);
    if (dest) pin(dest, "🏠", view.order.address ?? "Delivery address", 20);
    if (rider) {
      pin(
        rider,
        "🚗",
        view.rider?.name ?? (view.rider?.kind === "DRIVER" ? "Driver" : "Courier"),
        30,
      );
      // The run so far, shop → rider → door, so the operator can see at a
      // glance whether the rider is heading the right way.
      new g.maps.Polyline({
        map,
        path: [shop, rider, dest].filter(Boolean) as LatLng[],
        strokeColor: "#7c3aed",
        strokeOpacity: 0.55,
        strokeWeight: 3,
      });
    } else if (shop && dest) {
      new g.maps.Polyline({
        map,
        path: [shop, dest],
        strokeColor: "#a1a1aa",
        strokeOpacity: 0.5,
        strokeWeight: 2,
      });
    }

    const pts = [shop, dest, rider].filter(Boolean) as LatLng[];
    if (pts.length > 1) {
      const bounds = new g.maps.LatLngBounds();
      pts.forEach((p) => bounds.extend(p));
      map.fitBounds(bounds, 64);
    } else if (pts.length === 1) {
      map.setCenter(pts[0]);
      map.setZoom(15);
    }
  }, [ready, view]);

  const shopPt = view && isPoint(view.shop) ? view.shop : null;
  const destPt = view && isPoint(view.order) ? view.order : null;
  const miles = shopPt && destPt ? directMiles(shopPt, destPt) : null;
  const error = loadError ?? mapsError;
  // Google's own directions, so the operator can hand a route to a driver.
  const directionsUrl =
    shopPt && destPt
      ? `https://www.google.com/maps/dir/?api=1&origin=${shopPt.lat},${shopPt.lng}&destination=${destPt.lat},${destPt.lng}`
      : null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Map for order ${orderRef}`}
        tabIndex={-1}
        className="flex w-full max-w-2xl flex-col overflow-hidden overscroll-contain rounded-2xl bg-white shadow-xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3.5">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-900">
              Map {orderRef}
            </h3>
            {view?.order.address ? (
              <p className="truncate text-xs text-zinc-500">
                {view.order.address}
              </p>
            ) : null}
          </div>
          <button
            onClick={onClose}
            aria-label="Close map"
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-zinc-700">{error}</p>
          </div>
        ) : !view || !ready ? (
          <div className="flex h-72 items-center justify-center sm:h-96">
            <Loader2 className="h-5 w-5 animate-spin text-zinc-300" />
          </div>
        ) : !destPt && !shopPt ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm font-medium text-zinc-900">
              This order has no address we can place on a map.
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              Add a delivery address to the order, then open the map again.
            </p>
          </div>
        ) : (
          <>
            <div ref={divRef} className="h-72 w-full bg-zinc-100 sm:h-96" />

            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-zinc-100 px-5 py-3 text-xs text-zinc-600">
              <span className="flex items-center gap-1.5">
                <span aria-hidden>🏢</span>
                {view.shop.name}
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden>🏠</span>
                {view.order.customerName ?? "Delivery"}
              </span>
              {view.rider ? (
                <span className="flex items-center gap-1.5">
                  <span aria-hidden>🚗</span>
                  {view.rider.name ??
                    (view.rider.kind === "DRIVER" ? "Driver" : "Courier")}
                  <span className="text-zinc-400">
                    · seen {seenLabel(view.rider.ageMinutes)}
                  </span>
                </span>
              ) : null}
              {miles != null ? (
                <span className="text-zinc-500">
                  {miles.toFixed(1)} mi direct
                </span>
              ) : null}
              {!destPt ? (
                <span className="text-amber-700">
                  Delivery address could not be placed — showing the shop only.
                </span>
              ) : null}
              {directionsUrl ? (
                <a
                  href={directionsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto font-semibold text-violet-700 hover:text-violet-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
                >
                  Open in Google Maps
                </a>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
