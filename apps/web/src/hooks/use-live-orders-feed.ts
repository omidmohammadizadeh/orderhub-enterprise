"use client";

// Shared live-orders feed — the ONE source of truth for GET /v1/orders/live.
//
// Before this existed, three hooks fetched the same endpoint independently:
// the orders board polled every 30s under ["orders","live",loc], and
// auto-accept + auto-print EACH polled every 7s under a different key —
// so an idle dashboard tab issued ~10 requests/minute to one endpoint on
// every page, which is what blew the per-user rate-limit bucket (429s on
// the Products page with no orders view open).
//
// The model now is socket-first:
//   • WebSocket connected  → NO steady poll. An order event (order:new /
//     order:updated / order:cancelled) for our location triggers ONE
//     debounced refetch of the shared query — needed because socket payloads
//     are slim (no items[]) and auto-print must render full receipts.
//   • WebSocket down       → a single 60s fallback poll keeps automations
//     alive (idempotency guards in the consumers make replays harmless).
//     The poll stops the moment the socket reconnects, and every reconnect
//     triggers one catch-up refetch.
//
// Every consumer (orders board, auto-accept, auto-print) observes the SAME
// queryKeys.liveOrders(locationId) cache — React Query guarantees one
// in-flight request no matter how many hooks are mounted.

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ordersClient, type Order } from "../lib/api/orders.client";
import {
  getSocket,
  joinLocationRoom,
  leaveLocationRoom,
  joinAllLocationsRoom,
  leaveAllLocationsRoom,
} from "../lib/socket/socket.client";
import { useAuthStore } from "../stores/auth.store";
import { queryKeys } from "../lib/api/query-keys";

/** How long the fallback poll waits between fetches while the socket is down. */
const FALLBACK_POLL_MS = 60_000;
/** Coalesce bursts of socket events (a rush of orders) into one refetch. */
const EVENT_DEBOUNCE_MS = 800;

/** Reactive view of the shared socket's connection state. */
export function useSocketConnected(): boolean {
  const token = useAuthStore((s) => s.accessToken);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!token) {
      setConnected(false);
      return;
    }
    const socket = getSocket(token);
    const up = () => setConnected(true);
    const down = () => setConnected(false);
    setConnected(socket.connected);
    socket.on("connect", up);
    socket.on("disconnect", down);
    return () => {
      socket.off("connect", up);
      socket.off("disconnect", down);
    };
  }, [token]);

  return connected;
}

export function useLiveOrdersFeed(
  locationId?: string,
  opts?: { enabled?: boolean },
) {
  const token = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  const connected = useSocketConnected();
  const enabled = opts?.enabled ?? true;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const query = useQuery({
    queryKey: queryKeys.liveOrders(locationId),
    queryFn: ({ signal }) => ordersClient.live(locationId, { signal }),
    enabled,
    // Socket healthy → no poll at all; socket down → one 60s fallback.
    // (React Query resolves conflicting intervals across observers to the
    // smallest, so every consumer must come through this hook.) The "All
    // locations" view (locationId undefined) used to always poll — it
    // joined no room at all, so a socket event never reached it. It now
    // asks the server to join every room it's allowed to see (room:join-all
    // below), so it gets the same socket-first treatment as a single
    // location once connected.
    refetchInterval: connected ? false : FALLBACK_POLL_MS,
    staleTime: 30_000,
    // Focus-refetch races in-flight status mutations (see useLiveOrders for
    // the war story); event-driven invalidation covers freshness instead.
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!token || !enabled) return;
    const socket = getSocket(token);

    const invalidateSoon = () => {
      if (debounceRef.current) return;
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void queryClient.invalidateQueries({
          queryKey: queryKeys.liveOrders(locationId),
        });
      }, EVENT_DEBOUNCE_MS);
    };

    // Slim event payloads carry locationId — refetch only for events that
    // belong to the location this feed is scoped to (undefined = all).
    const onOrderEvent = (payload: { locationId?: string }) => {
      if (locationId && payload?.locationId !== locationId) return;
      invalidateSoon();
    };
    // Reconnect → one catch-up fetch for anything missed while offline.
    const onReconnect = () => invalidateSoon();

    socket.on("order:new", onOrderEvent);
    socket.on("order:updated", onOrderEvent);
    socket.on("order:cancelled", onOrderEvent as never);
    socket.on("connect", onReconnect);
    if (locationId) joinLocationRoom(socket, locationId);
    else joinAllLocationsRoom(socket);

    return () => {
      socket.off("order:new", onOrderEvent);
      socket.off("order:updated", onOrderEvent);
      socket.off("order:cancelled", onOrderEvent as never);
      socket.off("connect", onReconnect);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (locationId) leaveLocationRoom(socket, locationId);
      else leaveAllLocationsRoom(socket);
    };
  }, [token, locationId, enabled, queryClient]);

  return {
    orders: query.data as Order[] | undefined,
    connected,
    query,
  };
}
