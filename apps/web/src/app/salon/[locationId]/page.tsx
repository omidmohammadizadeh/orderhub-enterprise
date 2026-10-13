"use client";

// A barber's / salon's own booking page — the link in their Instagram bio.
//
// Four steps, one screen at a time on a phone: what you're having, who
// with ("anyone" first, because most people don't mind and it fills the
// gaps), when, and your details. Times come straight from the shop's live
// diary for exactly these services, so every time shown will book.

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, Clock, Info, UsersRound } from "lucide-react";
import {
  addDays,
  longDate,
  minutesLabel,
  publicSalonClient,
  shopTime,
  todayIn,
  type PublicShop,
  type WantedService,
} from "@/lib/api/salon.client";
import {
  GhostButton,
  PoleStripe,
  PrimaryButton,
  SP,
  Shell,
  ShopHeader,
  display,
  fieldCls,
  money,
  staffNoun,
} from "@/components/salon-public/salon-public-ui";

type Step = 0 | 1 | 2 | 3;
const STEP_TITLES = ["What are you having?", "Who with?", "When suits you?", "Your details"];

export default function SalonBookingPage() {
  const params = useParams<{ locationId: string }>();
  const locationId = params?.locationId ?? "";
  const shopQ = useQuery({
    queryKey: ["salon-public", "shop", locationId],
    queryFn: () => publicSalonClient.shop(locationId),
    enabled: !!locationId,
    retry: false,
  });
  const shop = shopQ.data;

  if (shopQ.isLoading) {
    return (
      <Shell>
        <div className="h-14 w-2/3 animate-pulse rounded-xl bg-white" />
        <div className="mt-6 h-64 animate-pulse rounded-2xl bg-white" />
      </Shell>
    );
  }
  if (!shop) {
    return (
      <Shell>
        <p className={`text-3xl ${display}`}>We couldn&rsquo;t find this shop.</p>
        <p className="mt-2" style={{ color: SP.steel }}>
          Check the link, or call the shop to book.
        </p>
      </Shell>
    );
  }
  if (!shop.onlineBookingEnabled) {
    return (
      <Shell>
        <ShopHeader name={shop.name} logoUrl={shop.logoUrl} address={shop.address} phone={shop.phone} />
        <div className="mt-8 rounded-2xl bg-white p-6">
          <p className={`text-2xl ${display}`}>Online booking is closed right now.</p>
          <p className="mt-2 text-[15px]" style={{ color: SP.steel }}>
            {shop.phone ? <>Call us on <a className="font-semibold underline" href={`tel:${shop.phone.replace(/[^\d+]/g, "")}`}>{shop.phone}</a> to book.</> : "Pop in or call the shop to book."}
          </p>
          {shop.queueOnlineJoin && (
            <a href={`/salon/${locationId}/queue`} className="mt-4 inline-flex items-center gap-2 font-semibold underline" style={{ color: SP.brass }}>
              <UsersRound className="h-4 w-4" aria-hidden /> Join the walk-in queue instead
            </a>
          )}
        </div>
      </Shell>
    );
  }
  return <Booking shop={shop} />;
}

function Booking({ shop }: { shop: PublicShop }) {
  const router = useRouter();
  const tz = shop.timezone;
  const [step, setStep] = useState<Step>(0);
  const [wanted, setWanted] = useState<WantedService[]>([]);
  const [staffId, setStaffId] = useState<string>("any");
  const [date, setDate] = useState(todayIn(tz));
  const [slot, setSlot] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [step]);

  const chosen = wanted.map((w) => shop.services.find((s) => s.id === w.serviceId)!).filter(Boolean);
  const serviceIds = chosen.map((s) => s.id);
  const eligible = shop.staff.filter((s) => s.serviceIds.length === 0 || serviceIds.every((id) => s.serviceIds.includes(id)));
  const person = shop.staff.find((s) => s.id === staffId) ?? null;
  const totalMins = chosen.reduce(
    (t, s) => t + s.durationMins + s.addons.filter((a) => wanted.find((w) => w.serviceId === s.id)?.addonIds?.includes(a.id)).reduce((x, a) => x + a.durationMins, 0),
    0,
  );
  const priceOf = (sid: string) => {
    const s = shop.services.find((x) => x.id === sid)!;
    return person?.priceOverrides?.[sid] ?? s.price;
  };
  const total = chosen.reduce(
    (t, s) => t + priceOf(s.id) + s.addons.filter((a) => wanted.find((w) => w.serviceId === s.id)?.addonIds?.includes(a.id)).reduce((x, a) => x + a.price, 0),
    0,
  );
  const fromPrice = chosen.some((s) => s.priceFrom);

  const days = useQuery({
    queryKey: ["salon-public", "days", shop.locationId, JSON.stringify(wanted), staffId],
    queryFn: () => publicSalonClient.days(shop.locationId, { from: todayIn(tz), days: 14, services: wanted, staffId }),
    enabled: step >= 2 && wanted.length > 0,
  });
  const slots = useQuery({
    queryKey: ["salon-public", "slots", shop.locationId, JSON.stringify(wanted), staffId, date],
    queryFn: () => publicSalonClient.slots(shop.locationId, { date, services: wanted, staffId }),
    enabled: step >= 2 && wanted.length > 0,
  });
  // Land on the first day that has room.
  useEffect(() => {
    const d = days.data?.days;
    if (!d || slot) return;
    const current = d.find((x) => x.date === date);
    if (current && current.slots > 0) return;
    const first = d.find((x) => x.slots > 0);
    if (first) setDate(first.date);
  }, [days.data, date, slot]);

  const grouped = useMemo(() => {
    const out: Record<"Morning" | "Afternoon" | "Evening", Array<{ startsAt: string; label: string; staffIds: string[] }>> = {
      Morning: [],
      Afternoon: [],
      Evening: [],
    };
    for (const s of slots.data?.slots ?? []) {
      const label = shopTime(s.startsAt, tz);
      const h = Number(label.slice(0, 2));
      out[h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening"].push({ startsAt: s.startsAt, label, staffIds: s.staffIds });
    }
    return out;
  }, [slots.data, tz]);

  const deposit = useMemo(() => {
    let d = 0;
    for (const s of chosen) {
      const w = wanted.find((x) => x.serviceId === s.id);
      const line = priceOf(s.id) + s.addons.filter((a) => w?.addonIds?.includes(a.id)).reduce((x, a) => x + a.price, 0);
      if (s.depositType === "FIXED") d += Math.min(line, s.depositValue ?? 0);
      else if (s.depositType === "PERCENT") d += (line * (s.depositValue ?? 0)) / 100;
      else if (s.depositType === "FULL") d += line;
    }
    return Math.round(d * 100) / 100;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen, wanted, person]);

  const book = useMutation({
    mutationFn: () =>
      publicSalonClient.book(shop.locationId, {
        staffId,
        startsAt: slot!,
        services: wanted,
        customerName: name.trim(),
        customerPhone: phone.trim(),
        customerEmail: email.trim(),
        notes: notes.trim() || undefined,
      }),
    onSuccess: (r) => {
      if (r.checkoutUrl) {
        window.location.href = r.checkoutUrl;
        return;
      }
      router.push(`/salon/booking/${r.appointment.token}?new=1`);
    },
    onError: (e: Error) => {
      setError(e.message);
      if (/just gone|isn't free/i.test(e.message)) {
        setSlot(null);
        setStep(2);
        void slots.refetch();
        void days.refetch();
      }
    },
  });

  const categories = useMemo(() => {
    const m = new Map<string, PublicShop["services"]>();
    for (const s of shop.services) m.set(s.category, [...(m.get(s.category) ?? []), s]);
    return Array.from(m.entries());
  }, [shop.services]);

  const toggleService = (id: string) => {
    setSlot(null);
    setWanted((w) => (w.some((x) => x.serviceId === id) ? w.filter((x) => x.serviceId !== id) : [...w, { serviceId: id, addonIds: [] }]));
  };
  const toggleAddon = (sid: string, aid: string) => {
    setSlot(null);
    setWanted((w) =>
      w.map((x) =>
        x.serviceId !== sid ? x : { ...x, addonIds: x.addonIds?.includes(aid) ? x.addonIds.filter((a) => a !== aid) : [...(x.addonIds ?? []), aid] },
      ),
    );
  };

  // "Anyone" only means something with a choice of people. With one, or
  // when the shop wants guests to pick, start on a real person.
  const anyAllowed = shop.offerAnyStaff && eligible.length > 1;
  useEffect(() => {
    if (step !== 1) return;
    if (staffId === "any" && !anyAllowed && eligible[0]) setStaffId(eligible[0].id);
    if (staffId !== "any" && !eligible.some((s) => s.id === staffId)) setStaffId(anyAllowed ? "any" : (eligible[0]?.id ?? "any"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, anyAllowed, eligible.length]);
  const canNext =
    step === 0 ? wanted.length > 0 : step === 1 ? (staffId === "any" ? anyAllowed : eligible.some((s) => s.id === staffId)) : step === 2 ? !!slot : !!(name.trim() && phone.trim() && /\S+@\S+\.\S+/.test(email));
  const noun = staffNoun(shop.trade);
  const slotStaff = slot ? (slots.data?.slots.find((s) => s.startsAt === slot)?.staffIds ?? []) : [];
  const assigned = staffId === "any" ? shop.staff.find((s) => s.id === slotStaff[0]) : person;

  return (
    <Shell>
      <ShopHeader name={shop.name} logoUrl={shop.logoUrl} address={shop.address} phone={shop.phone} compact={step > 0} />
      <div className="mt-6">
        <PoleStripe step={step} steps={4} trade={shop.trade} />
        <div className="mt-4 flex items-center gap-2">
          {step > 0 && (
            <button
              type="button"
              aria-label="Back"
              onClick={() => setStep((s) => (s - 1) as Step)}
              className="grid h-10 w-10 place-items-center rounded-full bg-white"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <h2 className={`text-[1.75rem] leading-tight ${display}`}>{STEP_TITLES[step]}</h2>
        </div>
      </div>

      {step === 0 && (
        <div className="mt-5 space-y-6">
          {categories.map(([cat, list]) => (
            <section key={cat}>
              <h3 className="mb-2 text-[13px] font-semibold" style={{ color: SP.steel }}>
                {cat}
              </h3>
              <ul className="overflow-hidden rounded-2xl bg-white" style={{ boxShadow: `0 0 0 1px ${SP.line}` }}>
                {list.map((s) => {
                  const on = wanted.find((w) => w.serviceId === s.id);
                  return (
                    <li key={s.id} className="border-b last:border-b-0" style={{ borderColor: SP.line }}>
                      <button type="button" onClick={() => toggleService(s.id)} aria-pressed={!!on} className="flex w-full items-start gap-3 px-4 py-4 text-left">
                        <span
                          className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 transition"
                          style={{ borderColor: on ? SP.ink : SP.line, background: on ? SP.ink : "transparent" }}
                        >
                          {on && <Check className="h-3.5 w-3.5 text-white" aria-hidden />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[16px] font-semibold">{s.name}</span>
                          <span className="mt-0.5 flex items-center gap-1 text-[13px]" style={{ color: SP.steel }}>
                            <Clock className="h-3.5 w-3.5" aria-hidden /> {minutesLabel(s.durationMins)}
                            {s.depositType !== "NONE" && " · deposit to book"}
                          </span>
                          {s.description && (
                            <span className="mt-1 block text-[13px] leading-snug" style={{ color: SP.steel }}>
                              {s.description}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-[15px] font-semibold tabular-nums">
                          {s.priceFrom && <span className="mr-1 text-[12px] font-normal">from</span>}
                          {money(s.price, shop.currency)}
                        </span>
                      </button>
                      {on && s.addons.length > 0 && (
                        <div className="flex flex-wrap gap-2 px-4 pb-4 pl-[52px]">
                          {s.addons.map((a) => {
                            const ao = on.addonIds?.includes(a.id);
                            return (
                              <button
                                key={a.id}
                                type="button"
                                aria-pressed={ao}
                                onClick={() => toggleAddon(s.id, a.id)}
                                className="rounded-full border px-3 py-1.5 text-[13px] font-medium transition"
                                style={{ borderColor: ao ? SP.brass : SP.line, background: ao ? SP.brassSoft : "white" }}
                              >
                                + {a.name} · {money(a.price, shop.currency)}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {shop.queueOnlineJoin && (
            <a href={`/salon/${shop.locationId}/queue`} className="flex items-center gap-2 text-[14px] font-semibold underline-offset-2 hover:underline" style={{ color: SP.brass }}>
              <UsersRound className="h-4 w-4" aria-hidden /> Want to walk in today? Join the queue
            </a>
          )}
        </div>
      )}

      {step === 1 && (
        <ul className="mt-5 grid gap-2">
          {anyAllowed && (
            <li>
              <PersonCard
                selected={staffId === "any"}
                onClick={() => {
                  setStaffId("any");
                  setSlot(null);
                }}
                title="Anyone available"
                sub={`Most times — first free ${noun}`}
              />
            </li>
          )}
          {eligible.map((s) => (
            <li key={s.id}>
              <PersonCard
                selected={staffId === s.id}
                onClick={() => {
                  setStaffId(s.id);
                  setSlot(null);
                }}
                title={s.name}
                sub={s.title ?? undefined}
                bio={s.bio ?? undefined}
                avatar={s.avatarUrl}
              />
            </li>
          ))}
          {eligible.length === 0 && (
            <li className="rounded-2xl bg-white p-5 text-[15px]">Nobody here does all of those together. Try booking them separately.</li>
          )}
        </ul>
      )}

      {step === 2 && (
        <div className="mt-5 space-y-5">
          <div className="-mx-4 overflow-x-auto px-4 pb-1">
            <div className="flex gap-2">
              {(days.data?.days ?? Array.from({ length: 14 }, (_, i) => ({ date: addDays(todayIn(tz), i), slots: -1 }))).map((d) => {
                const on = d.date === date;
                const [wk, dd, mm] = longDate(d.date).split(" ");
                return (
                  <button
                    key={d.date}
                    type="button"
                    disabled={d.slots === 0}
                    aria-pressed={on}
                    onClick={() => {
                      setDate(d.date);
                      setSlot(null);
                    }}
                    className="flex w-[64px] shrink-0 flex-col items-center rounded-2xl border py-2.5 transition disabled:opacity-35"
                    style={{ borderColor: on ? SP.ink : SP.line, background: on ? SP.ink : "white", color: on ? "white" : SP.ink }}
                  >
                    <span className="text-[11px] font-medium opacity-75">{wk!.slice(0, 3)}</span>
                    <span className={`text-[22px] leading-tight ${display}`}>{dd}</span>
                    <span className="text-[11px] opacity-75">{mm!.slice(0, 3)}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <p className="text-[14px]" style={{ color: SP.steel }}>
            {longDate(date)} · {minutesLabel(totalMins)}
            {person ? ` with ${person.name}` : ""}
          </p>
          {slots.isLoading ? (
            <div className="h-40 animate-pulse rounded-2xl bg-white" />
          ) : slots.isError ? (
            <p className="rounded-2xl bg-white p-4 text-[15px]">{(slots.error as Error).message}</p>
          ) : (slots.data?.slots.length ?? 0) === 0 ? (
            <p className="rounded-2xl bg-white p-5 text-[15px]">No times left this day — pick another.</p>
          ) : (
            (Object.entries(grouped) as Array<[string, Array<{ startsAt: string; label: string }>]>)
              .filter(([, l]) => l.length)
              .map(([part, list]) => (
                <section key={part}>
                  <h3 className="mb-2 text-[13px] font-semibold" style={{ color: SP.steel }}>
                    {part}
                  </h3>
                  <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                    {list.map((s) => {
                      const on = slot === s.startsAt;
                      return (
                        <button
                          key={s.startsAt}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setSlot(s.startsAt)}
                          className="h-12 rounded-xl border text-[15px] font-semibold tabular-nums transition"
                          style={{ borderColor: on ? SP.brass : SP.line, background: on ? SP.brass : "white", color: on ? "white" : SP.ink }}
                        >
                          {s.label}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))
          )}
        </div>
      )}

      {step === 3 && (
        <form
          className="mt-5 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (canNext) book.mutate();
          }}
        >
          <section className="rounded-2xl bg-white p-4" style={{ boxShadow: `0 0 0 1px ${SP.line}` }}>
            <p className={`text-xl ${display}`}>
              {longDate(date)}, {slot ? shopTime(slot, tz) : ""}
            </p>
            <p className="mt-1 text-[14px]" style={{ color: SP.steel }}>
              {chosen.map((s) => s.name).join(" + ")} · {minutesLabel(totalMins)}
              {assigned ? ` · with ${assigned.name}` : ""}
            </p>
            <div className="mt-3 flex items-baseline justify-between border-t pt-3" style={{ borderColor: SP.line }}>
              <span className="text-[14px]">Total{fromPrice ? " (from)" : ""}</span>
              <span className="text-lg font-semibold tabular-nums">{money(total, shop.currency)}</span>
            </div>
            {deposit > 0 && (
              <p className="mt-1 text-[13px]" style={{ color: SP.brass }}>
                {money(deposit, shop.currency)} deposit to secure it — taken off your bill on the day.
              </p>
            )}
          </section>
          <div className="space-y-3">
            <label className="block">
              <span className="text-[14px] font-semibold">Name</span>
              <input required name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={`${fieldCls} mt-1`} style={{ borderColor: SP.line }} />
            </label>
            <label className="block">
              <span className="text-[14px] font-semibold">Mobile</span>
              <input required name="tel" type="tel" autoComplete="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={`${fieldCls} mt-1`} style={{ borderColor: SP.line }} />
            </label>
            <label className="block">
              <span className="text-[14px] font-semibold">Email</span>
              <input required name="email" type="email" spellCheck={false} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`${fieldCls} mt-1`} style={{ borderColor: SP.line }} />
              <span className="mt-1 block text-[12px]" style={{ color: SP.steel }}>
                Your confirmation and a link to change or cancel go here.
              </span>
            </label>
            <label className="block">
              <span className="text-[14px] font-semibold">Anything we should know? (optional)</span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`${fieldCls} mt-1 h-auto py-3`} style={{ borderColor: SP.line }} />
            </label>
          </div>
          {chosen.some((s) => s.requiresPatchTest) && (
            <p className="flex gap-2 rounded-2xl p-4 text-[13px]" style={{ background: SP.brassSoft }}>
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              This needs a skin patch test at least 48 hours before. If you haven&rsquo;t had one with us recently, please pop in or call.
            </p>
          )}
          {(shop.bookingPolicy || shop.cancellationWindowHours > 0) && (
            <p className="text-[13px] leading-relaxed" style={{ color: SP.steel }}>
              {shop.bookingPolicy && <>{shop.bookingPolicy} </>}
              {shop.cancellationWindowHours > 0 &&
                `Free to change or cancel up to ${shop.cancellationWindowHours} hours before${deposit > 0 ? " — after that the deposit isn't refunded" : ""}.`}
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-xl p-3 text-[14px] font-medium text-white" style={{ background: SP.red }}>
              {error}
            </p>
          )}
          <PrimaryButton type="submit" disabled={!canNext} loading={book.isPending}>
            {deposit > 0 ? `Pay ${money(deposit, shop.currency)} deposit & book` : "Confirm booking"}
          </PrimaryButton>
        </form>
      )}

      {step < 3 && (
        <div className="fixed inset-x-0 bottom-0 border-t bg-white/95 px-4 py-3 backdrop-blur" style={{ borderColor: SP.line }}>
          <div className="mx-auto flex max-w-xl items-center gap-3">
            <div className="min-w-0 flex-1 text-[13px]" style={{ color: SP.steel }}>
              {wanted.length === 0 ? (
                "Pick one or more"
              ) : (
                <>
                  <span className="font-semibold" style={{ color: SP.ink }}>
                    {fromPrice ? "from " : ""}
                    {money(total, shop.currency)}
                  </span>{" "}
                  · {minutesLabel(totalMins)}
                  {slot ? ` · ${shopTime(slot, tz)}` : ""}
                </>
              )}
            </div>
            <div className="w-40">
              <PrimaryButton disabled={!canNext} onClick={() => setStep((s) => (s + 1) as Step)}>
                Continue
              </PrimaryButton>
            </div>
          </div>
        </div>
      )}
      {step === 3 && (
        <div className="mt-4">
          <GhostButton onClick={() => setStep(2)}>Change time</GhostButton>
        </div>
      )}
    </Shell>
  );
}

function PersonCard({
  selected,
  onClick,
  title,
  sub,
  bio,
  avatar,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  sub?: string;
  bio?: string;
  avatar?: string | null;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-2xl border bg-white p-4 text-left transition"
      style={{ borderColor: selected ? SP.ink : SP.line, boxShadow: selected ? `0 0 0 1px ${SP.ink}` : undefined }}
    >
      {avatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatar} alt="" width={48} height={48} className="h-12 w-12 shrink-0 rounded-full object-cover" />
      ) : (
        <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-full text-lg ${display}`} style={{ background: SP.brassSoft, color: SP.brass }}>
          {title === "Anyone available" ? <UsersRound className="h-5 w-5" aria-hidden /> : title.slice(0, 1)}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-[16px] font-semibold">{title}</span>
        {sub && (
          <span className="block text-[13px]" style={{ color: SP.steel }}>
            {sub}
          </span>
        )}
        {bio && (
          <span className="mt-1 block text-[13px] leading-snug" style={{ color: SP.steel }}>
            {bio}
          </span>
        )}
      </span>
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border-2" style={{ borderColor: selected ? SP.ink : SP.line, background: selected ? SP.ink : "transparent" }}>
        {selected && <Check className="h-3.5 w-3.5 text-white" aria-hidden />}
      </span>
    </button>
  );
}
