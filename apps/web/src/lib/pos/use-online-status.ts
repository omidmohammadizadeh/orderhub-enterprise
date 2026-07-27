"use client";

// Phase AM — tiny hook around navigator.onLine + 'online'/'offline' events.
// Used by the POS to render the offline banner and disable online-card
// payment when the network is down.

import { useCallback, useEffect, useState } from "react";
import type { QueuedOrder } from "./idb-storage";
import { listQueue } from "./idb-storage";
import { drainQueue } from "./sync-worker";

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const onUp = () => setOnline(true);
    const onDown = () => setOnline(false);
    window.addEventListener("online", onUp);
    window.addEventListener("offline", onDown);
    return () => {
      window.removeEventListener("online", onUp);
      window.removeEventListener("offline", onDown);
    };
  }, []);

  return online;
}

// Phase AN — companion for the offline order queue: exposes the pending orders
// (for the "X waiting to sync" banner / queue list) and a manual retry. Polls
// IndexedDB on a light interval + whenever connectivity flips.
export function useSyncQueue(): {
  queue: QueuedOrder[];
  pending: number;
  refresh: () => void;
  retry: () => void;
} {
  const [queue, setQueue] = useState<QueuedOrder[]>([]);

  const refresh = useCallback(() => {
    void listQueue().then(setQueue);
  }, []);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, 5_000);
    const onOnline = () => {
      void drainQueue().then(refresh);
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  const retry = useCallback(() => {
    void drainQueue().then(refresh);
  }, [refresh]);

  const pending = queue.filter(
    (o) => o.status === "pending" || o.status === "failed",
  ).length;

  return { queue, pending, refresh, retry };
}
