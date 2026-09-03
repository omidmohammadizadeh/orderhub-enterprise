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
//
// Data source: the SHARED live-orders feed (use-live-orders-feed.ts) —
// socket-first with a 60s fallback poll only while the socket is down.
// This hook used to run its own 7-second poll of /orders/live on every
// dashboard page, which was the main driver of the production 429s.
// The feed is only even enabled here when the location actually has
// auto-accept switched on, so most browsers fetch nothing at all.

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { ordersClient } from "../lib/api/orders.client";
import { locationsClient } from "../lib/api/locations.client";
import { useLiveOrdersFeed } from "./use-live-orders-feed";
import { queryKeys } from "../lib/api/query-keys";
import { isAwaitingOurPayment } from "../lib/orders/awaiting-payment";

export function useAutoAccept(locationId?: string) {
  const acceptedRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());

  // Is auto-accept switched on for this location? A settings flag changes
  // rarely — a 5-minute refresh is plenty (was 60s).
  const locationQuery = useQuery({
    queryKey: queryKeys.locationDetail(locationId ?? ""),
    queryFn: () => locationsClient.get(locationId!),
    enabled: !!locationId,
    refetchInterval: 300_000,
    staleTime: 300_000,
  });
  const autoAccept = !!(
    (locationQuery.data as any)?.settings?.autoAcceptOrders
  );

  // Shared feed — no independent poll. Only enabled when this location has
  // auto-accept on, so a browser at a location without it fetches nothing.
  const { orders } = useLiveOrdersFeed(locationId, {
    enabled: !!locationId && autoAccept,
  });

  useEffect(() => {
    if (!locationId || !autoAccept || !orders) return;
    for (const o of orders) {
      if (String(o.status ?? "").toUpperCase() !== "PENDING") continue;
      // Held until WE have been paid — see isAwaitingOurPayment for the
      // full list and why collection cash is not in it.
      if (isAwaitingOurPayment(o as any)) continue;
      if (acceptedRef.current.has(o.id) || inFlightRef.current.has(o.id))
        continue;
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
          acceptedRef.current.add(o.id); // don't hammer it every refetch
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
