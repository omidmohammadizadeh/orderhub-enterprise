"use client";

// Client-side auto-print. No conditions, no server print-job pipeline,
// no socket — it rides the exact same path as the manual "print" button
// (which works): watch the live orders feed, and when a NEW order shows
// up, print it straight to every Bluetooth printer whose "Auto-print"
// toggle is on, using that printer's configured copy counts.
//
// Per-printer settings live on printer.defaults:
//   autoPrint        — master on/off for this printer
//   copiesNewOrder   — copies to print when a new order arrives
//   copiesCancelled  — copies to print when an order is cancelled (0 = off)
//   copiesReprint    — copies the manual reprint button uses
//
// Dedupe rule: on first load we seed every currently-visible order as
// "already handled" so we never reprint the existing board. Only orders
// that appear AFTER mount print. Each order prints once for "new" and
// once (at most) for "cancelled".

import { useEffect, useRef } from "react";
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

export function useBridgeAutoPrint(locationId?: string, orders?: any[]) {
  // Ids we've already acted on, so we never double-print.
  const printedNewRef = useRef<Set<string>>(new Set());
  const printedCancelRef = useRef<Set<string>>(new Set());
  const seededRef = useRef(false);

  // Keep the printer list fresh (auto-print toggle / copies change on
  // another device, or a printer is connected, without a reload).
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
    if (!hasNativeBridge() || !locationId || !orders) return;

    // First time we see the orders list: remember everything currently
    // on the board so we don't reprint the backlog. Nothing prints on
    // this pass.
    if (!seededRef.current) {
      for (const o of orders) {
        printedNewRef.current.add(o.id);
        if (CANCELLED_STATUSES.has(String(o.status ?? "").toUpperCase()))
          printedCancelRef.current.add(o.id);
      }
      seededRef.current = true;
      return;
    }

    const btPrinters = printersRef.current.filter(
      (p: any) =>
        p.locationId === locationId &&
        p.connectionType === "BLUETOOTH" &&
        p.ipAddress &&
        p.isActive !== false &&
        p.defaults?.autoPrint,
    );

    const printToAll = async (
      order: any,
      copiesField: "copiesNewOrder" | "copiesCancelled",
      banner?: string,
    ) => {
      const payload = buildPrintPayload(order, banner ? { banner } : undefined);
      for (const p of btPrinters) {
        const copies = Math.max(
          0,
          Math.floor(Number(p.defaults?.[copiesField] ?? (copiesField === "copiesNewOrder" ? 1 : 0))) || 0,
        );
        if (copies < 1) continue;
        try {
          const single = buildOrderReceipt(payload, p.paperWidth ?? 80);
          await bridgePrint(p.ipAddress!, repeatReceipt(single, copies));
          console.log(
            `[auto-print] ${copiesField} ${copies}x order=${order.id} -> ${p.name}`,
          );
        } catch (e) {
          console.error(`[auto-print] FAILED order=${order.id} -> ${p.name}`, e);
        }
      }
    };

    for (const o of orders) {
      const status = String(o.status ?? "").toUpperCase();

      // New order → print once.
      if (!printedNewRef.current.has(o.id)) {
        printedNewRef.current.add(o.id);
        if (btPrinters.length) void printToAll(o, "copiesNewOrder");
      }

      // Cancelled → print a cancellation slip once (if copies > 0).
      if (
        CANCELLED_STATUSES.has(status) &&
        !printedCancelRef.current.has(o.id)
      ) {
        printedCancelRef.current.add(o.id);
        if (btPrinters.length)
          void printToAll(o, "copiesCancelled", "*** ORDER CANCELLED ***");
      }
    }

    // Bound memory on a long-running till.
    for (const ref of [printedNewRef, printedCancelRef]) {
      if (ref.current.size > 500) {
        ref.current = new Set(Array.from(ref.current).slice(-500));
      }
    }
  }, [orders, locationId, printersQuery.data]);
}
