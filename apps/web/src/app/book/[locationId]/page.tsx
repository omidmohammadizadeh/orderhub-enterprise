"use client";

// Guest booking form — the public door into reservations. No login, keyed
// only by the location id in the URL (same idea as the signage board's
// token page). Mobile first: most bookings come off a phone.
//
// Availability is checked live as the guest changes party size / date /
// time so "fully booked" is visible BEFORE they type their details, and
// the submit button can't fire into a slot the API will reject.

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  publicReservationsClient,
  toDateInput,
  toIsoFromLocal,
  type PublicReservation,
} from "@/lib/api/reservations.client";

export default function GuestBookingPage() {
  const params = useParams<{ locationId: string }>();
  const locationId = params?.locationId ?? "";

  const settingsQuery = useQuery({
    queryKey: ["reservations", "public", "settings", locationId],
    queryFn: () => publicReservationsClient.settings(locationId),
    enabled: !!locationId,
    retry: false,
  });
  const settings = settingsQuery.data;

  const [partySize, setPartySize] = useState(2);
  const [date, setDate] = useState(() => toDateInput(new Date()));
  const [time, setTime] = useState("19:00");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmed, setConfirmed] = useState<PublicReservation | null>(null);

  const startsAt = date && time ? toIsoFromLocal(date, time) : "";

  // Booking horizon comes from the restaurant's settings, so the date
  // input can't offer a day the API would refuse.
  const dateBounds = useMemo(() => {
    const today = new Date();
    const max = new Date();
    max.setDate(max.getDate() + (settings?.maxDaysAhead ?? 60));
    return { min: toDateInput(today), max: toDateInput(max) };
  }, [settings?.maxDaysAhead]);

  const availabilityQuery = useQuery({
    queryKey: ["reservations", "public", "availability", locationId, startsAt, partySize],
    queryFn: () =>
      publicReservationsClient.availability({ locationId, startsAt, partySize }),
    enabled: !!locationId && !!startsAt && partySize > 0 && !!settings?.onlineEnabled,
    retry: false,
  });
  const available = availabilityQuery.data?.available === true;

  const book = useMutation({
    mutationFn: () =>
      publicReservationsClient.create({
        locationId,
        customerName: name.trim(),
        customerPhone: phone.trim() || null,
        customerEmail: email.trim() || null,
        partySize,
        startsAt,
        notes: notes.trim() || null,
        source: "ONLINE",
      }),
    onSuccess: (res) => setConfirmed(res),
  });

  const fieldClass =
    "w-full rounded-md border border-zinc-200 px-3 py-2.5 text-sm min-h-[44px] focus:border-orange-400 focus:outline-none";
  const labelClass = "mb-1 block text-xs font-medium text-zinc-700";

  if (settingsQuery.isLoading) {
    return <Shell><p className="text-sm text-zinc-500">Loading…</p></Shell>;
  }

  if (settingsQuery.isError || !settings) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-zinc-900">
          We couldn't find that restaurant
        </h1>
        <p className="mt-2 text-sm text-zinc-600">
          Please check the link you were given, or call the restaurant directly.
        </p>
      </Shell>
    );
  }

  if (!settings.tableServiceEnabled || !settings.onlineEnabled) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-zinc-900">
          {settings.locationName}
        </h1>
        <p className="mt-2 text-sm text-zinc-600">
          We're not taking online bookings at the moment. Please give us a call
          and we'll find you a table.
        </p>
      </Shell>
    );
  }

  if (confirmed) {
    return (
      <Shell>
        <div className="text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-100 text-xl">
            ✓
          </div>
          <h1 className="mt-3 text-lg font-semibold text-zinc-900">
            Table booked
          </h1>
          <p className="mt-1 text-sm text-zinc-600">
            Thanks {confirmed.customerName} — we'll see you at{" "}
            <b>
              {new Date(confirmed.startsAt).toLocaleString("en-GB", {
                weekday: "long",
                day: "numeric",
                month: "long",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </b>{" "}
            for {confirmed.partySize}{" "}
            {confirmed.partySize === 1 ? "person" : "people"}.
          </p>
          <div className="mt-4 rounded-lg bg-zinc-50 px-4 py-3">
            <p className="text-[11px] uppercase tracking-wide text-zinc-400">
              Your reference
            </p>
            <p className="font-mono text-lg font-bold text-zinc-900">
              {confirmed.reference}
            </p>
          </div>
          <p className="mt-3 text-[11px] text-zinc-500">
            Need to change or cancel? Call {settings.locationName} and quote your
            reference.
          </p>
        </div>
      </Shell>
    );
  }

  const errorMessage = (book.error as Error | null)?.message;

  return (
    <Shell>
      <h1 className="text-lg font-semibold text-zinc-900">
        Book a table at {settings.locationName}
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        Tables are held for {settings.slotMinutes} minutes.
      </p>

      <div className="mt-5 space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className={labelClass}>People</label>
            <select
              value={partySize}
              onChange={(e) => setPartySize(Number(e.target.value))}
              className={fieldClass}
            >
              {Array.from({ length: settings.maxPartySize }, (_, i) => i + 1).map(
                (n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ),
              )}
            </select>
          </div>
          <div>
            <label className={labelClass}>Date</label>
            <input
              type="date"
              value={date}
              min={dateBounds.min}
              max={dateBounds.max}
              onChange={(e) => setDate(e.target.value)}
              className={fieldClass}
            />
          </div>
          <div>
            <label className={labelClass}>Time</label>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className={fieldClass}
            />
          </div>
        </div>

        <div
          className={`rounded-md px-3 py-2 text-xs ${
            availabilityQuery.isLoading
              ? "bg-zinc-50 text-zinc-500"
              : available
                ? "bg-emerald-50 text-emerald-800"
                : "bg-amber-50 text-amber-800"
          }`}
        >
          {availabilityQuery.isLoading
            ? "Checking availability…"
            : available
              ? "A table is free at that time."
              : "We're fully booked at that time — please try another slot."}
        </div>

        <div>
          <label className={labelClass}>Your name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldClass}
            autoComplete="name"
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Phone</label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="tel"
              autoComplete="tel"
              className={fieldClass}
            />
          </div>
          <div>
            <label className={labelClass}>Email (optional)</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              inputMode="email"
              autoComplete="email"
              className={fieldClass}
            />
          </div>
        </div>
        <div>
          <label className={labelClass}>
            Anything we should know? (optional)
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Allergies, high chair, celebrating something…"
            className="w-full rounded-md border border-zinc-200 px-3 py-2.5 text-sm focus:border-orange-400 focus:outline-none"
          />
        </div>

        {errorMessage && (
          // The API's guest-facing 400s already read like a host talking —
          // show them word for word.
          <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
            {errorMessage}
          </div>
        )}

        <button
          onClick={() => book.mutate()}
          disabled={
            book.isPending ||
            !name.trim() ||
            !startsAt ||
            !available ||
            availabilityQuery.isLoading
          }
          className="min-h-[48px] w-full rounded-lg bg-orange-500 px-4 py-3 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
        >
          {book.isPending ? "Booking…" : "Book table"}
        </button>
        <p className="text-center text-[11px] text-zinc-400">
          Bookings need at least {settings.leadTimeMins} minutes' notice. For
          parties over {settings.maxPartySize}, please call us.
        </p>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-50 px-4 py-8">
      <div className="mx-auto w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
        {children}
      </div>
    </div>
  );
}
