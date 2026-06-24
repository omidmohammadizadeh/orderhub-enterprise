"use client";

// Client-side auto-accept. Mirrors how auto-print finally became
// reliable: instead of trusting the server-side webhook path, the
// dashboard itself watches the live orders feed and, when the location
// has auto-accept enabled, fires the EXACT same PATCH /orders/:id/status
// call the operator's manual "Accept" button uses. Because manual accept
// already works for every channel (HubRise, Uber Eats, Deliveroo, Just
// Eat, direct, POS…), this works for every channel too — present and
// future — with zero per-channel wiring.
//
// Runs from the dashboard layout, so it's active on every page as long
// as the till has the dashboard open.

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { ordersClient } from "../lib/api/orders.client";
import { locationsClient } from "../lib/api/locations.client";

export function useAutoAccept(locationId?: string) {
  const acceptedRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());

  // Is auto-accept switched on for this location?
  const locationQuery = useQuery({
    queryKey: ["locations", "detail", locationId],
    queryFn: () => locationsClient.get(locationId!),
    enabled: !!locationId,
    refetchInterval: 60_000,
    staleTime: 60_000,
  });
  const autoAccept = !!(
    (locationQuery.data as any)?.settings?.autoAcceptOrders
  );

  // Share the live-orders query key with the auto-print hook so React
  // Query dedupes — one poll feeds both automations.
  const ordersQuery = useQuery({
    queryKey: ["auto-print", "orders", locationId ?? "all"],
    queryFn: () => ordersClient.live(locationId),
    enabled: !!locationId,
    refetchInterval: 7_000,
    staleTime: 0,
  });
  const orders = ordersQuery.data;

  useEffect(() => {
    if (!locationId || !autoAccept || !orders) return;
    for (const o of orders) {
      if (String(o.status ?? "").toUpperCase() !== "PENDING") continue;
      if (acceptedRef.current.has(o.id) || inFlightRef.current.has(o.id))
        continue;
      // Scheduled orders auto-accept on arrival just like any other —
      // they print immediately with the scheduled date/time on the
      // ticket so the kitchen knows when it's for. No special hold.
      inFlightRef.current.add(o.id);
      ordersClient
        .updateStatus(o.id, "ACCEPTED", { note: "auto-accept" } as any)
        .then(() => {
          acceptedRef.current.add(o.id);
          console.log(`[auto-accept] accepted order ${o.id}`);
        })
        .catch((e: any) => {
          // Most likely the order already advanced (a server-side
          // accept won the race) — harmless. Log and move on.
          console.warn(
            `[auto-accept] could not accept ${o.id}: ${e?.message ?? e}`,
          );
          acceptedRef.current.add(o.id); // don't hammer it every poll
        })
        .finally(() => inFlightRef.current.delete(o.id));
    }
    if (acceptedRef.current.size > 800) {
      acceptedRef.current = new Set(
        Array.from(acceptedRef.current).slice(-800),
      );
    }
  }, [orders, autoAccept, locationId]);
}
