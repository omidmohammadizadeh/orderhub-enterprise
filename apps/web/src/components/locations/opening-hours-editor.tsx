"use client";

// Phase AN — Opening hours editor.
//
// Shared by the standalone drawer and the location edit modal's
// "Opening Hours" tab. Renders one row per day with a toggle + slots,
// supports add/remove of a second slot, copy day, and save.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, Plus, Trash2, X } from "lucide-react";
import {
  locationsClient,
  type OpeningHoursMap,
  type DaySchedule,
  type WeekdayKey,
  WEEKDAY_LABELS,
  emptyOpeningHours,
} from "@/lib/api/locations.client";

interface Props {
  locationId: string;
}

export function OpeningHoursEditor({ locationId }: Props) {
  const qc = useQueryClient();
  const hoursQuery = useQuery({
    queryKey: ["locations", "hours", locationId],
    queryFn: () => locationsClient.getOpeningHours(locationId),
  });

  const [hours, setHours] = useState<OpeningHoursMap>(emptyOpeningHours());
  const [feedback, setFeedback] = useState<string | null>(null);

  // Sync server data into local state on first load (only).
  useEffect(() => {
    if (hoursQuery.data) {
      // Hydrate any missing day with an empty entry so toggles render.
      const merged: OpeningHoursMap = { ...emptyOpeningHours(), ...hoursQuery.data };
      setHours(merged);
    }
  }, [hoursQuery.data]);

  const save = useMutation({
    mutationFn: () => locationsClient.setOpeningHours(locationId, hours),
    onSuccess: () => {
      setFeedback("Saved");
      qc.invalidateQueries({ queryKey: ["locations", "hours", locationId] });
      window.setTimeout(() => setFeedback(null), 2500);
    },
    onError: (err: any) =>
      setFeedback(err?.response?.data?.message ?? err.message ?? "Failed"),
  });

  const updateDay = (day: WeekdayKey, patch: Partial<DaySchedule>) =>
    setHours((prev) => ({ ...prev, [day]: { ...prev[day], ...patch } }));

  const addSlot = (day: WeekdayKey) =>
    updateDay(day, {
      slots: [...(hours[day]?.slots ?? []), { from: "10:00", to: "22:00" }],
    });

  const removeSlot = (day: WeekdayKey, idx: number) =>
    updateDay(day, {
      slots: hours[day].slots.filter((_, i) => i !== idx),
    });

  const updateSlot = (day: WeekdayKey, idx: number, key: "from" | "to", value: string) =>
    updateDay(day, {
      slots: hours[day].slots.map((s, i) =>
        i === idx ? { ...s, [key]: value } : s,
      ),
    });

  // Phase AN follow-up: duplicating a day no longer applies blindly to
  // every day. We surface a modal so the operator ticks which days
  // should receive the schedule.
  const [duplicateSource, setDuplicateSource] = useState<WeekdayKey | null>(null);

  const applyDuplicate = (targetDays: WeekdayKey[]) => {
    if (!duplicateSource) return;
    const src = hours[duplicateSource];
    setHours((prev) => {
      const out = { ...prev };
      for (const day of targetDays) {
        if (day === duplicateSource) continue;
        out[day] = { enabled: src.enabled, slots: src.slots.map((s) => ({ ...s })) };
      }
      return out;
    });
    setDuplicateSource(null);
    setFeedback("Schedule copied — remember to Save");
    window.setTimeout(() => setFeedback(null), 2500);
  };

  return (
    <div className="space-y-3">
      {hoursQuery.isLoading ? (
        <p className="py-4 text-center text-xs text-zinc-400">Loading…</p>
      ) : (
        WEEKDAY_LABELS.map(([key, label]) => (
          <DayRow
            key={key}
            label={label}
            day={hours[key]}
            onToggle={(enabled) => updateDay(key, { enabled })}
            onAddSlot={() => addSlot(key)}
            onRemoveSlot={(i) => removeSlot(key, i)}
            onUpdateSlot={(i, k, v) => updateSlot(key, i, k, v)}
            onDuplicate={() => setDuplicateSource(key)}
          />
        ))
      )}

      <div className="flex items-center justify-between gap-3 border-t border-zinc-200 pt-3">
        <span className="text-[11px] text-zinc-500">
          {feedback ?? "Slots wrapping past midnight (00:00–01:00) are allowed."}
        </span>
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save hours
        </button>
      </div>

      {duplicateSource && (
        <DuplicateDayModal
          sourceDay={duplicateSource}
          onCancel={() => setDuplicateSource(null)}
          onApply={applyDuplicate}
        />
      )}
    </div>
  );
}

/**
 * Phase AN — pick which days the duplicated schedule lands on.
 * Days other than the source are pre-checked; operator unticks any
 * they want to keep distinct.
 */
function DuplicateDayModal({
  sourceDay,
  onCancel,
  onApply,
}: {
  sourceDay: WeekdayKey;
  onCancel: () => void;
  onApply: (days: WeekdayKey[]) => void;
}) {
  const [picked, setPicked] = useState<Set<WeekdayKey>>(
    () => new Set(WEEKDAY_LABELS.map(([k]) => k).filter((k) => k !== sourceDay)),
  );

  const toggle = (k: WeekdayKey) => {
    const next = new Set(picked);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setPicked(next);
  };

  const sourceLabel =
    WEEKDAY_LABELS.find(([k]) => k === sourceDay)?.[1] ?? sourceDay;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">Duplicate {sourceLabel}</h3>
            <p className="text-[11px] text-zinc-500">Tick the days that should match.</p>
          </div>
          <button onClick={onCancel} className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-1 p-3">
          {WEEKDAY_LABELS.filter(([k]) => k !== sourceDay).map(([k, label]) => (
            <label
              key={k}
              className="flex items-center gap-2 rounded-md border border-zinc-200 px-2 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
            >
              <input
                type="checkbox"
                checked={picked.has(k)}
                onChange={() => toggle(k)}
                className="h-3.5 w-3.5"
              />
              {label}
            </label>
          ))}
        </div>
        <footer className="flex justify-end gap-2 border-t border-zinc-200 px-4 py-3">
          <button
            onClick={onCancel}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onApply(Array.from(picked))}
            disabled={picked.size === 0}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            Apply to {picked.size} {picked.size === 1 ? "day" : "days"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function DayRow({
  label,
  day,
  onToggle,
  onAddSlot,
  onRemoveSlot,
  onUpdateSlot,
  onDuplicate,
}: {
  label: string;
  day: DaySchedule;
  onToggle: (enabled: boolean) => void;
  onAddSlot: () => void;
  onRemoveSlot: (idx: number) => void;
  onUpdateSlot: (idx: number, k: "from" | "to", v: string) => void;
  onDuplicate: () => void;
}) {
  return (
    <div className="rounded-md border border-zinc-200 px-3 py-2">
      <div className="flex items-center gap-3">
        <Toggle checked={day.enabled} onChange={onToggle} />
        <span className="text-xs font-medium text-zinc-800 w-24">{label}</span>
        <button
          type="button"
          onClick={onDuplicate}
          disabled={!day.enabled}
          title="Duplicate to other days…"
          className="rounded p-1 text-zinc-400 hover:bg-zinc-100 disabled:opacity-30"
        >
          <Copy className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={onAddSlot}
          disabled={!day.enabled || (day.slots?.length ?? 0) >= 2}
          title="Add second slot"
          className="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-100 disabled:opacity-30"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
      {day.enabled && (
        <div className="mt-2 space-y-1.5">
          {(day.slots ?? []).map((slot, idx) => (
            <div key={idx} className="flex items-center gap-2 pl-12">
              <input
                type="time"
                value={slot.from}
                onChange={(e) => onUpdateSlot(idx, "from", e.target.value)}
                className="rounded-md border border-zinc-200 px-2 py-1 text-xs focus:border-zinc-900 focus:outline-none"
              />
              <span className="text-xs text-zinc-400">–</span>
              <input
                type="time"
                value={slot.to}
                onChange={(e) => onUpdateSlot(idx, "to", e.target.value)}
                className="rounded-md border border-zinc-200 px-2 py-1 text-xs focus:border-zinc-900 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => onRemoveSlot(idx)}
                className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          {(day.slots ?? []).length === 0 && (
            <p className="pl-12 text-[11px] text-zinc-400">No slots — add one.</p>
          )}
        </div>
      )}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        checked ? "bg-emerald-500" : "bg-zinc-300"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

