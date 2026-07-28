"use client";

// "They're here" — pick the table for a booking that never named one.
//
// Only tables /availability says are free for THIS slot are offered, but
// the seat call can still fail (someone opened a tab on that table two
// seconds ago), so the server's message is shown verbatim rather than
// swallowed — it names the table and says what to do.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  reservationsClient,
  formatTime,
  type Reservation,
} from "@/lib/api/reservations.client";

export function SeatPicker({
  reservation,
  seating,
  error,
  onSeat,
  onClose,
}: {
  reservation: Reservation;
  seating: boolean;
  error: string | null;
  onSeat: (tableId: string) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);

  const availabilityQuery = useQuery({
    queryKey: ["reservations", "availability", "seat", reservation.id],
    queryFn: () =>
      reservationsClient.availability({
        locationId: reservation.locationId,
        startsAt: reservation.startsAt,
        partySize: reservation.partySize,
        durationMins: reservation.durationMins,
        ignoreReservationId: reservation.id,
      }),
  });
  const free = availabilityQuery.data?.available ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-zinc-200 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              Seat {reservation.customerName}
            </h2>
            <p className="text-[11px] text-zinc-500">
              {formatTime(reservation.startsAt)} · party of{" "}
              {reservation.partySize} — pick a table to open their tab.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="mx-3 mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="max-h-80 overflow-y-auto p-3">
          {availabilityQuery.isLoading ? (
            <p className="p-3 text-sm text-zinc-500">Loading tables…</p>
          ) : free.length === 0 ? (
            <p className="p-3 text-sm text-zinc-500">
              No free table big enough right now. Clear a table on the Tables
              page, then try again.
            </p>
          ) : (
            free.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setPicked(t.id);
                  onSeat(t.id);
                }}
                disabled={seating}
                className="mb-1.5 flex min-h-[44px] w-full items-center justify-between rounded-md border border-zinc-200 px-3 py-2 text-left hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-50"
              >
                <span className="text-sm font-medium text-zinc-900">
                  {t.name}
                  {t.area ? <span className="text-zinc-400"> · {t.area}</span> : null}
                </span>
                <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                  {seating && picked === t.id
                    ? "Seating…"
                    : t.seats
                      ? `${t.seats} seats`
                      : "Seat here"}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="flex justify-end border-t border-zinc-100 px-5 py-3">
          <Button variant="outline" onClick={onClose} className="min-h-[44px]">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
