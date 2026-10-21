"use client";

// The time grid behind both Day and Week.
//
//   Day  — one column per TABLE (plus "Unassigned"), so dragging a booking
//          sideways changes its table and dragging it up/down changes its
//          time, in one move.
//   Week — one column per DAY; dragging changes the day and time and keeps
//          the table.
//
// Dragging is done with pointer events, not HTML5 drag-and-drop: the tills
// are tablets, and HTML5 DnD doesn't work with a finger on most of them. A
// mouse starts dragging after a few pixels; a finger has to press and hold
// first, so an ordinary swipe still scrolls the diary.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StickyNote, Users } from "lucide-react";
import {
  formatTime,
  minuteLabel,
  minutesOfDay,
  toDateInput,
  type Reservation,
} from "@/lib/api/reservations.client";
import { LIVE_STATUSES, STATUS_BLOCK } from "./reservation-style";

export interface TimelineColumn {
  key: string;
  header: React.ReactNode;
  /** "YYYY-MM-DD" this column shows. */
  date: string;
  /**
   * What dropping here does to the table: a table id or null (unassign) in
   * the Day view; `undefined` in the Week view, meaning "leave it alone".
   */
  tableId?: string | null;
  /** Shade (closed) minute ranges, [from, to) minutes of day. */
  closed?: [number, number][];
  muted?: boolean;
  /** Table size, so the drag ghost can warn before a too-big party lands. */
  seats?: number | null;
  bookings: Reservation[];
}

export interface DropTarget {
  date: string;
  minute: number;
  tableId?: string | null;
}

const PX = 1.3; // pixels per minute
const SNAP = 15;
const HEADER_H = 52;

export function ReservationTimeline({
  columns,
  startMin,
  endMin,
  columnWidth,
  showTableOnBlock,
  onOpen,
  onEmpty,
  onDrop,
}: {
  columns: TimelineColumn[];
  startMin: number;
  endMin: number;
  /** Tailwind width classes for each column. */
  columnWidth: string;
  showTableOnBlock?: boolean;
  onOpen: (r: Reservation) => void;
  onEmpty: (target: DropTarget) => void;
  onDrop: (r: Reservation, target: DropTarget) => void;
}) {
  const bodies = useRef(new Map<string, HTMLDivElement>());
  const scroller = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ col: string; min: number } | null>(null);
  const [drag, setDrag] = useState<{
    r: Reservation;
    col: string | null;
    min: number;
  } | null>(null);
  const suppressClick = useRef(false);
  const now = useNow();
  const today = toDateInput(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();

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
      return Math.max(startMin, Math.min(endMin - SNAP, Math.round(raw / SNAP) * SNAP));
    },
    [startMin, endMin],
  );

  const columnAt = (clientX: number, clientY: number): string | null => {
    for (const [key, el] of bodies.current) {
      const r = el.getBoundingClientRect();
      if (clientX >= r.left && clientX < r.right && clientY >= r.top - 40 && clientY <= r.bottom + 40)
        return key;
    }
    return null;
  };

  // ── Dragging ──────────────────────────────────────────────────────────
  const pending = useRef<{
    r: Reservation;
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
          // Moved before the hold finished: it's a scroll, not a drag.
          if (dist > 8) endDrag();
          return;
        }
        if (dist < 5) return;
        p.active = true;
      }
      const col = columnAt(e.clientX, e.clientY);
      const el = col ? bodies.current.get(col) : null;
      setDrag({ r: p.r, col, min: el ? minuteAt(el, e.clientY, p.grab) : 0 });
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
            target.date === toDateInput(new Date(p.r.startsAt)) &&
            minute === minutesOfDay(p.r.startsAt) &&
            (target.tableId === undefined || (target.tableId ?? null) === (p.r.tableId ?? null));
          if (!same) onDrop(p.r, { date: target.date, minute, tableId: target.tableId });
        }
      }
      endDrag();
    };
    // While a finger is dragging, stop the page scrolling under it.
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
    // columnAt reads refs only; columns/onDrop are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, onDrop, minuteAt, endDrag]);

  const startPress = (e: React.PointerEvent, r: Reservation) => {
    if (e.button !== 0 || !LIVE_STATUSES.includes(r.status)) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const touch = e.pointerType !== "mouse";
    const p = {
      r,
      pointerId: e.pointerId,
      touch,
      x: e.clientX,
      y: e.clientY,
      grab: e.clientY - rect.top,
      active: false,
      timer: null as number | null,
    };
    if (touch) {
      p.timer = window.setTimeout(() => {
        if (pending.current !== p) return;
        p.active = true;
        navigator.vibrate?.(15);
        const col = columnAt(p.x, p.y);
        const el = col ? bodies.current.get(col) : null;
        setDrag({ r, col, min: el ? minuteAt(el, p.y, p.grab) : 0 });
      }, 320);
    }
    pending.current = p;
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-card-sm">
      <div ref={scroller} className="max-h-[calc(100vh-260px)] min-h-[420px] overflow-auto overscroll-contain">
        <div className="flex min-w-max">
          {/* Time axis */}
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
            // Bookings overlapping in one column sit side by side; give each
            // at least ~96px so a name stays readable.
            const stack = Math.max(1, ...col.bookings.map((r) => overlapCount(r, col.bookings)));
            return (
              <div
                key={col.key}
                className={`shrink-0 border-r border-zinc-100 last:border-r-0 ${columnWidth}`}
                style={stack > 1 ? { minWidth: stack * 96 } : undefined}
              >
                <div
                  className={`sticky top-0 z-10 border-b border-zinc-100 ${col.muted ? "bg-zinc-50" : "bg-white"}`}
                  style={{ height: HEADER_H }}
                >
                  {col.header}
                </div>
                <div
                  ref={(el) => {
                    if (el) bodies.current.set(col.key, el);
                    else bodies.current.delete(col.key);
                  }}
                  className={`relative select-none ${col.muted ? "bg-zinc-50/60" : ""} ${
                    drag?.col === col.key ? "bg-orange-50/40" : ""
                  }`}
                  style={{ height: heightPx }}
                  onPointerMove={(e) => {
                    if (pending.current || e.pointerType !== "mouse") return;
                    if ((e.target as HTMLElement).dataset.slot === undefined) return setHover(null);
                    setHover({ col: col.key, min: minuteAt(e.currentTarget, e.clientY) });
                  }}
                  onPointerLeave={() => setHover(null)}
                >
                  {/* Click target for "book here" */}
                  <button
                    type="button"
                    data-slot
                    aria-label={`New booking on ${col.date}`}
                    tabIndex={-1}
                    className="absolute inset-0 cursor-crosshair"
                    onClick={(e) => {
                      if (suppressClick.current) return;
                      onEmpty({
                        date: col.date,
                        minute: minuteAt(e.currentTarget.parentElement as HTMLElement, e.clientY),
                        tableId: col.tableId,
                      });
                    }}
                  />
                  {/* Closed hours */}
                  {(col.closed ?? []).map(([a, b], i) => {
                    const s = Math.max(a, startMin);
                    const t = Math.min(b, endMin);
                    if (t <= s) return null;
                    return (
                      <div
                        key={i}
                        className="pointer-events-none absolute inset-x-0 bg-[repeating-linear-gradient(135deg,rgba(24,24,27,.045)_0_6px,transparent_6px_12px)]"
                        style={{ top: (s - startMin) * PX, height: (t - s) * PX }}
                      />
                    );
                  })}
                  {/* Hour + half-hour lines */}
                  {Array.from({ length: Math.ceil((endMin - startMin) / 30) }, (_, i) => (
                    <div
                      key={i}
                      className={`pointer-events-none absolute inset-x-0 border-t ${
                        (startMin + i * 30) % 60 === 0 ? "border-zinc-100" : "border-dashed border-zinc-100/70"
                      }`}
                      style={{ top: i * 30 * PX }}
                    />
                  ))}

                  {hover?.col === col.key && !drag && (
                    <div
                      className="pointer-events-none absolute inset-x-1 z-[1] rounded-lg border border-dashed border-orange-300 bg-orange-50/70 px-2 py-0.5 text-[10px] font-semibold text-orange-700"
                      style={{ top: (hover.min - startMin) * PX, height: 30 * PX }}
                    >
                      + {minuteLabel(hover.min)}
                    </div>
                  )}

                  {col.bookings.map((r) => (
                    <Block
                      key={r.id}
                      r={r}
                      startMin={startMin}
                      endMin={endMin}
                      lane={lane(r, col.bookings)}
                      dragging={drag?.r.id === r.id}
                      showTable={showTableOnBlock}
                      onPointerDown={(e) => startPress(e, r)}
                      onClick={() => {
                        if (suppressClick.current) return;
                        onOpen(r);
                      }}
                    />
                  ))}

                  {/* Drop ghost */}
                  {drag && drag.col === col.key && (() => {
                    const tooSmall = !!col.seats && drag.r.partySize > col.seats;
                    return (
                      <div
                        className={`pointer-events-none absolute inset-x-1 z-30 rounded-lg border-2 px-2 py-1 shadow-lg ${
                          tooSmall ? "border-red-500 bg-red-100/80 text-red-900" : "border-orange-500 bg-orange-100/80 text-orange-900"
                        }`}
                        style={{ top: (drag.min - startMin) * PX, height: Math.max(26, drag.r.durationMins * PX - 2) }}
                      >
                        <div className="text-[11px] font-bold">
                          {minuteLabel(drag.min)} · {drag.r.customerName}
                        </div>
                        {tooSmall && (
                          <div className="text-[10px] font-medium">
                            Seats {col.seats} — party of {drag.r.partySize}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {isToday && nowMin >= startMin && nowMin <= endMin && (
                    <div
                      className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-red-500"
                      style={{ top: (nowMin - startMin) * PX }}
                    >
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

function Block({
  r,
  startMin,
  endMin,
  lane,
  dragging,
  showTable,
  onPointerDown,
  onClick,
}: {
  r: Reservation;
  startMin: number;
  endMin: number;
  lane: { left: string; width: string };
  dragging: boolean;
  showTable?: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onClick: () => void;
}) {
  const s = minutesOfDay(r.startsAt);
  const e = s + r.durationMins;
  const top = (Math.max(s, startMin) - startMin) * PX;
  const h = Math.max(26, (Math.min(e, endMin) - Math.max(s, startMin)) * PX - 2);
  const live = LIVE_STATUSES.includes(r.status);
  return (
    <div className="absolute z-[2] p-0.5" style={{ top, height: h + 2, ...lane }}>
      <button
        type="button"
        onPointerDown={onPointerDown}
        onClick={onClick}
        onContextMenu={(ev) => ev.preventDefault()}
        title={`${r.customerName} · ${r.partySize} · ${formatTime(r.startsAt)}${live ? " — drag to move" : ""}`}
        className={`group relative flex h-full w-full flex-col overflow-hidden rounded-lg border-l-[3px] px-2 py-1 text-left shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
          STATUS_BLOCK[r.status]
        } ${live ? "cursor-grab hover:shadow-md active:cursor-grabbing" : "opacity-70"} ${
          dragging ? "opacity-30" : ""
        }`}
        style={{ touchAction: live ? "manipulation" : undefined }}
      >
        <span className="flex items-center gap-1 truncate text-[12px] font-semibold leading-tight">
          <span className="truncate">{r.customerName}</span>
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium opacity-70">
            <Users className="h-3 w-3" aria-hidden />
            {r.partySize}
          </span>
        </span>
        {h > 34 && (
          <span className="truncate text-[11px] leading-tight opacity-75">
            {formatTime(r.startsAt)}–{minuteLabel(e)}
            {showTable ? ` · ${r.table?.name ?? "No table"}` : ""}
          </span>
        )}
        {h > 54 && r.notes && (
          <span className="mt-0.5 flex items-center gap-1 truncate text-[10px] opacity-70">
            <StickyNote className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">{r.notes}</span>
          </span>
        )}
        {r.source === "ONLINE" && (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-sky-500" title="Booked online" />
        )}
      </button>
    </div>
  );
}

function overlapCount(r: Reservation, all: Reservation[]): number {
  const s = new Date(r.startsAt).getTime();
  const e = s + r.durationMins * 60_000;
  return all.filter((o) => {
    const os = new Date(o.startsAt).getTime();
    return os < e && s < os + o.durationMins * 60_000;
  }).length;
}

/** Overlapping bookings sit side by side within a column. */
function lane(r: Reservation, all: Reservation[]) {
  const s = new Date(r.startsAt).getTime();
  const e = s + r.durationMins * 60_000;
  const overlapping = all
    .filter((o) => {
      const os = new Date(o.startsAt).getTime();
      return os < e && s < os + o.durationMins * 60_000;
    })
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
  const i = Math.max(0, overlapping.findIndex((o) => o.id === r.id));
  const n = Math.max(1, overlapping.length);
  return { left: `${(i / n) * 100}%`, width: `${100 / n}%` };
}

function autoScroll(el: HTMLElement | null, clientX: number) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (clientX > r.right - 40) el.scrollLeft += 12;
  else if (clientX < r.left + 96) el.scrollLeft -= 12;
}

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}
