"use client";

// The diary grid behind Day and Week.
//
//   Day  — one column per barber: drag sideways to give the client to
//          someone else, up/down to change the time.
//   Week — one column per day for one barber: drag to another day or time.
//
// Pointer events, not HTML5 drag-and-drop, because the tills are tablets: a
// mouse drags after a few pixels, a finger presses and holds first so an
// ordinary swipe still scrolls the diary. Times are the SHOP's wall clock.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CreditCard, Globe2, StickyNote } from "lucide-react";
import {
  LIVE_APPOINTMENT,
  shopDate,
  shopMinutes,
  shopTime,
  type Appointment,
} from "@/lib/api/salon.client";
import { STATUS_BLOCK } from "./salon-shared";

export interface SalonColumn {
  key: string;
  header: React.ReactNode;
  date: string;
  /** Dropping here gives the appointment to this person (Day view). */
  staffId?: string;
  /** Minutes of the day this person isn't working (shaded). */
  closed: [number, number][];
  /** Time off (hatched, labelled). */
  away: Array<{ from: number; to: number; label: string }>;
  appointments: Appointment[];
}

export interface SalonDrop {
  date: string;
  minute: number;
  staffId?: string;
}

const PX = 1.6;
const SNAP = 5;
const HEADER_H = 56;

function minuteLabel(m: number): string {
  const h = Math.floor(m / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function SalonTimeline({
  columns,
  startMin,
  endMin,
  tz,
  snap = 15,
  columnWidth = "min-w-[13rem] flex-1",
  onOpen,
  onEmpty,
  onDrop,
}: {
  columns: SalonColumn[];
  startMin: number;
  endMin: number;
  tz: string;
  snap?: number;
  columnWidth?: string;
  onOpen: (a: Appointment) => void;
  onEmpty: (t: SalonDrop) => void;
  onDrop: (a: Appointment, t: SalonDrop) => void;
}) {
  const bodies = useRef(new Map<string, HTMLDivElement>());
  const scroller = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ col: string; min: number } | null>(null);
  const [drag, setDrag] = useState<{ a: Appointment; col: string | null; min: number } | null>(null);
  const suppressClick = useRef(false);
  const now = useNow();
  const today = shopDate(now, tz);
  const nowMin = shopMinutes(now, tz);
  const step = Math.max(SNAP, snap);

  const heightPx = (endMin - startMin) * PX;
  const hours = useMemo(() => {
    const out: number[] = [];
    for (let m = Math.ceil(startMin / 60) * 60; m < endMin; m += 60) out.push(m);
    return out;
  }, [startMin, endMin]);

  const minuteAt = useCallback(
    (el: HTMLElement, clientY: number, grab = 0) => {
      const rect = el.getBoundingClientRect();
      const raw = (clientY - rect.top - grab) / PX + startMin;
      return Math.max(startMin, Math.min(endMin - step, Math.round(raw / step) * step));
    },
    [startMin, endMin, step],
  );

  const columnAt = (clientX: number, clientY: number): string | null => {
    for (const [key, el] of bodies.current) {
      const r = el.getBoundingClientRect();
      if (clientX >= r.left && clientX < r.right && clientY >= r.top - 40 && clientY <= r.bottom + 40) return key;
    }
    return null;
  };

  // Scroll to "now" (or the first appointment) once, so the tablet opens on
  // the part of the day that matters.
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !scroller.current) return;
    const first = Math.min(
      ...columns.flatMap((c) => c.appointments.map((a) => shopMinutes(a.startsAt, tz))),
      columns.some((c) => c.date === today) ? nowMin - 60 : Infinity,
    );
    if (Number.isFinite(first)) {
      scroller.current.scrollTop = Math.max(0, (first - startMin - 30) * PX);
      scrolled.current = true;
    }
  }, [columns, startMin, nowMin, today, tz]);

  const pending = useRef<{
    a: Appointment;
    pointerId: number;
    touch: boolean;
    x: number;
    y: number;
    grab: number;
    active: boolean;
    timer: number | null;
  } | null>(null);

  const endDrag = useCallback(() => {
    const p = pending.current;
    if (p?.timer) window.clearTimeout(p.timer);
    pending.current = null;
    setDrag(null);
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = pending.current;
      if (!p || e.pointerId !== p.pointerId) return;
      const dist = Math.hypot(e.clientX - p.x, e.clientY - p.y);
      if (!p.active) {
        if (p.touch) {
          if (dist > 8) endDrag();
          return;
        }
        if (dist < 5) return;
        p.active = true;
      }
      const col = columnAt(e.clientX, e.clientY);
      const el = col ? bodies.current.get(col) : null;
      setDrag({ a: p.a, col, min: el ? minuteAt(el, e.clientY, p.grab) : 0 });
      autoScroll(scroller.current, e.clientX);
    };
    const up = (e: PointerEvent) => {
      const p = pending.current;
      if (!p || e.pointerId !== p.pointerId) return;
      if (p.active) {
        suppressClick.current = true;
        window.setTimeout(() => (suppressClick.current = false), 50);
        const col = columnAt(e.clientX, e.clientY);
        const el = col ? bodies.current.get(col) : null;
        const target = columns.find((c) => c.key === col);
        if (el && target) {
          const minute = minuteAt(el, e.clientY, p.grab);
          const same =
            target.date === shopDate(p.a.startsAt, tz) &&
            minute === shopMinutes(p.a.startsAt, tz) &&
            (target.staffId === undefined || target.staffId === p.a.staffId);
          if (!same) onDrop(p.a, { date: target.date, minute, staffId: target.staffId });
        }
      }
      endDrag();
    };
    const touchMove = (e: TouchEvent) => {
      if (pending.current?.active) e.preventDefault();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("touchmove", touchMove, { passive: false });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("touchmove", touchMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, onDrop, minuteAt, endDrag, tz]);

  const movable = (a: Appointment) => ["CONFIRMED", "CHECKED_IN", "PENDING_PAYMENT"].includes(a.status);

  const startPress = (e: React.PointerEvent, a: Appointment) => {
    if (e.button !== 0 || !movable(a)) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const touch = e.pointerType !== "mouse";
    const p = { a, pointerId: e.pointerId, touch, x: e.clientX, y: e.clientY, grab: e.clientY - rect.top, active: false, timer: null as number | null };
    if (touch) {
      p.timer = window.setTimeout(() => {
        if (pending.current !== p) return;
        p.active = true;
        navigator.vibrate?.(15);
        const col = columnAt(p.x, p.y);
        const el = col ? bodies.current.get(col) : null;
        setDrag({ a, col, min: el ? minuteAt(el, p.y, p.grab) : 0 });
      }, 320);
    }
    pending.current = p;
  };

  const lengthOf = (a: Appointment) => Math.max(5, (new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime()) / 60_000);

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-card-sm">
      <div ref={scroller} className="max-h-[calc(100vh-250px)] min-h-[440px] overflow-auto overscroll-contain">
        <div className="flex min-w-max">
          <div className="sticky left-0 z-20 w-14 shrink-0 border-r border-zinc-100 bg-white">
            <div className="sticky top-0 z-10 border-b border-zinc-100 bg-white" style={{ height: HEADER_H }} />
            <div className="relative" style={{ height: heightPx }}>
              {hours.map((m) => (
                <div
                  key={m}
                  className="absolute right-2 -translate-y-1/2 text-[10px] font-medium tabular-nums text-zinc-400"
                  style={{ top: (m - startMin) * PX }}
                >
                  {m === startMin ? "" : minuteLabel(m)}
                </div>
              ))}
            </div>
          </div>

          {columns.map((col) => {
            const isToday = col.date === today;
            const live = col.appointments.filter((a) => a.status !== "CANCELLED");
            const stack = Math.max(1, ...live.map((a) => overlapping(a, live).length));
            return (
              <div
                key={col.key}
                className={`border-r border-zinc-100 last:border-r-0 ${columnWidth}`}
                style={stack > 1 ? { minWidth: stack * 110 } : undefined}
              >
                <div className="sticky top-0 z-10 border-b border-zinc-100 bg-white" style={{ height: HEADER_H }}>
                  {col.header}
                </div>
                <div
                  ref={(el) => {
                    if (el) bodies.current.set(col.key, el);
                    else bodies.current.delete(col.key);
                  }}
                  className={`relative select-none ${drag?.col === col.key ? "bg-orange-50/40" : ""}`}
                  style={{ height: heightPx }}
                  onPointerMove={(e) => {
                    if (pending.current || e.pointerType !== "mouse") return;
                    if ((e.target as HTMLElement).dataset.slot === undefined) return setHover(null);
                    setHover({ col: col.key, min: minuteAt(e.currentTarget, e.clientY) });
                  }}
                  onPointerLeave={() => setHover(null)}
                >
                  <button
                    type="button"
                    data-slot
                    aria-label={`New appointment on ${col.date}`}
                    tabIndex={-1}
                    className="absolute inset-0 cursor-crosshair"
                    onClick={(e) => {
                      if (suppressClick.current) return;
                      onEmpty({
                        date: col.date,
                        minute: minuteAt(e.currentTarget.parentElement as HTMLElement, e.clientY),
                        staffId: col.staffId,
                      });
                    }}
                  />
                  {col.closed.map(([a, b], i) => {
                    const s = Math.max(a, startMin);
                    const t = Math.min(b, endMin);
                    if (t <= s) return null;
                    return (
                      <div
                        key={`c${i}`}
                        className="pointer-events-none absolute inset-x-0 bg-zinc-100/70"
                        style={{ top: (s - startMin) * PX, height: (t - s) * PX }}
                      />
                    );
                  })}
                  {col.away.map((w, i) => {
                    const s = Math.max(w.from, startMin);
                    const t = Math.min(w.to, endMin);
                    if (t <= s) return null;
                    return (
                      <div
                        key={`a${i}`}
                        className="pointer-events-none absolute inset-x-0 z-[1] bg-[repeating-linear-gradient(135deg,rgba(24,24,27,.07)_0_6px,transparent_6px_12px)] px-2 pt-1 text-[10px] font-semibold text-zinc-500"
                        style={{ top: (s - startMin) * PX, height: (t - s) * PX }}
                      >
                        {w.label}
                      </div>
                    );
                  })}
                  {Array.from({ length: Math.ceil((endMin - startMin) / 15) }, (_, i) => {
                    const m = startMin + i * 15;
                    return (
                      <div
                        key={i}
                        className={`pointer-events-none absolute inset-x-0 border-t ${
                          m % 60 === 0 ? "border-zinc-200/80" : m % 30 === 0 ? "border-dashed border-zinc-100" : "border-transparent"
                        }`}
                        style={{ top: i * 15 * PX }}
                      />
                    );
                  })}

                  {hover?.col === col.key && !drag && (
                    <div
                      className="pointer-events-none absolute inset-x-1 z-[1] rounded-lg border border-dashed border-orange-300 bg-orange-50/70 px-2 py-0.5 text-[10px] font-semibold text-orange-700"
                      style={{ top: (hover.min - startMin) * PX, height: 30 * PX }}
                    >
                      + {minuteLabel(hover.min)}
                    </div>
                  )}

                  {col.appointments.map((a) => {
                    const s = shopMinutes(a.startsAt, tz);
                    const len = lengthOf(a);
                    const top = (Math.max(s, startMin) - startMin) * PX;
                    const h = Math.max(30, (Math.min(s + len, endMin) - Math.max(s, startMin)) * PX - 2);
                    const lane = laneOf(a, live);
                    const isLive = LIVE_APPOINTMENT.includes(a.status);
                    return (
                      <div key={a.id} className="absolute z-[2] p-0.5" style={{ top, height: h + 2, ...lane }}>
                        <button
                          type="button"
                          onPointerDown={(e) => startPress(e, a)}
                          onClick={() => {
                            if (suppressClick.current) return;
                            onOpen(a);
                          }}
                          onContextMenu={(ev) => ev.preventDefault()}
                          title={`${a.customerName} · ${a.summary} · ${shopTime(a.startsAt, tz)}${movable(a) ? " — drag to move" : ""}`}
                          className={`relative flex h-full w-full flex-col overflow-hidden rounded-lg border-l-[3px] px-2 py-1 text-left shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                            STATUS_BLOCK[a.status]
                          } ${movable(a) ? "cursor-grab hover:shadow-md active:cursor-grabbing" : ""} ${!isLive && a.status !== "IN_SERVICE" ? "opacity-70" : ""} ${
                            drag?.a.id === a.id ? "opacity-30" : ""
                          }`}
                          style={{ touchAction: movable(a) ? "manipulation" : undefined }}
                        >
                          <span className="truncate text-[12px] font-semibold leading-tight">{a.customerName}</span>
                          {h > 34 && <span className="truncate text-[11px] leading-tight opacity-80">{a.summary}</span>}
                          {h > 52 && (
                            <span className="truncate text-[10px] leading-tight opacity-70">
                              {shopTime(a.startsAt, tz)}–{shopTime(a.endsAt, tz)}
                            </span>
                          )}
                          {h > 70 && a.notes && (
                            <span className="mt-0.5 flex items-center gap-1 truncate text-[10px] opacity-70">
                              <StickyNote className="h-3 w-3 shrink-0" aria-hidden />
                              <span className="truncate">{a.notes}</span>
                            </span>
                          )}
                          <span className="absolute right-1 top-1 flex gap-0.5">
                            {a.source === "ONLINE" && <Globe2 className="h-3 w-3 text-sky-600" aria-label="Booked online" />}
                            {a.depositStatus === "PAID" && <CreditCard className="h-3 w-3 text-emerald-600" aria-label="Deposit paid" />}
                          </span>
                        </button>
                      </div>
                    );
                  })}

                  {drag && drag.col === col.key && (
                    <div
                      className="pointer-events-none absolute inset-x-1 z-30 rounded-lg border-2 border-orange-500 bg-orange-100/85 px-2 py-1 text-orange-950 shadow-lg"
                      style={{ top: (drag.min - startMin) * PX, height: Math.max(30, lengthOf(drag.a) * PX - 2) }}
                    >
                      <div className="text-[11px] font-bold">
                        {minuteLabel(drag.min)} · {drag.a.customerName}
                      </div>
                    </div>
                  )}

                  {isToday && nowMin >= startMin && nowMin <= endMin && (
                    <div className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-red-500" style={{ top: (nowMin - startMin) * PX }}>
                      <span className="absolute -left-1 -top-[5px] h-2 w-2 rounded-full bg-red-500" />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function overlapping(a: Appointment, all: Appointment[]): Appointment[] {
  const s = new Date(a.startsAt).getTime();
  const e = new Date(a.endsAt).getTime();
  return all
    .filter((o) => new Date(o.startsAt).getTime() < e && s < new Date(o.endsAt).getTime())
    .sort((x, y) => x.startsAt.localeCompare(y.startsAt) || x.id.localeCompare(y.id));
}

function laneOf(a: Appointment, all: Appointment[]) {
  if (a.status === "CANCELLED") return { left: "55%", width: "45%" };
  const o = overlapping(a, all);
  const i = Math.max(0, o.findIndex((x) => x.id === a.id));
  const n = Math.max(1, o.length);
  return { left: `${(i / n) * 100}%`, width: `${100 / n}%` };
}

function autoScroll(el: HTMLElement | null, clientX: number) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (clientX > r.right - 40) el.scrollLeft += 12;
  else if (clientX < r.left + 96) el.scrollLeft -= 12;
}

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

export { minuteLabel };
