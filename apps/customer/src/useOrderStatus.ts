import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { getOrderStatus, type OrderStatusPayload } from "./api";
import { isFinished } from "./format";

const POLL_MS = 10_000;

/** Polls the public tracking endpoint while the screen is focused and the
 *  order is still moving. Push does the alerting; this keeps the screen
 *  honest if a push is late or the customer turned them off. */
export function useOrderStatus(orderId: string, { poll = true } = {}) {
  const [order, setOrder] = useState<OrderStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const finished = order ? isFinished(order.status) : false;
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await getOrderStatus(orderId);
      if (!alive.current) return;
      setOrder(next);
      setError(null);
    } catch (err) {
      if (alive.current) setError(String(err));
    }
  }, [orderId]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      load();
      if (!poll || finished) return;
      const timer = setInterval(() => {
        if (AppState.currentState === "active") load();
      }, POLL_MS);
      return () => clearInterval(timer);
    }, [load, poll, finished]),
  );

  return { order, error, refreshing, refresh };
}
