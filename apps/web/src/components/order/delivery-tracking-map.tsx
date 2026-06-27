"use client";

import { useEffect, useRef } from "react";
import { useGoogleMaps } from "@/lib/hooks/use-google-maps";

type LatLng = { lat: number; lng: number };

// Live customer-facing tracking map: the driver (car) approaching the delivery
// destination (pin). Re-centres as the driver's GPS updates.
export function DeliveryTrackingMap({
  driver,
  destination,
}: {
  driver: LatLng | null;
  destination: LatLng | null;
}) {
  const { ready, error } = useGoogleMaps();
  const divRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const driverMarker = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const destMarker = useRef<any>(null);
  const fitted = useRef(false);

  useEffect(() => {
    if (!ready || !divRef.current || mapRef.current) return;
    const g = window.google;
    mapRef.current = new g.maps.Map(divRef.current, {
      center: destination ?? driver ?? { lat: 51.5074, lng: -0.1278 },
      zoom: 14,
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: "greedy",
    });
  }, [ready, destination, driver]);

  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const g = window.google;

    if (destination) {
      if (!destMarker.current) {
        destMarker.current = new g.maps.Marker({
          map: mapRef.current,
          position: destination,
          label: { text: "🏠", fontSize: "18px" },
          title: "Delivery address",
        });
      } else {
        destMarker.current.setPosition(destination);
      }
    }

    if (driver) {
      if (!driverMarker.current) {
        driverMarker.current = new g.maps.Marker({
          map: mapRef.current,
          position: driver,
          label: { text: "🚗", fontSize: "18px" },
          zIndex: 50,
          title: "Your driver",
        });
      } else {
        driverMarker.current.setPosition(driver);
      }
    }

    // Fit both points once, then follow the driver.
    const pts = [driver, destination].filter(Boolean) as LatLng[];
    if (!fitted.current && pts.length) {
      if (pts.length === 2) {
        const bounds = new g.maps.LatLngBounds();
        pts.forEach((p) => bounds.extend(p));
        mapRef.current.fitBounds(bounds, 60);
      } else {
        mapRef.current.setCenter(pts[0]);
      }
      fitted.current = true;
    } else if (driver) {
      mapRef.current.panTo(driver);
    }
  }, [ready, driver, destination]);

  if (error) {
    return (
      <div className="flex h-64 items-center justify-center rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-center text-xs text-zinc-500">
        {error}
      </div>
    );
  }

  return <div ref={divRef} className="h-64 w-full overflow-hidden rounded-2xl border border-zinc-200" />;
}
