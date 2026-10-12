"use client";

// Reservations — the table diary.
//
// Four ways to look at the same bookings:
//   Day   — a timeline with one column per table. Drag a booking sideways to
//           change its table, up or down to change its time.
//   Week  — seven days side by side; drag to another day or time.
//   Month — covers per day at a glance; drag a booking onto another day.
//   List  — the day as cards, with Seat / table / Details on each.
//
// Bookings arrive from three doors — staff on this page, the guest on the
// public /book page, and the AI phone line — and all land here. Clicking any
// booking opens its details panel, where it can be moved, seated, cancelled
// or re-sent to the guest.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Info,
  Plus,
  Settings2,
  StickyNote,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { useAuthStore } from "@/stores/auth.store";
import { locationsClient } from "@/lib/api/locations.client";
import { tablesClient } from "@/lib/api/tables.client";
import { queryKeys } from "@/lib/api/query-keys";
import { ReservationEditor } from "@/components/reservations/reservation-editor";
import { ReservationSettingsCard } from "@/components/reservations/reservation-settings-card";
import { SeatPicker } from "@/components/reservations/seat-picker";
import { ReservationDrawer } from "@/components/reservations/reservation-drawer";
import { TableAssignMenu } from "@/components/reservations/table-assign-menu";
import {
  ReservationTimeline,
  type DropTarget,
  type TimelineColumn,
} from "@/components/reservations/reservation-timeline";
import { ReservationMonth } from "@/components/reservations/reservation-month";
import {
  LIVE_STATUSES,
  STATUS_DOT,
  StatusPill,
  apiMessage,
} from "@/components/reservations/reservation-style";
import {
  reservationsClient,
  endOfDayIso,
  formatLongDate,
  formatTime,
  minuteLabel,
  minutesOfDay,
  shiftDate,
  shiftMonth,
  startOfDayIso,
  startOfMonth,
  startOfWeek,
  toDateInput,
  toIsoFromLocal,
  RESERVATION_STATUS_LABELS,
  type Reservation,
  type ReservationStatus,
} from "@/lib/api/reservations.client";

type View = "day" | "week" | "month" | "list";
const VIEWS: { key: View; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "list", label: "List" },
];
const VIEW_KEY = "reservations:view";

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
  const [view, setViewState] = useState<View>("day");
  const [showSettings, setShowSettings] = useState(false);
  const [creating, setCreating] = useState<{ date: string; time?: string; tableId?: string | null } | null>(null);
  const [editing, setEditing] = useState<Reservation | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [seatFor, setSeatFor] = useState<Reservation | null>(null);
  const [seatError, setSeatError] = useState<string | null>(null);

  // Remember the view per device: the host's tablet lives on Day, the
  // manager's laptop on Month. Phones start on List — a 12-table timeline
  // is a lot of sideways scrolling on a 390px screen.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY) as View | null;
      if (saved && VIEWS.some((v) => v.key === saved)) setViewState(saved);
      else if (window.innerWidth < 640) setViewState("list");
    } catch {
      /* private mode */
    }
  }, []);
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode */
    }
  };

  const locationQuery = useQuery({
    queryKey: queryKeys.locationDetail(locationId ?? ""),
    queryFn: () => locationsClient.get(locationId!),
    enabled: !!locationId,
  });
  const location: any = locationQuery.data ?? {};
  const tableService: any = (location.settings ?? {}).tableService ?? {};
  const tableServiceEnabled = !!tableService.enabled;
  const slotMinutes = Number(tableService.reservations?.slotMinutes) || 90;

  const tablesQuery = useQuery({
    queryKey: ["tables", locationId],
    queryFn: () => tablesClient.list(locationId!),
    enabled: !!locationId,
  });
  const tables = useMemo(
    () =>
      (tablesQuery.data ?? [])
        .filter((t) => t.isActive)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, undefined, { numeric: true })),
    [tablesQuery.data],
  );

  // ── The range on screen ───────────────────────────────────────────────
  const range = useMemo(() => {
    if (view === "week") {
      const from = startOfWeek(date);
      return { from, days: 7 };
    }
    if (view === "month") {
      return { from: startOfWeek(startOfMonth(date)), days: 42 };
    }
    return { from: date, days: 1 };
  }, [view, date]);
  const rangeTo = shiftDate(range.from, range.days - 1);

  const listKey = useMemo(
    () => ["reservations", "list", locationId, range.from, rangeTo] as const,
    [locationId, range.from, rangeTo],
  );
  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: () =>
      reservationsClient.list({
        locationId: locationId!,
        from: startOfDayIso(range.from),
        to: endOfDayIso(rangeTo),
      }),
    enabled: !!locationId,
    refetchInterval: 30_000,
  });
  const reservations = listQuery.data ?? [];

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["reservations", "list", locationId] });
    qc.invalidateQueries({ queryKey: ["reservations", "detail"] });
  }, [qc, locationId]);

  // ── Mutations ─────────────────────────────────────────────────────────
  const statusMut = useMutation({
    mutationFn: (v: { id: string; status: ReservationStatus }) =>
      reservationsClient.setStatus(v.id, v.status),
    onSuccess: (_r, v) => {
      refresh();
      toast.success(`Marked ${RESERVATION_STATUS_LABELS[v.status].toLowerCase()}`);
    },
    onError: (e) => toast.error(apiMessage(e, "Couldn't update the booking")),
  });

  const seatMut = useMutation({
    mutationFn: (v: { id: string; tableId?: string }) =>
      reservationsClient.seat(v.id, v.tableId),
    onSuccess: () => {
      refresh();
      qc.invalidateQueries({ queryKey: ["tables", locationId] });
      setSeatFor(null);
      setSeatError(null);
      toast.success("Seated — tab open on the table");
    },
    onError: (e) => {
      // "Table 5 already has an open tab" etc. — the server names the table
      // and says what to do, so show it rather than a generic one.
      const message = apiMessage(e, "Couldn't seat this booking");
      setSeatError(message);
      toast.error(message);
    },
  });

  const seat = (r: Reservation) => {
    setSeatError(null);
    if (r.tableId) seatMut.mutate({ id: r.id });
    else setSeatFor(r);
  };

  /**
   * Drag-and-drop move. Applied to the cache first so the block lands where
   * it was dropped; rolled back if the server refuses (table taken).
   */
  const move = useCallback(
    async (r: Reservation, target: DropTarget, opts?: { forceUnassign?: boolean }) => {
      const startsAt = toIsoFromLocal(target.date, minuteLabel(target.minute));
      const tableId = opts?.forceUnassign ? null : target.tableId;
      const timeChanged = startsAt !== new Date(r.startsAt).toISOString();
      const table =
        tableId === undefined
          ? r.table
          : tableId === null
            ? null
            : (() => {
                const t = tables.find((x) => x.id === tableId);
                return t ? { id: t.id, name: t.name, area: t.area } : r.table;
              })();

      const previous = qc.getQueryData<Reservation[]>(listKey);
      qc.setQueryData<Reservation[]>(listKey, (old) =>
        (old ?? []).map((x) =>
          x.id === r.id
            ? { ...x, startsAt, ...(tableId !== undefined ? { tableId, table } : {}) }
            : x,
        ),
      );
      try {
        await reservationsClient.update(r.id, {
          startsAt,
          ...(tableId !== undefined ? { tableId } : {}),
        });
        const when = `${formatLongDate(target.date).replace(/ \d{4}$/, "")} ${minuteLabel(target.minute)}`;
        toast.success(
          `${r.customerName} → ${timeChanged ? when : ""}${timeChanged && table ? " · " : ""}${
            tableId !== undefined ? (table?.name ?? "unassigned") : ""
          }${timeChanged && r.customerEmail ? " — guest emailed" : ""}`,
        );
        refresh();
      } catch (e) {
        qc.setQueryData(listKey, previous);
        const msg = apiMessage(e, "Couldn't move the booking");
        // Week/month keep the table; if it's taken at the new time, offer to
        // move the booking anyway and decide the table on the day.
        if (!opts?.forceUnassign && r.tableId && /isn't free/i.test(msg)) {
          if (
            confirm(
              `${r.table?.name ?? "Their table"} is already booked at that time.\n\nMove ${r.customerName} anyway and leave the table unassigned?`,
            )
          ) {
            void move(r, target, { forceUnassign: true });
          }
          return;
        }
        toast.error(msg);
      }
    },
    [qc, listKey, refresh, tables],
  );

  // ── Derived ───────────────────────────────────────────────────────────
  const counts = useMemo(() => {
    const live = reservations.filter((r) => LIVE_STATUSES.includes(r.status));
    return {
      covers: live.reduce((sum, r) => sum + r.partySize, 0),
      bookings: live.length,
      unassigned: live.filter((r) => !r.tableId && r.status !== "SEATED").length,
    };
  }, [reservations]);

  const bookingsOn = useCallback(
    (d: string) => reservations.filter((r) => toDateInput(new Date(r.startsAt)) === d),
    [reservations],
  );

  // The grid spans the shop's hours across the visible days, widened to
  // fit any booking outside them, padded half an hour each side.
  const [startMin, endMin] = useMemo(() => {
    const days = Array.from({ length: Math.min(range.days, 7) }, (_, i) => shiftDate(range.from, i));
    let lo = 11 * 60;
    let hi = 23 * 60;
    const open = days.flatMap((d) => openRanges(location.openingHours, d));
    if (open.length) {
      lo = Math.min(...open.map((o) => o[0]));
      hi = Math.max(...open.map((o) => o[1]));
    }
    for (const r of reservations) {
      const s = minutesOfDay(r.startsAt);
      lo = Math.min(lo, s);
      hi = Math.max(hi, Math.min(24 * 60, s + r.durationMins));
    }
    return [Math.max(0, Math.floor((lo - 30) / 60) * 60), Math.min(24 * 60, Math.ceil((hi + 30) / 60) * 60)];
  }, [location.openingHours, range, reservations]);

  const closedFor = useCallback(
    (d: string): [number, number][] => {
      const open = openRanges(location.openingHours, d);
      if (!open.length) return hoursConfigured(location.openingHours) ? [[0, 24 * 60]] : [];
      const out: [number, number][] = [];
      let cursor = 0;
      for (const [a, b] of [...open].sort((x, y) => x[0] - y[0])) {
        if (a > cursor) out.push([cursor, a]);
        cursor = Math.max(cursor, b);
      }
      if (cursor < 24 * 60) out.push([cursor, 24 * 60]);
      return out;
    },
    [location.openingHours],
  );

  const dayColumns: TimelineColumn[] = useMemo(() => {
    const day = bookingsOn(date);
    const known = new Set(tables.map((t) => t.id));
    const closed = closedFor(date);
    const unassigned = day.filter((r) => !r.tableId || !known.has(r.tableId));
    return [
      {
        key: "unassigned",
        date,
        tableId: null,
        closed,
        muted: true,
        bookings: unassigned,
        header: (
          <ColumnHead
            title="Unassigned"
            sub={`${unassigned.filter((r) => LIVE_STATUSES.includes(r.status)).length} waiting`}
            accent
          />
        ),
      },
      ...tables.map((t) => {
        const own = day.filter((r) => r.tableId === t.id);
        return {
          key: t.id,
          date,
          tableId: t.id,
          closed,
          seats: t.seats,
          muted: t.outOfService,
          bookings: own,
          header: (
            <ColumnHead
              title={t.name}
              sub={[
                t.seats ? `${t.seats} seats` : null,
                t.area,
                t.outOfService ? "Out of service" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          ),
        };
      }),
    ];
  }, [bookingsOn, date, tables, closedFor]);

  const weekColumns: TimelineColumn[] = useMemo(() => {
    const today = toDateInput(new Date());
    return Array.from({ length: 7 }, (_, i) => {
      const d = shiftDate(range.from, i);
      const list = bookingsOn(d);
      const covers = list
        .filter((r) => LIVE_STATUSES.includes(r.status))
        .reduce((s, r) => s + r.partySize, 0);
      return {
        key: d,
        date: d,
        closed: closedFor(d),
        bookings: list,
        header: (
          <button
            type="button"
            onClick={() => {
              setDate(d);
              setView("day");
            }}
            className="flex h-full w-full flex-col items-center justify-center hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500"
          >
            <span className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
                {new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short" })}
              </span>
              <span
                className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold tabular-nums ${
                  d === today ? "bg-orange-500 text-white" : "text-zinc-800"
                }`}
              >
                {Number(d.slice(8))}
              </span>
            </span>
            <span className="mt-0.5 text-[10px] text-zinc-400">
              {covers ? `${covers} covers` : "—"}
            </span>
          </button>
        ),
      };
    });
    // setView is stable enough — it only writes state + localStorage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, bookingsOn, closedFor]);

  const shift = (n: number) =>
    setDate((d) =>
      view === "month" ? shiftMonth(d, n) : shiftDate(d, view === "week" ? n * 7 : n),
    );

  const title =
    view === "month"
      ? new Date(`${date.slice(0, 7)}-01T12:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" })
      : view === "week"
        ? weekTitle(range.from)
        : formatLongDate(date);

  const today = toDateInput(new Date());
  const onToday =
    view === "month"
      ? date.slice(0, 7) === today.slice(0, 7)
      : view === "week"
        ? startOfWeek(date) === startOfWeek(today)
        : date === today;

  const canManage = !!role && MANAGE_ROLES.includes(role);
  // Owner-level only — a manager takes and seats bookings but doesn't set the
  // rules (party size, lead time, whether the shop takes bookings online).
  const canEditBookingSettings =
    !!role && MANAGE_ROLES.filter((r) => r !== "MANAGER").includes(role);

  if (!locationId) {
    return (
      <div className="p-6">
        <p className="text-sm text-zinc-500">Select a location to see its bookings.</p>
      </div>
    );
  }

  const openNew = (target?: DropTarget) =>
    setCreating({
      date: target?.date ?? date,
      time: target ? minuteLabel(target.minute) : undefined,
      tableId: target?.tableId,
    });

  return (
    <div className="space-y-5 p-4 sm:p-6">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-zinc-900">
            <CalendarDays className="h-5 w-5 text-orange-500" aria-hidden /> Reservations
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Take bookings, move them between tables and times, and seat parties as they arrive.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tableService.reservations?.onlineEnabled && (
            <a
              href={`/book/${locationId}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
            >
              <ExternalLink className="h-4 w-4" aria-hidden /> Booking page
            </a>
          )}
          {/* Booking settings write settings.tableService.reservations, which
              the API refuses for a MANAGER (managerForbiddenLocationFields). */}
          {canEditBookingSettings && (
            <Button variant="outline" onClick={() => setShowSettings((s) => !s)} className="min-h-[44px]">
              <Settings2 className="h-4 w-4" />
              {showSettings ? "Hide settings" : "Booking settings"}
            </Button>
          )}
          <Button onClick={() => openNew()} disabled={!tableServiceEnabled} className="min-h-[44px]">
            <Plus className="h-4 w-4" /> New booking
          </Button>
        </div>
      </div>

      {showSettings && canEditBookingSettings && <ReservationSettingsCard locationId={locationId} />}

      {!tableServiceEnabled && !locationQuery.isLoading && (
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Table service is off for this location — turn it on from the Tables page before taking bookings.
        </div>
      )}

      {/* ── Toolbar ────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-3 shadow-card-sm lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-full border border-zinc-200 bg-white">
            <button
              type="button"
              onClick={() => shift(-1)}
              aria-label={`Previous ${view === "list" ? "day" : view}`}
              className="grid h-11 w-11 place-items-center rounded-l-full text-zinc-600 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setDate(today)}
              className={`h-11 px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                onToday ? "text-orange-600" : "text-zinc-700 hover:text-zinc-900"
              }`}
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => shift(1)}
              aria-label={`Next ${view === "list" ? "day" : view}`}
              className="grid h-11 w-11 place-items-center rounded-r-full text-zinc-600 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <h2 className="min-w-0 text-base font-semibold text-zinc-900 sm:text-lg">{title}</h2>
          <input
            type="date"
            value={date}
            aria-label="Go to date"
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="min-h-[44px] rounded-full border border-zinc-200 px-3 text-sm text-zinc-700 focus:border-orange-400 focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="tablist" aria-label="Calendar view" className="flex rounded-full bg-zinc-100 p-1">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                type="button"
                role="tab"
                aria-selected={view === v.key}
                onClick={() => setView(v.key)}
                className={`min-h-[36px] rounded-full px-3.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                  view === v.key ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-800"
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-4">
            <Stat label="Covers" value={counts.covers} />
            <Stat label="Bookings" value={counts.bookings} />
            <Stat label="Unassigned" value={counts.unassigned} warn={counts.unassigned > 0} />
          </div>
        </div>
      </div>

      {/* Legend + hint */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-zinc-500">
        {(["PENDING", "CONFIRMED", "SEATED", "COMPLETED", "CANCELLED"] as ReservationStatus[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${STATUS_DOT[s]}`} aria-hidden />
            {RESERVATION_STATUS_LABELS[s]}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-sky-500" aria-hidden /> Booked online
        </span>
        {view !== "list" && (
          <span className="ml-auto hidden items-center gap-1 text-zinc-400 md:inline-flex">
            <Info className="h-3.5 w-3.5" aria-hidden />
            {view === "month"
              ? "Drag a booking onto another day to move it · click a day to open it"
              : "Drag a booking to move it (hold first on a tablet) · click an empty slot to book"}
          </span>
        )}
      </div>

      {/* ── The diary ──────────────────────────────────────── */}
      {listQuery.isLoading ? (
        <div className="grid h-64 place-items-center rounded-2xl border border-zinc-200 bg-white text-sm text-zinc-500">
          Loading bookings…
        </div>
      ) : view === "day" ? (
        tables.length === 0 && !tablesQuery.isLoading ? (
          <EmptyTables />
        ) : (
          <ReservationTimeline
            columns={dayColumns}
            startMin={startMin}
            endMin={endMin}
            columnWidth="w-[150px] flex-1"
            onOpen={(r) => setOpenId(r.id)}
            onEmpty={tableServiceEnabled ? openNew : () => {}}
            onDrop={(r, t) => void move(r, t)}
          />
        )
      ) : view === "week" ? (
        <ReservationTimeline
          columns={weekColumns}
          startMin={startMin}
          endMin={endMin}
          columnWidth="w-[132px] flex-1"
          showTableOnBlock
          onOpen={(r) => setOpenId(r.id)}
          onEmpty={tableServiceEnabled ? openNew : () => {}}
          onDrop={(r, t) => void move(r, t)}
        />
      ) : view === "month" ? (
        <ReservationMonth
          gridStart={range.from}
          month={date.slice(0, 7)}
          reservations={reservations}
          onOpenDay={(d) => {
            setDate(d);
            setView("day");
          }}
          onOpen={(r) => setOpenId(r.id)}
          onMoveToDay={(r, d) => void move(r, { date: d, minute: minutesOfDay(r.startsAt) })}
        />
      ) : (
        <DayList
          reservations={reservations}
          date={date}
          busy={statusMut.isPending || seatMut.isPending}
          onSeat={seat}
          onStatus={(r, status) => statusMut.mutate({ id: r.id, status })}
          onDetails={(r) => setOpenId(r.id)}
          onChanged={refresh}
        />
      )}

      {openId && (
        <ReservationDrawer
          reservationId={openId}
          canDelete={canManage}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
          onEdit={(r) => setEditing(r)}
          onSeat={(r) => seat(r)}
        />
      )}

      {(creating || editing) && (
        <ReservationEditor
          locationId={locationId}
          reservation={editing}
          defaultDate={creating?.date ?? date}
          defaultTime={creating?.time}
          defaultTableId={creating?.tableId}
          defaultDurationMins={slotMinutes}
          onClose={() => {
            setCreating(null);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(null);
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

// ── Pieces ────────────────────────────────────────────────────────────────

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="text-right">
      <div className={`text-lg font-bold leading-tight tabular-nums ${warn ? "text-amber-600" : "text-zinc-900"}`}>
        {value}
      </div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">{label}</div>
    </div>
  );
}

function ColumnHead({ title, sub, accent }: { title: string; sub?: string; accent?: boolean }) {
  return (
    <div className="flex h-full flex-col justify-center px-3">
      <div className={`truncate text-sm font-semibold ${accent ? "text-amber-700" : "text-zinc-900"}`}>{title}</div>
      {sub && <div className="truncate text-[11px] text-zinc-400">{sub}</div>}
    </div>
  );
}

function EmptyTables() {
  return (
    <div className="rounded-2xl border border-dashed border-zinc-200 bg-white p-10 text-center">
      <CalendarDays className="mx-auto h-8 w-8 text-zinc-300" aria-hidden />
      <p className="mx-auto mt-3 max-w-md text-sm text-zinc-600">
        Add your tables on the <a href="/dashboard/tables" className="font-medium text-orange-600 hover:underline">Tables</a>{" "}
        page and each one gets its own column here — drag bookings between them to seat parties.
      </p>
    </div>
  );
}

function DayList({
  reservations,
  date,
  busy,
  onSeat,
  onStatus,
  onDetails,
  onChanged,
}: {
  reservations: Reservation[];
  date: string;
  busy: boolean;
  onSeat: (r: Reservation) => void;
  onStatus: (r: Reservation, s: ReservationStatus) => void;
  onDetails: (r: Reservation) => void;
  onChanged: () => void;
}) {
  const day = reservations.filter((r) => toDateInput(new Date(r.startsAt)) === date);
  // Grouped by wall-clock time so a 19:00 sitting reads as one block.
  const groups = new Map<string, Reservation[]>();
  for (const r of day) {
    const key = formatTime(r.startsAt);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const isToday = date === toDateInput(new Date());

  if (day.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-200 bg-white p-10 text-center">
        <CalendarDays className="mx-auto h-8 w-8 text-zinc-300" aria-hidden />
        <p className="mx-auto mt-3 max-w-md text-sm text-zinc-600">
          No bookings for {isToday ? "today" : formatLongDate(date)}. Take one with <b>New booking</b>, and when the
          party arrives tap <b>Seat</b> — the table's tab opens with their covers already filled in.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {[...groups.entries()].map(([time, list]) => (
        <div key={time}>
          <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-zinc-400">
            {time}
            <span className="h-px flex-1 bg-zinc-100" />
            <span className="normal-case tracking-normal">
              {list.filter((r) => LIVE_STATUSES.includes(r.status)).reduce((s, r) => s + r.partySize, 0)} covers
            </span>
          </h3>
          <div className="space-y-2">
            {list.map((r) => (
              <BookingCard
                key={r.id}
                r={r}
                busy={busy}
                onSeat={() => onSeat(r)}
                onStatus={(s) => onStatus(r, s)}
                onDetails={() => onDetails(r)}
                onChanged={onChanged}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function BookingCard({
  r,
  busy,
  onSeat,
  onStatus,
  onDetails,
  onChanged,
}: {
  r: Reservation;
  busy: boolean;
  onSeat: () => void;
  onStatus: (s: ReservationStatus) => void;
  onDetails: () => void;
  onChanged: () => void;
}) {
  const live = LIVE_STATUSES.includes(r.status);
  const seated = r.status === "SEATED";
  return (
    <div
      className={`relative rounded-2xl border p-3 transition sm:p-4 ${
        live ? "border-zinc-200 bg-white shadow-card-sm hover:border-zinc-300" : "border-zinc-100 bg-zinc-50"
      }`}
    >
      <span
        className={`absolute inset-y-3 left-0 w-1 rounded-r-full ${STATUS_DOT[r.status]}`}
        aria-hidden
      />
      <div className="flex flex-wrap items-start justify-between gap-3 pl-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onDetails}
              className="truncate text-left text-sm font-semibold text-zinc-900 hover:text-orange-600 focus-visible:outline-none focus-visible:underline"
            >
              {r.customerName}
            </button>
            <span className="inline-flex items-center gap-1 text-xs text-zinc-500">
              <Users className="h-3.5 w-3.5" aria-hidden />
              {r.partySize}
            </span>
            <StatusPill status={r.status} />
            {r.source === "ONLINE" && (
              <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700">
                Online
              </span>
            )}
            {r.source === "PHONE" && (
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                Phone
              </span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-zinc-500">
            <span className="tabular-nums">
              {formatTime(r.startsAt)} · {r.durationMins} mins
            </span>
            {live ? (
              <TableAssignMenu reservation={r} onChanged={onChanged} disabled={busy} />
            ) : (
              <span className="font-medium text-zinc-600">{r.table?.name ?? "No table"}</span>
            )}
            {r.customerPhone && (
              <a href={`tel:${r.customerPhone}`} className="hover:text-zinc-800">
                {r.customerPhone}
              </a>
            )}
            <span className="font-mono text-zinc-300">{r.reference}</span>
          </div>
          {r.notes && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-800">
              <StickyNote className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {r.notes}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {live && !seated && (
            <Button size="sm" onClick={onSeat} disabled={busy} className="min-h-[44px] px-4">
              Seat
            </Button>
          )}
          {r.status === "PENDING" && (
            <Button size="sm" variant="outline" onClick={() => onStatus("CONFIRMED")} disabled={busy} className="min-h-[44px]">
              Confirm
            </Button>
          )}
          {seated && (
            <Button size="sm" variant="outline" onClick={() => onStatus("COMPLETED")} disabled={busy} className="min-h-[44px]">
              Finish
            </Button>
          )}
          {live && !seated && (
            <Button size="sm" variant="outline" onClick={() => onStatus("NO_SHOW")} disabled={busy} className="min-h-[44px]">
              No-show
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onDetails} className="min-h-[44px]">
            Details
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function weekTitle(monday: string): string {
  const a = new Date(`${monday}T12:00:00`);
  const b = new Date(`${shiftDate(monday, 6)}T12:00:00`);
  const sameMonth = a.getMonth() === b.getMonth();
  const left = a.toLocaleDateString("en-GB", { day: "numeric", ...(sameMonth ? {} : { month: "short" }) });
  const right = b.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return `${left} – ${right}`;
}

const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function hoursConfigured(h: any): boolean {
  if (!h) return false;
  if (Array.isArray(h)) return h.length > 0;
  return typeof h === "object" && Object.keys(h).length > 0;
}

/**
 * Open [from, to) minute ranges for one date, from either stored shape of
 * opening hours (legacy array `[{day, open, close}]`, day 0 = Sunday, or the
 * map `{monday: {enabled, slots}|[...]}`). Overnight slots run to midnight.
 */
function openRanges(h: any, date: string): [number, number][] {
  if (!hoursConfigured(h)) return [];
  const dow = new Date(`${date}T12:00:00`).getDay();
  const toMin = (s: unknown) => {
    if (typeof s !== "string") return NaN;
    const [hh = 0, mm = 0] = s.split(":").map(Number);
    return hh * 60 + mm;
  };
  let slots: { from?: string; to?: string; open?: string; close?: string }[] = [];
  if (Array.isArray(h)) slots = h.filter((r: any) => Number(r?.day) === dow);
  else {
    const d = h[DAY_KEYS[dow]!];
    slots = !d ? [] : Array.isArray(d) ? d : d.enabled === false ? [] : (d.slots ?? []);
  }
  const out: [number, number][] = [];
  for (const s of slots) {
    const a = toMin(s.from ?? s.open);
    let b = toMin(s.to ?? s.close);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (b <= a) b = 24 * 60;
    out.push([a, b]);
  }
  return out;
}
