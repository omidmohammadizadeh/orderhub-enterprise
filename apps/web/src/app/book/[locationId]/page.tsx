"use client";

// Guest booking page — the public door into reservations. No login, keyed
// only by the location id in the URL. Mobile first: most bookings come off a
// phone.
//
// Guests → day → time → details, all on one page. The time grid comes from
// /public/slots, which checks every start time on the day against the
// restaurant's hours and free tables in one call, so a guest only ever taps
// a time that will actually book. The confirmation is emailed, so email is
// required.

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import { CalendarPlus, Check, Clock, MapPin, Phone, Users } from "lucide-react";
import {
  publicReservationsClient,
  shiftDate,
  toDateInput,
  type PublicReservation,
} from "@/lib/api/reservations.client";

const STRIP_DAYS = 14;

export default function GuestBookingPage() {
  const params = useParams<{ locationId: string }>();
  const locationId = params?.locationId ?? "";

  const settingsQuery = useQuery({
    queryKey: ["reservations", "public", "settings", locationId],
    queryFn: () => publicReservationsClient.settings(locationId),
    enabled: !!locationId,
    retry: false,
  });
  const settings = settingsQuery.data;

  const today = toDateInput(new Date());
  const [partySize, setPartySize] = useState(2);
  const [date, setDate] = useState(today);
  const [slot, setSlot] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmed, setConfirmed] = useState<PublicReservation | null>(null);

  const maxDate = useMemo(
    () => shiftDate(today, settings?.maxDaysAhead ?? 60),
    [today, settings?.maxDaysAhead],
  );
  const strip = useMemo(
    () =>
      Array.from({ length: Math.min(STRIP_DAYS, (settings?.maxDaysAhead ?? 60) + 1) }, (_, i) =>
        shiftDate(today, i),
      ),
    [today, settings?.maxDaysAhead],
  );

  const slotsQuery = useQuery({
    queryKey: ["reservations", "public", "slots", locationId, date, partySize],
    queryFn: () => publicReservationsClient.slots({ locationId, date, partySize }),
    enabled: !!locationId && !!settings?.onlineEnabled && !!settings?.tableServiceEnabled,
    retry: false,
  });
  const slots = slotsQuery.data?.slots ?? [];
  const groups = useMemo(() => groupSlots(slots), [slots]);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const book = useMutation({
    mutationFn: () =>
      publicReservationsClient.create({
        locationId,
        customerName: name.trim(),
        customerPhone: phone.trim() || null,
        customerEmail: email.trim(),
        partySize,
        startsAt: slot!,
        notes: notes.trim() || null,
        source: "ONLINE",
      }),
    onSuccess: (res) => setConfirmed(res),
    // Someone may have taken the slot while the guest typed — refresh it.
    onError: () => slotsQuery.refetch(),
  });

  if (settingsQuery.isLoading) {
    return (
      <Shell>
        <div className="space-y-3 p-6">
          <div className="h-6 w-2/3 animate-pulse rounded bg-zinc-100" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-zinc-100" />
        </div>
      </Shell>
    );
  }

  if (settingsQuery.isError || !settings) {
    return (
      <Shell>
        <div className="p-6">
          <h1 className="text-lg font-semibold text-zinc-900">We couldn't find that restaurant</h1>
          <p className="mt-2 text-sm text-zinc-600">
            Please check the link you were given, or call the restaurant directly.
          </p>
        </div>
      </Shell>
    );
  }

  const header = <ShopHeader settings={settings} />;

  if (!settings.tableServiceEnabled || !settings.onlineEnabled) {
    return (
      <Shell>
        {header}
        <div className="p-6">
          <p className="text-sm text-zinc-600">
            We're not taking online bookings at the moment.
            {settings.phone ? (
              <>
                {" "}
                Give us a call on{" "}
                <a className="font-semibold text-orange-600" href={`tel:${settings.phone}`}>
                  {settings.phone}
                </a>{" "}
                and we'll find you a table.
              </>
            ) : (
              " Please give us a call and we'll find you a table."
            )}
          </p>
        </div>
      </Shell>
    );
  }

  if (confirmed) {
    const start = new Date(confirmed.startsAt);
    const end = new Date(start.getTime() + confirmed.durationMins * 60_000);
    const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const cal = `https://calendar.google.com/calendar/render?${new URLSearchParams({
      action: "TEMPLATE",
      text: `Table at ${settings.locationName}`,
      dates: `${stamp(start)}/${stamp(end)}`,
      details: `Table for ${confirmed.partySize}. Reference ${confirmed.reference}.`,
      ...(settings.address ? { location: settings.address } : {}),
    })}`;
    return (
      <Shell>
        {header}
        <div className="p-6 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-100 text-emerald-700">
            <Check className="h-7 w-7" aria-hidden />
          </div>
          <h2 className="mt-4 text-2xl font-semibold tracking-tight text-zinc-900">You're booked in</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Thanks {confirmed.customerName.split(" ")[0]} — we've emailed your confirmation to{" "}
            <b className="text-zinc-800">{email.trim()}</b>.
          </p>

          <dl className="mx-auto mt-6 max-w-sm divide-y divide-zinc-100 rounded-2xl border border-zinc-200 text-left text-sm">
            <SummaryRow k="Date">
              {start.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
            </SummaryRow>
            <SummaryRow k="Time">{start.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</SummaryRow>
            <SummaryRow k="Guests">
              {confirmed.partySize} {confirmed.partySize === 1 ? "person" : "people"}
            </SummaryRow>
            <SummaryRow k="Reference">
              <span className="font-mono font-bold tracking-wider">{confirmed.reference}</span>
            </SummaryRow>
          </dl>

          <a
            href={cal}
            target="_blank"
            rel="noreferrer"
            className="mt-6 inline-flex min-h-[48px] items-center gap-2 rounded-full bg-zinc-900 px-5 text-sm font-semibold text-white hover:bg-zinc-800"
          >
            <CalendarPlus className="h-4 w-4" aria-hidden /> Add to calendar
          </a>
          <p className="mt-4 text-xs text-zinc-500">
            Need to change or cancel?{" "}
            {settings.phone ? (
              <>
                Call{" "}
                <a href={`tel:${settings.phone}`} className="font-medium text-orange-600">
                  {settings.phone}
                </a>
              </>
            ) : (
              "Call us"
            )}{" "}
            and quote your reference.
          </p>
        </div>
      </Shell>
    );
  }

  const errorMessage = (book.error as Error | null)?.message;
  const partyOptions = Array.from({ length: Math.min(settings.maxPartySize, 8) }, (_, i) => i + 1);
  const chosen = slot ? new Date(slot) : null;

  return (
    <Shell>
      {header}

      <div className="space-y-7 p-5 sm:p-6">
        {/* 1 — Guests */}
        <Step n={1} title="How many guests?">
          <div className="flex flex-wrap gap-2">
            {partyOptions.map((n) => (
              <Chip
                key={n}
                active={partySize === n}
                onClick={() => {
                  setPartySize(n);
                  setSlot(null);
                }}
                className="w-12"
              >
                {n}
              </Chip>
            ))}
            {settings.maxPartySize > 8 && (
              <select
                aria-label="More guests"
                value={partySize > 8 ? partySize : ""}
                onChange={(e) => {
                  setPartySize(Number(e.target.value));
                  setSlot(null);
                }}
                className={`min-h-[44px] rounded-full border px-3 text-sm font-medium ${
                  partySize > 8 ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 text-zinc-700"
                }`}
              >
                <option value="" disabled>
                  9+
                </option>
                {Array.from({ length: settings.maxPartySize - 8 }, (_, i) => i + 9).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            )}
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            More than {settings.maxPartySize}?{" "}
            {settings.phone ? (
              <a href={`tel:${settings.phone}`} className="font-medium text-orange-600">
                Call us
              </a>
            ) : (
              "Please call us"
            )}
            .
          </p>
        </Step>

        {/* 2 — Day */}
        <Step n={2} title="Pick a day">
          <div className="-mx-5 overflow-x-auto px-5 pb-1 [scrollbar-width:none] sm:-mx-6 sm:px-6 [&::-webkit-scrollbar]:hidden">
            <div className="flex gap-2">
              {strip.map((d) => {
                const dt = new Date(`${d}T12:00:00`);
                const active = d === date;
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => {
                      setDate(d);
                      setSlot(null);
                    }}
                    aria-pressed={active}
                    className={`flex min-h-[68px] w-[60px] shrink-0 flex-col items-center justify-center rounded-2xl border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                      active
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-200 bg-white text-zinc-800 hover:border-zinc-400"
                    }`}
                  >
                    <span className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${active ? "text-orange-300" : "text-zinc-400"}`}>
                      {d === today ? "Today" : dt.toLocaleDateString("en-GB", { weekday: "short" })}
                    </span>
                    <span className="text-lg font-bold tabular-nums leading-tight">{dt.getDate()}</span>
                    <span className={`text-[10px] ${active ? "text-zinc-300" : "text-zinc-400"}`}>
                      {dt.toLocaleDateString("en-GB", { month: "short" })}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
            Another date:
            <input
              type="date"
              value={date}
              min={today}
              max={maxDate}
              onChange={(e) => {
                if (!e.target.value) return;
                setDate(e.target.value);
                setSlot(null);
              }}
              className="min-h-[40px] rounded-full border border-zinc-200 px-3 text-sm text-zinc-700 focus:border-orange-400 focus:outline-none"
            />
          </label>
        </Step>

        {/* 3 — Time */}
        <Step n={3} title="Pick a time">
          {slotsQuery.isLoading ? (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
              {Array.from({ length: 10 }, (_, i) => (
                <div key={i} className="h-11 animate-pulse rounded-xl bg-zinc-100" />
              ))}
            </div>
          ) : slots.length === 0 ? (
            <p className="rounded-xl bg-zinc-50 px-4 py-3 text-sm text-zinc-600">
              No times left on this day — please try another day.
            </p>
          ) : !slots.some((s) => s.available) ? (
            <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
              We're fully booked for {partySize} on this day — please try another day.
            </p>
          ) : (
            <div className="space-y-4">
              {groups.map((g) => (
                <div key={g.label}>
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">{g.label}</div>
                  <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                    {g.slots.map((s) => {
                      const active = slot === s.startsAt;
                      return (
                        <button
                          key={s.startsAt}
                          type="button"
                          disabled={!s.available}
                          onClick={() => setSlot(s.startsAt)}
                          aria-pressed={active}
                          className={`min-h-[44px] rounded-xl border text-sm font-semibold tabular-nums transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                            active
                              ? "border-orange-500 bg-orange-500 text-white shadow-sm"
                              : s.available
                                ? "border-zinc-200 bg-white text-zinc-800 hover:border-orange-400 hover:text-orange-700"
                                : "cursor-not-allowed border-zinc-100 bg-zinc-50 text-zinc-300 line-through"
                          }`}
                        >
                          {new Date(s.startsAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Step>

        {/* 4 — Details */}
        <Step n={4} title="Your details" dim={!slot}>
          {chosen && (
            <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl bg-orange-50 px-4 py-3 text-sm text-orange-900">
              <span className="inline-flex items-center gap-1.5 font-semibold">
                <Clock className="h-4 w-4" aria-hidden />
                {chosen.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ·{" "}
                {chosen.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Users className="h-4 w-4" aria-hidden />
                {partySize} {partySize === 1 ? "guest" : "guests"}
              </span>
            </div>
          )}
          <fieldset disabled={!slot} className="space-y-3 disabled:opacity-50">
            <Field label="Your name">
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className={field} />
            </Field>
            <Field label="Email" hint="Your confirmation is sent here">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                className={field}
              />
            </Field>
            <Field label="Phone">
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="tel"
                autoComplete="tel"
                className={field}
              />
            </Field>
            <Field label="Anything we should know? (optional)">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Allergies, high chair, celebrating something…"
                className={`${field} min-h-[72px]`}
              />
            </Field>
          </fieldset>

          {errorMessage && (
            // The API's guest-facing 400s already read like a host talking —
            // show them word for word.
            <div role="alert" className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
              {errorMessage}
            </div>
          )}

          <button
            type="button"
            onClick={() => book.mutate()}
            disabled={book.isPending || !slot || !name.trim() || !emailOk}
            className="mt-5 min-h-[52px] w-full rounded-full bg-orange-500 px-4 text-base font-semibold text-white shadow-sm transition hover:bg-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 disabled:opacity-40"
          >
            {book.isPending ? "Booking…" : slot ? "Confirm booking" : "Pick a time first"}
          </button>
          <p className="mt-3 text-center text-[11px] text-zinc-400">
            Tables are held for {settings.slotMinutes} minutes. Bookings need {settings.leadTimeMins} minutes' notice.
          </p>
        </Step>
      </div>
    </Shell>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────

const field =
  "w-full min-h-[48px] rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-base text-zinc-900 placeholder:text-zinc-400 focus:border-orange-400 focus:outline-none focus:ring-4 focus:ring-orange-100 sm:text-sm";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_#fff7ed,_#fafafa_55%)] px-3 py-6 sm:px-4 sm:py-10">
      <div className="mx-auto w-full max-w-lg overflow-hidden rounded-3xl border border-zinc-200/80 bg-white shadow-xl shadow-zinc-200/50">
        {children}
      </div>
      <p className="mt-6 text-center text-[11px] text-zinc-400">Bookings by Order Hub</p>
    </div>
  );
}

function ShopHeader({
  settings,
}: {
  settings: { locationName: string; logoUrl?: string | null; address?: string | null; phone?: string | null };
}) {
  return (
    <div className="bg-zinc-950 px-5 py-6 text-white sm:px-6">
      <div className="flex items-center gap-3">
        {settings.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={settings.logoUrl} alt="" width={48} height={48} className="h-12 w-12 rounded-xl bg-white object-contain" />
        ) : (
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-orange-500 text-lg font-bold">
            {settings.locationName.slice(0, 1)}
          </div>
        )}
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-orange-400">Book a table</div>
          <h1 className="truncate text-xl font-semibold tracking-tight">{settings.locationName}</h1>
        </div>
      </div>
      {(settings.address || settings.phone) && (
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
          {settings.address && (
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5" aria-hidden /> {settings.address}
            </span>
          )}
          {settings.phone && (
            <a href={`tel:${settings.phone}`} className="inline-flex items-center gap-1.5 hover:text-white">
              <Phone className="h-3.5 w-3.5" aria-hidden /> {settings.phone}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function Step({
  n,
  title,
  dim,
  children,
}: {
  n: number;
  title: string;
  dim?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={dim ? "opacity-90" : ""}>
      <h2 className="mb-3 flex items-center gap-2.5 text-base font-semibold text-zinc-900">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-zinc-900 text-[11px] font-bold text-white">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Chip({
  active,
  onClick,
  className = "",
  children,
}: {
  active: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-[44px] rounded-full border text-sm font-semibold tabular-nums transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
        active ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-400"
      } ${className}`}
    >
      {children}
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between text-xs font-medium text-zinc-700">
        {label}
        {hint && <span className="font-normal text-zinc-400">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function SummaryRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">{k}</dt>
      <dd className="text-right text-zinc-900">{children}</dd>
    </div>
  );
}

function groupSlots(slots: { startsAt: string; available: boolean }[]) {
  const buckets: { label: string; slots: typeof slots }[] = [
    { label: "Morning", slots: [] },
    { label: "Lunch", slots: [] },
    { label: "Afternoon", slots: [] },
    { label: "Evening", slots: [] },
  ];
  for (const s of slots) {
    const h = new Date(s.startsAt).getHours();
    const i = h < 11 ? 0 : h < 15 ? 1 : h < 17 ? 2 : 3;
    buckets[i]!.slots.push(s);
  }
  return buckets.filter((b) => b.slots.length > 0);
}
