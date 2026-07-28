"use client";

// New / edit booking. One modal for both — the API's PATCH takes the same
// fields as POST, so the only difference is which mutation fires.
//
// The table picker is fed live from /availability as the time, duration or
// party size changes: staff need to see "is there even room" while they're
// still on the phone to the guest, not after they hit save.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  reservationsClient,
  toDateInput,
  toIsoFromLocal,
  toTimeInput,
  type CreateReservationInput,
  type Reservation,
} from "@/lib/api/reservations.client";

export function ReservationEditor({
  locationId,
  reservation,
  defaultDate,
  defaultDurationMins,
  onClose,
  onSaved,
}: {
  locationId: string;
  reservation: Reservation | null;
  /** Day the diary is showing — a new booking should land on it, not today. */
  defaultDate: string;
  defaultDurationMins: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existingStart = reservation ? new Date(reservation.startsAt) : null;

  const [name, setName] = useState(reservation?.customerName ?? "");
  const [phone, setPhone] = useState(reservation?.customerPhone ?? "");
  const [email, setEmail] = useState(reservation?.customerEmail ?? "");
  const [partySize, setPartySize] = useState(
    String(reservation?.partySize ?? 2),
  );
  const [date, setDate] = useState(
    existingStart ? toDateInput(existingStart) : defaultDate,
  );
  const [time, setTime] = useState(
    existingStart ? toTimeInput(existingStart) : "19:00",
  );
  const [duration, setDuration] = useState(
    String(reservation?.durationMins ?? defaultDurationMins),
  );
  const [tableId, setTableId] = useState(reservation?.tableId ?? "");
  const [notes, setNotes] = useState(reservation?.notes ?? "");

  const party = Number(partySize) || 0;
  const durationMins = Number(duration) || defaultDurationMins;
  const startsAt = date && time ? toIsoFromLocal(date, time) : "";

  const availabilityQuery = useQuery({
    queryKey: [
      "reservations",
      "availability",
      locationId,
      startsAt,
      party,
      durationMins,
      reservation?.id ?? null,
    ],
    queryFn: () =>
      reservationsClient.availability({
        locationId,
        startsAt,
        partySize: party,
        durationMins,
        // Editing must not treat the booking's own table as taken.
        ignoreReservationId: reservation?.id,
      }),
    enabled: !!locationId && !!startsAt && party > 0,
  });
  const free = availabilityQuery.data?.available ?? [];
  const fullyBooked = !availabilityQuery.isLoading && free.length === 0;

  const save = useMutation({
    mutationFn: () => {
      const input: CreateReservationInput = {
        locationId,
        tableId: tableId || null,
        customerName: name.trim(),
        customerPhone: phone.trim() || null,
        customerEmail: email.trim() || null,
        partySize: party,
        startsAt,
        durationMins,
        notes: notes.trim() || null,
        source: "PHONE",
      };
      return reservation
        ? reservationsClient.update(reservation.id, input)
        : reservationsClient.create(input);
    },
    onSuccess: () => {
      toast.success(reservation ? "Booking updated" : "Booking taken");
      onSaved();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't save the booking"),
  });

  const inputClass =
    "w-full rounded-md border border-zinc-200 px-3 py-2 text-sm min-h-[44px]";
  const labelClass = "mb-1 block text-xs font-medium text-zinc-700";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">
            {reservation ? "Edit booking" : "New booking"}
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3 p-5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Guest name"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Phone</label>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="tel"
                placeholder="07…"
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>Email (optional)</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              inputMode="email"
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label className={labelClass}>Party</label>
              <input
                type="number"
                min={1}
                value={partySize}
                onChange={(e) => setPartySize(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Time</label>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Mins</label>
              <input
                type="number"
                min={15}
                step={15}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className={labelClass + " mb-0"}>Table (optional)</label>
              <span
                className={`text-[11px] ${
                  fullyBooked ? "text-red-600" : "text-zinc-500"
                }`}
              >
                {availabilityQuery.isLoading
                  ? "Checking…"
                  : fullyBooked
                    ? "Fully booked at this time"
                    : `${free.length} table${free.length === 1 ? "" : "s"} free`}
              </span>
            </div>
            <select
              value={tableId}
              onChange={(e) => setTableId(e.target.value)}
              className={inputClass}
            >
              {/* Most restaurants take the booking first and decide the
                  actual table on the day — that's the default. */}
              <option value="">Any table — decide on the day</option>
              {free.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.seats ? ` · ${t.seats} seats` : ""}
                  {t.area ? ` · ${t.area}` : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass}>Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Allergies, birthday, high chair…"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3">
          <Button variant="outline" onClick={onClose} className="min-h-[44px]">
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!name.trim() || party < 1 || !startsAt}
            className="min-h-[44px]"
          >
            {reservation ? "Save booking" : "Take booking"}
          </Button>
        </div>
      </div>
    </div>
  );
}
