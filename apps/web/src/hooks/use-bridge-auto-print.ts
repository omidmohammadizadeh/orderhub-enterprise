"use client";

// Client-side auto-print — runs globally (mounted in the dashboard
// layout), so it works on EVERY page, not just one orders view.
//
// It fetches the live orders itself (independent of whichever orders
// screen is open) and, when a NEW order appears, prints it straight to
// every Bluetooth printer whose "Auto-print" toggle is on, using that
// printer's copy counts. Same code path as the manual Print button.
//
// Per-printer settings on printer.defaults:
//   autoPrint, copiesNewOrder, copiesCancelled, copiesReprint

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { printersClient } from "../lib/api/printers.client";
import { ordersClient } from "../lib/api/orders.client";
import {
  bridgePrint,
  buildOrderReceipt,
  hasNativeBridge,
  repeatReceipt,
} from "../lib/printing/bridge";
import { buildPrintPayload } from "../lib/printing/order-receipt";

const CANCELLED_STATUSES = new Set(["CANCELLED", "REJECTED", "CANCELED"]);

export interface AutoPrintStatus {
  inApp: boolean;
  armedPrinters: number;
  lastMessage: string | null;
}

export function useBridgeAutoPrint(locationId?: string): AutoPrintStatus {
  const printedNewRef = useRef<Set<string>>(new Set());
  const printedCancelRef = useRef<Set<string>>(new Set());
  const seededRef = useRef(false);
  const [status, setStatus] = useState<AutoPrintStatus>({
    inApp: false,
    armedPrinters: 0,
    lastMessage: null,
  });

  const inApp = typeof window !== "undefined" && hasNativeBridge();

  const printersQuery = useQuery({
    queryKey: ["printers", "list", locationId ?? "all"],
    queryFn: () => printersClient.list(locationId),
    enabled: !!locationId && inApp,
    refetchInterval: 30_000,
    staleTime: 30_000,
  });

  // Fetch live orders ourselves — independent of which page is open and
  // of the orders store. Poll every 7s; that's plenty for auto-print.
  const ordersQuery = useQuery({
    queryKey: ["auto-print", "orders", locationId ?? "all"],
    queryFn: () => ordersClient.live(locationId),
    enabled: !!locationId && inApp,
    refetchInterval: 7_000,
    staleTime: 0,
  });

  const printersRef = useRef<any[]>([]);
  printersRef.current = printersQuery.data ?? [];
  const orders = ordersQuery.data;

  useEffect(() => {
    const btPrinters = (printersRef.current ?? []).filter(
      (p: any) =>
        (!locationId || p.locationId === locationId) &&
        p.connectionType === "BLUETOOTH" &&
        p.ipAddress &&
        p.isActive !== false &&
        p.defaults?.autoPrint,
    );
    setStatus((s) => ({ ...s, inApp, armedPrinters: btPrinters.length }));

    if (!inApp || !locationId || !orders) return;

    if (!seededRef.current) {
      for (const o of orders) {
        printedNewRef.current.add(o.id);
        if (CANCELLED_STATUSES.has(String(o.status ?? "").toUpperCase()))
          printedCancelRef.current.add(o.id);
      }
      seededRef.current = true;
      return;
    }

    const hasItems = (o: any) => Array.isArray(o?.items) && o.items.length > 0;

    const printToAll = async (
      order: any,
      copiesField: "copiesNewOrder" | "copiesCancelled",
      banner?: string,
    ) => {
      const payload = buildPrintPayload(order, banner ? { banner } : undefined);
      let printedAny = false;
      for (const p of btPrinters) {
        const fallback = copiesField === "copiesNewOrder" ? 1 : 0;
        const copies = Math.max(
          0,
          Math.floor(Number(p.defaults?.[copiesField] ?? fallback)) || 0,
        );
        if (copies < 1) continue;
        try {
          const single = buildOrderReceipt(payload, p.paperWidth ?? 80);
          await bridgePrint(p.ipAddress!, repeatReceipt(single, copies));
          printedAny = true;
          const msg = `Printed ${copies}× ${banner ? "cancellation" : "order"} #${
            order.displayId ?? order.orderNumber ?? order.id?.slice(-4)
          } @ ${new Date().toLocaleTimeString()}`;
          console.log(`[auto-print] ${msg}`);
          setStatus((s) => ({ ...s, lastMessage: msg }));
        } catch (e: any) {
          const msg = `FAILED → ${p.name}: ${e?.message ?? e}`;
          console.error("[auto-print]", msg, e);
          setStatus((s) => ({ ...s, lastMessage: msg }));
        }
      }
      // Clear this order's server-side job(s) from the queue + bump
      // "last print" — the receipt has physically printed.
      if (printedAny && order?.id) {
        void printersClient.markOrderPrinted(order.id);
      }
    };

    for (const o of orders) {
      const st = String(o.status ?? "").toUpperCase();

      if (!printedNewRef.current.has(o.id)) {
        if (btPrinters.length === 0) {
          printedNewRef.current.add(o.id);
        } else if (hasItems(o)) {
          printedNewRef.current.add(o.id);
          void printToAll(o, "copiesNewOrder");
        }
        // partial order (no items yet): leave unseen, print when full
      }

      if (CANCELLED_STATUSES.has(st) && !printedCancelRef.current.has(o.id)) {
        printedCancelRef.current.add(o.id);
        if (btPrinters.length && hasItems(o))
          void printToAll(o, "copiesCancelled", "*** ORDER CANCELLED ***");
      }
    }

    for (const ref of [printedNewRef, printedCancelRef]) {
      if (ref.current.size > 500)
        ref.current = new Set(Array.from(ref.current).slice(-500));
    }
  }, [orders, locationId, printersQuery.data, inApp]);

  return status;
}
