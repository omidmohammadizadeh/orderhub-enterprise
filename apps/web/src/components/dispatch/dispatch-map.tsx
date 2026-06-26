"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useRef } from "react";
import { useGoogleMaps } from "@/lib/hooks/use-google-maps";
import type { DispatchFeed } from "@/lib/api/dispatch.client";

// UK fallback centre when no location has been geocoded yet.
const UK_CENTER = { lat: 52.4814, lng: -1.8998 };

// House-shaped marker (roof + body), centred so the countdown sits in the body.
const HOUSE_PATH = "M0,-16 L14,-4 L10,-4 L10,12 L-10,12 L-10,-4 L-14,-4 Z";

function orderColor(deadlineAt: string | null, now: number): string {
  if (!deadlineAt) return "#3b82f6"; // blue — no deadline known
  const remaining = new Date(deadlineAt).getTime() - now;
  if (remaining <= 5 * 60_000) return "#dc2626"; // red — ≤5 min to promised time / overdue
  if (remaining <= 15 * 60_000) return "#f97316"; // orange — ≤15 min
  return "#16a34a"; // green — plenty of time
}

// Minutes shown INSIDE the order pin (OrderLord style). Negative = late.
function minutesLabel(deadlineAt: string | null, now: number): string {
  if (!deadlineAt) return "·";
  const remaining = new Date(deadlineAt).getTime() - now;
  const mins = Math.ceil(Math.abs(remaining) / 60_000);
  return remaining < 0 ? `-${mins}` : `${mins}`;
}

function countdownLabel(deadlineAt: string | null, now: number): string {
  if (!deadlineAt) return "—";
  const remaining = new Date(deadlineAt).getTime() - now;
  const mins = Math.round(Math.abs(remaining) / 60_000);
  return remaining >= 0 ? `${mins} min left` : `${mins} min late`;
}

export function DispatchMap({
  feed,
  now,
  focusKey,
}: {
  feed: DispatchFeed | undefined;
  now: number;
  focusKey?: string;
}) {
  const { ready, error } = useGoogleMaps();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<Map<string, any>>(new Map());
  const infoRef = useRef<any>(null);
  const fittedRef = useRef(false);

  // Init the map once the API is ready.
  useEffect(() => {
    if (!ready || mapRef.current || !containerRef.current) return;
    const g = window.google;
    mapRef.current = new g.maps.Map(containerRef.current, {
      center: UK_CENTER,
      zoom: 11,
      disableDefaultUI: true,
      zoomControl: true,
      styles: [{ elementType: "labels.icon", stylers: [{ visibility: "off" }] }],
    });
    infoRef.current = new g.maps.InfoWindow();
  }, [ready]);

  // Re-fit the viewport whenever the selected scope changes (e.g. "All
  // locations" → a single shop), so the location + its orders auto-zoom in.
  useEffect(() => {
    fittedRef.current = false;
  }, [focusKey]);

  // Sync markers whenever the feed or the 1s clock ticks.
  useEffect(() => {
    if (!ready || !mapRef.current || !feed) return;
    const g = window.google;
    const map = mapRef.current;
    const seen = new Set<string>();

    // Location markers — a BIG building glyph (no pin) + the name beneath it.
    // Transparent icon host so only the emoji/name show (no purple teardrop).
    const transparentIcon = {
      path: g.maps.SymbolPath.CIRCLE,
      scale: 1,
      fillOpacity: 0,
      strokeOpacity: 0,
    };
    for (const loc of feed.locations) {
      if (loc.lat == null || loc.lng == null) continue;
      const pos = { lat: loc.lat, lng: loc.lng };

      const bKey = `locb:${loc.id}`;
      seen.add(bKey);
      if (!markersRef.current.get(bKey)) {
        markersRef.current.set(
          bKey,
          new g.maps.Marker({
            map,
            position: pos,
            title: loc.name,
            icon: transparentIcon,
            label: { text: "🏢", fontSize: "34px" },
            zIndex: 60,
          }),
        );
      }

      const nKey = `locn:${loc.id}`;
      seen.add(nKey);
      if (!markersRef.current.get(nKey)) {
        markersRef.current.set(
          nKey,
          new g.maps.Marker({
            map,
            position: pos,
            icon: { ...transparentIcon, labelOrigin: new g.maps.Point(0, 28) },
            label: {
              text: loc.name,
              color: "#0f172a",
              fontSize: "13px",
              fontWeight: "800",
              className: "oh-loc-label",
            },
            zIndex: 59,
          }),
        );
      }
    }

    // Order pins — BIG urgency-coloured circle with the countdown minutes in
    // the centre (OrderLord style).
    for (const o of feed.orders) {
      if (o.lat == null || o.lng == null) continue;
      const key = `ord:${o.id}`;
      seen.add(key);
      const color = orderColor(o.deadlineAt, now);
      let m = markersRef.current.get(key);
      if (!m) {
        m = new g.maps.Marker({ map, position: { lat: o.lat, lng: o.lng }, zIndex: 100 });
        m.addListener("click", () => {
          infoRef.current.setContent(
            `<div style="font-family:system-ui;font-size:13px;min-width:190px">
              <strong>#${o.displayId ?? o.orderNumber ?? o.id.slice(-5)}</strong> · ${o.platform}<br/>
              ${o.customerName ?? "Customer"}<br/>
              £${o.total} · ${o.paymentMethod ?? "—"}<br/>
              <span style="color:${orderColor(o.deadlineAt, Date.now())};font-weight:700">${countdownLabel(o.deadlineAt, Date.now())}</span> · ${o.status}
              <br/><button disabled style="margin-top:6px;opacity:.5">Dispatch (coming soon)</button>
            </div>`,
          );
          infoRef.current.open(map, m);
        });
        markersRef.current.set(key, m);
      }
      m.setPosition({ lat: o.lat, lng: o.lng });
      // Customer pin = a HOUSE that recolours green → orange (≤15m) → red (≤5m)
      // toward the promised time. Delivered (done) orders go grey with a tick,
      // then drop off the feed after 10 min.
      m.setIcon({
        path: HOUSE_PATH,
        fillColor: o.done ? "#9ca3af" : color,
        fillOpacity: o.done ? 0.85 : 1,
        strokeColor: "#ffffff",
        strokeWeight: 1.5,
        scale: o.done ? 1.1 : 1.5,
        anchor: new g.maps.Point(0, 12), // base of the house sits on the address
        labelOrigin: new g.maps.Point(0, 4), // countdown inside the body
      });
      m.setLabel({
        text: o.done ? "✓" : minutesLabel(o.deadlineAt, now),
        color: "#ffffff",
        fontSize: "12px",
        fontWeight: "800",
      });
      m.setZIndex(o.done ? 40 : 100);
    }

    // Driver dots (blue = available, amber = on a job).
    for (const d of feed.drivers) {
      if (d.lat == null || d.lng == null) continue;
      const key = `drv:${d.driverId}`;
      seen.add(key);
      let m = markersRef.current.get(key);
      if (!m) {
        m = new g.maps.Marker({ map, title: d.name, zIndex: 80 });
        markersRef.current.set(key, m);
      }
      m.setPosition({ lat: d.lat, lng: d.lng });
      // Car marker — green when available (ONLINE), red when busy (ON_JOB).
      m.setIcon({
        path: g.maps.SymbolPath.CIRCLE,
        fillColor: d.status === "ON_JOB" ? "#dc2626" : "#16a34a",
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeWeight: 2,
        scale: 15,
      });
      m.setLabel({ text: "🚗", fontSize: "16px" });
    }

    // Remove stale markers (e.g. completed orders that left the feed).
    for (const [key, marker] of markersRef.current.entries()) {
      if (!seen.has(key)) {
        marker.setMap(null);
        markersRef.current.delete(key);
      }
    }

    // Auto-fit: on first data and whenever the scope changes (focusKey effect
    // resets fittedRef). Pads the bounds and clamps zoom for single points.
    if (!fittedRef.current && markersRef.current.size > 0) {
      const bounds = new g.maps.LatLngBounds();
      let any = false;
      for (const m of markersRef.current.values()) {
        const pos = m.getPosition?.();
        if (pos) {
          bounds.extend(pos);
          any = true;
        }
      }
      if (any) {
        if (markersRef.current.size === 1) {
          map.setCenter(bounds.getCenter());
          map.setZoom(15);
        } else {
          map.fitBounds(bounds, 80);
          const once = g.maps.event.addListenerOnce(map, "idle", () => {
            if (map.getZoom() > 16) map.setZoom(16);
          });
          void once;
        }
        fittedRef.current = true;
      }
    }
  }, [ready, feed, now]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
        {error}
      </div>
    );
  }

  // Explicit height — Google Maps renders nothing if the container collapses
  // to 0 (a percentage height with no definite parent height resolves to 0).
  return (
    <div
      ref={containerRef}
      className="w-full rounded-lg"
      style={{ height: "100%", minHeight: "70vh" }}
    />
  );
}
