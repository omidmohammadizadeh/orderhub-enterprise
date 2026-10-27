"use client";

import { useEffect, useRef, useState } from "react";
import { LocateFixed } from "lucide-react";
import { useGoogleMaps } from "@/lib/hooks/use-google-maps";
import {
  type LatLng,
  TRACKING_MAP_STYLE,
  bearing,
  driverIconSvg,
  homeIconSvg,
  milesBetween,
  shopIconSvg,
} from "@/lib/maps/tracking-style";

const GLIDE_MS = 2500;

// Live customer-facing tracking map, the same look as the restaurant apps:
// grey base, the driver gliding between GPS fixes with an arrow turned the way
// they're travelling, a dashed route to the door, the shop before pickup. The
// camera keeps everyone in view until the customer drags the map.
export function DeliveryTrackingMap({
  driver,
  destination,
  shop = null,
  arrived = false,
  className = "h-80",
}: {
  driver: LatLng | null;
  destination: LatLng | null;
  shop?: LatLng | null;
  arrived?: boolean;
  className?: string;
}) {
  const { ready, error } = useGoogleMaps();
  const divRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const driverMarker = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const destMarker = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shopMarker = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const route = useRef<any>(null);
  const shown = useRef<LatLng | null>(null);
  const heading = useRef(0);
  const frame = useRef<number | null>(null);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  followingRef.current = following;

  // Create the map once.
  useEffect(() => {
    if (!ready || !divRef.current || mapRef.current) return;
    const g = window.google;
    mapRef.current = new g.maps.Map(divRef.current, {
      center: driver ?? destination ?? shop ?? { lat: 54.97, lng: -1.61 },
      zoom: 15,
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: "greedy",
      clickableIcons: false,
      styles: TRACKING_MAP_STYLE,
    });
    // A drag means "let me look around": stop following until Re-centre.
    mapRef.current.addListener("dragstart", () => setFollowing(false));
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const fit = () => {
    const g = window.google;
    if (!g || !mapRef.current) return;
    const pts = [shown.current ?? driver, destination, driver ? null : shop].filter(Boolean) as LatLng[];
    if (!pts.length) return;
    const close = pts.length > 1 && milesBetween(pts[0]!, pts[1]!) < 0.08;
    if (pts.length === 1 || close) {
      mapRef.current.panTo(pts[0]);
      mapRef.current.setZoom(17);
      return;
    }
    const bounds = new g.maps.LatLngBounds();
    pts.forEach((p) => bounds.extend(p));
    mapRef.current.fitBounds(bounds, { top: 70, right: 60, bottom: 70, left: 60 });
  };

  const drawRoute = () => {
    const g = window.google;
    if (!g || !mapRef.current) return;
    const from = shown.current;
    if (!from || !destination || arrived) {
      route.current?.setMap(null);
      route.current = null;
      return;
    }
    if (!route.current) {
      route.current = new g.maps.Polyline({
        map: mapRef.current,
        strokeOpacity: 0,
        icons: [
          {
            icon: { path: "M 0,-1 0,1", strokeOpacity: 1, strokeColor: "#111827", strokeWeight: 4, scale: 2.5 },
            offset: "0",
            repeat: "14px",
          },
        ],
        zIndex: 1,
      });
    }
    route.current.setPath([from, destination]);
  };

  // Home + shop pins.
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const g = window.google;
    if (destination) {
      if (!destMarker.current) {
        destMarker.current = new g.maps.Marker({
          map: mapRef.current,
          position: destination,
          title: "Delivery address",
          icon: { url: homeIconSvg(), scaledSize: new g.maps.Size(44, 50), anchor: new g.maps.Point(22, 50) },
          zIndex: 20,
        });
      } else destMarker.current.setPosition(destination);
    }
    const showShop = shop && !driver;
    if (showShop && !shopMarker.current) {
      shopMarker.current = new g.maps.Marker({
        map: mapRef.current,
        position: shop,
        title: "Restaurant",
        icon: { url: shopIconSvg(), scaledSize: new g.maps.Size(38, 38), anchor: new g.maps.Point(19, 19) },
        zIndex: 10,
      });
    } else if (!showShop && shopMarker.current) {
      shopMarker.current.setMap(null);
      shopMarker.current = null;
    }
    if (followingRef.current) fit();
  }, [ready, destination?.lat, destination?.lng, shop?.lat, shop?.lng, !!driver]); // eslint-disable-line react-hooks/exhaustive-deps

  // The driver: glide from the last shown point to the new fix.
  useEffect(() => {
    if (!ready || !mapRef.current || !driver) return;
    const g = window.google;
    const start = shown.current ?? driver;
    if (start.lat !== driver.lat || start.lng !== driver.lng) heading.current = bearing(start, driver);
    else if (!shown.current && destination) heading.current = bearing(driver, destination);

    const icon = () => ({
      url: driverIconSvg(heading.current, arrived),
      scaledSize: new g.maps.Size(64, 64),
      anchor: new g.maps.Point(32, 32),
    });
    if (!driverMarker.current) {
      driverMarker.current = new g.maps.Marker({
        map: mapRef.current,
        position: driver,
        title: "Your driver",
        icon: icon(),
        zIndex: 50,
        optimized: false,
      });
    } else {
      driverMarker.current.setIcon(icon());
    }

    if (frame.current) cancelAnimationFrame(frame.current);
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / GLIDE_MS);
      const e = 1 - Math.pow(1 - k, 3);
      const p = { lat: start.lat + (driver.lat - start.lat) * e, lng: start.lng + (driver.lng - start.lng) * e };
      shown.current = p;
      driverMarker.current.setPosition(p);
      drawRoute();
      if (k < 1) frame.current = requestAnimationFrame(step);
      else if (followingRef.current) fit();
    };
    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [ready, driver?.lat, driver?.lng, arrived]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (following) fit();
  }, [following]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className={`flex items-center justify-center rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-center text-xs text-zinc-500 ${className}`}>
        {error}
      </div>
    );
  }

  return (
    <div className={`relative w-full overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-100 ${className}`}>
      <div ref={divRef} className="absolute inset-0" />
      {!following && (
        <button
          type="button"
          onClick={() => setFollowing(true)}
          className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-sm font-semibold text-zinc-900 shadow-md hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-900"
        >
          <LocateFixed className="h-4 w-4" aria-hidden /> Re-centre
        </button>
      )}
    </div>
  );
}
