"use client";

// Reservations — the day's diary. Front of house works this page top to
// bottom: who's booked, at what time, on which table, and what to do when
// they walk in (Seat opens the table's tab, pre-filled with their covers).
//
// Bookings arrive here from three doors — taken by phone on this page, by
// staff on the floor, or by the guest on the public /book page — and all
// three land in the same list.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  Settings2,
  Pencil,
  Trash2,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { useAuthStore } from "@/stores/auth.store";
import { locationsClient } from "@/lib/api/locations.client";
import { queryKeys } from "@/lib/api/query-keys";
import { ReservationEditor } from "@/components/reservations/reservation-editor";
import { ReservationSettingsCard } from "@/components/reservations/reservation-settings-card";
import { SeatPicker } from "@/components/reservations/seat-picker";
import {
  reservationsClient,
  endOfDayIso,
  formatLongDate,
  formatTime,
  shiftDate,
  startOfDayIso,
  toDateInput,
  RESERVATION_STATUS_LABELS,
  type Reservation,
  type ReservationStatus,
} from "@/lib/api/reservations.client";

const STATUS_PILL: Record<ReservationStatus, string> = {
  PENDING: "bg-amber-100 text-amber-800",
  CONFIRMED: "bg-indigo-100 text-indigo-800",
  SEATED: "bg-emerald-100 text-emerald-800",
  COMPLETED: "bg-zinc-100 text-zinc-600",
  CANCELLED: "bg-red-100 text-red-700",
  NO_SHOW: "bg-red-100 text-red-700",
};

// A booking that's been cancelled, no-showed or finished is history: it
// no longer counts towards covers and offers no actions.
const LIVE: ReservationStatus[] = ["PENDING", "CONFIRMED", "SEATED"];

const MANAGE_ROLES = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "MANAGER",
  "DARK_KITCHEN_MANAGER",
];

export default function ReservationsPage() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const role = useAuthStore((s) => s.user?.role);
  const qc = useQueryClient();

  const [date, setDate] = useState(() => toDateInput(new Date()));
  const [showSettings, setShowSettings] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Reservation | null>(null);
  const [seatFor, setSeatFor] = useState<Reservation | null>(null);
  const [seatError, setSeatError] = useState<string | null>(null);

  const locationQuery = useQuery({
    queryKey: queryKeys.locationDetail(locationId ?? ""),
    queryFn: () => locationsClient.get(locationId!),
    enabled: !!locationId,
  });
  const tableService: any =
    ((locationQuery.data as any)?.settings ?? {}).tableService ?? {};
  const tableServiceEnabled = !!tableService.enabled;
  const slotMinutes = Number(tableService.reservations?.slotMinutes) || 90;

  const listQuery = useQuery({
    queryKey: ["reservations", "list", locationId, date],
    queryFn: () =>
      reservationsClient.list({
        locationId: locationId!,
        from: startOfDayIso(date),
        to: endOfDayIso(date),
      }),
    enabled: !!locationId,
    refetchInterval: 30_000,
  });
  const reservations = listQuery.data ?? [];

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["reservations", "list", locationId, date] });

  const statusMut = useMutation({
    mutationFn: (v: { id: string; status: ReservationStatus }) =>
      reservationsClient.setStatus(v.id, v.status),
    onSuccess: (_r, v) => {
      refresh();
      toast.success(`Marked ${RESERVATION_STATUS_LABELS[v.status].toLowerCase()}`);
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't update the booking"),
  });

  const seatMut = useMutation({
    mutationFn: (v: { id: string; tableId?: string }) =>
      reservationsClient.seat(v.id, v.tableId),
    onSuccess: () => {
      refresh();
      // The tables board shows the newly opened tab — drop its cache too.
      qc.invalidateQueries({ queryKey: ["tables", locationId] });
      setSeatFor(null);
      setSeatError(null);
      toast.success("Seated — tab open on the table");
    },
    onError: (e: any) => {
      // "Table 5 already has an open tab" etc. — the server's message names
      // the table and says what to do, so show it rather than a generic one.
      const message =
        e?.response?.data?.message ?? "Couldn't seat this booking";
      setSeatError(message);
      toast.error(message);
    },
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => reservationsClient.remove(id),
    onSuccess: () => {
      refresh();
      toast.success("Booking deleted");
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't delete"),
  });

  const counts = useMemo(() => {
    const live = reservations.filter((r) => LIVE.includes(r.status));
    return {
      covers: live.reduce((sum, r) => sum + r.partySize, 0),
      bookings: live.length,
      unassigned: live.filter((r) => !r.tableId).length,
    };
  }, [reservations]);

  // Grouped by wall-clock time so a 19:00 sitting reads as one block.
  const groups = useMemo(() => {
    const map = new Map<string, Reservation[]>();
    for (const r of reservations) {
      const key = formatTime(r.startsAt);
      const bucket = map.get(key) ?? [];
      bucket.push(r);
      map.set(key, bucket);
    }
    return [...map.entries()];
  }, [reservations]);

  const isToday = date === toDateInput(new Date());
  const canManage = !!role && MANAGE_ROLES.includes(role);

  if (!locationId) {
    return (
      <div className="p-6">
        <p className="text-sm text-zinc-500">
          Select a location to see its bookings.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-zinc-900">
            <CalendarDays className="h-5 w-5" /> Reservations
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            The day's diary — take bookings, seat parties on arrival, and keep
            no-shows off your covers.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setShowSettings((s) => !s)}
            className="min-h-[44px]"
          >
            <Settings2 className="mr-1 h-4 w-4" />
            {showSettings ? "Hide settings" : "Booking settings"}
          </Button>
          <Button
            onClick={() => setCreating(true)}
            disabled={!tableServiceEnabled}
            className="min-h-[44px]"
          >
            <Plus className="mr-1 h-4 w-4" /> New booking
          </Button>
        </div>
      </div>

      {showSettings && <ReservationSettingsCard locationId={locationId} />}

      {!tableServiceEnabled && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Table service is off for this location — turn it on from the Tables
          page before taking bookings.
        </div>
      )}

      {/* ── Day picker + counts ─────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setDate((d) => shiftDate(d, -1))}
            aria-label="Previous day"
            className="grid h-11 w-11 place-items-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-50"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="min-h-[44px] rounded-md border border-zinc-200 px-3 py-2 text-sm"
          />
          <button
            onClick={() => setDate((d) => shiftDate(d, 1))}
            aria-label="Next day"
            className="grid h-11 w-11 place-items-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-50"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <Button
            variant={isToday ? "secondary" : "outline"}
            onClick={() => setDate(toDateInput(new Date()))}
            className="min-h-[44px]"
          >
            Today
          </Button>
          <span className="ml-1 hidden text-sm text-zinc-500 sm:inline">
            {formatLongDate(date)}
          </span>
        </div>

        <div className="flex items-center gap-5">
          <Stat label="Covers" value={counts.covers} />
          <Stat label="Bookings" value={counts.bookings} />
          <Stat label="Unassigned" value={counts.unassigned} />
        </div>
      </div>

      {/* ── The diary ───────────────────────────────────────── */}
      {listQuery.isLoading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : reservations.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 p-10 text-center">
          <CalendarDays className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mx-auto mt-3 max-w-md text-sm text-zinc-600">
            No bookings for {isToday ? "today" : formatLongDate(date)}. This page
            is your table diary: take a booking over the phone with{" "}
            <b>New booking</b>, and when the party arrives tap <b>Seat</b> — the
            table's tab opens with their covers already filled in.
          </p>
          <p className="mt-2 text-[11px] text-zinc-400">
            Turn on <b>Take bookings online</b> in booking settings to let guests
            book themselves.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map(([time, list]) => (
            <div key={time}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                {time}
              </h2>
              <div className="space-y-2">
                {list.map((r) => (
                  <ReservationRow
                    key={r.id}
                    reservation={r}
                    canManage={canManage}
                    busy={statusMut.isPending || seatMut.isPending}
                    onSeat={() => {
                      setSeatError(null);
                      if (r.tableId) seatMut.mutate({ id: r.id });
                      else setSeatFor(r);
                    }}
                    onStatus={(status) => statusMut.mutate({ id: r.id, status })}
                    onEdit={() => setEditing(r)}
                    onDelete={() => {
                      if (confirm(`Delete ${r.customerName}'s booking?`))
                        removeMut.mutate(r.id);
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <ReservationEditor
          locationId={locationId}
          reservation={editing}
          defaultDate={date}
          defaultDurationMins={slotMinutes}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            refresh();
          }}
        />
      )}

      {seatFor && (
        <SeatPicker
          reservation={seatFor}
          seating={seatMut.isPending}
          error={seatError}
          onSeat={(tableId) => seatMut.mutate({ id: seatFor.id, tableId })}
          onClose={() => {
            setSeatFor(null);
            setSeatError(null);
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-right">
      <div className="text-lg font-bold leading-tight text-zinc-900">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-zinc-400">
        {label}
      </div>
    </div>
  );
}

function ReservationRow({
  reservation: r,
  canManage,
  busy,
  onSeat,
  onStatus,
  onEdit,
  onDelete,
}: {
  reservation: Reservation;
  canManage: boolean;
  busy: boolean;
  onSeat: () => void;
  onStatus: (status: ReservationStatus) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const live = LIVE.includes(r.status);
  const seated = r.status === "SEATED";

  return (
    <div
      className={`rounded-xl border p-3 ${
        live ? "border-zinc-200 bg-white" : "border-zinc-100 bg-zinc-50"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-zinc-900">
              {r.customerName}
            </span>
            <span className="inline-flex items-center gap-1 text-xs text-zinc-500">
              <Users className="h-3.5 w-3.5" />
              {r.partySize}
            </span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                STATUS_PILL[r.status]
              }`}
            >
              {RESERVATION_STATUS_LABELS[r.status]}
            </span>
            {r.source === "ONLINE" && (
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-500">
                Online
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
            <span>
              {formatTime(r.startsAt)} · {r.durationMins} mins
            </span>
            {r.table ? (
              <span className="font-medium text-zinc-700">
                {r.table.name}
                {r.table.area ? ` · ${r.table.area}` : ""}
              </span>
            ) : (
              <span className="text-amber-700">Unassigned</span>
            )}
            {r.customerPhone && <a href={`tel:${r.customerPhone}`}>{r.customerPhone}</a>}
            <span className="text-zinc-300">{r.reference}</span>
          </div>
          {r.notes && (
            <p className="mt-1 text-[11px] text-zinc-600">{r.notes}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {live && !seated && (
            <Button
              size="sm"
              onClick={onSeat}
              disabled={busy}
              className="min-h-[44px] px-4"
            >
              Seat
            </Button>
          )}
          {r.status === "PENDING" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onStatus("CONFIRMED")}
              disabled={busy}
              className="min-h-[44px]"
            >
              Confirm
            </Button>
          )}
          {seated && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onStatus("COMPLETED")}
              disabled={busy}
              className="min-h-[44px]"
            >
              Finish
            </Button>
          )}
          {live && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onStatus("NO_SHOW")}
                disabled={busy}
                className="min-h-[44px]"
              >
                No-show
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onStatus("CANCELLED")}
                disabled={busy}
                className="min-h-[44px]"
              >
                Cancel
              </Button>
            </>
          )}
          <button
            onClick={onEdit}
            aria-label="Edit booking"
            className="grid h-11 w-11 place-items-center rounded-md text-zinc-400 hover:text-zinc-700"
          >
            <Pencil className="h-4 w-4" />
          </button>
          {canManage && (
            <button
              onClick={onDelete}
              aria-label="Delete booking"
              className="grid h-11 w-11 place-items-center rounded-md text-zinc-400 hover:text-red-600"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
