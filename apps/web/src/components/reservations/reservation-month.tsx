"use client";

// Month at a glance: covers per day and the first few bookings, so a manager
// can see which Saturdays are filling up. Click a day for its timeline; drag
// a booking onto another day to move it (same time, same table if free).

import { useState } from "react";
import {
  formatTime,
  shiftDate,
  toDateInput,
  type Reservation,
} from "@/lib/api/reservations.client";
import { LIVE_STATUSES, STATUS_DOT } from "./reservation-style";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SHOW = 3;

export function ReservationMonth({
  gridStart,
  month,
  reservations,
  onOpenDay,
  onOpen,
  onMoveToDay,
}: {
  /** Monday the 6-week grid starts on. */
  gridStart: string;
  /** "YYYY-MM" being shown — other days are dimmed. */
  month: string;
  reservations: Reservation[];
  onOpenDay: (date: string) => void;
  onOpen: (r: Reservation) => void;
  onMoveToDay: (r: Reservation, date: string) => void;
}) {
  const today = toDateInput(new Date());
  const [over, setOver] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const byDay = new Map<string, Reservation[]>();
  for (const r of reservations) {
    const k = toDateInput(new Date(r.startsAt));
    const list = byDay.get(k) ?? [];
    list.push(r);
    byDay.set(k, list);
  }

  const days = Array.from({ length: 42 }, (_, i) => shiftDate(gridStart, i));

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-card-sm">
      <div className="grid grid-cols-7 border-b border-zinc-100 bg-zinc-50/60">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const list = (byDay.get(d) ?? []).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
          const live = list.filter((r) => LIVE_STATUSES.includes(r.status));
          const covers = live.reduce((s, r) => s + r.partySize, 0);
          const inMonth = d.startsWith(month);
          const isToday = d === today;
          return (
            <div
              key={d}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                setOver(d);
              }}
              onDragLeave={() => setOver((o) => (o === d ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const r = reservations.find((x) => x.id === dragId);
                setDragId(null);
                if (r && toDateInput(new Date(r.startsAt)) !== d) onMoveToDay(r, d);
              }}
              className={`group relative min-h-[92px] border-b border-r border-zinc-100 p-1.5 transition-colors sm:min-h-[118px] [&:nth-child(7n)]:border-r-0 ${
                inMonth ? "bg-white" : "bg-zinc-50/70"
              } ${over === d ? "bg-orange-50 ring-2 ring-inset ring-orange-400" : ""}`}
            >
              <button
                type="button"
                onClick={() => onOpenDay(d)}
                className="absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500"
                aria-label={`Open ${d}`}
              />
              <div className="pointer-events-none relative flex items-center justify-between">
                <span
                  className={`grid h-7 w-7 place-items-center rounded-full text-xs font-semibold tabular-nums ${
                    isToday
                      ? "bg-orange-500 text-white"
                      : inMonth
                        ? "text-zinc-800"
                        : "text-zinc-400"
                  }`}
                >
                  {Number(d.slice(8))}
                </span>
                {covers > 0 && (
                  <span className="rounded-full bg-zinc-900 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">
                    {covers}
                    <span className="hidden sm:inline"> cov</span>
                  </span>
                )}
              </div>
              <div className="relative mt-1 hidden space-y-0.5 sm:block">
                {list.slice(0, SHOW).map((r) => {
                  const canDrag = LIVE_STATUSES.includes(r.status) && r.status !== "SEATED";
                  return (
                    <button
                      key={r.id}
                      type="button"
                      draggable={canDrag}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", r.id);
                        setDragId(r.id);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setOver(null);
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(r);
                      }}
                      className={`flex w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-left text-[11px] hover:bg-zinc-100 ${
                        LIVE_STATUSES.includes(r.status)
                          ? "text-zinc-800"
                          : r.status === "COMPLETED"
                            ? "text-zinc-400"
                            : "text-zinc-400 line-through"
                      } ${canDrag ? "cursor-grab" : ""}`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[r.status]}`} aria-hidden />
                      <span className="tabular-nums text-zinc-500">{formatTime(r.startsAt)}</span>
                      <span className="truncate font-medium">{r.customerName}</span>
                      <span className="ml-auto shrink-0 text-zinc-400">{r.partySize}</span>
                    </button>
                  );
                })}
                {list.length > SHOW && (
                  <div className="pointer-events-none px-1.5 text-[11px] font-medium text-orange-600">
                    +{list.length - SHOW} more
                  </div>
                )}
              </div>
              {/* Phones: dots instead of rows. */}
              {list.length > 0 && (
                <div className="pointer-events-none relative mt-1 flex flex-wrap gap-0.5 sm:hidden">
                  {list.slice(0, 6).map((r) => (
                    <span key={r.id} className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[r.status]}`} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
