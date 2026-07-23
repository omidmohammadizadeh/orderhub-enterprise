"use client";

import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ordersClient, type Order } from "../lib/api/orders.client";
import { useOrdersStore } from "../stores/orders.store";
import {
  getSocket,
  joinLocationRoom,
  leaveLocationRoom,
} from "../lib/socket/socket.client";
import { useAuthStore } from "../stores/auth.store";
import { useOrderSounds } from "./use-order-sounds";
import { alertsClient } from "../lib/api/printers.client";
import { useLiveOrdersFeed } from "./use-live-orders-feed";
import { queryKeys } from "../lib/api/query-keys";
import type {
  OrderEventPayload,
  OrderCancelledPayload,
} from "@orderhub/shared";

export function useLiveOrders(locationId?: string) {
  const setLiveOrders = useOrdersStore((s) => s.setLiveOrders);
  const applyNewOrder = useOrdersStore((s) => s.applyNewOrder);
  const applyOrderUpdated = useOrdersStore((s) => s.applyOrderUpdated);
  const applyOrderCancelled = useOrdersStore((s) => s.applyOrderCancelled);
  const liveOrders = useOrdersStore((s) => s.liveOrders);
  const token = useAuthStore((s) => s.accessToken);
  const { play } = useOrderSounds();

  // Pull the alert config so the simple useOrderSounds player honours
  // the "beep N times" / "every X ms" settings the operator set in
  // Printers → Alerts. Without this the dashboard beeps exactly once
  // even when the rule says 4 times, which is the user-visible bug.
  const alertsQuery = useQuery({
    // Same key as AlertSoundPlayer — one shared /v1/alerts cache entry
    // instead of two under different key shapes.
    queryKey: queryKeys.alerts(locationId),
    queryFn: () => alertsClient.list(locationId),
    enabled: !!locationId,
    staleTime: 60_000,
  });
  const alertOpts = (trigger: string) => {
    const rule = (alertsQuery.data ?? []).find(
      (a) => a.trigger === trigger && a.enabled,
    );
    if (!rule) return undefined;
    return {
      repeatCount: rule.repeatCount,
      intervalMs: rule.repeatIntervalMs,
    };
  };

  // The query itself lives in the SHARED live-orders feed — one cache entry
  // (queryKeys.liveOrders) observed by this board, auto-accept and
  // auto-print alike. Socket-first: no steady poll while connected (events
  // trigger a debounced refetch), one 60s fallback poll while disconnected.
  // The feed keeps refetchOnWindowFocus OFF — focus-refetch raced in-flight
  // status mutations and snapped cards back to their pre-mutation column
  // ("click Accept, tab away, come back, order is back in New").
  const { query } = useLiveOrdersFeed(locationId);

  useEffect(() => {
    if (query.data) setLiveOrders(query.data);
  }, [query.data, setLiveOrders]);

  // Socket subscription — live deltas between polls.
  useEffect(() => {
    if (!token) return;
    const socket = getSocket(token);

    // Defense-in-depth location filter. The server only broadcasts to the
    // `location:<id>` room, so this SHOULD already be a no-op — but a client
    // can end up joined to more than one location's room (e.g. the switch
    // below leaves the room it's given, but any other path that ever calls
    // room:join without a matching leave, a reconnect that re-joins before
    // the old room naturally times out, etc.). Every one of those failure
    // modes turns into "location A shows location B's order" if the board
    // blindly trusts room membership — so it never does: an event for any
    // location other than the one this hook is scoped to is dropped before
    // it reaches the store, full stop. `locationId` undefined means "all
    // locations" (the admin all-locations view) — that's the one case
    // everything is allowed through.
    const belongsHere = (eventLocationId: string) =>
      !locationId || eventLocationId === locationId;

    // Wrap each handler so we can play the matching sound *in addition*
    // to running the store mutation. We thread the original payload
    // through unchanged so all the existing optimistic-update logic
    // still fires; the sound is a side effect of the same event.
    //
    // Socket events use the slim OrderEventPayload / OrderCancelledPayload
    // shapes (orderId, not id) — not the full Order from the REST list
    // endpoint.
    const onNew = (payload: OrderEventPayload) => {
      if (!belongsHere(payload.locationId)) return;
      play("new", alertOpts("NEW_ORDER"));
      applyNewOrder(payload);
    };
    const onUpdated = (payload: OrderEventPayload) => {
      if (!belongsHere(payload.locationId)) return;
      // Only sound the rider-arrived alert when the status genuinely
      // transitioned *into* RIDER_ARRIVED — any re-emit of the same
      // status (idempotent webhook retries, board re-syncs) shouldn't
      // re-beep.
      if (payload.status === "RIDER_ARRIVED") {
        const prev = useOrdersStore
          .getState()
          .liveOrders.find((o) => o.id === payload.orderId);
        if (!prev || prev.status !== "RIDER_ARRIVED") {
          play("rider_arrived", alertOpts("RIDER_ARRIVED"));
        }
      }
      applyOrderUpdated(payload);
    };
    const onCancelled = (payload: OrderCancelledPayload) => {
      if (!belongsHere(payload.locationId)) return;
      play("cancelled", alertOpts("ORDER_CANCELLED"));
      applyOrderCancelled(payload);
    };

    socket.on("order:new", onNew);
    socket.on("order:updated", onUpdated);
    socket.on("order:cancelled", onCancelled);

    // Refcounted join — several consumers (this board, the alert player,
    // the live-orders feed) share the same location room; the helper only
    // actually leaves the room when the LAST consumer is done, so this
    // board unmounting no longer silently kicks the others out.
    if (locationId) joinLocationRoom(socket, locationId);

    return () => {
      socket.off("order:new", onNew);
      socket.off("order:updated", onUpdated);
      socket.off("order:cancelled", onCancelled);
      // Release our hold on the room — without this, switching locations
      // (or an admin flipping through several boards in one session) leaves
      // the socket subscribed to every location it's ever visited, and any
      // later fix to the server-side broadcast scoping would still leak
      // through this stale membership.
      if (locationId) leaveLocationRoom(socket, locationId);
    };
  }, [token, locationId, applyNewOrder, applyOrderUpdated, applyOrderCancelled, play]);

  return {
    orders: liveOrders,
    isLoading: query.isLoading,
    error: query.error,
  };
}

// ── Status-update mutation ──────────────────────────────────────────────────
//
// Implements the canonical TanStack Query optimistic-update pattern. Three
// things have to happen atomically the moment the user clicks an action
// button, otherwise the UI ends up fighting itself:
//
//   1. CANCEL any in-flight refetch of the live list. Without this, a
//      refetch that was already running (e.g. because the user just
//      tab-switched back and refetchOnWindowFocus fired) can resolve with
//      a PENDING snapshot *after* our optimistic update has moved the card
//      forward, snapping it back to the previous column. This was the
//      reported symptom: "I accept, switch tabs, come back, and the order
//      is back in New — I have to click Accept again."
//
//   2. WRITE the optimistic status into BOTH the React Query cache (so a
//      subsequent re-render or remount keeps the new value) AND the
//      Zustand store (so the board re-renders immediately without waiting
//      for the bridging useEffect to fire).
//
//   3. SNAPSHOT the prior cache so we can roll back atomically on error.
//
// On settle (success or error), invalidate to refetch the canonical server
// state — at that point the server has either persisted our change or
// rejected it, so the next snapshot is the source of truth.
export function useUpdateOrderStatus() {
  const optimisticStatusUpdate = useOrdersStore(
    (s) => s.optimisticStatusUpdate,
  );
  const setLiveOrders = useOrdersStore((s) => s.setLiveOrders);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      orderId,
      status,
      note,
      cancelReason,
    }: {
      orderId: string;
      status: string;
      note?: string;
      cancelReason?: string;
    }) => ordersClient.updateStatus(orderId, status, { note, cancelReason }),

    onMutate: async ({ orderId, status }) => {
      // 1. Stop any in-flight refetch (it could resolve with stale data
      // and overwrite our optimistic update mid-flight).
      await queryClient.cancelQueries({ queryKey: ["orders", "live"] });

      // 2. Snapshot every "orders/live" cache entry (we don't know which
      // locationId is active — could be undefined for "All locations").
      const snapshots = queryClient.getQueriesData<Order[]>({
        queryKey: ["orders", "live"],
      });

      // 3. Optimistically update every matching cache entry AND the store.
      queryClient.setQueriesData<Order[]>(
        { queryKey: ["orders", "live"] },
        (old) =>
          old?.map((o) =>
            o.id === orderId ? ({ ...o, status } as Order) : o,
          ) ?? old,
      );
      optimisticStatusUpdate(orderId, status);

      return { snapshots };
    },

    onSuccess: (updatedOrder) => {
      // Server confirmed the transition — write its authoritative response
      // back into every "orders/live" cache entry. This makes the cache
      // immediately consistent without waiting for the onSettled refetch
      // round-trip, so the store stays correct even if a delayed
      // refetch arrives shortly after.
      queryClient.setQueriesData<Order[]>(
        { queryKey: ["orders", "live"] },
        (old) =>
          old?.map((o) => (o.id === updatedOrder.id ? updatedOrder : o)) ??
          old,
      );
    },

    onError: (_err, _vars, context) => {
      // Restore every snapshotted cache entry. The bridging useEffect in
      // useLiveOrders will resync the store from the rolled-back cache.
      context?.snapshots.forEach(([key, data]) => {
        queryClient.setQueryData(key, data);
        if (Array.isArray(data)) setLiveOrders(data);
      });
    },

    onSettled: () => {
      // Always refetch once the mutation finishes — get the authoritative
      // server state. This runs in addition to onSuccess/onError so we
      // self-heal from any optimistic drift on the next tick.
      queryClient.invalidateQueries({ queryKey: ["orders", "live"] });
    },
  });
}
