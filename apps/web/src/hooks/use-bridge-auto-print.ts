"use client";

// Auto-print incoming orders straight to the tablet's Bluetooth printer.
//
// When the dashboard is loaded inside the OrderHub Solutions Android
// app, window.OrderHubBT is exposed. We listen for the API's
// printer:job:created socket event and, for any job whose printer is
// a bridge-bound Bluetooth printer at this location, render the
// rendered structured payload to ESC/POS and write it via the bridge.
//
// Single source of truth: the API decides WHEN to print (its auto-rule
// engine — ORDER_RECEIVED / ORDER_ACCEPTED / ORDER_PREPARING /
// ORDER_READY). We just react. No more order:new race with two
// listeners stepping on each other.
//
// Console messages are prefixed `[bridge-print]` so the operator (or
// a remote debugger) can grep logcat for them.

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

export function useBridgeAutoPrint(locationId?: string) {
  const token = useAuthStore((s) => s.accessToken);
  const printedRef = useRef<Set<string>>(new Set());

  // Refetch every 30s so a printer newly bound on another device shows
  // up without a full page reload.
  const printersQuery = useQuery({
    queryKey: ["printers", "list"],
    queryFn: () => printersClient.list(),
    enabled: !!locationId && hasNativeBridge(),
    refetchInterval: 30_000,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Log every reason the listener might NOT install so the operator
    // can self-diagnose by viewing console.
    if (!token) return console.log("[bridge-print] no token yet");
    if (!locationId)
      return console.log("[bridge-print] no locationId selected");
    if (!hasNativeBridge())
      return console.log(
        "[bridge-print] window.OrderHubBT not available — running in plain browser, not native shell",
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

    const socket = getSocket(token);
    console.log(
      `[bridge-print] subscribing to printer:job:created (socket connected=${(socket as any).connected})`,
    );

    const onJobCreated = async (event: any) => {
      console.log("[bridge-print] event:", event);
      if (!event?.id || !event?.printerId) {
        console.log("[bridge-print] skip — missing id/printerId");
        return;
      }
      // Prefer exact printerId match; fall back to any BT printer at
      // this location if the job was routed to a legacy LAN printer ID
      // that's no longer active. The socket event is already scoped to
      // this location's room, so falling back is safe when there is no
      // desktop print bridge active.
      const exactMatch = bt.find((p: any) => p.id === event.printerId);
      const printer = exactMatch ?? (bt.length > 0 ? bt[0] : null);
      if (!printer) {
        console.log(
          `[bridge-print] skip — no BT printer available (printerId=${event.printerId})`,
        );
        return;
      }
      if (!exactMatch) {
        console.log(
          `[bridge-print] using fallback printer ${printer.name} (event.printerId=${event.printerId} not in BT list)`,
        );
      }
      if (printedRef.current.has(event.id)) {
        console.log(`[bridge-print] skip — already printed job ${event.id}`);
        return;
      }
      printedRef.current.add(event.id);
      if (printedRef.current.size > 200) {
        const arr = Array.from(printedRef.current);
        printedRef.current = new Set(arr.slice(arr.length - 200));
      }

      const renderPayload = event.payload ?? null;
      if (!renderPayload) {
        console.warn(
          "[bridge-print] event has no payload — API likely on old build. Re-deploy API and try again.",
        );
        return;
      }
      const copies = Math.max(1, Number(event.copies ?? 1) || 1);
      console.log(
        `[bridge-print] rendering job=${event.id} trigger=${event.trigger} copies=${copies} printer=${printer.name}`,
      );
      try {
        const bytes = buildOrderReceipt(
          renderPayload,
          printer.paperWidth ?? 80,
        );
        for (let i = 0; i < copies; i++) {
          await bridgePrint(printer.ipAddress!, bytes);
          if (i + 1 < copies)
            await new Promise((r) => setTimeout(r, 400));
        }
        console.log(`[bridge-print] OK job=${event.id}`);
      } catch (e) {
        console.error("[bridge-print] FAILED", e);
      }
    };

    (socket as any).on("printer:job:created", onJobCreated);
    return () => {
      (socket as any).off("printer:job:created", onJobCreated);
    };
  }, [token, locationId, printersQuery.data]);
}
