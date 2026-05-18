"use client";

import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ordersClient } from "../lib/api/orders.client";
import { useOrdersStore } from "../stores/orders.store";
import { getSocket } from "../lib/socket/socket.client";
import { useAuthStore } from "../stores/auth.store";

export function useLiveOrders(locationId?: string) {
  const queryClient = useQueryClient();
  const token = useAuthStore((s) => s.accessToken);
  const { setLiveOrders, applyNewOrder, applyOrderUpdated, applyOrderCancelled, liveOrders } =
    useOrdersStore();

  // Initial snapshot
  const query = useQuery({
    queryKey: ["orders", "live", locationId],
    queryFn: () => ordersClient.live(locationId),
    refetchInterval: 30_000, // fallback poll every 30s in case socket misses event
  });

  useEffect(() => {
    if (query.data) setLiveOrders(query.data);
  }, [query.data, setLiveOrders]);

  // Socket subscription
  useEffect(() => {
    if (!token) return;
    const socket = getSocket(token);

    const handleNew = applyNewOrder;
    const handleUpdated = applyOrderUpdated;
    const handleCancelled = applyOrderCancelled;

    socket.on("order:new", handleNew);
    socket.on("order:updated", handleUpdated);
    socket.on("order:cancelled", handleCancelled);

    if (locationId) {
      socket.emit("room:join", locationId);
    }

    return () => {
      socket.off("order:new", handleNew);
      socket.off("order:updated", handleUpdated);
      socket.off("order:cancelled", handleCancelled);
    };
  }, [token, locationId, applyNewOrder, applyOrderUpdated, applyOrderCancelled]);

  return {
    orders: liveOrders,
    isLoading: query.isLoading,
    error: query.error,
  };
}

export function useUpdateOrderStatus() {
  const { optimisticStatusUpdate } = useOrdersStore();
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
    onMutate: ({ orderId, status }) => {
      optimisticStatusUpdate(orderId, status);
    },
    onError: () => {
      // Revert by refetching
      queryClient.invalidateQueries({ queryKey: ["orders", "live"] });
    },
  });
}
