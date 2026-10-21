"use client";

// Put a booking on a table straight from its card — no edit modal.
//
// The list is only the tables /availability says are free for THIS booking's
// slot (its own table not counted against it), so the floor can't double-book
// from here any more than from the editor.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Check, ChevronDown, Armchair } from "lucide-react";
import {
  reservationsClient,
  type Reservation,
} from "@/lib/api/reservations.client";
import { apiMessage } from "./reservation-style";

export function TableAssignMenu({
  reservation: r,
  onChanged,
  disabled,
  align = "left",
}: {
  reservation: Reservation;
  onChanged: () => void;
  disabled?: boolean;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const free = useQuery({
    queryKey: ["reservations", "availability", "assign", r.id, r.startsAt, r.partySize, r.durationMins],
    queryFn: () =>
      reservationsClient.availability({
        locationId: r.locationId,
        startsAt: r.startsAt,
        partySize: r.partySize,
        durationMins: r.durationMins,
        ignoreReservationId: r.id,
      }),
    enabled: open,
  });

  const assign = useMutation({
    mutationFn: (tableId: string | null) =>
      reservationsClient.update(r.id, { tableId, notifyCustomer: false }),
    onSuccess: (_d, tableId) => {
      setOpen(false);
      onChanged();
      toast.success(tableId ? "Table assigned" : "Table cleared");
    },
    onError: (e) => toast.error(apiMessage(e, "Couldn't assign the table")),
  });

  const tables = free.data?.available ?? [];

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        disabled={disabled || assign.isPending}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`inline-flex min-h-[32px] items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 disabled:opacity-50 ${
          r.table
            ? "border-zinc-200 bg-white text-zinc-800 hover:border-zinc-300"
            : "border-dashed border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100"
        }`}
      >
        <Armchair className="h-3.5 w-3.5" aria-hidden />
        {r.table ? r.table.name : "Assign table"}
        <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
      </button>

      {open && (
        <div
          role="listbox"
          onClick={(e) => e.stopPropagation()}
          className={`absolute z-40 mt-1 w-56 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <div className="border-b border-zinc-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
            Free for party of {r.partySize}
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {free.isLoading ? (
              <p className="px-3 py-2 text-xs text-zinc-500">Checking tables…</p>
            ) : (
              <>
                {r.table && (
                  <Option
                    label={r.table.name}
                    hint="Current"
                    active
                    onClick={() => setOpen(false)}
                  />
                )}
                {tables
                  .filter((t) => t.id !== r.tableId)
                  .map((t) => (
                    <Option
                      key={t.id}
                      label={t.name}
                      hint={[t.seats ? `${t.seats} seats` : null, t.area].filter(Boolean).join(" · ")}
                      onClick={() => assign.mutate(t.id)}
                    />
                  ))}
                {tables.filter((t) => t.id !== r.tableId).length === 0 && (
                  <p className="px-3 py-2 text-xs text-zinc-500">
                    No other table is free at this time.
                  </p>
                )}
                {r.table && (
                  <button
                    type="button"
                    onClick={() => assign.mutate(null)}
                    className="mt-1 w-full border-t border-zinc-100 px-3 py-2 text-left text-xs text-zinc-500 hover:bg-zinc-50"
                  >
                    Clear table — decide on the day
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Option({
  label,
  hint,
  active,
  onClick,
}: {
  label: string;
  hint?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={!!active}
      onClick={onClick}
      className={`flex min-h-[40px] w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-orange-50 ${
        active ? "text-orange-700" : "text-zinc-800"
      }`}
    >
      <span className="flex items-center gap-2 font-medium">
        {active && <Check className="h-3.5 w-3.5" aria-hidden />}
        {label}
      </span>
      {hint && <span className="text-[11px] text-zinc-400">{hint}</span>}
    </button>
  );
}
