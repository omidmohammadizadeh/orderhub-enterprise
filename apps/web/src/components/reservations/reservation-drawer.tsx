"use client";

// Booking details — everything about one booking, and everything you can do
// to it, in a panel that slides in from the right. Opened from the card's
// Details button and from any block on the calendar.
//
// "Move" lives here as its own small form (date, time, table, how long) so
// changing a booking doesn't mean retyping the guest in the full editor, and
// the table list is the live free list for the NEW time.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import toast from "react-hot-toast";
import {
  Armchair,
  Ban,
  CalendarClock,
  Check,
  CheckCheck,
  Clock,
  Mail,
  MessageCircle,
  Pencil,
  Phone,
  Send,
  StickyNote,
  Trash2,
  UserX,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  reservationsClient,
  formatTime,
  toDateInput,
  toIsoFromLocal,
  toTimeInput,
  RESERVATION_STATUS_LABELS,
  type Reservation,
  type ReservationStatus,
} from "@/lib/api/reservations.client";
import { LIVE_STATUSES, STATUS_DOT, StatusPill, apiMessage } from "./reservation-style";
import { TableAssignMenu } from "./table-assign-menu";

type Mode = "view" | "move" | "cancel";

export function ReservationDrawer({
  reservationId,
  initialMode = "view",
  canDelete,
  onClose,
  onChanged,
  onEdit,
  onSeat,
}: {
  reservationId: string;
  initialMode?: Mode;
  canDelete: boolean;
  onClose: () => void;
  /** Anything about the booking changed — refetch the diary. */
  onChanged: () => void;
  onEdit: (r: Reservation) => void;
  onSeat: (r: Reservation) => void;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const detail = useQuery({
    queryKey: ["reservations", "detail", reservationId],
    queryFn: () => reservationsClient.get(reservationId),
  });
  const r = detail.data;

  const changed = () => {
    detail.refetch();
    onChanged();
  };

  const status = useMutation({
    mutationFn: (v: { status: ReservationStatus; notifyCustomer?: boolean }) =>
      reservationsClient.setStatus(reservationId, v.status, {
        notifyCustomer: v.notifyCustomer,
      }),
    onSuccess: (_d, v) => {
      setMode("view");
      changed();
      toast.success(`Marked ${RESERVATION_STATUS_LABELS[v.status].toLowerCase()}`);
    },
    onError: (e) => toast.error(apiMessage(e, "Couldn't update the booking")),
  });

  const resend = useMutation({
    mutationFn: () => reservationsClient.resendEmail(reservationId),
    onSuccess: (d) => toast.success(`Emailed ${d.to}`),
    onError: (e) => toast.error(apiMessage(e, "Couldn't send the email")),
  });

  const remove = useMutation({
    mutationFn: () => reservationsClient.remove(reservationId),
    onSuccess: () => {
      toast.success("Booking deleted");
      onChanged();
      onClose();
    },
    onError: (e) => toast.error(apiMessage(e, "Couldn't delete")),
  });

  const live = r ? LIVE_STATUSES.includes(r.status) : false;
  const tel = r?.customerPhone?.replace(/[^\d+]/g, "") ?? "";
  const wa = tel.replace(/^\+/, "").replace(/^0/, "44");
  const busy = status.isPending;

  const past = r?.history ?? [];
  const visits = past.filter((h) => h.status === "COMPLETED" || h.status === "SEATED").length;
  const noShows = past.filter((h) => h.status === "NO_SHOW").length;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Booking details">
      <button
        type="button"
        aria-label="Close details"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-zinc-950/40 backdrop-blur-[1px] motion-safe:animate-fade-in"
      />
      <aside className="relative flex h-full w-full max-w-md flex-col overflow-hidden bg-white shadow-2xl motion-safe:animate-slide-in-right">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-zinc-100 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
              <span className="font-mono">{r?.reference ?? "Booking"}</span>
              {r && <StatusPill status={r.status} />}
            </div>
            <h2 className="mt-1 truncate text-xl font-semibold text-zinc-900">
              {r?.customerName ?? "Loading…"}
            </h2>
            {r && (visits > 0 || noShows > 0) && (
              <p className="mt-0.5 text-xs text-zinc-500">
                {visits > 0 && <>{ordinal(visits + 1)} visit</>}
                {visits > 0 && noShows > 0 && " · "}
                {noShows > 0 && (
                  <span className="font-medium text-red-600">
                    {noShows} no-show{noShows === 1 ? "" : "s"} before
                  </span>
                )}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {!r ? (
          <div className="flex-1 p-6 text-sm text-zinc-500">
            {detail.isError ? "Couldn't load this booking." : "Loading…"}
          </div>
        ) : (
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {/* Contact */}
            {(tel || r.customerEmail) && (
              <div className="flex flex-wrap gap-2">
                {tel && (
                  <a href={`tel:${tel}`} className={chip}>
                    <Phone className="h-3.5 w-3.5" aria-hidden /> {r.customerPhone}
                  </a>
                )}
                {tel && (
                  <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" className={chip}>
                    <MessageCircle className="h-3.5 w-3.5" aria-hidden /> WhatsApp
                  </a>
                )}
                {r.customerEmail && (
                  <a href={`mailto:${r.customerEmail}`} className={`${chip} max-w-full`}>
                    <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{r.customerEmail}</span>
                  </a>
                )}
              </div>
            )}

            {/* The booking */}
            <section className="divide-y divide-zinc-100 rounded-2xl border border-zinc-200">
              <Row icon={<CalendarClock className="h-4 w-4" />} k="When">
                <div className="font-medium text-zinc-900">
                  {new Date(r.startsAt).toLocaleDateString("en-GB", {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}
                </div>
                <div className="text-xs text-zinc-500">
                  {formatTime(r.startsAt)} –{" "}
                  {formatTime(new Date(new Date(r.startsAt).getTime() + r.durationMins * 60_000).toISOString())}{" "}
                  · {r.durationMins} mins
                </div>
              </Row>
              <Row icon={<Users className="h-4 w-4" />} k="Guests">
                <span className="font-medium text-zinc-900">
                  {r.partySize} {r.partySize === 1 ? "person" : "people"}
                </span>
              </Row>
              <Row icon={<Armchair className="h-4 w-4" />} k="Table">
                {live ? (
                  <TableAssignMenu reservation={r} onChanged={changed} />
                ) : (
                  <span className="text-zinc-700">{r.table?.name ?? "—"}</span>
                )}
              </Row>
              <Row icon={<Clock className="h-4 w-4" />} k="Booked">
                <span className="text-xs text-zinc-600">
                  {sourceLabel(r.source)} ·{" "}
                  {new Date(r.createdAt).toLocaleString("en-GB", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
                {r.seatedAt && (
                  <div className="text-xs text-emerald-700">Seated at {formatTime(r.seatedAt)}</div>
                )}
              </Row>
            </section>

            {r.notes && (
              <section className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                <StickyNote className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <p className="whitespace-pre-wrap">{r.notes}</p>
              </section>
            )}

            {/* Actions */}
            {mode === "view" && (
              <section className="grid grid-cols-2 gap-2">
                {live && r.status !== "SEATED" && (
                  <Button onClick={() => onSeat(r)} disabled={busy} className="col-span-2 min-h-[44px]">
                    <Armchair className="h-4 w-4" /> Seat now
                    {r.table ? ` at ${r.table.name}` : ""}
                  </Button>
                )}
                {r.status === "PENDING" && (
                  <Button variant="outline" onClick={() => status.mutate({ status: "CONFIRMED" })} disabled={busy} className="min-h-[44px]">
                    <Check className="h-4 w-4" /> Confirm
                  </Button>
                )}
                {r.status === "SEATED" && (
                  <Button onClick={() => status.mutate({ status: "COMPLETED" })} disabled={busy} className="col-span-2 min-h-[44px]">
                    <CheckCheck className="h-4 w-4" /> Finish sitting
                  </Button>
                )}
                {live && (
                  <Button variant="outline" onClick={() => setMode("move")} disabled={busy} className="min-h-[44px]">
                    <CalendarClock className="h-4 w-4" /> Move
                  </Button>
                )}
                <Button variant="outline" onClick={() => onEdit(r)} disabled={busy} className="min-h-[44px]">
                  <Pencil className="h-4 w-4" /> Edit details
                </Button>
                {live && r.status !== "SEATED" && (
                  <Button variant="outline" onClick={() => status.mutate({ status: "NO_SHOW" })} disabled={busy} className="min-h-[44px]">
                    <UserX className="h-4 w-4" /> No-show
                  </Button>
                )}
                {live && (
                  <Button
                    variant="outline"
                    onClick={() => setMode("cancel")}
                    disabled={busy}
                    className="min-h-[44px] text-red-600 hover:bg-red-50 hover:text-red-700"
                  >
                    <Ban className="h-4 w-4" /> Cancel
                  </Button>
                )}
                {!live && (
                  <Button variant="outline" onClick={() => status.mutate({ status: "CONFIRMED" })} disabled={busy} className="col-span-2 min-h-[44px]">
                    <Check className="h-4 w-4" /> Set back to confirmed
                  </Button>
                )}
              </section>
            )}

            {mode === "move" && (
              <MoveForm
                reservation={r}
                onCancel={() => setMode("view")}
                onMoved={() => {
                  setMode("view");
                  changed();
                }}
              />
            )}

            {mode === "cancel" && (
              <CancelForm
                hasEmail={!!r.customerEmail}
                busy={busy}
                onBack={() => setMode("view")}
                onConfirm={(notify) => status.mutate({ status: "CANCELLED", notifyCustomer: notify })}
              />
            )}

            {r.customerEmail && mode === "view" && (
              <button
                type="button"
                onClick={() => resend.mutate()}
                disabled={resend.isPending}
                className="flex min-h-[40px] items-center gap-2 text-sm text-zinc-600 hover:text-orange-600 disabled:opacity-50"
              >
                <Send className="h-4 w-4" aria-hidden />
                {resend.isPending
                  ? "Sending…"
                  : r.status === "CANCELLED"
                    ? "Email the cancellation again"
                    : "Email the confirmation again"}
              </button>
            )}

            {/* Guest history */}
            {past.length > 0 && (
              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
                  Other bookings by this guest
                </h3>
                <ul className="divide-y divide-zinc-100 rounded-2xl border border-zinc-200 text-sm">
                  {past.map((h) => (
                    <li key={h.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                      <span className="flex items-center gap-2 text-zinc-700">
                        <span className={`h-2 w-2 rounded-full ${STATUS_DOT[h.status]}`} aria-hidden />
                        {new Date(h.startsAt).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                          year: "2-digit",
                        })}{" "}
                        · {formatTime(h.startsAt)} · {h.partySize}p
                      </span>
                      <span className="text-xs text-zinc-500">{RESERVATION_STATUS_LABELS[h.status]}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {canDelete && (
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Delete ${r.customerName}'s booking for good? To keep a record, cancel it instead.`))
                    remove.mutate();
                }}
                className="flex min-h-[40px] items-center gap-1.5 text-xs text-zinc-400 hover:text-red-600"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete booking permanently
              </button>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

const chip =
  "inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:border-orange-300 hover:text-orange-700";

function Row({ icon, k, children }: { icon: React.ReactNode; k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 text-sm">
      <span className="mt-0.5 text-zinc-400" aria-hidden>
        {icon}
      </span>
      <div className="w-16 shrink-0 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
        {k}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function MoveForm({
  reservation: r,
  onCancel,
  onMoved,
}: {
  reservation: Reservation;
  onCancel: () => void;
  onMoved: () => void;
}) {
  const start = new Date(r.startsAt);
  const [date, setDate] = useState(toDateInput(start));
  const [time, setTime] = useState(toTimeInput(start));
  const [duration, setDuration] = useState(String(r.durationMins));
  const [party, setParty] = useState(String(r.partySize));
  const [tableId, setTableId] = useState(r.tableId ?? "");
  const [notify, setNotify] = useState(true);

  const startsAt = date && time ? toIsoFromLocal(date, time) : "";
  const durationMins = Number(duration) || r.durationMins;
  const partySize = Number(party) || r.partySize;

  const free = useQuery({
    queryKey: ["reservations", "availability", "move", r.id, startsAt, partySize, durationMins],
    queryFn: () =>
      reservationsClient.availability({
        locationId: r.locationId,
        startsAt,
        partySize,
        durationMins,
        ignoreReservationId: r.id,
      }),
    enabled: !!startsAt && partySize > 0,
  });
  const tables = free.data?.available ?? [];
  // The current table may not be free at the new time — don't silently keep it.
  const tableStillFree = !tableId || tables.some((t) => t.id === tableId);

  const save = useMutation({
    mutationFn: () =>
      reservationsClient.update(r.id, {
        startsAt,
        durationMins,
        partySize,
        tableId: tableId || null,
        notifyCustomer: notify,
      }),
    onSuccess: () => {
      toast.success("Booking moved");
      onMoved();
    },
    onError: (e) => toast.error(apiMessage(e, "Couldn't move the booking")),
  });

  const timeChanged =
    startsAt !== new Date(r.startsAt).toISOString() || partySize !== r.partySize;

  return (
    <section className="space-y-3 rounded-2xl border border-orange-200 bg-orange-50/40 p-4">
      <h3 className="text-sm font-semibold text-zinc-900">Move booking</h3>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} />
        </Field>
        <Field label="Time">
          <input type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} className={input} />
        </Field>
        <Field label="Guests">
          <input type="number" min={1} value={party} onChange={(e) => setParty(e.target.value)} className={input} />
        </Field>
        <Field label="Minutes">
          <input type="number" min={15} step={15} value={duration} onChange={(e) => setDuration(e.target.value)} className={input} />
        </Field>
      </div>
      <Field label={free.isLoading ? "Table · checking…" : `Table · ${tables.length} free`}>
        <select value={tableStillFree ? tableId : ""} onChange={(e) => setTableId(e.target.value)} className={input}>
          <option value="">Any table — decide on the day</option>
          {tables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.seats ? ` · ${t.seats} seats` : ""}
              {t.area ? ` · ${t.area}` : ""}
            </option>
          ))}
        </select>
      </Field>
      {!tableStillFree && (
        <p className="text-xs text-amber-700">
          {r.table?.name ?? "That table"} is taken at the new time — pick another or leave it unassigned.
        </p>
      )}
      {r.customerEmail && timeChanged && (
        <label className="flex min-h-[36px] items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
            className="h-4 w-4 accent-orange-500"
          />
          Email the new time to {r.customerEmail}
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} className="min-h-[44px]">
          Back
        </Button>
        <Button
          onClick={() => save.mutate()}
          loading={save.isPending}
          disabled={!startsAt || partySize < 1}
          className="min-h-[44px]"
        >
          Move booking
        </Button>
      </div>
    </section>
  );
}

function CancelForm({
  hasEmail,
  busy,
  onBack,
  onConfirm,
}: {
  hasEmail: boolean;
  busy: boolean;
  onBack: () => void;
  onConfirm: (notify: boolean) => void;
}) {
  const [notify, setNotify] = useState(true);
  return (
    <section className="space-y-3 rounded-2xl border border-red-200 bg-red-50/50 p-4">
      <h3 className="text-sm font-semibold text-red-800">Cancel this booking?</h3>
      <p className="text-xs text-red-700">The table is freed straight away.</p>
      {hasEmail && (
        <label className="flex min-h-[36px] items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
            className="h-4 w-4 accent-orange-500"
          />
          Email the guest that it's cancelled
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onBack} className="min-h-[44px]">
          Keep booking
        </Button>
        <Button variant="destructive" onClick={() => onConfirm(notify)} loading={busy} className="min-h-[44px]">
          Cancel booking
        </Button>
      </div>
    </section>
  );
}

const input =
  "w-full min-h-[44px] rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-600">{label}</span>
      {children}
    </label>
  );
}

function sourceLabel(s: Reservation["source"]): string {
  return s === "ONLINE" ? "Booked online" : s === "PHONE" ? "By phone" : "By staff";
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}
