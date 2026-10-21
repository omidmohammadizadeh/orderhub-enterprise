"use client";

// The salon diary.
//
//   Day  — a column per barber; drag to move or hand over, tap an empty
//          slot to book there.
//   Week — one barber's week, a column per day.
//   List — the day as a running order, for phones and the front desk.
//
// Bookings land here from every door — this screen, the online booking
// page, the walk-in queue — and the socket keeps every till in step.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { ChevronLeft, ChevronRight, Globe2, Plus } from "lucide-react";
import { normaliseWeeklyHours, staffDayWindows } from "@orderhub/shared";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/use-currency";
import {
  addDays,
  apiError,
  LIVE_APPOINTMENT,
  longDate,
  salonClient,
  shopDate,
  shopIso,
  shopMinutes,
  shopTime,
  todayIn,
  type Appointment,
} from "@/lib/api/salon.client";
import {
  SalonFrame,
  StatusPill,
  staffWord,
  useSalonLocation,
  useSalonServices,
  useSalonStaff,
} from "@/components/salon/salon-shared";
import { SalonTimeline, minuteLabel, type SalonColumn, type SalonDrop } from "@/components/salon/salon-timeline";
import { NewAppointment } from "@/components/salon/new-appointment";
import { AppointmentDrawer } from "@/components/salon/appointment-drawer";

type View = "day" | "week" | "list";
const VIEW_KEY = "salon:view";

export default function SalonDiaryPage() {
  return (
    <SalonFrame title="Appointments" subtitle="Your team's day, bookings and walk-ins in one place.">
      <Diary />
    </SalonFrame>
  );
}

function Diary() {
  const qc = useQueryClient();
  const { money } = useCurrency();
  const { locationId, settings } = useSalonLocation();
  const tz = settings.data?.timezone ?? "Europe/London";
  const trade = settings.data?.settings.trade ?? "BARBER";
  const shopHours = useMemo(() => normaliseWeeklyHours(settings.data?.shopHours ?? {}), [settings.data?.shopHours]);
  const services = useSalonServices(locationId);
  const staffQ = useSalonStaff(locationId);
  const staff = staffQ.data ?? [];

  const [date, setDate] = useState(() => todayIn(tz));
  const [view, setViewState] = useState<View>("day");
  const [weekStaff, setWeekStaff] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ date: string; time?: string; staffId?: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY) as View | null;
      if (saved === "day" || saved === "week" || saved === "list") setViewState(saved);
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

  const weekPerson = weekStaff ?? staff[0]?.id ?? null;
  const weekFrom = useMemo(() => {
    const [y, m, d] = date.split("-").map(Number);
    const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
    return addDays(date, -((dow + 6) % 7));
  }, [date]);
  const from = view === "week" ? weekFrom : date;
  const days = view === "week" ? 7 : 1;

  const listQ = useQuery({
    queryKey: ["salon", "appointments", locationId, from, days, view === "week" ? weekPerson : null],
    queryFn: () =>
      salonClient.appointments({
        locationId: locationId!,
        from: shopIso(from, "00:00", tz),
        to: shopIso(addDays(from, days), "00:00", tz),
        ...(view === "week" && weekPerson ? { staffId: weekPerson } : {}),
      }),
    enabled: !!locationId,
    refetchInterval: 60_000,
  });
  const appts = listQ.data ?? [];
  const timeOff = useQuery({
    queryKey: ["salon", "timeoff", locationId, from, days],
    queryFn: () => salonClient.timeOff(locationId!, shopIso(from, "00:00", tz), shopIso(addDays(from, days), "00:00", tz)),
    enabled: !!locationId && view !== "list",
  });

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["salon", "appointments", locationId] });
  }, [qc, locationId]);

  const windowsFor = useCallback(
    (staffHours: unknown, d: string): [number, number][] =>
      staffDayWindows({ staffHours: normaliseWeeklyHours(staffHours), shopHours, date: d, tz }).map((w) => [
        shopMinutes(w.start, tz),
        shopMinutes(w.end, tz) || 24 * 60,
      ]),
    [shopHours, tz],
  );
  const closedFrom = (open: [number, number][]): [number, number][] => {
    if (!open.length) return [[0, 24 * 60]];
    const out: [number, number][] = [];
    let cursor = 0;
    for (const [a, b] of [...open].sort((x, y) => x[0] - y[0])) {
      if (a > cursor) out.push([cursor, a]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < 24 * 60) out.push([cursor, 24 * 60]);
    return out;
  };
  const awayFor = (staffId: string, d: string) =>
    (timeOff.data ?? [])
      .filter((t) => t.staffId === staffId && shopDate(t.startsAt, tz) <= d && shopDate(t.endsAt, tz) >= d)
      .map((t) => ({
        from: shopDate(t.startsAt, tz) < d ? 0 : shopMinutes(t.startsAt, tz),
        to: shopDate(t.endsAt, tz) > d ? 24 * 60 : shopMinutes(t.endsAt, tz),
        label: t.reason || "Off",
      }));

  const columns: SalonColumn[] = useMemo(() => {
    if (view === "week") {
      const person = staff.find((s) => s.id === weekPerson);
      if (!person) return [];
      return Array.from({ length: 7 }, (_, i) => addDays(weekFrom, i)).map((d) => ({
        key: d,
        date: d,
        header: (
          <button
            type="button"
            onClick={() => {
              setDate(d);
              setView("day");
            }}
            className={`flex h-full w-full flex-col items-start justify-center px-3 text-left hover:bg-zinc-50 ${d === todayIn(tz) ? "text-orange-600" : ""}`}
          >
            <span className="text-xs font-medium text-zinc-500">{longDate(d).split(" ")[0]}</span>
            <span className="text-sm font-semibold">{longDate(d).split(" ").slice(1).join(" ")}</span>
          </button>
        ),
        closed: closedFrom(windowsFor(person.weeklyHours, d)),
        away: awayFor(person.id, d),
        appointments: appts.filter((a) => shopDate(a.startsAt, tz) === d),
      }));
    }
    return staff.map((s) => {
      const mine = appts.filter((a) => a.staffId === s.id);
      const live = mine.filter((a) => LIVE_APPOINTMENT.includes(a.status) || a.status === "COMPLETED");
      return {
        key: s.id,
        date,
        staffId: s.id,
        header: (
          <div className="flex h-full items-center gap-2 px-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold text-white" style={{ background: s.colour }}>
              {s.name.slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-zinc-900">{s.name}</span>
              <span className="block text-xs text-zinc-500">
                {live.length} booked · {money(live.reduce((t, a) => t + a.totalPrice, 0))}
              </span>
            </span>
          </div>
        ),
        closed: closedFrom(windowsFor(s.weeklyHours, date)),
        away: awayFor(s.id, date),
        appointments: mine,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, staff, appts, date, weekFrom, weekPerson, windowsFor, timeOff.data, tz, money]);

  const [startMin, endMin] = useMemo(() => {
    let lo = 9 * 60;
    let hi = 18 * 60;
    const open = columns.flatMap((c) => {
      const closed = c.closed;
      const out: [number, number][] = [];
      let cursor = 0;
      for (const [a, b] of closed) {
        if (a > cursor) out.push([cursor, a]);
        cursor = Math.max(cursor, b);
      }
      if (cursor < 24 * 60) out.push([cursor, 24 * 60]);
      return out.filter(([a, b]) => b - a < 24 * 60);
    });
    if (open.length) {
      lo = Math.min(...open.map((o) => o[0]));
      hi = Math.max(...open.map((o) => o[1]));
    }
    for (const a of appts) {
      lo = Math.min(lo, shopMinutes(a.startsAt, tz));
      hi = Math.max(hi, Math.min(24 * 60, shopMinutes(a.endsAt, tz) || 24 * 60));
    }
    return [Math.max(0, Math.floor((lo - 30) / 60) * 60), Math.min(24 * 60, Math.ceil((hi + 30) / 60) * 60)];
  }, [columns, appts, tz]);

  const move = useCallback(
    async (a: Appointment, t: SalonDrop, force = false) => {
      const startsAt = shopIso(t.date, minuteLabel(t.minute), tz);
      try {
        await salonClient.update(a.id, { startsAt, ...(t.staffId ? { staffId: t.staffId } : {}), force });
        const who = t.staffId && t.staffId !== a.staffId ? ` → ${staff.find((s) => s.id === t.staffId)?.name}` : "";
        toast.success(`${a.customerName} moved to ${minuteLabel(t.minute)}${who}${a.customerEmail ? " — guest emailed" : ""}`);
        refresh();
      } catch (e) {
        const msg = apiError(e, "Couldn't move it");
        if (!force && /isn't free/i.test(msg)) {
          if (confirm(`${msg}\n\nSqueeze ${a.customerName} in anyway?`)) void move(a, t, true);
          return;
        }
        toast.error(msg);
      }
    },
    [tz, staff, refresh],
  );

  const dayAppts = appts.filter((a) => shopDate(a.startsAt, tz) === date);
  const live = dayAppts.filter((a) => LIVE_APPOINTMENT.includes(a.status));
  const done = dayAppts.filter((a) => a.status === "COMPLETED");
  const online = dayAppts.filter((a) => a.source === "ONLINE" && a.status !== "CANCELLED").length;

  if (staffQ.isSuccess && staff.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center">
        <p className="text-sm text-zinc-600">Add your first {staffWord(trade).toLowerCase()} to start taking appointments.</p>
        <a href="/dashboard/salon/team" className="mt-3 inline-flex h-10 items-center rounded-lg bg-orange-500 px-4 text-sm font-medium text-white hover:bg-orange-600">
          Add {staffWord(trade, true).toLowerCase()}
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-lg border border-zinc-200 bg-white">
          <button type="button" aria-label="Previous" onClick={() => setDate(addDays(date, view === "week" ? -7 : -1))} className="grid h-10 w-10 place-items-center text-zinc-600 hover:bg-zinc-50">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => setDate(todayIn(tz))} className="h-10 border-x border-zinc-200 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50">
            Today
          </button>
          <button type="button" aria-label="Next" onClick={() => setDate(addDays(date, view === "week" ? 7 : 1))} className="grid h-10 w-10 place-items-center text-zinc-600 hover:bg-zinc-50">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <label>
          <span className="sr-only">Go to date</span>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-10 rounded-lg border border-zinc-200 bg-white px-2 text-sm" />
        </label>
        <h2 className="mr-auto text-base font-semibold text-zinc-900">
          {view === "week" ? `Week of ${longDate(weekFrom)}` : longDate(date)}
        </h2>
        {view === "week" && (
          <label>
            <span className="sr-only">Whose week</span>
            <select value={weekPerson ?? ""} onChange={(e) => setWeekStaff(e.target.value)} className="h-10 rounded-lg border border-zinc-200 bg-white px-2 text-sm">
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div role="tablist" aria-label="View" className="flex rounded-lg bg-zinc-100 p-0.5">
          {(["day", "week", "list"] as View[]).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`h-9 rounded-md px-3 text-sm font-medium capitalize ${view === v ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-600"}`}
            >
              {v}
            </button>
          ))}
        </div>
        <Button onClick={() => setCreating({ date })}>
          <Plus className="h-4 w-4" aria-hidden /> New
        </Button>
      </div>

      {view !== "week" && (
        <p className="text-sm text-zinc-500">
          {live.length} to come · {done.length} done · {money(done.reduce((t, a) => t + a.totalPrice, 0))} taken
          {online > 0 && (
            <>
              {" "}
              · <Globe2 className="inline h-3.5 w-3.5 text-sky-600" aria-hidden /> {online} booked online
            </>
          )}
        </p>
      )}

      {listQ.isError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{apiError(listQ.error, "Couldn't load the diary")}</p>}

      {view === "list" ? (
        <AgendaList appointments={dayAppts} tz={tz} onOpen={(a) => setOpenId(a.id)} />
      ) : (
        <SalonTimeline
          columns={columns}
          startMin={startMin}
          endMin={endMin}
          tz={tz}
          snap={settings.data?.settings.slotStepMins ?? 15}
          columnWidth={view === "week" ? "min-w-[9rem] flex-1" : "min-w-[13rem] flex-1"}
          onOpen={(a) => setOpenId(a.id)}
          onEmpty={(t) => setCreating({ date: t.date, time: minuteLabel(t.minute), staffId: t.staffId ?? weekPerson ?? undefined })}
          onDrop={(a, t) => void move(a, t)}
        />
      )}

      {creating && locationId && (
        <NewAppointment
          locationId={locationId}
          tz={tz}
          trade={trade}
          services={services.data ?? []}
          staff={staff}
          initial={creating}
          onClose={() => setCreating(null)}
          onBooked={() => {
            setCreating(null);
            refresh();
          }}
        />
      )}
      {openId && locationId && (
        <AppointmentDrawer
          appointmentId={openId}
          locationId={locationId}
          tz={tz}
          staff={staff}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function AgendaList({ appointments, tz, onOpen }: { appointments: Appointment[]; tz: string; onOpen: (a: Appointment) => void }) {
  const { money } = useCurrency();
  if (appointments.length === 0) {
    return <p className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">Nothing booked for this day yet.</p>;
  }
  return (
    <ul className="divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-white">
      {appointments.map((a) => (
        <li key={a.id}>
          <button type="button" onClick={() => onOpen(a)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50">
            <span className="w-12 shrink-0 text-sm font-semibold tabular-nums text-zinc-900">{shopTime(a.startsAt, tz)}</span>
            <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: a.staff?.colour ?? "#d4d4d8" }} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-zinc-900">{a.customerName}</span>
              <span className="block truncate text-xs text-zinc-500">
                {a.summary} · {a.staff?.name ?? "Anyone"}
              </span>
            </span>
            <span className="hidden text-sm tabular-nums text-zinc-700 sm:block">{money(a.totalPrice)}</span>
            <StatusPill status={a.status} />
          </button>
        </li>
      ))}
    </ul>
  );
}
