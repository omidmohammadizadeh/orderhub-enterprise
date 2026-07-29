"use client";

// Online table bookings announce themselves, the same way online orders do.
//
// A booking that only appears in the diary is a booking nobody sees until
// somebody thinks to look — which on a Friday night is never. This chimes,
// toasts, and (when the till has a Bluetooth printer) drops a paper chit,
// so a host at the door gets the booking without touching a screen.

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { getSocket, joinLocationRoom } from "../lib/socket/socket.client";
import { useAuthStore } from "../stores/auth.store";
import { printBookingViaBridge, type BookingChit } from "../lib/printing/booking-chit";

interface ReservationEvent extends BookingChit {
  id: string;
  locationId: string;
  source?: string;
}

export function useBookingAlerts(locationId?: string, opts?: { print?: boolean }) {
  const qc = useQueryClient();
  const token = useAuthStore((s) => s.accessToken);
  // The socket can redeliver on reconnect; never chime or print twice for
  // the same booking.
  const seen = useRef<Set<string>>(new Set());
  const printEnabled = opts?.print !== false;

  useEffect(() => {
    if (!locationId || !token) return;
    const socket = getSocket(token);
    joinLocationRoom(socket, locationId);

    const onBooking = (ev: ReservationEvent) => {
      if (!ev?.id || seen.current.has(ev.id)) return;
      seen.current.add(ev.id);

      // Autoplay is blocked until the page has been interacted with; the
      // toast still lands, so a silent chime is never a silent booking.
      try {
        const audio = new Audio("/sounds/new_order.mp3");
        audio.volume = 0.9;
        void audio.play().catch(() => undefined);
      } catch {
        /* no audio on this device */
      }

      const when = new Date(ev.startsAt);
      const time = Number.isFinite(when.getTime())
        ? when.toLocaleString("en-GB", {
            weekday: "short",
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
      toast.success(
        `New booking — ${ev.customerName}, ${ev.partySize} ${
          ev.partySize === 1 ? "guest" : "guests"
        }${time ? ` · ${time}` : ""}`,
        { duration: 10_000, icon: "📅" },
      );

      // Refresh whatever diary is on screen.
      qc.invalidateQueries({ queryKey: ["reservations"] });

      if (printEnabled) {
        void printBookingViaBridge(ev.locationId ?? locationId, ev).catch(
          () => undefined,
        );
      }
    };

    socket.on("reservation:new" as any, onBooking as any);
    return () => {
      socket.off("reservation:new" as any, onBooking as any);
    };
  }, [locationId, token, qc, printEnabled]);
}
