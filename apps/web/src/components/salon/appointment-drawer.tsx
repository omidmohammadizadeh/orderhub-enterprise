"use client";

// Everything about one appointment, and everything you can do to it:
// arrive → in the chair → checkout, or move / no-show / cancel. The client's
// history sits underneath so the barber sees "6th visit, usual skin fade"
// before they pick up the clippers.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import toast from "react-hot-toast";
import {
  Ban,
  CalendarClock,
  CreditCard,
  Mail,
  MessageCircle,
  Phone,
  Play,
  RotateCcw,
  Send,
  StickyNote,
  UserCheck,
  UserX,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/use-currency";
import {
  apiError,
  longDate,
  minutesLabel,
  salonClient,
  shopDate,
  shopIso,
  shopTime,
  type AppointmentDetail,
  type AppointmentStatus,
  type SalonStaff,
} from "@/lib/api/salon.client";
import { CheckoutPanel } from "./checkout-panel";
import { StatusPill, inputCls } from "./salon-shared";

type Mode = "view" | "move" | "cancel";

export function AppointmentDrawer({
  appointmentId,
  locationId,
  tz,
  staff,
  onClose,
  onChanged,
}: {
  appointmentId: string;
  locationId: string;
  tz: string;
  staff: SalonStaff[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { money } = useCurrency();
  const [mode, setMode] = useState<Mode>("view");
  const [checkout, setCheckout] = useState(false);
  const detail = useQuery({
    queryKey: ["salon", "appointment", appointmentId],
    queryFn: () => salonClient.appointment(appointmentId),
  });
  const a = detail.data;

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !checkout && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose, checkout]);

  const changed = () => {
    void detail.refetch();
    onChanged();
  };

  const status = useMutation({
    mutationFn: (v: { status: AppointmentStatus; reason?: string; refundDeposit?: boolean; notifyGuest?: boolean }) =>
      salonClient.setStatus(appointmentId, v),
    onSuccess: (_d, v) => {
      setMode("view");
      changed();
      const words: Partial<Record<AppointmentStatus, string>> = {
        CHECKED_IN: "Marked as arrived",
        IN_SERVICE: "In the chair",
        NO_SHOW: "Marked as no-show",
        CANCELLED: "Cancelled",
        CONFIRMED: "Back in the diary",
      };
      toast.success(words[v.status] ?? "Updated");
    },
    onError: (e) => toast.error(apiError(e, "Couldn't update the appointment")),
  });

  const resend = useMutation({
    mutationFn: () => salonClient.resend(appointmentId),
    onSuccess: (r) => (r.sent ? toast.success("Confirmation re-sent") : toast.error("No email was sent")),
    onError: (e) => toast.error(apiError(e, "Couldn't send the email")),
  });

  const tel = a?.customerPhone?.replace(/[^\d+]/g, "") ?? "";
  const wa = tel.replace(/^\+/, "").replace(/^0/, "44");
  const open = a && ["CONFIRMED", "CHECKED_IN", "IN_SERVICE", "PENDING_PAYMENT"].includes(a.status);
  const chip =
    "inline-flex h-9 items-center gap-1.5 rounded-full border border-zinc-200 px-3 text-xs font-medium text-zinc-700 hover:border-zinc-400";

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Appointment details">
      <button type="button" aria-label="Close details" onClick={onClose} className="absolute inset-0 cursor-default bg-zinc-950/40 motion-safe:animate-fade-in" />
      <aside className="relative flex h-full w-full max-w-md flex-col overflow-hidden bg-white shadow-2xl motion-safe:animate-slide-in-right">
        <div className="flex items-start justify-between gap-3 border-b border-zinc-100 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <span className="font-mono">{a?.reference ?? "Appointment"}</span>
              {a && <StatusPill status={a.status} />}
            </div>
            <h2 className="mt-1 truncate text-xl font-semibold text-zinc-900">{a?.customerName ?? "Loading…"}</h2>
            {a && (a.history.visits > 0 || a.history.noShows > 0) && (
              <p className="mt-0.5 text-xs text-zinc-500">
                {a.history.visits > 0 && `${a.history.visits} visit${a.history.visits === 1 ? "" : "s"} before`}
                {a.history.visits > 0 && a.history.noShows > 0 && " · "}
                {a.history.noShows > 0 && (
                  <span className="font-medium text-red-600">
                    {a.history.noShows} no-show{a.history.noShows === 1 ? "" : "s"}
                  </span>
                )}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        {!a ? (
          <div className="flex-1 p-6 text-sm text-zinc-500">{detail.isError ? "Couldn't load this appointment." : "Loading…"}</div>
        ) : (
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {(tel || a.customerEmail) && (
              <div className="flex flex-wrap gap-2">
                {tel && (
                  <a href={`tel:${tel}`} className={chip}>
                    <Phone className="h-3.5 w-3.5" aria-hidden /> {a.customerPhone}
                  </a>
                )}
                {tel && (
                  <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" className={chip}>
                    <MessageCircle className="h-3.5 w-3.5" aria-hidden /> WhatsApp
                  </a>
                )}
                {a.customerEmail && (
                  <a href={`mailto:${a.customerEmail}`} className={`${chip} max-w-full`}>
                    <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{a.customerEmail}</span>
                  </a>
                )}
              </div>
            )}

            <section className="divide-y divide-zinc-100 rounded-2xl border border-zinc-200 text-sm">
              <div className="flex gap-3 px-4 py-3">
                <CalendarClock className="mt-0.5 h-4 w-4 text-zinc-400" aria-hidden />
                <div>
                  <div className="font-medium text-zinc-900">{longDate(shopDate(a.startsAt, tz))}</div>
                  <div className="text-zinc-600">
                    {shopTime(a.startsAt, tz)}–{shopTime(a.endsAt, tz)} with{" "}
                    <span className="font-medium text-zinc-900">{a.staff?.name ?? "anyone"}</span>
                  </div>
                </div>
              </div>
              <div className="px-4 py-3">
                <ul className="space-y-1">
                  {a.services.map((l, i) => (
                    <li key={i}>
                      <div className="flex justify-between gap-3">
                        <span className="text-zinc-900">
                          {l.name} <span className="text-xs text-zinc-500">{minutesLabel(l.durationMins)}</span>
                        </span>
                        <span className="tabular-nums text-zinc-700">
                          {l.priceFrom ? "from " : ""}
                          {money(l.price)}
                        </span>
                      </div>
                      {l.addons.map((x) => (
                        <div key={x.id} className="flex justify-between pl-3 text-xs text-zinc-500">
                          <span>+ {x.name}</span>
                          <span className="tabular-nums">{money(x.price)}</span>
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex justify-between border-t border-zinc-100 pt-2 font-semibold text-zinc-900">
                  <span>Total</span>
                  <span className="tabular-nums">{money(a.totalPrice)}</span>
                </div>
                {a.depositAmount > 0 && (
                  <p className="mt-1 text-xs text-zinc-600">
                    Deposit {money(a.depositAmount)} ·{" "}
                    <span className={a.depositStatus === "PAID" ? "font-semibold text-emerald-700" : ""}>
                      {
                        ({
                          PENDING: "waiting for the guest to pay",
                          PAID: "paid — comes off the bill",
                          APPLIED: "used on the bill",
                          REFUNDED: "refunded",
                          FORFEITED: "kept",
                          EXPIRED: "never paid",
                        } as Record<string, string>)[a.depositStatus] ?? a.depositStatus.toLowerCase()
                      }
                    </span>
                  </p>
                )}
                {a.tipAmount ? <p className="mt-1 text-xs text-zinc-600">Tip {money(a.tipAmount)}</p> : null}
                {a.order && (
                  <p className="mt-1 text-xs text-zinc-500">
                    Bill {a.order.orderNumber ? `#${a.order.orderNumber}` : ""} · {money(a.order.total)} ·{" "}
                    {a.order.paymentStatus === "PAID" ? "paid" : "not paid yet"}
                  </p>
                )}
              </div>
              {(a.notes || a.staffNotes) && (
                <div className="space-y-1 px-4 py-3">
                  {a.notes && (
                    <p className="flex gap-2 text-zinc-700">
                      <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" aria-hidden /> {a.notes}
                    </p>
                  )}
                  {a.staffNotes && <p className="whitespace-pre-line rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{a.staffNotes}</p>}
                </div>
              )}
              <div className="px-4 py-2 text-xs text-zinc-500">
                Booked {a.source === "ONLINE" ? "online" : a.source === "WALK_IN" ? "as a walk-in" : a.source.toLowerCase().replace("_", " ")}
                {a.anyStaff ? " · asked for anyone" : ""}
              </div>
            </section>

            {mode === "view" && open && (
              <div className="grid grid-cols-2 gap-2">
                {a.status === "CONFIRMED" && (
                  <Button variant="outline" onClick={() => status.mutate({ status: "CHECKED_IN" })} disabled={status.isPending}>
                    <UserCheck className="h-4 w-4" aria-hidden /> Arrived
                  </Button>
                )}
                {(a.status === "CONFIRMED" || a.status === "CHECKED_IN") && (
                  <Button variant="outline" onClick={() => status.mutate({ status: "IN_SERVICE" })} disabled={status.isPending}>
                    <Play className="h-4 w-4" aria-hidden /> Start
                  </Button>
                )}
                {a.status !== "PENDING_PAYMENT" && (
                  <Button className="col-span-2" onClick={() => setCheckout(true)}>
                    <CreditCard className="h-4 w-4" aria-hidden /> Checkout
                  </Button>
                )}
                <Button variant="secondary" onClick={() => setMode("move")}>
                  <CalendarClock className="h-4 w-4" aria-hidden /> Move
                </Button>
                {a.status !== "IN_SERVICE" && (
                  <Button variant="secondary" onClick={() => status.mutate({ status: "NO_SHOW" })} disabled={status.isPending}>
                    <UserX className="h-4 w-4" aria-hidden /> No-show
                  </Button>
                )}
                <Button variant="ghost" className="text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => setMode("cancel")}>
                  <Ban className="h-4 w-4" aria-hidden /> Cancel
                </Button>
                {a.customerEmail && (
                  <Button variant="ghost" onClick={() => resend.mutate()} loading={resend.isPending}>
                    <Send className="h-4 w-4" aria-hidden /> Re-send email
                  </Button>
                )}
              </div>
            )}
            {mode === "view" && (a.status === "NO_SHOW" || a.status === "CANCELLED") && (
              <Button variant="outline" onClick={() => status.mutate({ status: "CONFIRMED" })} loading={status.isPending}>
                <RotateCcw className="h-4 w-4" aria-hidden /> Put back in the diary
              </Button>
            )}

            {mode === "move" && (
              <MoveForm
                a={a}
                tz={tz}
                locationId={locationId}
                staff={staff}
                onCancel={() => setMode("view")}
                onMoved={() => {
                  setMode("view");
                  changed();
                }}
              />
            )}

            {mode === "cancel" && (
              <CancelForm
                hasDeposit={a.depositStatus === "PAID"}
                deposit={money(a.depositAmount)}
                hasEmail={!!a.customerEmail}
                busy={status.isPending}
                onBack={() => setMode("view")}
                onConfirm={(v) => status.mutate({ status: "CANCELLED", ...v })}
              />
            )}

            {a.history.recent.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-semibold text-zinc-800">Past visits</h3>
                <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 text-sm">
                  {a.history.recent.map((h) => (
                    <li key={h.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-zinc-900">{h.summary}</div>
                        <div className="text-xs text-zinc-500">
                          {new Date(h.startsAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: tz })}
                          {h.staffName ? ` · ${h.staffName}` : ""}
                        </div>
                      </div>
                      <StatusPill status={h.status} />
                    </li>
                  ))}
                </ul>
                {a.history.spent > 0 && <p className="mt-1 text-xs text-zinc-500">Spent {money(a.history.spent)} here so far.</p>}
              </section>
            )}
          </div>
        )}
      </aside>
      {checkout && a && (
        <CheckoutPanel
          appointment={a}
          locationId={locationId}
          onClose={() => setCheckout(false)}
          onDone={() => {
            setCheckout(false);
            changed();
          }}
        />
      )}
    </div>
  );
}

function MoveForm({
  a,
  tz,
  locationId,
  staff,
  onCancel,
  onMoved,
}: {
  a: AppointmentDetail;
  tz: string;
  locationId: string;
  staff: SalonStaff[];
  onCancel: () => void;
  onMoved: () => void;
}) {
  const [date, setDate] = useState(shopDate(a.startsAt, tz));
  const [staffId, setStaffId] = useState(a.staffId ?? staff[0]?.id ?? "");
  const [time, setTime] = useState<string | null>(null);
  const [notify, setNotify] = useState(true);
  const services = a.services.map((l) => ({ serviceId: l.serviceId, addonIds: l.addons.map((x) => x.id) }));
  const slots = useQuery({
    queryKey: ["salon", "availability", locationId, date, staffId, a.id],
    queryFn: () => salonClient.availability({ locationId, date, services, staffId, ignore: a.id }),
    enabled: !!staffId,
  });
  const move = useMutation({
    mutationFn: (force: boolean) =>
      salonClient.update(a.id, { startsAt: shopIso(date, time!, tz), staffId, force, notifyGuest: notify }),
    onSuccess: () => {
      toast.success(`Moved to ${time}${notify && a.customerEmail ? " — guest emailed" : ""}`);
      onMoved();
    },
    onError: (e) => {
      const msg = apiError(e, "Couldn't move it");
      if (/isn't free/i.test(msg) && confirm(`${msg}\n\nSqueeze it in anyway?`)) move.mutate(true);
      else toast.error(msg);
    },
  });
  return (
    <section className="space-y-3 rounded-2xl border border-orange-200 bg-orange-50/40 p-4">
      <h3 className="text-sm font-semibold text-zinc-900">Move appointment</h3>
      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className="text-xs text-zinc-600">Day</span>
          <input type="date" value={date} onChange={(e) => { setDate(e.target.value); setTime(null); }} className={`${inputCls} mt-1`} />
        </label>
        <label>
          <span className="text-xs text-zinc-600">With</span>
          <select value={staffId} onChange={(e) => { setStaffId(e.target.value); setTime(null); }} className={`${inputCls} mt-1`}>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
        {(slots.data?.slots ?? []).map((s) => {
          const t = shopTime(s.startsAt, tz);
          return (
            <button
              key={s.startsAt}
              type="button"
              onClick={() => setTime(t)}
              aria-pressed={time === t}
              className={`h-9 rounded-lg border px-3 text-sm tabular-nums ${time === t ? "border-orange-500 bg-orange-500 font-semibold text-white" : "border-zinc-200 bg-white"}`}
            >
              {t}
            </button>
          );
        })}
        {slots.data && slots.data.slots.length === 0 && <p className="text-sm text-zinc-500">No free times — try another day or person.</p>}
      </div>
      {a.customerEmail && (
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="h-4 w-4 accent-orange-500" />
          Email the guest the new time
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Back
        </Button>
        <Button disabled={!time} loading={move.isPending} onClick={() => move.mutate(false)}>
          Move to {time ?? "…"}
        </Button>
      </div>
    </section>
  );
}

function CancelForm({
  hasDeposit,
  deposit,
  hasEmail,
  busy,
  onBack,
  onConfirm,
}: {
  hasDeposit: boolean;
  deposit: string;
  hasEmail: boolean;
  busy: boolean;
  onBack: () => void;
  onConfirm: (v: { reason?: string; refundDeposit?: boolean; notifyGuest?: boolean }) => void;
}) {
  const [reason, setReason] = useState("");
  const [refund, setRefund] = useState(true);
  const [notify, setNotify] = useState(true);
  return (
    <section className="space-y-3 rounded-2xl border border-red-200 bg-red-50/40 p-4">
      <h3 className="text-sm font-semibold text-zinc-900">Cancel this appointment?</h3>
      <label className="block">
        <span className="text-xs text-zinc-600">Reason (for your records)</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Barber off sick" className={`${inputCls} mt-1`} />
      </label>
      {hasDeposit && (
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)} className="h-4 w-4 accent-orange-500" />
          Refund the {deposit} deposit to their card
        </label>
      )}
      {hasEmail && (
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="h-4 w-4 accent-orange-500" />
          Email the guest
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onBack}>
          Keep it
        </Button>
        <Button variant="destructive" loading={busy} onClick={() => onConfirm({ reason: reason.trim() || undefined, refundDeposit: refund, notifyGuest: notify })}>
          Cancel appointment
        </Button>
      </div>
    </section>
  );
}
