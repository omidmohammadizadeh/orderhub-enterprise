"use client";

// Auto publish — re-publish this menu to its marketplace channels on chosen
// days and times. Built for Just Eat: when JET order injection stops for a
// store, publishing the menu again brings it back, so a schedule does it
// before anyone notices.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { AlertTriangle, CalendarClock, CheckCircle2, Clock, Loader2, Play, Plus, Trash2, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PlatformLogo } from "@/components/ui/platform-logo";
import { cn } from "@/lib/utils";
import {
  menuAutoPublishClient,
  type AutoPublishChannel,
  type AutoPublishRunResult,
} from "@/lib/api/menu-auto-publish.client";

const CHANNELS: Array<{ id: AutoPublishChannel; label: string; logo: string }> = [
  { id: "JUST_EAT", label: "Just Eat", logo: "JUST_EAT" },
  { id: "DELIVEROO", label: "Deliveroo", logo: "DELIVEROO" },
  { id: "UBER_EATS", label: "Uber Eats", logo: "UBER_EATS" },
  { id: "HUBRISE", label: "HubRise", logo: "HUBRISE" },
];

// Shown Monday-first; stored 0 = Sunday … 6 = Saturday.
const DAYS: Array<{ id: number; short: string }> = [
  { id: 1, short: "Mon" },
  { id: 2, short: "Tue" },
  { id: 3, short: "Wed" },
  { id: 4, short: "Thu" },
  { id: 5, short: "Fri" },
  { id: 6, short: "Sat" },
  { id: 0, short: "Sun" },
];

const TIMEZONES = ["Europe/London", "Europe/Dublin", "Asia/Dubai", "Asia/Riyadh", "Asia/Qatar", "Asia/Kuwait", "Asia/Bahrain", "Asia/Muscat"];

function fmtWhen(iso: string | null | undefined, tz: string) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

interface Props {
  open: boolean;
  menuId: string;
  menuName: string;
  onClose: () => void;
}

export function AutoPublishModal({ open, menuId, menuName, onClose }: Props) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["menu-auto-publish", menuId],
    queryFn: () => menuAutoPublishClient.get(menuId),
    enabled: open && !!menuId,
  });

  const [enabled, setEnabled] = useState(true);
  const [channels, setChannels] = useState<AutoPublishChannel[]>(["JUST_EAT"]);
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [times, setTimes] = useState<string[]>(["10:45"]);
  const [timezone, setTimezone] = useState("Europe/London");
  const [lastRun, setLastRun] = useState<AutoPublishRunResult[] | null>(null);

  useEffect(() => {
    if (!open || !q.data) return;
    const s = q.data.schedule;
    setEnabled(s?.enabled ?? true);
    setChannels(s?.channels?.length ? s.channels : ["JUST_EAT"]);
    setDays(s?.days?.length ? s.days : [0, 1, 2, 3, 4, 5, 6]);
    setTimes(s?.times?.length ? s.times : ["10:45"]);
    setTimezone(s?.timezone ?? q.data.defaultTimezone ?? "Europe/London");
    setLastRun(s?.lastResult ?? null);
  }, [open, q.data]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["menu-auto-publish", menuId] });

  const save = useMutation({
    mutationFn: () => menuAutoPublishClient.save(menuId, { enabled, channels, days, times, timezone }),
    onSuccess: (s) => {
      toast.success(
        s.enabled && s.nextRunAt
          ? `Auto publish saved — next run ${fmtWhen(s.nextRunAt, s.timezone)}`
          : "Auto publish saved (switched off)",
      );
      refresh();
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? "Could not save the schedule"),
  });

  const runNow = useMutation({
    mutationFn: async () => {
      // Run what is on screen, not a stale saved copy.
      await menuAutoPublishClient.save(menuId, { enabled, channels, days, times, timezone });
      return menuAutoPublishClient.runNow(menuId);
    },
    onSuccess: (r) => {
      setLastRun(r.results);
      const ok = r.results.filter((x) => x.ok).length;
      if (r.status === "ok") toast.success(`Published to ${ok} of ${r.results.length}`);
      else toast.error(`${ok} of ${r.results.length} published — see the details below`);
      refresh();
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? "Run failed"),
  });

  const remove = useMutation({
    mutationFn: () => menuAutoPublishClient.remove(menuId),
    onSuccess: () => {
      toast.success("Auto publish removed");
      refresh();
      onClose();
    },
  });

  const validTimes = useMemo(() => times.filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)), [times]);
  const canSave = !enabled || (channels.length > 0 && days.length > 0 && validTimes.length > 0);

  if (!open) return null;
  const schedule = q.data?.schedule ?? null;
  const targets = q.data?.targets;

  const toggleChannel = (c: AutoPublishChannel) =>
    setChannels((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  const toggleDay = (d: number) => setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 backdrop-blur-sm sm:p-4">
      <div className="min-h-full w-full max-w-2xl bg-white shadow-2xl sm:my-8 sm:min-h-0 sm:rounded-xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-zinc-100 bg-white px-5 py-4 sm:rounded-t-xl">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
              <CalendarClock className="h-4 w-4 text-orange-500" /> Auto publish
            </h2>
            <p className="truncate text-xs text-zinc-500">{menuName}</p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {q.isPending ? (
          <div className="flex items-center justify-center py-16 text-sm text-zinc-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : q.isError ? (
          <p className="py-16 text-center text-sm text-red-600">Could not load the schedule.</p>
        ) : (
          <div className="space-y-6 p-5">
            <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2.5">
              <span>
                <span className="block text-sm font-semibold text-zinc-900">Publish automatically</span>
                <span className="block text-xs text-zinc-500">
                  Re-publishes this menu on the days and times below — no one has to press Publish.
                </span>
              </span>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-5 w-5 accent-orange-500"
              />
            </label>

            <section className={cn(!enabled && "pointer-events-none opacity-50")}>
              <h3 className="mb-2 text-sm font-semibold text-zinc-900">Channels</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {CHANNELS.map((c) => {
                  const on = channels.includes(c.id);
                  const where = targets?.[c.id] ?? [];
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleChannel(c.id)}
                      className={cn(
                        "flex items-start gap-3 rounded-lg border p-3 text-left transition",
                        on ? "border-orange-400 bg-orange-50/60 ring-1 ring-orange-300" : "border-zinc-200 hover:border-zinc-300",
                      )}
                    >
                      <PlatformLogo platform={c.logo} size={28} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-zinc-900">{c.label}</span>
                        <span
                          className="block truncate text-xs text-zinc-500"
                          title={where.map((w) => w.locationName ?? "this location").join(", ")}
                        >
                          {c.id === "HUBRISE"
                            ? "One catalog push"
                            : where.length
                              ? `Publishes to: ${where.map((w) => w.locationName ?? "this location").join(", ")}`
                              : "Not published here yet"}
                        </span>
                      </span>
                      <input type="checkbox" readOnly checked={on} className="mt-1 h-4 w-4 accent-orange-500" />
                    </button>
                  );
                })}
              </div>
              {channels.includes("JUST_EAT") && (
                <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Just Eat: a fresh publish restores order injection when it drops. Just Eat processes the menu in
                  the background — the result appears in Logs a few minutes later.
                </p>
              )}
            </section>

            <section className={cn(!enabled && "pointer-events-none opacity-50")}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-zinc-900">Days</h3>
                <div className="flex gap-1.5 text-xs">
                  {(
                    [
                      ["Every day", [0, 1, 2, 3, 4, 5, 6]],
                      ["Weekdays", [1, 2, 3, 4, 5]],
                      ["Weekends", [0, 6]],
                    ] as const
                  ).map(([label, set]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setDays([...set])}
                      className="rounded-full bg-zinc-100 px-2.5 py-1 font-medium text-zinc-600 hover:bg-zinc-200"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {DAYS.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => toggleDay(d.id)}
                    className={cn(
                      "h-10 w-14 rounded-lg text-sm font-semibold",
                      days.includes(d.id) ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200",
                    )}
                  >
                    {d.short}
                  </button>
                ))}
              </div>
            </section>

            <section className={cn(!enabled && "pointer-events-none opacity-50")}>
              <h3 className="mb-2 text-sm font-semibold text-zinc-900">Times</h3>
              <div className="flex flex-wrap items-center gap-2">
                {times.map((t, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 py-1 pl-2 pr-1">
                    <Clock className="h-3.5 w-3.5 text-zinc-400" />
                    <input
                      type="time"
                      value={t}
                      onChange={(e) => setTimes((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                      className="bg-transparent text-sm outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setTimes((prev) => prev.filter((_, j) => j !== i))}
                      className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600"
                      aria-label="Remove time"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => setTimes((prev) => [...prev, "16:45"])}
                  disabled={times.length >= 12}
                  className="inline-flex items-center gap-1 rounded-lg border border-dashed border-zinc-300 px-2.5 py-1.5 text-sm font-medium text-zinc-600 hover:border-zinc-400"
                >
                  <Plus className="h-3.5 w-3.5" /> Add time
                </button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                Times are in
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-xs text-zinc-700"
                >
                  {[...new Set([timezone, ...TIMEZONES])].map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
                <span>— tip: publish shortly before each service (e.g. 10:45 and 16:45).</span>
              </div>
            </section>

            {schedule && (
              <section className="rounded-lg bg-zinc-50 p-3 text-sm">
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  <p>
                    <span className="text-zinc-500">Next run:</span>{" "}
                    <span className="font-semibold text-zinc-900">
                      {schedule.enabled ? fmtWhen(schedule.nextRunAt, schedule.timezone) : "Off"}
                    </span>
                  </p>
                  <p>
                    <span className="text-zinc-500">Last run:</span>{" "}
                    <span className="font-semibold text-zinc-900">{fmtWhen(schedule.lastRunAt, schedule.timezone)}</span>
                    {schedule.lastStatus && (
                      <span
                        className={cn(
                          "ml-2 rounded px-1.5 py-0.5 text-[11px] font-bold uppercase",
                          schedule.lastStatus === "ok"
                            ? "bg-emerald-100 text-emerald-800"
                            : schedule.lastStatus === "partial"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-red-100 text-red-800",
                        )}
                      >
                        {schedule.lastStatus}
                      </span>
                    )}
                  </p>
                </div>
                {lastRun && lastRun.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {lastRun.map((r, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs">
                        {r.ok ? (
                          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                        ) : (
                          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
                        )}
                        <span className="text-zinc-700">
                          <span className="font-semibold">{CHANNELS.find((c) => c.id === r.channel)?.label ?? r.channel}</span>
                          {r.locationName ? ` · ${r.locationName}` : ""} — {r.message}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {enabled && !canSave && (
              <p className="flex items-center gap-1.5 text-xs text-red-600">
                <AlertTriangle className="h-3.5 w-3.5" /> Pick at least one channel, one day and one time.
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 pt-4">
              <div>
                {schedule && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => confirm("Remove auto publish for this menu?") && remove.mutate()}
                    disabled={remove.isPending}
                    className="text-zinc-500 hover:text-red-600"
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" /> Remove
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => runNow.mutate()}
                  disabled={runNow.isPending || !canSave || channels.length === 0}
                  title="Save and publish to the chosen channels right now"
                >
                  {runNow.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
                  Run now
                </Button>
                <Button type="button" onClick={() => save.mutate()} disabled={save.isPending || !canSave}>
                  {save.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                  Save schedule
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
