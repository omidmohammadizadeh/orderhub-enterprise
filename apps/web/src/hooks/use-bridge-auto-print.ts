"use client";

// Client-side auto-print. No conditions, no server print-job pipeline,
// no socket dependency for the print itself — it rides the same path as
// the manual "print" button (which works): watch the live orders feed,
// and when a NEW order shows up, print it straight to every Bluetooth
// printer whose "Auto-print" toggle is on, using that printer's copy
// counts.
//
// Per-printer settings live on printer.defaults:
//   autoPrint, copiesNewOrder, copiesCancelled, copiesReprint
//
// Returns a live status object so the board can show, ON SCREEN, whether
// auto-print is armed — invaluable on a tablet where there's no console.

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { printersClient } from "../lib/api/printers.client";
import {
  bridgePrint,
  buildOrderReceipt,
  hasNativeBridge,
  repeatReceipt,
} from "../lib/printing/bridge";
import { buildPrintPayload } from "../lib/printing/order-receipt";

const CANCELLED_STATUSES = new Set(["CANCELLED", "REJECTED", "CANCELED"]);

export interface AutoPrintStatus {
  inApp: boolean; // running inside the native tablet shell
  armedPrinters: number; // BT printers with auto-print ON
  lastMessage: string | null; // last action / error, for on-screen display
}

export function useBridgeAutoPrint(locationId?: string, orders?: any[]) {
  const printedNewRef = useRef<Set<string>>(new Set());
  const printedCancelRef = useRef<Set<string>>(new Set());
  const seededRef = useRef(false);
  const [status, setStatus] = useState<AutoPrintStatus>({
    inApp: false,
    armedPrinters: 0,
    lastMessage: null,
  });

  const printersQuery = useQuery({
    queryKey: ["printers", "list", locationId ?? "all"],
    queryFn: () => printersClient.list(locationId),
    enabled: !!locationId && hasNativeBridge(),
    refetchInterval: 30_000,
    staleTime: 30_000,
  });
  const printersRef = useRef<any[]>([]);
  printersRef.current = printersQuery.data ?? [];

  useEffect(() => {
    if (typeof window === "undefined") return;
    const inApp = hasNativeBridge();

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

    // First load: remember the current board so we don't reprint the
    // backlog. Nothing prints on this pass.
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
          const msg = `Printed ${copies}× ${
            banner ? "cancellation" : "order"
          } #${order.displayId ?? order.orderNumber ?? order.id?.slice(-4)} → ${p.name} @ ${new Date().toLocaleTimeString()}`;
          console.log(`[auto-print] ${msg}`);
          setStatus((s) => ({ ...s, lastMessage: msg }));
        } catch (e: any) {
          const msg = `FAILED → ${p.name}: ${e?.message ?? e}`;
          console.error("[auto-print]", msg, e);
          setStatus((s) => ({ ...s, lastMessage: msg }));
        }
      }
    };

    for (const o of orders) {
      const statusUp = String(o.status ?? "").toUpperCase();

      // New order → print once, but only once we actually have the line
      // items. New orders first arrive over the socket as a PARTIAL
      // record (no items); printing then would spit a blank receipt and
      // poison the dedupe so the full order never prints. Wait for the
      // full order (REST refetch / order:updated) before committing.
      if (!printedNewRef.current.has(o.id)) {
        if (btPrinters.length === 0) {
          // No armed printer — treat as handled so we don't dump the
          // backlog the moment one gets enabled.
          printedNewRef.current.add(o.id);
        } else if (hasItems(o)) {
          printedNewRef.current.add(o.id);
          void printToAll(o, "copiesNewOrder");
        }
        // else: partial order, leave unseen so it prints when full.
      }

      // Cancelled → print a cancellation slip once.
      if (CANCELLED_STATUSES.has(statusUp) && !printedCancelRef.current.has(o.id)) {
        printedCancelRef.current.add(o.id);
        if (btPrinters.length && hasItems(o))
          void printToAll(o, "copiesCancelled", "*** ORDER CANCELLED ***");
      }
    }

    for (const ref of [printedNewRef, printedCancelRef]) {
      if (ref.current.size > 500)
        ref.current = new Set(Array.from(ref.current).slice(-500));
    }
  }, [orders, locationId, printersQuery.data]);

  return status;
}
