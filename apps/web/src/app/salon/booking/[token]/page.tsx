"use client";

// A guest's own booking: the link in their confirmation email, and where
// they land after booking or paying a deposit. They can add it to their
// calendar, move it, cancel it — inside the shop's window — or finish
// paying a deposit they walked away from.

import { Suspense, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, CheckCircle2, Clock, CreditCard, Info, Phone, XCircle } from "lucide-react";
import {
  addDays,
  longDate,
  minutesLabel,
  publicSalonClient,
  shopDate,
  shopTime,
  todayIn,
  type PublicBooking,
} from "@/lib/api/salon.client";
import {
  GhostButton,
  PrimaryButton,
  SP,
  Shell,
  ShopHeader,
  display,
  money,
  staffNoun,
} from "@/components/salon-public/salon-public-ui";

export default function ManageBookingPage() {
  return (
    <Suspense fallback={null}>
      <ManageBookingInner />
    </Suspense>
  );
}

function ManageBookingInner() {
  const params = useParams<{ token: string }>();
  const search = useSearchParams();
  const token = params?.token ?? "";
  const q = useQuery({
    queryKey: ["salon-public", "booking", token],
    queryFn: () => publicSalonClient.booking(token),
    enabled: !!token,
    retry: false,
    // Back from Stripe: the webhook may land a moment after the guest does.
    refetchInterval: (query) => (query.state.data?.status === "PENDING_PAYMENT" && search?.get("paid") ? 3000 : false),
  });
  const b = q.data;
  if (q.isLoading) {
    return (
      <Shell>
        <div className="h-64 animate-pulse rounded-2xl bg-white" />
      </Shell>
    );
  }
  if (!b) {
    return (
      <Shell>
        <p className={`text-3xl ${display}`}>We couldn&rsquo;t find that booking.</p>
        <p className="mt-2" style={{ color: SP.steel }}>
          The link may be incomplete — open it again from your confirmation email.
        </p>
      </Shell>
    );
  }
  return <Manage b={b} isNew={search?.get("new") === "1"} cancelledPay={search?.get("cancelled") === "1"} justPaid={search?.get("paid") === "1"} />;
}

function calendarUrl(b: PublicBooking): string {
  const stamp = (d: string) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: `${b.summary} at ${b.shop.name}`,
    dates: `${stamp(b.startsAt)}/${stamp(b.endsAt)}`,
    details: `${b.summary}${b.staff ? ` with ${b.staff.name}` : ""}. Ref ${b.reference}.`,
    ...(b.shop.address ? { location: b.shop.address } : {}),
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}

function Manage({ b, isNew, cancelledPay, justPaid }: { b: PublicBooking; isNew: boolean; cancelledPay: boolean; justPaid: boolean }) {
  const qc = useQueryClient();
  const tz = b.shop.timezone;
  const [mode, setMode] = useState<"view" | "move" | "cancel">("view");
  const [error, setError] = useState<string | null>(null);
  const set = (nb: PublicBooking) => qc.setQueryData(["salon-public", "booking", b.token], nb);

  const pay = useMutation({
    mutationFn: () => publicSalonClient.pay(b.token),
    onSuccess: (r) => (window.location.href = r.url),
    onError: (e: Error) => setError(e.message),
  });
  const cancel = useMutation({
    mutationFn: () => publicSalonClient.cancel(b.token),
    onSuccess: (nb) => {
      set(nb);
      setMode("view");
    },
    onError: (e: Error) => setError(e.message),
  });

  const cancelled = b.status === "CANCELLED";
  const pending = b.status === "PENDING_PAYMENT";
  const date = shopDate(b.startsAt, tz);
  const heading = cancelled
    ? "Cancelled"
    : pending
      ? justPaid
        ? "Confirming your payment…"
        : "Almost booked"
      : b.status === "COMPLETED"
        ? "Thanks for coming in"
        : isNew || justPaid
          ? "You're booked in"
          : "Your booking";

  return (
    <Shell>
      <ShopHeader name={b.shop.name} logoUrl={b.shop.logoUrl} address={b.shop.address} phone={b.shop.phone} compact />

      <div className="mt-6 flex items-center gap-2">
        {cancelled ? (
          <XCircle className="h-7 w-7" style={{ color: SP.red }} aria-hidden />
        ) : pending ? (
          <Clock className="h-7 w-7" style={{ color: SP.brass }} aria-hidden />
        ) : (
          <CheckCircle2 className="h-7 w-7" style={{ color: "#2F7D4F" }} aria-hidden />
        )}
        <h2 className={`text-[2rem] leading-none ${display}`}>{heading}</h2>
      </div>
      {(isNew || justPaid) && !cancelled && !pending && (
        <p className="mt-2 text-[15px]" style={{ color: SP.steel }}>
          We&rsquo;ve emailed your confirmation. Keep this page — it&rsquo;s where you change or cancel.
        </p>
      )}

      {/* The ticket */}
      <section className={`mt-5 overflow-hidden rounded-2xl bg-white ${cancelled ? "opacity-60" : ""}`} style={{ boxShadow: `0 0 0 1px ${SP.line}` }}>
        <div className="px-5 py-5">
          <p className={`text-[1.6rem] leading-tight ${display}`}>{longDate(date)}</p>
          <p className={`text-[2.6rem] leading-none ${display}`} style={{ color: SP.brass }}>
            {shopTime(b.startsAt, tz)}
          </p>
          <p className="mt-2 text-[15px]">
            {b.summary}
            {b.staff ? ` with ${b.staff.name}` : ""}
          </p>
        </div>
        <div className="border-t border-dashed px-5 py-4 text-[14px]" style={{ borderColor: SP.line }}>
          <ul className="space-y-1">
            {b.services.map((s, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span>
                  {s.name}
                  {s.addons.length > 0 && <span style={{ color: SP.steel }}> + {s.addons.join(", ")}</span>}
                  <span className="ml-1 text-[12px]" style={{ color: SP.steel }}>
                    {minutesLabel(s.durationMins)}
                  </span>
                </span>
                <span className="tabular-nums">
                  {s.priceFrom ? "from " : ""}
                  {money(s.price, b.shop.currency)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex justify-between border-t pt-2 font-semibold" style={{ borderColor: SP.line }}>
            <span>Total</span>
            <span className="tabular-nums">{money(b.totalPrice, b.shop.currency)}</span>
          </div>
          {b.depositAmount > 0 && (
            <p className="mt-1 text-[13px]" style={{ color: b.depositStatus === "PAID" ? "#2F7D4F" : SP.brass }}>
              {
                ({
                  PAID: `${money(b.depositAmount, b.shop.currency)} deposit paid — comes off your bill`,
                  PENDING: `${money(b.depositAmount, b.shop.currency)} deposit still to pay`,
                  REFUNDED: `${money(b.depositAmount, b.shop.currency)} deposit refunded to your card`,
                  FORFEITED: `${money(b.depositAmount, b.shop.currency)} deposit kept (cancelled late)`,
                  EXPIRED: "Deposit wasn't paid in time",
                  APPLIED: `${money(b.depositAmount, b.shop.currency)} deposit used on your bill`,
                } as Record<string, string>)[b.depositStatus] ?? ""
              }
            </p>
          )}
          <p className="mt-3 font-mono text-[12px] tracking-wider" style={{ color: SP.steel }}>
            Ref {b.reference}
          </p>
        </div>
      </section>

      {b.patchTest && !cancelled && (
        <p className="mt-4 flex gap-2 rounded-2xl p-4 text-[13px]" style={{ background: SP.brassSoft }}>
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          This needs a skin patch test at least 48 hours before. If you haven&rsquo;t had one with us recently, please pop in or call.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-4 rounded-xl p-3 text-[14px] font-medium text-white" style={{ background: SP.red }}>
          {error}
        </p>
      )}

      {pending && !justPaid && (
        <div className="mt-5 space-y-2">
          {cancelledPay && <p className="text-[14px]" style={{ color: SP.steel }}>Payment wasn&rsquo;t finished. Your time is held for a few more minutes.</p>}
          <PrimaryButton onClick={() => pay.mutate()} loading={pay.isPending}>
            <CreditCard className="h-4 w-4" aria-hidden /> Pay {money(b.depositAmount, b.shop.currency)} deposit
          </PrimaryButton>
        </div>
      )}

      {mode === "view" && !cancelled && !pending && b.status !== "COMPLETED" && (
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <a href={calendarUrl(b)} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl text-sm font-semibold text-white" style={{ background: SP.ink }}>
            <CalendarPlus className="h-4 w-4" aria-hidden /> Add to calendar
          </a>
          {b.canChange && b.freeChange && <GhostButton onClick={() => setMode("move")}>Change time</GhostButton>}
          {b.canChange && <GhostButton danger onClick={() => setMode("cancel")}>Cancel booking</GhostButton>}
          {b.shop.phone && (
            <a href={`tel:${b.shop.phone.replace(/[^\d+]/g, "")}`} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border text-sm font-semibold" style={{ borderColor: SP.line }}>
              <Phone className="h-4 w-4" aria-hidden /> Call the shop
            </a>
          )}
        </div>
      )}
      {mode === "view" && !cancelled && b.canChange && !b.freeChange && (
        <p className="mt-3 text-[13px]" style={{ color: SP.steel }}>
          It&rsquo;s within {b.cancellationWindowHours} hours, so the time can&rsquo;t be moved online
          {b.depositStatus === "PAID" ? " and cancelling keeps the deposit" : ""}. Call the shop if something&rsquo;s come up.
        </p>
      )}

      {mode === "cancel" && (
        <section className="mt-5 space-y-3 rounded-2xl bg-white p-5" style={{ boxShadow: `0 0 0 1px ${SP.line}` }}>
          <p className={`text-xl ${display}`}>Cancel this booking?</p>
          <p className="text-[14px]" style={{ color: SP.steel }}>
            {b.depositStatus === "PAID"
              ? b.freeChange
                ? `Your ${money(b.depositAmount, b.shop.currency)} deposit goes back to your card.`
                : `It's within ${b.cancellationWindowHours} hours, so the deposit isn't refunded.`
              : "The time goes back to the diary for someone else."}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <GhostButton onClick={() => setMode("view")}>Keep it</GhostButton>
            <button
              type="button"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
              className="inline-flex h-11 items-center justify-center rounded-xl text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: SP.red }}
            >
              Yes, cancel
            </button>
          </div>
        </section>
      )}

      {mode === "move" && <Reschedule b={b} onDone={(nb) => { set(nb); setMode("view"); }} onBack={() => setMode("view")} />}

      {(cancelled || b.status === "COMPLETED") && (
        <a href={`/salon/${b.shop.locationId}`} className="mt-6 inline-flex h-12 w-full items-center justify-center rounded-xl text-[15px] font-semibold text-white" style={{ background: SP.ink }}>
          Book again
        </a>
      )}
    </Shell>
  );
}

function Reschedule({ b, onDone, onBack }: { b: PublicBooking; onDone: (nb: PublicBooking) => void; onBack: () => void }) {
  const tz = b.shop.timezone;
  const [date, setDate] = useState(shopDate(b.startsAt, tz));
  const [slot, setSlot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const slots = useQuery({
    queryKey: ["salon-public", "reslots", b.token, date],
    queryFn: () => publicSalonClient.rescheduleSlots(b.token, date),
  });
  const move = useMutation({
    mutationFn: () => publicSalonClient.reschedule(b.token, slot!),
    onSuccess: onDone,
    onError: (e: Error) => {
      setError(e.message);
      void slots.refetch();
    },
  });
  const days = Array.from({ length: 14 }, (_, i) => addDays(todayIn(tz), i));
  return (
    <section className="mt-5 space-y-4 rounded-2xl bg-white p-5" style={{ boxShadow: `0 0 0 1px ${SP.line}` }}>
      <p className={`text-xl ${display}`}>Pick a new time{b.staff ? ` with ${b.staff.name}` : ""}</p>
      <div className="-mx-5 overflow-x-auto px-5">
        <div className="flex gap-2">
          {days.map((d) => {
            const on = d === date;
            const [wk, dd] = longDate(d).split(" ");
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setDate(d);
                  setSlot(null);
                }}
                className="flex w-14 shrink-0 flex-col items-center rounded-xl border py-2"
                style={{ borderColor: on ? SP.ink : SP.line, background: on ? SP.ink : "white", color: on ? "white" : SP.ink }}
              >
                <span className="text-[11px] opacity-75">{wk!.slice(0, 3)}</span>
                <span className={`text-lg ${display}`}>{dd}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {(slots.data?.slots ?? []).map((s) => {
          const on = slot === s.startsAt;
          return (
            <button
              key={s.startsAt}
              type="button"
              aria-pressed={on}
              onClick={() => setSlot(s.startsAt)}
              className="h-11 rounded-xl border text-sm font-semibold tabular-nums"
              style={{ borderColor: on ? SP.brass : SP.line, background: on ? SP.brass : "white", color: on ? "white" : SP.ink }}
            >
              {shopTime(s.startsAt, tz)}
            </button>
          );
        })}
      </div>
      {slots.data && slots.data.slots.length === 0 && (
        <p className="text-[14px]" style={{ color: SP.steel }}>
          No free times with your {staffNoun(b.shop.trade)} this day.
        </p>
      )}
      {error && <p className="text-[14px] font-medium" style={{ color: SP.red }}>{error}</p>}
      <div className="grid grid-cols-2 gap-2">
        <GhostButton onClick={onBack}>Back</GhostButton>
        <PrimaryButton disabled={!slot} loading={move.isPending} onClick={() => move.mutate()}>
          Move to {slot ? shopTime(slot, tz) : "…"}
        </PrimaryButton>
      </div>
    </section>
  );
}
