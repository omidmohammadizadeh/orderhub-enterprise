"use client";

// Auto-print incoming orders straight to the tablet's Bluetooth printer.
//
// When the dashboard is loaded inside the OrderHub Solutions Android
// app, window.OrderHubBT is exposed. We subscribe to the same socket
// stream the orders board uses, and any time a new order arrives we
// render an ESC/POS receipt in JS and send it directly to every
// Bluetooth printer at this location. No print agent, no PrintJob
// queue, no API round-trip.
//
// One print per matching BT printer per order. We dedupe by orderId
// in a small in-memory set so reconnects + socket replays don't
// re-print yesterday's orders.

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { getSocket } from "../lib/socket/socket.client";
import { useAuthStore } from "../stores/auth.store";
import { printersClient } from "../lib/api/printers.client";
import {
  bridgePrint,
  buildOrderReceipt,
  hasNativeBridge,
} from "../lib/printing/bridge";
import type { OrderEventPayload } from "@orderhub/shared";

export function useBridgeAutoPrint(locationId?: string) {
  const token = useAuthStore((s) => s.accessToken);
  const printedRef = useRef<Set<string>>(new Set());

  // We need the printer list to know which BT printers to send to.
  const printersQuery = useQuery({
    queryKey: ["printers", "list"],
    queryFn: () => printersClient.list(),
    enabled: !!locationId && hasNativeBridge(),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!token || !locationId || !hasNativeBridge()) return;
    const bt = (printersQuery.data ?? []).filter(
      (p: any) =>
        p.locationId === locationId &&
        p.connectionType === "BLUETOOTH" &&
        p.ipAddress &&
        p.isActive !== false,
    );
    if (bt.length === 0) return;

    const socket = getSocket(token);

    const printOrder = async (orderId: string) => {
      if (printedRef.current.has(orderId)) return;
      printedRef.current.add(orderId);
      // Cap the dedupe set to the last 200 orders so we don't grow
      // memory unbounded across a long shift.
      if (printedRef.current.size > 200) {
        const arr = Array.from(printedRef.current);
        printedRef.current = new Set(arr.slice(arr.length - 200));
      }
      let order: any;
      try {
        order = await fetch(`/api/v1/orders/${orderId}`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then((r) => (r.ok ? r.json() : null));
      } catch {
        order = null;
      }
      if (!order) return;
      for (const printer of bt) {
        try {
          const bytes = buildOrderReceipt(order, printer.paperWidth ?? 80);
          await bridgePrint(printer.ipAddress!, bytes);
        } catch (e) {
          // Silently swallow — operator will see the order on screen
          // and can hit the test/reprint button manually. We don't
          // surface a toast because a noisy modal during service is
          // worse than a missed receipt.
          // eslint-disable-next-line no-console
          console.warn("[bridge-print] failed", e);
        }
      }
    };

    const onNew = (payload: OrderEventPayload) => {
      if (!payload?.orderId) return;
      void printOrder(payload.orderId);
    };
    // printer:job:created fires for EVERY auto-print trigger that matches
    // a printer rule: ORDER_RECEIVED, ORDER_ACCEPTED, ORDER_PREPARING,
    // ORDER_READY. For the BT-bridge path, we treat the job as a signal
    // to render + send via the tablet. The PrintJob row remains in the
    // queue (no agent claims it) — that's intentional for v1 so the
    // operator can see in the queue what's already been auto-printed.
    const onJobCreated = (payload: any) => {
      if (!payload?.orderId || !payload?.printerId) return;
      const printerMatches = bt.some((p: any) => p.id === payload.printerId);
      if (!printerMatches) return;
      void printOrder(payload.orderId);
    };
    socket.on("order:new", onNew);
    socket.on("printer:job:created", onJobCreated);
    return () => {
      socket.off("order:new", onNew);
      socket.off("printer:job:created", onJobCreated);
    };
  }, [token, locationId, printersQuery.data]);
}
