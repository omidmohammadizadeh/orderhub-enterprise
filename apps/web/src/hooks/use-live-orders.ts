"use client";

import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ordersClient, type Order } from "../lib/api/orders.client";
import { useOrdersStore } from "../stores/orders.store";
import { getSocket } from "../lib/socket/socket.client";
import { useAuthStore } from "../stores/auth.store";
import { useOrderSounds } from "./use-order-sounds";
import { alertsClient } from "../lib/api/printers.client";
import type {
  OrderEventPayload,
  OrderCancelledPayload,
} from "@orderhub/shared";

// ── React Query key ─────────────────────────────────────────────────────────
// Exported so the mutation hook below (and any future consumer) shares the
// exact same key shape — drift between key tuples is the most common cause
// of "the mutation succeeded but the list never updates" bugs.
const liveOrdersKey = (locationId?: string) =>
  ["orders", "live", locationId] as const;

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
    queryKey: ["alerts", locationId] as const,
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

  const query = useQuery({
    queryKey: liveOrdersKey(locationId),
    queryFn: () => ordersClient.live(locationId),
    refetchInterval: 30_000, // fallback poll in case the socket misses an event
    // Treat cache as fresh for one full poll cycle. Without this, navigating
    // away from /dashboard/orders and back triggers an immediate refetch on
    // the new mount because the default staleTime is 0 — which races any
    // optimistic update that's still mid-PATCH and snaps cards back to
    // their pre-mutation column. The 30s poll still keeps data fresh.
    staleTime: 30_000,
    // refetchOnWindowFocus would race in-flight status mutations:
    //   1. User clicks Accept   → optimistic store update + PATCH starts
    //   2. User switches tab    → window blur
    //   3. User switches back   → window focus fires a refetch
    //   4. The refetch hits the API *before* the PATCH commits and
    //      returns the pre-mutation snapshot (status: PENDING).
    //   5. The bridging useEffect resyncs the store from query.data and
    //      the card visibly snaps back to "New" — exactly the symptom
    //      the operator reported as "click, tab away, come back, lost".
    //
    // We don't actually need focus-driven refreshes: the live board has
    // a 30s fallback poll and the WebSocket gateway pushes deltas in
    // real time. Disabling focus-refetch eliminates the race without
    // sacrificing freshness.
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (query.data) setLiveOrders(query.data);
  }, [query.data, setLiveOrders]);

  // Socket subscription — live deltas between polls.
  useEffect(() => {
    if (!token) return;
    const socket = getSocket(token);

    // Wrap each handler so we can play the matching sound *in addition*
    // to running the store mutation. We thread the original payload
    // through unchanged so all the existing optimistic-update logic
    // still fires; the sound is a side effect of the same event.
    //
    // Socket events use the slim OrderEventPayload / OrderCancelledPayload
    // shapes (orderId, not id) — not the full Order from the REST list
    // endpoint.
    const onNew = (payload: OrderEventPayload) => {
      play("new", alertOpts("NEW_ORDER"));
      applyNewOrder(payload);
    };
    const onUpdated = (payload: OrderEventPayload) => {
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
      play("cancelled", alertOpts("ORDER_CANCELLED"));
      applyOrderCancelled(payload);
    };

    socket.on("order:new", onNew);
    socket.on("order:updated", onUpdated);
    socket.on("order:cancelled", onCancelled);

    if (locationId) socket.emit("room:join", locationId);

    return () => {
      socket.off("order:new", onNew);
      socket.off("order:updated", onUpdated);
      socket.off("order:cancelled", onCancelled);
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
