"use client";

// Book someone in from the diary: who, what, with whom, when.
//
// The time list is the barber's live free starts for exactly these services
// (add-ons included), so what's offered is what will save. "Book it anyway"
// lets the shop squeeze someone in at any time — barbers do — and the
// server records that it was forced.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Check, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/use-currency";
import {
  apiError,
  longDate,
  minutesLabel,
  salonClient,
  shopIso,
  shopTime,
  type AppointmentSource,
  type SalonService,
  type SalonStaff,
  type WantedService,
} from "@/lib/api/salon.client";
import { inputCls, staffWord } from "./salon-shared";
import type { SalonTrade } from "@/lib/api/salon.client";

export function ServicePicker({
  services,
  value,
  onChange,
  staff,
}: {
  services: SalonService[];
  value: WantedService[];
  onChange: (v: WantedService[]) => void;
  staff?: SalonStaff | null;
}) {
  const { money } = useCurrency();
  const [q, setQ] = useState("");
  const active = services.filter((s) => s.isActive);
  const shown = active.filter((s) => !q.trim() || `${s.name} ${s.category}`.toLowerCase().includes(q.trim().toLowerCase()));
  const groups = useMemo(() => {
    const m = new Map<string, SalonService[]>();
    for (const s of shown) m.set(s.category, [...(m.get(s.category) ?? []), s]);
    return Array.from(m.entries());
  }, [shown]);
  const picked = (id: string) => value.find((v) => v.serviceId === id);
  const toggle = (s: SalonService) =>
    onChange(picked(s.id) ? value.filter((v) => v.serviceId !== s.id) : [...value, { serviceId: s.id, addonIds: [] }]);
  const toggleAddon = (sid: string, aid: string) =>
    onChange(
      value.map((v) =>
        v.serviceId !== sid
          ? v
          : { ...v, addonIds: v.addonIds?.includes(aid) ? v.addonIds.filter((x) => x !== aid) : [...(v.addonIds ?? []), aid] },
      ),
    );
  const can = (s: SalonService) => !staff || staff.serviceIds.length === 0 || staff.serviceIds.includes(s.id);
  return (
    <div className="space-y-2">
      {active.length > 8 && (
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden />
          <span className="sr-only">Search services</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search services…" className={`${inputCls} pl-9`} />
        </label>
      )}
      <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
        {groups.map(([cat, list]) => (
          <div key={cat}>
            <p className="mb-1 text-xs font-semibold text-zinc-500">{cat}</p>
            <ul className="space-y-1">
              {list.map((s) => {
                const p = picked(s.id);
                const price = staff?.priceOverrides?.[s.id] ?? s.price;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => toggle(s)}
                      aria-pressed={!!p}
                      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                        p ? "border-orange-400 bg-orange-50" : "border-zinc-200 hover:border-zinc-300"
                      } ${can(s) ? "" : "opacity-50"}`}
                    >
                      <span className={`grid h-5 w-5 shrink-0 place-items-center rounded border ${p ? "border-orange-500 bg-orange-500 text-white" : "border-zinc-300"}`}>
                        {p && <Check className="h-3.5 w-3.5" aria-hidden />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-zinc-900">{s.name}</span>
                        <span className="text-xs text-zinc-500">
                          {minutesLabel(s.durationMins)}
                          {!can(s) && " · not done by this person"}
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums text-zinc-700">
                        {s.priceFrom ? "from " : ""}
                        {money(price)}
                      </span>
                    </button>
                    {p && s.addons.length > 0 && (
                      <div className="ml-8 mt-1 flex flex-wrap gap-1.5">
                        {s.addons.map((a) => {
                          const on = p.addonIds?.includes(a.id);
                          return (
                            <button
                              key={a.id}
                              type="button"
                              onClick={() => toggleAddon(s.id, a.id)}
                              aria-pressed={on}
                              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                                on ? "border-orange-500 bg-orange-500 text-white" : "border-zinc-200 text-zinc-700 hover:border-zinc-400"
                              }`}
                            >
                              + {a.name} · {money(a.price)}
                              {a.durationMins ? ` · ${a.durationMins}m` : ""}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {groups.length === 0 && <p className="py-4 text-center text-sm text-zinc-500">No services match.</p>}
      </div>
    </div>
  );
}

export function NewAppointment({
  locationId,
  tz,
  trade,
  services,
  staff,
  initial,
  onClose,
  onBooked,
}: {
  locationId: string;
  tz: string;
  trade: SalonTrade;
  services: SalonService[];
  staff: SalonStaff[];
  initial: { date: string; time?: string; staffId?: string };
  onClose: () => void;
  onBooked: (id: string) => void;
}) {
  const { money } = useCurrency();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [q, setQ] = useState("");
  const [wanted, setWanted] = useState<WantedService[]>([]);
  const [staffId, setStaffId] = useState<string>(initial.staffId ?? staff[0]?.id ?? "");
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState<string | null>(initial.time ?? null);
  const [force, setForce] = useState(false);
  const [notes, setNotes] = useState("");
  const [source, setSource] = useState<AppointmentSource>("PHONE");

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const clients = useQuery({
    queryKey: ["salon", "clients", locationId, q],
    queryFn: () => salonClient.clients(locationId, q),
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
  });

  const slots = useQuery({
    queryKey: ["salon", "availability", locationId, date, staffId, JSON.stringify(wanted)],
    queryFn: () => salonClient.availability({ locationId, date, services: wanted, staffId }),
    enabled: wanted.length > 0 && !!staffId && !!date,
  });
  const free = (slots.data?.slots ?? []).map((s) => shopTime(s.startsAt, tz));
  const timeFree = !!time && free.includes(time);

  const person = staff.find((s) => s.id === staffId) ?? null;
  const book = useMutation({
    mutationFn: () =>
      salonClient.book({
        locationId,
        staffId,
        startsAt: shopIso(date, time!, tz),
        services: wanted,
        customerName: name.trim(),
        customerPhone: phone.trim() || null,
        customerEmail: email.trim() || null,
        notes: notes.trim() || null,
        source,
        force: force || !timeFree,
      }),
    onSuccess: (a) => {
      toast.success(`Booked ${a.customerName} with ${person?.name ?? "them"} at ${time}${email.trim() ? " — confirmation emailed" : ""}`);
      onBooked(a.id);
    },
    onError: (e) => toast.error(apiError(e, "Couldn't book that")),
  });

  const ready = name.trim() && wanted.length > 0 && staffId && date && time;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="New appointment">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 cursor-default bg-zinc-950/40 motion-safe:animate-fade-in" />
      <aside className="relative flex h-full w-full max-w-lg flex-col bg-white shadow-2xl motion-safe:animate-slide-in-right">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-lg font-semibold text-zinc-900">New appointment</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-10 w-10 place-items-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>
        <form
          className="flex-1 space-y-5 overflow-y-auto px-5 py-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) book.mutate();
          }}
        >
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-zinc-800">Client</h3>
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden />
              <span className="sr-only">Find a returning client</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a returning client (name or phone)…" className={`${inputCls} pl-9`} />
            </label>
            {q.trim().length >= 2 && (clients.data?.length ?? 0) > 0 && (
              <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
                {clients.data!.map((c, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-zinc-50"
                      onClick={() => {
                        setName(c.name);
                        setPhone(c.phone ?? "");
                        setEmail(c.email ?? "");
                        setQ("");
                      }}
                    >
                      <span className="font-medium text-zinc-900">{c.name}</span>
                      <span className="text-xs text-zinc-500">{c.phone ?? c.email}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="sm:col-span-2">
                <span className="sr-only">Name</span>
                <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" autoComplete="off" className={inputCls} />
              </label>
              <label>
                <span className="sr-only">Phone</span>
                <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" inputMode="tel" autoComplete="off" className={inputCls} />
              </label>
              <label>
                <span className="sr-only">Email</span>
                <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (for confirmation)" type="email" spellCheck={false} autoComplete="off" className={inputCls} />
              </label>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-zinc-800">Services</h3>
            <ServicePicker services={services} value={wanted} onChange={setWanted} staff={person} />
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-zinc-800">With</h3>
            <div className="flex flex-wrap gap-2">
              {staff.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStaffId(s.id)}
                  aria-pressed={staffId === s.id}
                  className={`inline-flex h-9 items-center gap-2 rounded-full border px-3 text-sm font-medium transition ${
                    staffId === s.id ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 text-zinc-700 hover:border-zinc-400"
                  }`}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.colour }} aria-hidden />
                  {s.name}
                </button>
              ))}
              {staff.length === 0 && <p className="text-sm text-zinc-500">Add a {staffWord(trade).toLowerCase()} on the Team tab first.</p>}
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-end justify-between gap-2">
              <h3 className="text-sm font-semibold text-zinc-800">When</h3>
              <label className="text-xs text-zinc-500">
                <span className="sr-only">Date</span>
                <input type="date" value={date} onChange={(e) => { setDate(e.target.value); setTime(null); }} className="h-9 rounded-lg border border-zinc-200 px-2 text-sm text-zinc-900" />
              </label>
            </div>
            <p className="text-xs text-zinc-500">{longDate(date)}</p>
            {wanted.length === 0 ? (
              <p className="rounded-lg bg-zinc-50 px-3 py-3 text-sm text-zinc-500">Pick a service to see free times.</p>
            ) : slots.isLoading ? (
              <div className="h-20 animate-pulse rounded-lg bg-zinc-100" />
            ) : slots.isError ? (
              <p className="text-sm text-red-600">{apiError(slots.error, "Couldn't load free times")}</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {free.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTime(t)}
                      aria-pressed={time === t}
                      className={`h-9 rounded-lg border px-3 text-sm tabular-nums transition ${
                        time === t ? "border-orange-500 bg-orange-500 font-semibold text-white" : "border-zinc-200 text-zinc-800 hover:border-zinc-400"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                  {free.length === 0 && <p className="text-sm text-zinc-500">No free times that day for these services.</p>}
                </div>
                <p className="text-xs text-zinc-500">
                  {minutesLabel(slots.data?.durationMins ?? 0)} · {money(slots.data?.total ?? 0)}
                </p>
              </>
            )}
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="h-4 w-4 accent-orange-500" />
              Book it anyway at another time
            </label>
            {force && (
              <label className="block">
                <span className="sr-only">Time</span>
                <input type="time" step={300} value={time ?? ""} onChange={(e) => setTime(e.target.value || null)} className="h-10 rounded-lg border border-zinc-200 px-3 text-sm" />
              </label>
            )}
            {time && !timeFree && wanted.length > 0 && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {time} isn&rsquo;t a free slot for {person?.name ?? "them"} — it&rsquo;ll be squeezed in.
              </p>
            )}
          </section>

          <section className="grid gap-2 sm:grid-cols-2">
            <label className="sm:col-span-2">
              <span className="text-sm font-semibold text-zinc-800">Note</span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Grade 1 on the sides, long on top…" className={`${inputCls} mt-1 h-auto py-2`} />
            </label>
            <label>
              <span className="text-sm font-semibold text-zinc-800">How did they book?</span>
              <select value={source} onChange={(e) => setSource(e.target.value as AppointmentSource)} className={`${inputCls} mt-1`}>
                <option value="PHONE">Phone</option>
                <option value="STAFF">In person</option>
                <option value="WALK_IN">Walk-in</option>
                <option value="WHATSAPP">WhatsApp / message</option>
              </select>
            </label>
          </section>
        </form>
        <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-5 py-4">
          <p className="text-sm text-zinc-500">
            {ready ? `${name.trim()} · ${time} · ${person?.name}` : "Name, service and a time"}
          </p>
          <Button onClick={() => ready && book.mutate()} disabled={!ready} loading={book.isPending}>
            Book
          </Button>
        </div>
      </aside>
    </div>
  );
}
