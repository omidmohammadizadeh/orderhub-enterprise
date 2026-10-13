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
import toast from "react-hot-toast";
import { useQuery } from "@tanstack/react-query";
import { alertsClient, type AlertConfig } from "@/lib/api/printers.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import {
  getSocket,
  joinLocationRoom,
  leaveLocationRoom,
} from "@/lib/socket/socket.client";
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
    // Alert RULES change rarely (only when the operator edits them in
    // Printers → Alerts) — a 2-minute safety refresh is plenty. This ran
    // every 30s on every dashboard page and contributed to the 429 storm.
    // Room membership no longer depends on this poll either (the refcounted
    // helpers below + reconnect rejoin keep the socket in the room).
    refetchInterval: 120_000,
    staleTime: 60_000,
    // One immediate refresh when the operator comes back to the tab, so an
    // ack made on another till is picked up promptly despite the slower poll.
    refetchOnWindowFocus: true,
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

    // Salons: a guest booked / cancelled online, or joined the queue from
    // their phone. Uses that trigger's own rule when the shop has set one;
    // otherwise it sounds exactly like a new order (or a cancellation), so a
    // salon beeps out of the box with the sounds it already knows.
    const fallback = (trigger: string, sound: string): AlertConfig =>
      ({
        trigger,
        enabled: true,
        soundUrl: sound,
        volume: 1,
        repeatCount: 1,
        repeatIntervalMs: 5000,
        requireAcknowledgement: false,
      }) as AlertConfig;
    const onSalonAlert = (p: {
      trigger: "NEW_APPOINTMENT" | "APPOINTMENT_CANCELLED" | "WALK_IN_JOINED";
      locationId: string;
      customerName?: string;
      startsAt?: string;
      summary?: string | null;
      staffName?: string | null;
    }) => {
      if (!p || !belongsHere(p.locationId)) return;
      const saved = (alertsQuery.data ?? []).find((a) => a.trigger === p.trigger);
      if (saved && !saved.enabled) return;
      const cancel = p.trigger === "APPOINTMENT_CANCELLED";
      const rule =
        saved ??
        findRule(cancel ? "ORDER_CANCELLED" : "NEW_ORDER") ??
        fallback(p.trigger, cancel ? "/sounds/canceled_order.mp3" : "/sounds/new_order.mp3");
      play(rule);
      const when = p.startsAt
        ? new Date(p.startsAt).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
        : "";
      const who = p.customerName ?? "A guest";
      if (p.trigger === "NEW_APPOINTMENT") {
        toast.success(`New booking — ${who}${p.summary ? `, ${p.summary}` : ""}${when ? ` · ${when}` : ""}${p.staffName ? ` with ${p.staffName}` : ""}`, { duration: 10_000, icon: "✂️" });
      } else if (cancel) {
        toast(`${who} cancelled${when ? ` (${when})` : ""}`, { duration: 10_000, icon: "🚫" });
      } else {
        toast(`${who} joined the walk-in queue${p.summary ? ` — ${p.summary}` : ""}`, { duration: 8_000, icon: "🚶" });
      }
    };

    socket.on("salon:alert" as any, onSalonAlert as any);
    socket.on("order:new", onNew);
    socket.on("order:updated", onUpdated);
    socket.on("printer:agent:offline" as any, onPrinterOffline);
    socket.on("print:job", onPrintJob);

    // Refcounted join — shared with the orders board + live-orders feed;
    // only the LAST consumer's leave actually exits the room, and the
    // socket client rejoins held rooms after every reconnect.
    joinLocationRoom(socket, locationId);

    return () => {
      socket.off("salon:alert" as any, onSalonAlert as any);
      socket.off("order:new", onNew);
      socket.off("order:updated", onUpdated);
      socket.off("printer:agent:offline" as any, onPrinterOffline);
      socket.off("print:job", onPrintJob);
      leaveLocationRoom(socket, locationId);
    };
  }, [locationId, user, token, alertsQuery.data]);

  return null;
}
