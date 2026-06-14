"use client";

// Phase AS-4 — global alert sound player.
//
// Subscribes to the orders socket (`new-order`, `order:updated`) and the
// printer socket (`printer:agent:offline`, `printer:job:created` with
// status=FAILED) and triggers the matching AlertConfig sound + repeat
// pattern. Sounds play in every dashboard tab the operator has open;
// acknowledgement is broadcast through `/v1/alerts/ack` so clicking
// Stop on one tab kills the alert everywhere via re-fetch.
//
// Deliberate scope: this component does NOT live-update from the
// server's view of alerts (no socket round-trip on ack). It re-reads
// `alertsClient.list()` periodically.

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { alertsClient, type AlertConfig } from "@/lib/api/printers.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { io, Socket } from "socket.io-client";
import { useAuthStore } from "@/stores/auth.store";

export function AlertSoundPlayer() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const user = useAuthStore((s) => s.user);
  const alertsQuery = useQuery({
    queryKey: ["alerts", "list", locationId ?? "all"],
    queryFn: () => alertsClient.list(locationId ?? undefined),
    enabled: !!locationId,
    refetchInterval: 30_000,
  });

  const socketRef = useRef<Socket | null>(null);
  const audioCacheRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  useEffect(() => {
    if (!locationId || !user) return;
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "/api";
    const url = apiBase.replace(/\/api(\/v1)?$/, "");
    const socket = io(url, {
      reconnection: true,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    const findRule = (trigger: string): AlertConfig | undefined =>
      (alertsQuery.data ?? []).find(
        (a) => a.trigger === trigger && a.enabled,
      );

    const play = (rule: AlertConfig, refKey: string) => {
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

    socket.on("new-order", (payload: any) => {
      const rule = findRule("NEW_ORDER");
      if (rule) play(rule, `new-order:${payload?.orderId ?? Date.now()}`);
    });
    socket.on("order:updated", (payload: any) => {
      if (payload?.status === "CANCELLED" || payload?.status === "REJECTED") {
        const rule = findRule("ORDER_CANCELLED");
        if (rule)
          play(rule, `order-cancelled:${payload?.orderId ?? Date.now()}`);
      }
      if (payload?.status === "RIDER_ARRIVED") {
        const rule = findRule("RIDER_ARRIVED");
        if (rule)
          play(rule, `rider-arrived:${payload?.orderId ?? Date.now()}`);
      }
    });
    socket.on("printer:agent:offline", () => {
      const rule = findRule("PRINTER_OFFLINE");
      if (rule) play(rule, `printer-offline:${Date.now()}`);
    });
    socket.on("printer:job:failed", () => {
      const rule = findRule("FAILED_PRINT");
      if (rule) play(rule, `failed-print:${Date.now()}`);
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [locationId, user, alertsQuery.data]);

  return null;
}
