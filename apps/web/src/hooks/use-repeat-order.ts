"use client";

// "The usual" — loading a customer's last order into the till's basket.
//
// This lives in its own hook because the effect that drives it had a bug that
// is invisible while reading it and impossible to see from the network tab:
// the order was fetched, answered 200, and its lines were then dropped on the
// floor, so the basket opened empty.
//
//     const orderId = pendingRepeatOrderId;
//     setPendingRepeatOrderId(null);   // ← a DEPENDENCY of this effect
//     let cancelled = false;
//     ... await fetch ...
//     if (cancelled) return;           // ← always true by now
//
// Clearing the store re-ran the effect, and re-running an effect first runs
// the PREVIOUS run's cleanup — which set `cancelled`. The request was already
// in flight and its result was discarded every single time.
//
// So: what has already been started is remembered in a ref, keyed on the order
// id, and nothing cancels on a re-run. The work is idempotent and the id is
// consumed once.

import { useEffect, useRef } from "react";
import { buildRepeatLines, indexMenuItems, type RepeatLine } from "@orderhub/shared";

export interface RepeatOrderHandlers {
  /** The id waiting to be loaded, from the store. */
  orderId: string | null;
  /** Clears it, so a remount doesn't load the same order twice. */
  clear: () => void;
  /** Today's menu categories. Null/undefined = not loaded yet; we wait. */
  categories: unknown;
  /** Fetches the order. Injected so this can be driven without a server. */
  fetchOrder: (orderId: string) => Promise<{ items?: unknown[] } | null>;
  /** Called as soon as a repeat is pending, before anything is fetched. */
  onStart: () => void;
  onLines: (lines: RepeatLine[]) => void;
  onNote: (note: string) => void;
}

export function useRepeatOrder({
  orderId,
  clear,
  categories,
  fetchOrder,
  onStart,
  onLines,
  onNote,
}: RepeatOrderHandlers) {
  // Everything that can change between renders, read at call time, so none of
  // it has to be a dependency and re-running is never destructive.
  const latest = useRef({ clear, categories, fetchOrder, onStart, onLines, onNote });
  latest.current = { clear, categories, fetchOrder, onStart, onLines, onNote };

  /** Order ids already started. The guard that replaces the cancel flag. */
  const started = useRef<string | null>(null);

  useEffect(() => {
    if (!orderId) return;
    // Into the basket immediately, before the order has even been fetched. The
    // menu read takes up to two seconds on a real shop, and until this was
    // here a repeat sat on the "who is this order for?" screen for all of it —
    // indistinguishable from having pressed "start a new order", which is
    // exactly what it was mistaken for.
    latest.current.onStart();

    // Without the menu every line looks unavailable and the whole basket is
    // dropped, so wait rather than guess. This runs again when it lands.
    const cats = latest.current.categories;
    if (!cats) return;

    if (started.current === orderId) return;
    started.current = orderId;
    latest.current.clear();

    const liveItems = indexMenuItems(cats);
    void (async () => {
      try {
        const order = await latest.current.fetchOrder(orderId);
        const { lines, gone, repriced, kept } = buildRepeatLines(
          (order?.items ?? []) as any,
          liveItems,
        );
        latest.current.onLines(lines);
        latest.current.onNote(
          lines.length === 0
            ? "Nothing from that order is on the menu any more — start it fresh."
            : [
                `Loaded their last order (${lines.length} line${lines.length === 1 ? "" : "s"}).`,
                gone.length ? `Not on the menu now: ${gone.join(", ")}.` : null,
                repriced.length ? `Priced at today's menu: ${repriced.join(", ")}.` : null,
                kept.length
                  ? `Couldn't tell which size — left at last time's price, please check: ${kept.join(", ")}.`
                  : null,
              ]
                .filter(Boolean)
                .join(" "),
        );
      } catch (err: any) {
        // Let them start again rather than leaving a basket that half-loaded.
        started.current = null;
        latest.current.onNote(
          err?.response?.data?.message ?? "Couldn't load that order — start a new one.",
        );
      }
    })();
    // `categories` is deliberately read through the ref: it is a fresh object
    // on most renders, and depending on it would restart this constantly.
    // The `started` guard is what makes re-running safe.
  }, [orderId, categories ? true : false]);
}
