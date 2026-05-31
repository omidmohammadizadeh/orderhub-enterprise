"use client";

// Phase AN — Opening hours editor.
//
// Shared by the standalone drawer and the location edit modal's
// "Opening Hours" tab. Renders one row per day with a toggle + slots,
// supports add/remove of a second slot, copy day, and save.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, Plus, Trash2 } from "lucide-react";
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
  /** When set, renders a footer with apply-to-other-locations action. */
  allLocationsForApply?: Array<{ id: string; name: string }>;
}

export function OpeningHoursEditor({ locationId, allLocationsForApply }: Props) {
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

  /** Copy this day's schedule onto all other days. */
  const copyToAllDays = (day: WeekdayKey) => {
    const src = hours[day];
    setHours((prev) => {
      const out = { ...prev };
      for (const [k] of WEEKDAY_LABELS) {
        if (k !== day) out[k] = { enabled: src.enabled, slots: src.slots.map((s) => ({ ...s })) };
      }
      return out;
    });
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
            onCopyToAll={() => copyToAllDays(key)}
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

      {allLocationsForApply && allLocationsForApply.length > 1 && (
        <ApplyToOtherLocations
          locationId={locationId}
          options={allLocationsForApply}
        />
      )}
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
  onCopyToAll,
}: {
  label: string;
  day: DaySchedule;
  onToggle: (enabled: boolean) => void;
  onAddSlot: () => void;
  onRemoveSlot: (idx: number) => void;
  onUpdateSlot: (idx: number, k: "from" | "to", v: string) => void;
  onCopyToAll: () => void;
}) {
  return (
    <div className="rounded-md border border-zinc-200 px-3 py-2">
      <div className="flex items-center gap-3">
        <Toggle checked={day.enabled} onChange={onToggle} />
        <span className="text-xs font-medium text-zinc-800 w-24">{label}</span>
        <button
          type="button"
          onClick={onCopyToAll}
          title="Copy to all other days"
          className="rounded p-1 text-zinc-400 hover:bg-zinc-100"
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

function ApplyToOtherLocations({
  locationId,
  options,
}: {
  locationId: string;
  options: Array<{ id: string; name: string }>;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);

  const apply = useMutation({
    mutationFn: () => locationsClient.applyHoursTo(locationId, Array.from(picked)),
    onSuccess: (r) => {
      setStatus(`Applied to ${r.applied} location${r.applied === 1 ? "" : "s"}`);
      setPicked(new Set());
      window.setTimeout(() => setStatus(null), 3000);
    },
    onError: (err: any) =>
      setStatus(err?.response?.data?.message ?? err.message ?? "Failed"),
  });

  const togglePick = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const candidates = options.filter((o) => o.id !== locationId);
  if (candidates.length === 0) return null;

  return (
    <div className="border-t border-zinc-200 pt-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Apply these hours to other locations
      </p>
      <div className="flex flex-wrap gap-1.5">
        {candidates.map((o) => (
          <label
            key={o.id}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-[11px] text-zinc-700 hover:bg-zinc-50"
          >
            <input
              type="checkbox"
              checked={picked.has(o.id)}
              onChange={() => togglePick(o.id)}
              className="h-3 w-3"
            />
            {o.name}
          </label>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-zinc-500">{status}</span>
        <button
          type="button"
          onClick={() => apply.mutate()}
          disabled={apply.isPending || picked.size === 0}
          className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {apply.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
          Apply to {picked.size}
        </button>
      </div>
    </div>
  );
}
