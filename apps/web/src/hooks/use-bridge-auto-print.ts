"use client";

// Auto-print incoming orders straight to the tablet's Bluetooth printer.
//
// When the dashboard is loaded inside the OrderHub Solutions Android
// app, window.OrderHubBT is exposed. The API decides WHEN to print
// (its auto-rule engine creates a QUEUED PrintJob on ORDER_ACCEPTED
// etc.). We turn that job into ESC/POS bytes and write it over the
// bridge, then mark it PRINTED so it clears the queue.
//
// TWO paths to the same printer, on purpose:
//   1. Fast path — the printer:job:created socket event (instant).
//   2. Fallback — poll /print-jobs/pending-bridge every few seconds.
// The socket event can silently fail to reach a WebView (backgrounded
// tab, dropped/again-handshaking socket). When that happens auto-print
// just never fires and jobs sit in QUEUED forever. The poller is the
// safety net that makes auto-print actually reliable AND drains the
// queue. Both paths dedupe on job id and markBridgePrinted is
// idempotent, so a job never prints twice.
//
// Console messages are prefixed `[bridge-print]` so the operator (or a
// remote debugger) can grep logcat for them.

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { getSocket } from "../lib/socket/socket.client";
import { useAuthStore } from "../stores/auth.store";
import { printersClient } from "../lib/api/printers.client";
import {
  bridgePrint,
  buildOrderReceipt,
  hasNativeBridge,
  repeatReceipt,
} from "../lib/printing/bridge";

const POLL_MS = 5000;

interface BridgeJob {
  id: string;
  printerId?: string | null;
  copies?: number;
  payload?: any;
  trigger?: string | null;
}

export function useBridgeAutoPrint(locationId?: string) {
  const token = useAuthStore((s) => s.accessToken);
  // Job ids we've already started printing — dedupe across socket +
  // poll so a job never prints twice.
  const handledRef = useRef<Set<string>>(new Set());

  const printersQuery = useQuery({
    queryKey: ["printers", "list", locationId ?? "all"],
    queryFn: () => printersClient.list(locationId),
    enabled: !!locationId && hasNativeBridge(),
    refetchInterval: 30_000,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!token) return console.log("[bridge-print] no token yet");
    if (!locationId)
      return console.log("[bridge-print] no locationId selected");
    if (!hasNativeBridge())
      return console.log(
        "[bridge-print] window.OrderHubBT not available — plain browser, not native shell",
      );

    const bt = (printersQuery.data ?? []).filter(
      (p: any) =>
        p.locationId === locationId &&
        p.connectionType === "BLUETOOTH" &&
        p.ipAddress &&
        p.isActive !== false,
    );
    console.log(
      `[bridge-print] init: location=${locationId} bt-printers=${bt.length}`,
      bt.map((p: any) => ({ id: p.id, name: p.name, mac: p.ipAddress })),
    );
    if (bt.length === 0) return;

    let cancelled = false;

    // Render + write one job, then mark it printed so it leaves the
    // queue. Safe to call from both the socket handler and the poller.
    const handleJob = async (job: BridgeJob) => {
      if (cancelled) return;
      if (!job?.id) return;
      if (handledRef.current.has(job.id)) return;

      const exactMatch = bt.find((p: any) => p.id === job.printerId);
      const printer = exactMatch ?? bt[0];
      if (!printer) {
        console.log(
          `[bridge-print] skip ${job.id} — no BT printer available`,
        );
        return;
      }
      const payload = job.payload ?? null;
      if (!payload) {
        console.warn(`[bridge-print] job ${job.id} has no payload — skipping`);
        return;
      }

      // Claim the id up front so the other path doesn't double-fire
      // while this print is in flight.
      handledRef.current.add(job.id);
      if (handledRef.current.size > 300) {
        const arr = Array.from(handledRef.current);
        handledRef.current = new Set(arr.slice(arr.length - 300));
      }

      const copies = Math.max(1, Number(job.copies ?? 1) || 1);
      try {
        console.log(
          `[bridge-print] printing job=${job.id} trigger=${job.trigger} copies=${copies} printer=${printer.name}`,
        );
        const single = buildOrderReceipt(payload, printer.paperWidth ?? 80);
        await bridgePrint(printer.ipAddress!, repeatReceipt(single, copies));
        console.log(`[bridge-print] OK job=${job.id}`);
      } catch (e) {
        // Printing failed — let it be retried on a later poll.
        handledRef.current.delete(job.id);
        console.error(`[bridge-print] FAILED job=${job.id}`, e);
        return;
      }

      try {
        await printersClient.markBridgePrinted(job.id);
        console.log(`[bridge-print] marked PRINTED job=${job.id}`);
      } catch (markErr) {
        console.warn(
          `[bridge-print] printed but failed to mark ${job.id}`,
          markErr,
        );
      }
    };

    // ── Fast path: socket event ──────────────────────────────────────
    const socket = getSocket(token);
    console.log(
      `[bridge-print] subscribing to printer:job:created (connected=${(socket as any).connected})`,
    );
    const onJobCreated = (event: any) => {
      console.log("[bridge-print] socket event:", event?.id);
      void handleJob(event);
    };
    (socket as any).on("printer:job:created", onJobCreated);

    // ── Fallback: poll for QUEUED jobs ───────────────────────────────
    const poll = async () => {
      if (cancelled) return;
      try {
        const jobs = await printersClient.pendingBridgeJobs(locationId);
        if (jobs.length)
          console.log(`[bridge-print] poll found ${jobs.length} queued job(s)`);
        for (const j of jobs) {
          await handleJob(j);
        }
      } catch (e) {
        // Network blip — next tick tries again.
      }
    };
    void poll();
    const timer = setInterval(poll, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      (socket as any).off("printer:job:created", onJobCreated);
    };
  }, [token, locationId, printersQuery.data]);
}
