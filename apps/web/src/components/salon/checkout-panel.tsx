"use client";

// Checkout: settle "from" prices, add products, a discount and a tip, then
// take the money through the till's own payment screens — cash (with change
// and the drawer), the card machine (Stripe or Dojo), or a payment link.
//
// The bill is created as an ordinary POS order on the server; a paid salon
// sale completes itself, and that completes the appointment. When a payment
// screen closes we ask the server to sync, in case the event beat us.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Banknote, CreditCard, Link2, Plus, Star, Trash2, Wallet, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/use-currency";
import { CashPaymentModal } from "@/components/pos/cash-payment-modal";
import { ChargeReaderModal } from "@/components/pos/charge-reader-modal";
import { PaymentLinkModal } from "@/components/pos/payment-link-modal";
import { LoyaltyTillModal } from "@/components/pos/loyalty-till-modal";
import { walkInTill, type TillMember } from "@/lib/api/loyalty-walk-in.client";
import {
  apiError,
  salonClient,
  type AppointmentDetail,
  type CheckoutResult,
  type PayMethod,
} from "@/lib/api/salon.client";
import { inputBase, inputCls } from "./salon-shared";

const TIPS = [0, 10, 15, 20];

export function CheckoutPanel({
  appointment,
  locationId,
  onClose,
  onDone,
}: {
  appointment: AppointmentDetail;
  locationId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { money, symbol } = useCurrency();
  const preview = useQuery({
    queryKey: ["salon", "checkout", appointment.id],
    queryFn: () => salonClient.checkoutPreview(appointment.id),
  });
  const services = appointment.services;
  const [prices, setPrices] = useState<Record<number, string>>({});
  const [extras, setExtras] = useState<Array<{ name: string; price: string; quantity: number }>>([]);
  const [discount, setDiscount] = useState("");
  const [tipPct, setTipPct] = useState<number | null>(0);
  const [tipCustom, setTipCustom] = useState("");
  const [paying, setPaying] = useState<CheckoutResult | null>(null);
  // Walk-in loyalty: the visit earns a stamp when it's paid; a reward
  // spent here comes off the bill (amount off, or a free service).
  const loyaltyStatus = useQuery({
    queryKey: ["loyalty-till-status", locationId],
    queryFn: () => walkInTill.status(locationId),
    staleTime: 5 * 60_000,
  });
  const [loyaltyOpen, setLoyaltyOpen] = useState(false);
  const [member, setMember] = useState<TillMember | null>(null);
  const [reward, setReward] = useState<TillMember["rewards"][number] | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !paying && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose, paying]);

  const serviceTotal = useMemo(
    () =>
      services.reduce((s, l, i) => {
        const p = prices[i] !== undefined && prices[i] !== "" ? Number(prices[i]) : l.price;
        return s + (Number.isFinite(p) ? p : l.price) + l.addons.reduce((a, x) => a + x.price, 0);
      }, 0),
    [services, prices],
  );
  const extrasTotal = extras.reduce((s, x) => s + (Number(x.price) || 0) * x.quantity, 0);
  const deposit = preview.data?.deposit ?? 0;
  // What the reward is worth on THIS bill: money off if it's a money-off
  // reward; otherwise the service the shop chose for its card (Settings on
  // the loyalty card), else the service named on the reward, else the first.
  const rewardServiceId = useQuery({
    queryKey: ["salon", "settings", locationId],
    queryFn: () => salonClient.settings(locationId),
    staleTime: 60_000,
  }).data?.settings.loyaltyRewardServiceId;
  const rewardLine = (() => {
    const priceAt = (i: number) => {
      const p = prices[i] !== undefined && prices[i] !== "" ? Number(prices[i]) : services[i]!.price;
      return Number.isFinite(p) ? p : services[i]!.price;
    };
    const byId = services.findIndex((l) => l.serviceId === rewardServiceId);
    if (byId >= 0) return priceAt(byId);
    const label = (reward?.label ?? "").toLowerCase();
    const byName = services.findIndex((l) => label.includes(l.name.toLowerCase()));
    if (byName >= 0) return priceAt(byName);
    return services[0] ? priceAt(0) : 0;
  })();
  const rewardValue = reward ? Math.min(serviceTotal + extrasTotal, reward.amountOff ?? rewardLine) : 0;
  // The reward is applied by the server on its own line; here it only
  // shows in the total. The discount field is the manual one alone.
  const manualDiscount = Math.max(0, Number(discount) || 0);
  const disc = manualDiscount + rewardValue;
  const beforeTip = Math.max(0, Math.round((serviceTotal + extrasTotal - deposit - disc) * 100) / 100);
  const tip =
    tipPct === null ? Math.max(0, Number(tipCustom) || 0) : Math.round(((serviceTotal * tipPct) / 100) * 100) / 100;
  const total = Math.round((beforeTip + tip) * 100) / 100;

  const pay = useMutation({
    mutationFn: (method: PayMethod) =>
      salonClient.checkout(appointment.id, {
        paymentMethod: method,
        tipAmount: tip,
        discount: manualDiscount,
        prices: Object.entries(prices)
          .filter(([, v]) => v !== "" && Number.isFinite(Number(v)))
          .map(([k, v]) => ({ index: Number(k), price: Number(v) })),
        extras: extras
          .filter((x) => x.name.trim() && Number(x.price) >= 0)
          .map((x) => ({ name: x.name.trim(), price: Number(x.price) || 0, quantity: x.quantity })),
        ...(member ? { loyaltyMemberId: member.id } : {}),
        ...(member && reward ? { loyaltyRewardId: reward.id } : {}),
      }),
    onSuccess: (r) => {
      if (r.paid) {
        toast.success(`Paid — ${money(r.amount)}`);
        void salonClient.sync(appointment.id).finally(onDone);
        return;
      }
      setPaying(r);
    },
    onError: (e) => toast.error(apiError(e, "Couldn't start the bill")),
  });

  const afterPayment = async () => {
    setPaying(null);
    try {
      const fresh = await salonClient.sync(appointment.id);
      if (fresh.status === "COMPLETED") {
        toast.success(`${appointment.customerName} paid — all done`);
        onDone();
        return;
      }
      toast("Bill saved but not paid yet — take payment again from the appointment.", { icon: "⏳" });
      onDone();
    } catch {
      onDone();
    }
  };

  return (
    <div className="fixed inset-0 z-[55] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="Checkout">
      <button type="button" aria-label="Close" onClick={() => !paying && onClose()} className="absolute inset-0 cursor-default bg-zinc-950/50" />
      <div className="relative flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">Checkout · {appointment.customerName}</h2>
            <p className="text-xs text-zinc-500">
              {appointment.staff?.name ? `With ${appointment.staff.name} · ` : ""}
              {appointment.reference}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-10 w-10 place-items-center rounded-full text-zinc-400 hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {preview.data?.existingOrder && preview.data.existingOrder.paymentStatus !== "PAID" && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              A bill for {money(preview.data.existingOrder.total)} was started and not paid. Paying now replaces it.
            </p>
          )}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-zinc-800">Services</h3>
            <ul className="space-y-2">
              {services.map((l, i) => (
                <li key={i} className="rounded-lg border border-zinc-200 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-sm font-medium text-zinc-900">{l.name}</span>
                    <label className="flex items-center gap-1 text-sm">
                      <span className="text-zinc-400">{symbol}</span>
                      <span className="sr-only">Price for {l.name}</span>
                      <input
                        inputMode="decimal"
                        value={prices[i] ?? String(l.price)}
                        onChange={(e) => setPrices((p) => ({ ...p, [i]: e.target.value.replace(/[^\d.]/g, "") }))}
                        className="h-9 w-20 rounded-lg border border-zinc-200 px-2 text-right tabular-nums focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-200"
                      />
                    </label>
                  </div>
                  {l.priceFrom && <p className="mt-0.5 text-xs text-amber-700">Priced from {money(l.price)} — set what it came to.</p>}
                  {l.addons.map((a) => (
                    <div key={a.id} className="mt-1 flex justify-between text-xs text-zinc-600">
                      <span>+ {a.name}</span>
                      <span className="tabular-nums">{money(a.price)}</span>
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-800">Products</h3>
              <button
                type="button"
                onClick={() => setExtras((x) => [...x, { name: "", price: "", quantity: 1 }])}
                className="inline-flex items-center gap-1 text-sm font-medium text-orange-600 hover:text-orange-700"
              >
                <Plus className="h-4 w-4" aria-hidden /> Add product
              </button>
            </div>
            {extras.length === 0 ? (
              <p className="text-xs text-zinc-500">Wax, shampoo, aftershave — anything sold with the visit.</p>
            ) : (
              <ul className="space-y-2">
                {extras.map((x, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <input
                      aria-label="Product"
                      value={x.name}
                      onChange={(e) => setExtras((all) => all.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))}
                      placeholder="Matt clay"
                      className={`${inputBase} min-w-0 flex-1`}
                    />
                    <input
                      aria-label="Quantity"
                      inputMode="numeric"
                      value={x.quantity}
                      onChange={(e) =>
                        setExtras((all) => all.map((y, j) => (j === i ? { ...y, quantity: Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1) } : y)))
                      }
                      className={`${inputBase} w-14 text-center`}
                    />
                    <input
                      aria-label="Price each"
                      inputMode="decimal"
                      value={x.price}
                      onChange={(e) => setExtras((all) => all.map((y, j) => (j === i ? { ...y, price: e.target.value.replace(/[^\d.]/g, "") } : y)))}
                      placeholder="0.00"
                      className={`${inputBase} w-24 text-right`}
                    />
                    <button type="button" aria-label="Remove product" onClick={() => setExtras((all) => all.filter((_, j) => j !== i))} className="grid h-10 w-10 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-red-600">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="grid grid-cols-2 gap-3">
            <label>
              <span className="text-sm font-semibold text-zinc-800">Discount ({symbol})</span>
              <input inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" className={`${inputCls} mt-1`} />
            </label>
            <div>
              <span className="text-sm font-semibold text-zinc-800">Tip</span>
              <div className="mt-1 flex gap-1">
                {TIPS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setTipPct(p)}
                    aria-pressed={tipPct === p}
                    className={`h-10 flex-1 rounded-lg border text-xs font-semibold ${tipPct === p ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 text-zinc-700"}`}
                  >
                    {p ? `${p}%` : "None"}
                  </button>
                ))}
              </div>
              <label className="mt-1 flex items-center gap-1 text-xs text-zinc-500">
                Other
                <input
                  inputMode="decimal"
                  value={tipCustom}
                  onFocus={() => setTipPct(null)}
                  onChange={(e) => {
                    setTipPct(null);
                    setTipCustom(e.target.value.replace(/[^\d.]/g, ""));
                  }}
                  placeholder="0.00"
                  className="h-8 w-20 rounded-md border border-zinc-200 px-2 text-right text-sm"
                />
              </label>
            </div>
          </section>

          {loyaltyStatus.data?.enabled && (
            <button
              type="button"
              onClick={() => setLoyaltyOpen(true)}
              className="flex w-full items-center gap-2 rounded-xl border border-dashed border-zinc-300 px-3 py-2.5 text-left text-sm hover:border-zinc-400"
            >
              <Star className="h-4 w-4 text-amber-500" aria-hidden />
              {member ? (
                <span>
                  <span className="font-medium text-zinc-900">{member.firstName ?? "Loyalty card"}</span> · {member.stamps}/{member.stampsRequired} stamps
                  {reward ? ` · using “${reward.label}”` : member.rewards.length ? ` · ${member.rewards.length} reward ready` : ""}
                </span>
              ) : (
                <span className="text-zinc-600">Scan their loyalty card — this visit earns a stamp</span>
              )}
            </button>
          )}

          <dl className="space-y-1 rounded-xl bg-zinc-50 px-4 py-3 text-sm">
            <Row k="Services" v={money(serviceTotal)} />
            {extrasTotal > 0 && <Row k="Products" v={money(extrasTotal)} />}
            {deposit > 0 && <Row k="Deposit paid online" v={`−${money(deposit)}`} />}
            {rewardValue > 0 && <Row k={`Reward: ${reward?.label ?? "loyalty"}`} v={`−${money(rewardValue)}`} />}
            {disc - rewardValue > 0 && <Row k="Discount" v={`−${money(disc - rewardValue)}`} />}
            {tip > 0 && <Row k="Tip" v={money(tip)} />}
            <div className="flex items-baseline justify-between border-t border-zinc-200 pt-2 text-base font-semibold text-zinc-900">
              <dt>To pay</dt>
              <dd className="tabular-nums">{money(total)}</dd>
            </div>
          </dl>
        </div>

        <div className="grid grid-cols-2 gap-2 border-t border-zinc-100 px-5 py-4 sm:grid-cols-4">
          {total === 0 ? (
            <Button className="col-span-2 sm:col-span-4" onClick={() => pay.mutate("EXTERNAL")} loading={pay.isPending}>
              <Wallet className="h-4 w-4" aria-hidden /> Nothing to pay — finish
            </Button>
          ) : (
            <>
              <Button onClick={() => pay.mutate("CASH")} loading={pay.isPending && pay.variables === "CASH"} disabled={pay.isPending}>
                <Banknote className="h-4 w-4" aria-hidden /> Cash
              </Button>
              <Button onClick={() => pay.mutate("CARD_TERMINAL")} loading={pay.isPending && pay.variables === "CARD_TERMINAL"} disabled={pay.isPending}>
                <CreditCard className="h-4 w-4" aria-hidden /> Card
              </Button>
              <Button variant="outline" onClick={() => pay.mutate("PAYMENT_LINK")} disabled={pay.isPending}>
                <Link2 className="h-4 w-4" aria-hidden /> Link
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  if (confirm(`Mark ${money(total)} as paid another way (voucher, bank transfer, own card machine)?`)) pay.mutate("EXTERNAL");
                }}
                disabled={pay.isPending}
              >
                <Wallet className="h-4 w-4" aria-hidden /> Other
              </Button>
            </>
          )}
        </div>
      </div>

      {loyaltyOpen && (
        <LoyaltyTillModal
          locationId={locationId}
          joinUrl={loyaltyStatus.data?.joinUrl ?? null}
          attached={member}
          attachedRewardId={reward?.id ?? null}
          onAttach={(m) => setMember(m)}
          onRedeem={(m, r) => {
            setMember(m);
            setReward(r);
          }}
          onDetach={() => {
            setMember(null);
            setReward(null);
          }}
          onClose={() => setLoyaltyOpen(false)}
        />
      )}
      <CashPaymentModal
        open={paying?.paymentMethod === "CASH"}
        orderId={paying?.paymentMethod === "CASH" ? paying.orderId : null}
        locationId={locationId}
        amount={paying?.amount ?? 0}
        onClose={afterPayment}
      />
      {paying?.paymentMethod === "CARD_TERMINAL" && (
        <ChargeReaderModal open orderId={paying.orderId} amount={paying.amount} locationId={locationId} onClose={afterPayment} />
      )}
      <PaymentLinkModal
        open={paying?.paymentMethod === "PAYMENT_LINK"}
        orderId={paying?.paymentMethod === "PAYMENT_LINK" ? paying.orderId : null}
        orderNumber={paying?.orderNumber ? `#${paying.orderNumber}` : null}
        amount={paying?.amount ?? 0}
        customerPhone={appointment.customerPhone}
        onClose={afterPayment}
      />
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between text-zinc-600">
      <dt>{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  );
}
