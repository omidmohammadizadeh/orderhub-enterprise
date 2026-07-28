"use client";

// Client-side auto-print — runs globally (mounted in the dashboard
// layout), so it works on EVERY page, not just one orders view.
//
// It observes the shared live-orders feed (socket-driven — see
// use-live-orders-feed.ts) independent of whichever orders screen is
// open and, when a NEW order appears, prints it straight to every
// Bluetooth printer whose "Auto-print" toggle is on, using that
// printer's copy counts. Same code path as the manual Print button.
//
// Per-printer settings on printer.defaults:
//   autoPrint, copiesNewOrder, copiesCancelled, copiesReprint

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { printersClient } from "../lib/api/printers.client";
import { useLiveOrdersFeed } from "./use-live-orders-feed";
import { queryKeys } from "../lib/api/query-keys";
import {
  writeToPrinter,
  bridgeSupportsPrinter,
  renderReceiptBytes,
  hasNativeBridge,
  repeatReceipt,
  resolveFontScale,
  resolveModifierScale,
} from "../lib/printing/bridge";
import { buildPrintPayload } from "../lib/printing/order-receipt";
import { resolveReceiptOffer, applyReceiptOffer } from "../lib/printing/print-order";

const CANCELLED_STATUSES = new Set(["CANCELLED", "REJECTED", "CANCELED"]);

export interface AutoPrintStatus {
  inApp: boolean;
  armedPrinters: number;
  lastMessage: string | null;
}

export function useBridgeAutoPrint(locationId?: string): AutoPrintStatus {
  const printedNewRef = useRef<Set<string>>(new Set());
  const printedCancelRef = useRef<Set<string>>(new Set());
  // Table Tabs — item ids already printed per order, so a later ROUND on an
  // open tab prints a chit with ONLY the new lines. Without this the bridge
  // printed an order exactly once (on first sight) and every subsequent
  // round silently never reached the paper kitchen.
  const printedItemsRef = useRef<Map<string, Set<string>>>(new Map());
  const seededRef = useRef(false);
  const [status, setStatus] = useState<AutoPrintStatus>({
    inApp: false,
    armedPrinters: 0,
    lastMessage: null,
  });

  const inApp = typeof window !== "undefined" && hasNativeBridge();

  const printersQuery = useQuery({
    queryKey: queryKeys.printers(locationId),
    queryFn: () => printersClient.list(locationId),
    enabled: !!locationId && inApp,
    refetchInterval: 30_000,
    staleTime: 30_000,
  });

  // Live orders come from the SHARED feed (socket-first, 60s fallback only
  // while the socket is down) — the independent 7-second poll this hook
  // used to run was a main driver of the production 429s. Native-only:
  // ordinary browsers never fetch for auto-print.
  const { orders } = useLiveOrdersFeed(locationId, {
    enabled: !!locationId && inApp,
  });

  const printersRef = useRef<any[]>([]);
  printersRef.current = printersQuery.data ?? [];

  useEffect(() => {
    const btPrinters = (printersRef.current ?? []).filter(
      (p: any) =>
        (!locationId || p.locationId === locationId) &&
        (p.connectionType === "BLUETOOTH" || p.connectionType === "LAN") &&
        p.ipAddress &&
        p.isActive !== false &&
        p.defaults?.autoPrint &&
        bridgeSupportsPrinter(p),
    );
    setStatus((s) => ({ ...s, inApp, armedPrinters: btPrinters.length }));

    if (!inApp || !locationId || !orders) return;

    if (!seededRef.current) {
      for (const o of orders) {
        printedNewRef.current.add(o.id);
        printedItemsRef.current.set(
          o.id,
          new Set(((o as any).items ?? []).map((i: any) => i.id)),
        );
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
      // Receipt logo (all tickets) + marketplace "scan to order online"
      // QR (new-order tickets only, never on cancellation slips).
      const offer = await resolveReceiptOffer(order);
      applyReceiptOffer(
        payload,
        copiesField === "copiesNewOrder"
          ? offer
          : offer && { ...offer, isMarketplace: false }, // logo only, no QR
      );
      let printedAny = false;
      for (const p of btPrinters) {
        const fallback = copiesField === "copiesNewOrder" ? 1 : 0;
        const copies = Math.max(
          0,
          Math.floor(Number(p.defaults?.[copiesField] ?? fallback)) || 0,
        );
        if (copies < 1) continue;
        try {
          // Star printers need Star Line Mode; Epson/Sunmi use ESC/POS.
          const commandSet =
            String((p as any).defaults?.commandSet ?? "").toUpperCase() ||
            (String((p as any).defaults?.brand ?? "").toLowerCase() === "star" ||
            /star/i.test(String((p as any).model ?? ""))
              ? "STAR"
              : "ESCPOS");
          const single = await renderReceiptBytes(payload, p.paperWidth ?? 80, {
            printLogo: p.defaults?.printLogo,
            qrCode: p.defaults?.qrCode,
            commandSet,
            fontScale: resolveFontScale(p),
            modifierScale: resolveModifierScale(p),
          });
          await writeToPrinter(p, repeatReceipt(single, copies));
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
          // Surface auto-print failures in the activity feed.
          void printersClient.reportPrint({
            ok: false,
            orderId: order.id,
            printerName: p.name,
            message: e?.message ?? String(e),
            kind: "auto",
          });
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
          printedItemsRef.current.set(
            o.id,
            new Set(((o as any).items ?? []).map((i: any) => i.id)),
          );
          void printToAll(o, "copiesNewOrder");
        }
        // partial order (no items yet): leave unseen, print when full
      } else if (hasItems(o)) {
        // Table Tabs — an already-printed DINE-IN tab that gained items is a
        // new ROUND: print a chit with ONLY the new lines (the kitchen has
        // the earlier rounds on paper already).
        const seen = printedItemsRef.current.get(o.id);
        const currentIds: string[] = ((o as any).items ?? []).map(
          (i: any) => i.id,
        );
        if (seen) {
          const freshIds = currentIds.filter((id) => !seen.has(id));
          if (freshIds.length && (o as any).tableId && btPrinters.length) {
            printedItemsRef.current.set(o.id, new Set(currentIds));
            const table = (o as any).tableName;
            void printToAll(
              {
                ...(o as any),
                items: ((o as any).items ?? []).filter((i: any) =>
                  freshIds.includes(i.id),
                ),
              },
              "copiesNewOrder",
              `*** ${table ? `TABLE ${table} - ` : ""}NEW ITEMS ***`,
            );
          } else if (freshIds.length) {
            // Non-tab edits already reprint server-side; just track them.
            printedItemsRef.current.set(o.id, new Set(currentIds));
          }
        } else {
          printedItemsRef.current.set(o.id, new Set(currentIds));
        }
      }

      if (CANCELLED_STATUSES.has(st) && !printedCancelRef.current.has(o.id)) {
        printedCancelRef.current.add(o.id);
        if (btPrinters.length && hasItems(o))
          void printToAll(o, "copiesCancelled", "*** ORDER CANCELLED ***");
      }
    }

    // Same bound on the per-order item map (a long shift shouldn't grow it
    // without limit).
    if (printedItemsRef.current.size > 500) {
      printedItemsRef.current = new Map(
        Array.from(printedItemsRef.current.entries()).slice(-500),
      );
    }
    for (const ref of [printedNewRef, printedCancelRef]) {
      if (ref.current.size > 500)
        ref.current = new Set(Array.from(ref.current).slice(-500));
    }
  }, [orders, locationId, printersQuery.data, inApp]);

  return status;
}
