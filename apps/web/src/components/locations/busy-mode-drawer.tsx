"use client";

// Phase AN — Busy Mode drawer. Toggles isPaused / busyMode on the
// location, captures a reason + until-time, plus a checkbox list of
// affected platforms. Today saved locally only — pushes to Uber Eats /
// Deliveroo / Just Eat / online ordering ship in a later phase.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { locationsClient } from "@/lib/api/locations.client";

const PLATFORMS = ["ONLINE", "UBER_EATS", "DELIVEROO", "JUST_EAT"] as const;

export function BusyModeDrawer({
  locationId,
  onClose,
  onSaved,
}: {
  locationId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const loc = useQuery({
    queryKey: ["locations", "detail", locationId],
    queryFn: () => locationsClient.get(locationId),
  });

  const [enabled, setEnabled] = useState(false);
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [platforms, setPlatforms] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!loc.data) return;
    setEnabled(loc.data.busyMode ?? false);
    const json = (loc.data.busyModeJson ?? {}) as any;
    setReason(json.reason ?? "");
    setUntil(json.until ?? "");
    setPlatforms(new Set(json.affectedPlatforms ?? []));
  }, [loc.data]);

  const save = useMutation({
    mutationFn: () =>
      locationsClient.setBusyMode(locationId, {
        enabled,
        reason: reason || undefined,
        until: until || null,
        affectedPlatforms: Array.from(platforms),
      }),
    onSuccess: onSaved,
  });

  const togglePlatform = (p: string) => {
    const next = new Set(platforms);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setPlatforms(next);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-md flex-col overflow-hidden bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">Busy mode</h2>
            <p className="text-xs text-zinc-500">{loc.data?.name ?? "Location"}</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
          <label className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2">
            <span className="text-sm font-medium text-zinc-800">Busy mode</span>
            <button
              type="button"
              onClick={() => setEnabled(!enabled)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                enabled ? "bg-amber-500" : "bg-zinc-300"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  enabled ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </button>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Reason
            </span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is the kitchen busy?"
              disabled={!enabled}
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none disabled:bg-zinc-50"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Until
            </span>
            <input
              type="datetime-local"
              value={until ? toLocalDt(until) : ""}
              onChange={(e) => setUntil(e.target.value ? new Date(e.target.value).toISOString() : "")}
              disabled={!enabled}
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none disabled:bg-zinc-50"
            />
          </label>

          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Affected platforms
            </p>
            <div className="grid grid-cols-2 gap-2">
              {PLATFORMS.map((p) => (
                <label
                  key={p}
                  className="inline-flex items-center gap-2 rounded-md border border-zinc-200 px-2 py-1.5 text-xs text-zinc-700"
                >
                  <input
                    type="checkbox"
                    checked={platforms.has(p)}
                    onChange={() => togglePlatform(p)}
                    disabled={!enabled}
                  />
                  {p.replace("_", " ")}
                </label>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-zinc-400">
              Status push to delivery platforms ships in a later phase. Saved locally for now.
            </p>
          </div>
        </div>

        <footer className="flex justify-end border-t border-zinc-200 p-3">
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}

function toLocalDt(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}
