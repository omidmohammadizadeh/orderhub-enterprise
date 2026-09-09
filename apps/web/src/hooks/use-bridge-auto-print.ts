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
  renderReceiptParts,
  joinReceiptAndQr,
  hasNativeBridge,
  repeatReceipt,
} from "../lib/printing/bridge";
import { buildPrintPayload } from "../lib/printing/order-receipt";
import {
  resolveReceiptOffer,
  applyReceiptOffer,
  printerRenderOptions,
} from "../lib/printing/print-order";
import { isAwaitingOurPayment } from "../lib/orders/awaiting-payment";

const CANCELLED_STATUSES = new Set(["CANCELLED", "REJECTED", "CANCELED"]);

// A note the phone line took AFTER the order was placed, written onto the
// order by the voice AI as "PHONE NOTE 14:32: ...".
//
// The tablet is the only renderer for shops printing over Bluetooth, and it
// builds its own tickets from the live-orders feed — it never sees the
// server's print jobs. So a note that reached the print queue perfectly still
// produced no paper here, which is what happened on the first two live calls.
const PHONE_NOTE = /PHONE NOTE \d{1,2}:\d{2}:/;

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
  /** orderId → the instructions already printed for it. */
  const printedNoteRef = useRef<Map<string, string>>(new Map());
  // orderId → a fingerprint of the lines on the ticket that physically
  // printed. An amend (phone or POS) rewrites the order in place, and the
  // kitchen's paper still says what the caller first asked for. Ids alone
  // are not enough: editOrder KEEPS the row of a line that stayed, so
  // changing "1 coke" to "2 coke" moves no id at all.
  const printedLinesRef = useRef<Map<string, string>>(new Map());
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

    // What the paper would say: every line, its quantity and its modifiers.
    // Order-independent, so a re-ordered list is not mistaken for an edit.
    const lineSig = (o: any) =>
      ((o?.items ?? []) as any[])
        .map(
          (i) =>
            `${i.id}\u00d7${i.quantity}[${((i.modifiers ?? []) as any[])
              .map((m: any) => `${m?.name ?? ""}\u00d7${m?.quantity ?? 1}`)
              .sort()
              .join("|")}]${i.notes ?? ""}`,
        )
        .sort()
        .join(";");

    if (!seededRef.current) {
      for (const o of orders) {
        printedNewRef.current.add(o.id);
        printedItemsRef.current.set(
          o.id,
          new Set(((o as any).items ?? []).map((i: any) => i.id)),
        );
        if (CANCELLED_STATUSES.has(String(o.status ?? "").toUpperCase()))
          printedCancelRef.current.add(o.id);
        printedNoteRef.current.set(o.id, String(o.specialInstructions ?? ""));
        printedLinesRef.current.set(o.id, lineSig(o));
      }
      seededRef.current = true;
      return;
    }

    const hasItems = (o: any) => Array.isArray(o?.items) && o.items.length > 0;

    const printToAll = async (
      order: any,
      copiesField: "copiesNewOrder" | "copiesCancelled",
      banner?: string,
      label = banner ? "cancellation" : "order",
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
          // Resolve the printer's dialects through the SAME helpers reprint
          // uses. This block used to inline its own copy of the commandSet
          // rule and pass nothing else, so auto-print quietly diverged: a
          // Sunmi got the GS ( k QR command it can't draw (blank or raw URL
          // on the slip) while a reprint of the same order got the raster and
          // came out right. printFont was missing too, so the per-printer
          // typeface never applied to a first print either.
          const { receipt, receiptWithQr, qrSlip } = await renderReceiptParts(
            payload,
            p.paperWidth ?? 80,
            printerRenderOptions(p),
          );
          // Detached: plain receipts, then the QR on its own ticket. Applied
          // here as well as on reprint — a setting that only worked on one of
          // the two is exactly the drift this comment block already warns of.
          const detached = (p as any).defaults?.qrDetached ? qrSlip : null;
          await writeToPrinter(
            p,
            joinReceiptAndQr(receipt, receiptWithQr, copies, detached),
          );
          printedAny = true;
          const msg = `Printed ${copies}× ${label} #${
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

      // Never print an order we are still collecting for. This hook prints
      // straight off the live-orders list and had NO payment check, so it
      // printed unpaid payment-link and walk-in tickets regardless of every
      // accept guard — accepting and printing are separate pipelines and only
      // one of them was being held.
      //
      // Skipped WITHOUT recording it as printed, so the moment payment lands
      // the next pass picks it up and prints with the correct paid status.
      if (isAwaitingOurPayment(o as any)) continue;

      if (!printedNewRef.current.has(o.id)) {
        if (btPrinters.length === 0) {
          printedNewRef.current.add(o.id);
          printedLinesRef.current.set(o.id, lineSig(o));
        } else if (hasItems(o)) {
          printedNewRef.current.add(o.id);
          printedItemsRef.current.set(
            o.id,
            new Set(((o as any).items ?? []).map((i: any) => i.id)),
          );
          printedLinesRef.current.set(o.id, lineSig(o));
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
        const sigNow = lineSig(o);
        if (seen) {
          const freshIds = currentIds.filter((id) => !seen.has(id));
          if (freshIds.length && (o as any).tableId && btPrinters.length) {
            printedItemsRef.current.set(o.id, new Set(currentIds));
            printedLinesRef.current.set(o.id, sigNow);
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
          } else if (printedLinesRef.current.get(o.id) !== sigNow) {
            // The order changed after its ticket printed — the phone line
            // amended it, or somebody edited it on the POS. This used to
            // read "non-tab edits already reprint server-side", which is
            // true only for shops whose printer takes the server's print
            // jobs. A Bluetooth tablet renders its own tickets from this
            // feed, so nothing reached the kitchen and the paper still
            // said what the caller first asked for.
            //
            // The WHOLE ticket, not just the added lines: an amend can
            // remove an item or change a quantity, and a chit listing only
            // what is new would leave the kitchen making the old order.
            printedItemsRef.current.set(o.id, new Set(currentIds));
            printedLinesRef.current.set(o.id, sigNow);
            if (btPrinters.length && !(o as any).tableId) {
              void printToAll(
                o,
                "copiesNewOrder",
                "*** ORDER UPDATED - REPLACES EARLIER TICKET ***",
                "updated order",
              );
            }
          }
        } else {
          printedItemsRef.current.set(o.id, new Set(currentIds));
          printedLinesRef.current.set(o.id, sigNow);
        }
      }

      if (CANCELLED_STATUSES.has(st) && !printedCancelRef.current.has(o.id)) {
        printedCancelRef.current.add(o.id);
        if (btPrinters.length && hasItems(o))
          void printToAll(o, "copiesCancelled", "*** ORDER CANCELLED ***");
      }

      // A caller rang after the order was placed and left the kitchen a
      // sentence. Printed as its own slip carrying that sentence and nothing
      // else — the order it belongs to may already be in the oven, and a slip
      // that looks like a ticket is a slip that gets cooked twice.
      const instructions = String((o as any).specialInstructions ?? "");
      const seenNote = printedNoteRef.current.get(o.id);
      if (seenNote === undefined) {
        printedNoteRef.current.set(o.id, instructions);
      } else if (instructions !== seenNote && PHONE_NOTE.test(instructions)) {
        printedNoteRef.current.set(o.id, instructions);
        // Only the newest note, not every one ever left on this order.
        const latest =
          instructions
            .split(" | ")
            .filter((part) => PHONE_NOTE.test(part))
            .pop() ?? instructions;
        if (btPrinters.length)
          void printToAll(
            {
              ...(o as any),
              items: [
                {
                  id: `note-${o.id}`,
                  name: "MESSAGE FROM THE CUSTOMER",
                  quantity: 1,
                  modifiers: [],
                  notes: latest,
                },
              ],
            },
            "copiesNewOrder",
            "*** CUSTOMER NOTE - DO NOT REMAKE ***",
            "customer note",
          );
      }
    }

    // Same bound on the per-order item map (a long shift shouldn't grow it
    // without limit).
    if (printedNoteRef.current.size > 500) {
      printedNoteRef.current = new Map(
        Array.from(printedNoteRef.current.entries()).slice(-500),
      );
    }
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
