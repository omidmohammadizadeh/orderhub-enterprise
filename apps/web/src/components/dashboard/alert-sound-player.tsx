"use client";

// Phase AS-4 — global alert sound player.
//
// Subscribes to the shared orders/printer socket (`order:new`,
// `order:updated`, `printer:agent:offline`, `print:job` with
// status=FAILED) and triggers the matching AlertConfig sound + repeat
// pattern. Sounds play in every dashboard tab the operator has open;
// acknowledgement is broadcast through `/v1/alerts/ack` so clicking
// Stop on one tab kills the alert everywhere via re-fetch.
//
// Deliberate scope: this component does NOT live-update from the
// server's view of alerts (no socket round-trip on ack). It re-reads
// `alertsClient.list()` periodically.
//
// Fixed 2026-07-10 — this used to open its OWN raw io() connection built
// from NEXT_PUBLIC_API_URL with a regex strip. When that env var is unset
// (falls back to the relative "/api"), the regex collapses it to an empty
// string, and socket.io-client then defaults an empty host to the current
// page's own origin — which runs no Socket.IO server — so the connection
// never succeeded; every event below was silently, permanently dead (only
// visible as an endless flood of 404s on /socket.io in the console). It
// also listened for "new-order" and "printer:job:failed", which the server
// never emits (the real names are "order:new" and "print:job" with a
// status field) — so even a working connection would have missed both.
// Now it reuses the same shared, correctly-configured socket singleton the
// orders board uses (getSocket, NEXT_PUBLIC_SOCKET_URL) instead of a
// second bespoke connection per tab.

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { alertsClient, type AlertConfig } from "@/lib/api/printers.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { getSocket } from "@/lib/socket/socket.client";
import { useAuthStore } from "@/stores/auth.store";
import type { OrderEventPayload, PrintJobEventPayload } from "@orderhub/shared";

export function AlertSoundPlayer() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.accessToken);
  const alertsQuery = useQuery({
    queryKey: ["alerts", "list", locationId ?? "all"],
    queryFn: () => alertsClient.list(locationId ?? undefined),
    enabled: !!locationId,
    refetchInterval: 30_000,
  });

  const audioCacheRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  useEffect(() => {
    if (!locationId || !user || !token) return;
    const socket = getSocket(token);

    const findRule = (trigger: string): AlertConfig | undefined =>
      (alertsQuery.data ?? []).find(
        (a) => a.trigger === trigger && a.enabled,
      );

    const play = (rule: AlertConfig) => {
      if (!rule.soundUrl) return;
      let audio = audioCacheRef.current.get(rule.soundUrl);
      if (!audio) {
        audio = new Audio(rule.soundUrl);
        audioCacheRef.current.set(rule.soundUrl, audio);
      }
      audio.volume = Math.max(0, Math.min(1, rule.volume));
      let played = 0;
      const playOnce = () => {
        audio!.currentTime = 0;
        audio!.play().catch(() => {});
        played++;
        if (played < rule.repeatCount) {
          setTimeout(playOnce, rule.repeatIntervalMs);
        } else if (rule.requireAcknowledgement) {
          // Repeat indefinitely until user acks.
          setTimeout(playOnce, rule.repeatIntervalMs);
        }
      };
      playOnce();
    };

    // Same "never trust room membership alone" rule as the orders board —
    // an order/print event for any location other than the one selected is
    // ignored, so a stale room join (or a future bug) can't sound an alert
    // for the wrong location.
    const belongsHere = (eventLocationId: string) =>
      eventLocationId === locationId;

    const onNew = (payload: OrderEventPayload) => {
      if (!belongsHere(payload.locationId)) return;
      const rule = findRule("NEW_ORDER");
      if (rule) play(rule);
    };
    const onUpdated = (payload: OrderEventPayload) => {
      if (!belongsHere(payload.locationId)) return;
      if (payload.status === "CANCELLED" || payload.status === "REJECTED") {
        const rule = findRule("ORDER_CANCELLED");
        if (rule) play(rule);
      }
      if (payload.status === "RIDER_ARRIVED") {
        const rule = findRule("RIDER_ARRIVED");
        if (rule) play(rule);
      }
    };
    // No locationId on this payload (ad-hoc event, not in the shared
    // ServerToClientEvents contract) — the server already scopes it to the
    // location:<id> room, so correct room join/leave below is what keeps
    // this one location-safe.
    const onPrinterOffline = () => {
      const rule = findRule("PRINTER_OFFLINE");
      if (rule) play(rule);
    };
    const onPrintJob = (payload: PrintJobEventPayload) => {
      if (payload.locationId !== locationId) return;
      if (payload.status !== "FAILED") return;
      const rule = findRule("FAILED_PRINT");
      if (rule) play(rule);
    };

    socket.on("order:new", onNew);
    socket.on("order:updated", onUpdated);
    socket.on("printer:agent:offline" as any, onPrinterOffline);
    socket.on("print:job", onPrintJob);

    socket.emit("room:join", locationId);

    return () => {
      socket.off("order:new", onNew);
      socket.off("order:updated", onUpdated);
      socket.off("printer:agent:offline" as any, onPrinterOffline);
      socket.off("print:job", onPrintJob);
      socket.emit("room:leave", locationId);
    };
  }, [locationId, user, token, alertsQuery.data]);

  return null;
}
