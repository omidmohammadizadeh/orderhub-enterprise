"use client";

// The team: who can be booked, when they work, what they do and at what
// price, and when they're off. Hours here are what the diary and the
// booking page offer — nobody is bookable outside them, and never while
// the shop itself is shut.

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Archive, CalendarOff, Globe2, Plus, Trash2, UserPlus, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/use-currency";
import {
  addDays,
  apiError,
  salonClient,
  shopIso,
  todayIn,
  type SalonService,
  type SalonStaff,
  type WeeklyHours,
} from "@/lib/api/salon.client";
import { SalonFrame, inputBase, inputCls, staffWord, useSalonLocation, useSalonServices, useSalonStaff } from "@/components/salon/salon-shared";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const COLOURS = ["#f97316", "#0ea5e9", "#22c55e", "#a855f7", "#ef4444", "#eab308", "#14b8a6", "#ec4899"];

export default function SalonTeamPage() {
  const { settings } = useSalonLocation();
  const trade = settings.data?.settings.trade;
  return (
    <SalonFrame title={staffWord(trade, true)} subtitle="Who can be booked, their hours, and their time off.">
      <Team />
    </SalonFrame>
  );
}

function Team() {
  const qc = useQueryClient();
  const { locationId, settings } = useSalonLocation();
  const tz = settings.data?.timezone ?? "Europe/London";
  const trade = settings.data?.settings.trade;
  const staffQ = useSalonStaff(locationId);
  const services = useSalonServices(locationId);
  const [editing, setEditing] = useState<SalonStaff | "new" | null>(null);
  const [offFor, setOffFor] = useState<SalonStaff | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["salon", "staff", locationId] });

  const timeOff = useQuery({
    queryKey: ["salon", "timeoff", locationId, "upcoming"],
    queryFn: () => salonClient.timeOff(locationId!, new Date().toISOString(), new Date(Date.now() + 120 * 86_400_000).toISOString()),
    enabled: !!locationId,
  });
  const removeOff = useMutation({
    mutationFn: (id: string) => salonClient.removeTimeOff(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["salon", "timeoff"] }),
    onError: (e) => toast.error(apiError(e, "Couldn't remove")),
  });

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button onClick={() => setEditing("new")}>
          <UserPlus className="h-4 w-4" aria-hidden /> Add {staffWord(trade).toLowerCase()}
        </Button>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {(staffQ.data ?? []).map((s) => (
          <li key={s.id} className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-card-sm">
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-full text-sm font-bold text-white" style={{ background: s.colour }}>
                {s.name.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-zinc-900">{s.name}</p>
                <p className="truncate text-xs text-zinc-500">{s.title ?? staffWord(trade)}</p>
              </div>
              {s.bookableOnline && <Globe2 className="h-4 w-4 text-sky-600" aria-label="Bookable online" />}
            </div>
            <p className="mt-3 text-xs text-zinc-600">{hoursSummary(s.weeklyHours)}</p>
            <p className="mt-1 text-xs text-zinc-500">
              {s.serviceIds.length ? `${s.serviceIds.length} services` : "Does everything"}
              {s.commissionPercent != null ? ` · ${s.commissionPercent}% commission` : ""}
              {!s.acceptsWalkIns ? " · no walk-ins" : ""}
            </p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(s)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOffFor(s)}>
                <CalendarOff className="h-3.5 w-3.5" aria-hidden /> Time off
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-800">Coming up: time off</h2>
        {(timeOff.data ?? []).length === 0 ? (
          <p className="text-sm text-zinc-500">Nobody has time off booked.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 rounded-2xl border border-zinc-200 bg-white">
            {timeOff.data!.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.staff.colour }} aria-hidden />
                <span className="font-medium text-zinc-900">{t.staff.name}</span>
                <span className="text-zinc-600">
                  {fmt(t.startsAt, tz)} → {fmt(t.endsAt, tz)}
                </span>
                {t.reason && <span className="truncate text-zinc-500">· {t.reason}</span>}
                <button
                  type="button"
                  aria-label="Remove time off"
                  onClick={() => removeOff.mutate(t.id)}
                  className="ml-auto grid h-9 w-9 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing && locationId && (
        <StaffEditor
          locationId={locationId}
          staff={editing === "new" ? null : editing}
          services={services.data ?? []}
          count={staffQ.data?.length ?? 0}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {offFor && (
        <TimeOffForm
          staff={offFor}
          tz={tz}
          onClose={() => setOffFor(null)}
          onSaved={() => {
            setOffFor(null);
            qc.invalidateQueries({ queryKey: ["salon", "timeoff"] });
          }}
        />
      )}
    </div>
  );
}

function fmt(iso: string, tz: string) {
  return new Date(iso).toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function hoursSummary(h: WeeklyHours): string {
  const on = DAYS.filter((d) => (h[d]?.length ?? 0) > 0);
  if (on.length === 0) return "Follows the shop's opening hours";
  return on.map((d) => `${d.slice(0, 3)} ${h[d]!.map((s) => `${s.from}–${s.to}`).join(", ")}`).join(" · ");
}

function HoursEditor({ value, onChange }: { value: WeeklyHours; onChange: (v: WeeklyHours) => void }) {
  const set = (d: string, slots: Array<{ from: string; to: string }>) => {
    const next = { ...value };
    if (slots.length) next[d] = slots;
    else delete next[d];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {DAYS.map((d) => {
        const slots = value[d] ?? [];
        return (
          <div key={d} className="flex flex-wrap items-center gap-2">
            <label className="flex w-28 items-center gap-2 text-sm capitalize text-zinc-800">
              <input
                type="checkbox"
                checked={slots.length > 0}
                onChange={(e) => set(d, e.target.checked ? [{ from: "09:00", to: "18:00" }] : [])}
                className="h-4 w-4 accent-orange-500"
              />
              {d}
            </label>
            {slots.length === 0 ? (
              <span className="text-xs text-zinc-400">Off</span>
            ) : (
              slots.map((s, i) => (
                <span key={i} className="inline-flex items-center gap-1">
                  <input
                    type="time"
                    aria-label={`${d} start`}
                    value={s.from}
                    onChange={(e) => set(d, slots.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))}
                    className="h-9 rounded-lg border border-zinc-200 px-2 text-sm"
                  />
                  –
                  <input
                    type="time"
                    aria-label={`${d} end`}
                    value={s.to}
                    onChange={(e) => set(d, slots.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))}
                    className="h-9 rounded-lg border border-zinc-200 px-2 text-sm"
                  />
                  {slots.length > 1 && (
                    <button type="button" aria-label="Remove this shift" onClick={() => set(d, slots.filter((_, j) => j !== i))} className="grid h-8 w-8 place-items-center rounded text-zinc-400 hover:text-red-600">
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </span>
              ))
            )}
            {slots.length > 0 && slots.length < 3 && (
              <button
                type="button"
                onClick={() => set(d, [...slots, { from: "14:00", to: "18:00" }])}
                className="text-xs font-medium text-orange-600 hover:text-orange-700"
              >
                + split shift
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StaffEditor({
  locationId,
  staff,
  services,
  count,
  onClose,
  onSaved,
}: {
  locationId: string;
  staff: SalonStaff | null;
  services: SalonService[];
  count: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { symbol } = useCurrency();
  const [name, setName] = useState(staff?.name ?? "");
  const [title, setTitle] = useState(staff?.title ?? "");
  const [bio, setBio] = useState(staff?.bio ?? "");
  const [colour, setColour] = useState(staff?.colour ?? COLOURS[count % COLOURS.length]!);
  const [online, setOnline] = useState(staff?.bookableOnline ?? true);
  const [walkIns, setWalkIns] = useState(staff?.acceptsWalkIns ?? true);
  const [ownHours, setOwnHours] = useState(Object.keys(staff?.weeklyHours ?? {}).length > 0);
  const [hours, setHours] = useState<WeeklyHours>(
    staff && Object.keys(staff.weeklyHours).length
      ? staff.weeklyHours
      : { monday: [{ from: "09:00", to: "18:00" }], tuesday: [{ from: "09:00", to: "18:00" }], wednesday: [{ from: "09:00", to: "18:00" }], thursday: [{ from: "09:00", to: "18:00" }], friday: [{ from: "09:00", to: "18:00" }], saturday: [{ from: "09:00", to: "17:00" }] },
  );
  const [doesAll, setDoesAll] = useState(!staff || staff.serviceIds.length === 0);
  const [serviceIds, setServiceIds] = useState<string[]>(staff?.serviceIds ?? []);
  const [prices, setPrices] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(staff?.priceOverrides ?? {}).map(([k, v]) => [k, String(v)])),
  );
  const [commission, setCommission] = useState(staff?.commissionPercent != null ? String(staff.commissionPercent) : "");

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const body = (): Partial<SalonStaff> => ({
    name: name.trim(),
    title: title.trim() || null,
    bio: bio.trim() || null,
    colour,
    bookableOnline: online,
    acceptsWalkIns: walkIns,
    weeklyHours: ownHours ? hours : {},
    serviceIds: doesAll ? [] : serviceIds,
    priceOverrides: Object.fromEntries(
      Object.entries(prices)
        .filter(([, v]) => v.trim() !== "" && Number.isFinite(Number(v)))
        .map(([k, v]) => [k, Number(v)]),
    ),
    commissionPercent: commission.trim() === "" ? null : Number(commission),
  });
  const save = useMutation({
    mutationFn: () => (staff ? salonClient.updateStaff(staff.id, body()) : salonClient.createStaff(locationId, body())),
    onSuccess: () => {
      toast.success(staff ? "Saved" : `${name.trim()} added`);
      onSaved();
    },
    onError: (e) => toast.error(apiError(e, "Couldn't save")),
  });
  const archive = useMutation({
    mutationFn: () => salonClient.archiveStaff(staff!.id),
    onSuccess: () => {
      toast.success(`${staff!.name} archived — their history stays`);
      onSaved();
    },
    onError: (e) => toast.error(apiError(e, "Couldn't archive")),
  });

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={staff ? `Edit ${staff.name}` : "New team member"}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 cursor-default bg-zinc-950/40" />
      <aside className="relative flex h-full w-full max-w-xl flex-col bg-white shadow-2xl motion-safe:animate-slide-in-right">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-lg font-semibold text-zinc-900">{staff ? staff.name : "New team member"}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-10 w-10 place-items-center rounded-full text-zinc-400 hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              <span className="text-sm font-medium text-zinc-800">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} mt-1`} />
            </label>
            <label>
              <span className="text-sm font-medium text-zinc-800">Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Senior barber" className={`${inputCls} mt-1`} />
            </label>
            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-zinc-800">About (shown when booking online)</span>
              <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={2} placeholder="Fades and beard work, 8 years behind the chair." className={`${inputCls} mt-1 h-auto py-2`} />
            </label>
          </div>
          <div>
            <p className="text-sm font-medium text-zinc-800">Colour in the diary</p>
            <div className="mt-1 flex gap-2">
              {COLOURS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Colour ${c}`}
                  aria-pressed={colour === c}
                  onClick={() => setColour(c)}
                  className={`h-8 w-8 rounded-full ring-offset-2 ${colour === c ? "ring-2 ring-zinc-900" : ""}`}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} className="h-4 w-4 accent-orange-500" />
              Can be booked online
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input type="checkbox" checked={walkIns} onChange={(e) => setWalkIns(e.target.checked)} className="h-4 w-4 accent-orange-500" />
              Takes walk-ins from the queue
            </label>
          </div>

          <fieldset className="space-y-3 rounded-2xl border border-zinc-200 p-4">
            <legend className="px-1 text-sm font-semibold text-zinc-800">Working hours</legend>
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input type="checkbox" checked={!ownHours} onChange={(e) => setOwnHours(!e.target.checked)} className="h-4 w-4 accent-orange-500" />
              Same as the shop&rsquo;s opening hours
            </label>
            {ownHours && <HoursEditor value={hours} onChange={setHours} />}
          </fieldset>

          <fieldset className="space-y-3 rounded-2xl border border-zinc-200 p-4">
            <legend className="px-1 text-sm font-semibold text-zinc-800">Services and prices</legend>
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input type="checkbox" checked={doesAll} onChange={(e) => setDoesAll(e.target.checked)} className="h-4 w-4 accent-orange-500" />
              Does every service
            </label>
            <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-100">
              {services.map((s) => {
                const on = doesAll || serviceIds.includes(s.id);
                return (
                  <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={`Does ${s.name}`}
                      disabled={doesAll}
                      checked={on}
                      onChange={(e) => setServiceIds((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id)))}
                      className="h-4 w-4 accent-orange-500"
                    />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <label className="flex items-center gap-1 text-xs text-zinc-500">
                      {symbol}
                      <span className="sr-only">Their price for {s.name}</span>
                      <input
                        inputMode="decimal"
                        disabled={!on}
                        placeholder={String(s.price)}
                        value={prices[s.id] ?? ""}
                        onChange={(e) => setPrices((p) => ({ ...p, [s.id]: e.target.value.replace(/[^\d.]/g, "") }))}
                        className="h-8 w-20 rounded-md border border-zinc-200 px-2 text-right text-sm"
                      />
                    </label>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-zinc-500">Leave a price blank to use the price list.</p>
          </fieldset>

          <label className="block">
            <span className="text-sm font-medium text-zinc-800">Commission on services (%)</span>
            <input inputMode="decimal" value={commission} onChange={(e) => setCommission(e.target.value.replace(/[^\d.]/g, ""))} placeholder="e.g. 40" className={`${inputBase} mt-1 w-32`} />
            <span className="mt-1 block text-xs text-zinc-500">Only used in Reports — nothing is paid out automatically.</span>
          </label>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-5 py-4">
          {staff ? (
            <Button variant="ghost" className="text-red-600 hover:bg-red-50" loading={archive.isPending} onClick={() => confirm(`Archive ${staff.name}?`) && archive.mutate()}>
              <Archive className="h-4 w-4" aria-hidden /> Archive
            </Button>
          ) : (
            <span />
          )}
          <Button disabled={!name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            {staff ? "Save" : "Add"}
          </Button>
        </div>
      </aside>
    </div>
  );
}

function TimeOffForm({ staff, tz, onClose, onSaved }: { staff: SalonStaff; tz: string; onClose: () => void; onSaved: () => void }) {
  const today = todayIn(tz);
  const [fromDate, setFromDate] = useState(today);
  const [fromTime, setFromTime] = useState("00:00");
  const [toDate, setToDate] = useState(today);
  const [toTime, setToTime] = useState("23:59");
  const [allDay, setAllDay] = useState(true);
  const [reason, setReason] = useState("");
  const add = useMutation({
    mutationFn: (force: boolean) =>
      salonClient.addTimeOff({
        staffId: staff.id,
        startsAt: shopIso(fromDate, allDay ? "00:00" : fromTime, tz),
        endsAt: allDay ? shopIso(addDays(toDate, 1), "00:00", tz) : shopIso(toDate, toTime, tz),
        reason: reason.trim() || undefined,
        force,
      }),
    onSuccess: () => {
      toast.success(`${staff.name}'s time off saved`);
      onSaved();
    },
    onError: (e) => {
      const msg = apiError(e, "Couldn't save");
      if (/book it anyway/.test(msg) && confirm(`${msg}\n\nSave the time off anyway? Their appointments stay in the diary to move.`)) add.mutate(true);
      else toast.error(msg);
    },
  });
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="Time off">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 cursor-default bg-zinc-950/50" />
      <div className="relative w-full max-w-md space-y-4 rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl">
        <h2 className="text-lg font-semibold text-zinc-900">Time off for {staff.name}</h2>
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="h-4 w-4 accent-orange-500" />
          Whole days
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className="text-xs text-zinc-600">From</span>
            <input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); if (e.target.value > toDate) setToDate(e.target.value); }} className={`${inputCls} mt-1`} />
            {!allDay && <input type="time" aria-label="From time" value={fromTime} onChange={(e) => setFromTime(e.target.value)} className={`${inputCls} mt-1`} />}
          </label>
          <label>
            <span className="text-xs text-zinc-600">Until</span>
            <input type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} className={`${inputCls} mt-1`} />
            {!allDay && <input type="time" aria-label="Until time" value={toTime} onChange={(e) => setToTime(e.target.value)} className={`${inputCls} mt-1`} />}
          </label>
        </div>
        <label className="block">
          <span className="text-xs text-zinc-600">Reason (only staff see it)</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Holiday" className={`${inputCls} mt-1`} />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={add.isPending} onClick={() => add.mutate(false)}>
            <Plus className="h-4 w-4" aria-hidden /> Save time off
          </Button>
        </div>
      </div>
    </div>
  );
}
