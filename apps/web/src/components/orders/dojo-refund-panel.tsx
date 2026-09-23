"use client";

// Give back money taken on a Dojo card machine — full or partial.
//
// Card-present money goes back card-present: Dojo refuses BOTH /refunds and
// /reversal on a payment its terminal captured (400 on each, sandbox
// 2026-09-23), so the refund is a "matched refund" session ON the machine,
// with the customer's card in their hand. That's the main button here.
//
// The remote route (reversal, falling back to a refund) is kept as a quieter
// second option: it's the right call once Dojo has settled the payment, or
// when the customer has gone and a phone refund is the only way.

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, Loader2, Undo2 } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "../ui/button";
import { apiClient } from "../../lib/api/client";
import { dojoClient } from "../../lib/api/dojo.client";
import { DOJO_PROMPTS } from "../../lib/dojo-prompts";
import { formatMoney } from "@orderhub/shared";

interface PaymentRow {
  id: string;
  provider: string;
  providerChargeId: string | null;
  amount: string | number;
  status: string;
  metadata?: {
    refundedMinor?: number;
    source?: string;
    /** Set when a PAID order was cancelled: money still owed on the card. */
    refundOwedMinor?: number | null;
    refundOwedReason?: string | null;
  } | null;
}

// Money going back out: the same manager tier the API enforces.
const REFUND_ROLES = new Set(["MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "OWNER", "DARK_KITCHEN_MANAGER"]);

export function DojoRefundPanel({
  orderId,
  locationId,
  currency,
  role,
  orderStatus,
  orderPaymentStatus,
}: {
  orderId: string;
  locationId?: string | null;
  currency?: string | null;
  role?: string | null;
  /** Both only steer the cache — see the key below. */
  orderStatus?: string | null;
  orderPaymentStatus?: string | null;
}) {
  const qc = useQueryClient();
  const allowed = !!role && REFUND_ROLES.has(role);
  // The order's own state is part of the key: cancelling a PAID order writes
  // what it owes onto the PAYMENT row, and with a key of just the id this
  // panel kept showing the snapshot it fetched before the cancel — the
  // "refund owed" note never appeared until the drawer was reopened
  // (2026-09-23). Keeping the previous rows on screen avoids a blink.
  const key = ["order-payments", orderId, orderStatus, orderPaymentStatus];
  const q = useQuery({
    queryKey: key,
    queryFn: () => apiClient.get<PaymentRow[]>(`/v1/payments/orders/${orderId}`).then((r) => r.data),
    enabled: allowed,
    placeholderData: (prev: PaymentRow[] | undefined) => prev,
  });
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [terminalId, setTerminalId] = useState<string>("");
  // The refund currently running on a machine: {paymentId, intentId}.
  const [live, setLive] = useState<{ paymentId: string; intentId: string } | null>(null);

  const rows = (q.data ?? []).filter(
    (p) => p.provider === "DOJO" && (p.status === "SUCCEEDED" || p.status === "REFUNDED") && p.providerChargeId,
  );

  const terminalsQuery = useQuery({
    queryKey: ["dojo-status", locationId],
    queryFn: () => dojoClient.status(locationId!),
    enabled: allowed && !!locationId && rows.length > 0,
    retry: false,
  });
  const terminals = terminalsQuery.data?.connected ? terminalsQuery.data.terminals : [];
  const activeTerminal =
    terminals.find((t) => t.id === terminalId) ?? terminals.find((t) => t.status === "Available") ?? terminals[0] ?? null;

  // A session already on the machine (drawer reopened, page refreshed) is
  // picked up rather than stranded — the customer is still standing there.
  const firstIntent = rows[0]?.providerChargeId ?? null;
  const pollFor = live?.intentId ?? firstIntent;
  const statusQuery = useQuery({
    queryKey: ["dojo-refund-status", pollFor],
    queryFn: () => dojoClient.terminalRefundStatus(pollFor!),
    enabled: allowed && !!pollFor && rows.length > 0,
    refetchInterval: live ? 1000 : false,
    retry: false,
  });
  const session = statusQuery.data?.active ? statusQuery.data : null;

  useEffect(() => {
    if (!session) return;
    if (!live && !session.done && !session.failed && firstIntent) {
      setLive({ paymentId: rows[0]!.id, intentId: firstIntent });
      return;
    }
    if (!live) return;
    if (session.done) {
      toast.success(
        session.full
          ? `Refunded ${money(session.amount)} — payment fully refunded`
          : `Refunded ${money(session.amount)} — ${money(session.leftToRefund ?? 0)} left`,
      );
      setLive(null);
      setAmounts((a) => ({ ...a, [live.paymentId]: "" }));
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ["orders", "live"] });
    } else if (session.failed) {
      toast.error(session.message ?? "The refund didn't go through on the machine.");
      setLive(null);
    }
    // `money` and `key` are stable for a given order.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.done, session?.failed, session?.terminalSessionId]);

  const money = (n: number) => formatMoney(n, currency ?? "GBP");
  if (!allowed || rows.length === 0) return null;

  const wanted = (p: PaymentRow, full: boolean, left: number) => {
    if (full) return undefined;
    const amount = Number((amounts[p.id] ?? "").trim());
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter the amount to refund");
      return null;
    }
    if (amount > left) {
      toast.error(`Only ${money(left)} is left to refund`);
      return null;
    }
    return amount;
  };

  const refundOnMachine = async (p: PaymentRow, full: boolean, left: number) => {
    const amount = wanted(p, full, left);
    if (amount === null) return;
    if (!activeTerminal) {
      toast.error("No card machine is available at this location.");
      return;
    }
    setBusy(p.id);
    try {
      await dojoClient.startTerminalRefund(p.providerChargeId!, {
        terminalId: activeTerminal.id,
        amount,
        reason: "Refund from OrderHub",
      });
      // Drop any finished session still in the cache, so the poll below is
      // reading THIS refund and not the last one's "done".
      qc.removeQueries({ queryKey: ["dojo-refund-status", p.providerChargeId] });
      setLive({ paymentId: p.id, intentId: p.providerChargeId! });
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't start the refund on the machine");
    } finally {
      setBusy(null);
    }
  };

  const refundRemotely = async (p: PaymentRow, full: boolean, left: number) => {
    const amount = wanted(p, full, left);
    if (amount === null) return;
    const label = full ? money(left) : money(amount!);
    if (!window.confirm(`Refund ${label} without the customer's card present?`)) return;
    setBusy(p.id);
    try {
      const r = await dojoClient.refund(p.providerChargeId!, amount, "Refund from OrderHub");
      toast.success(
        r.full ? `Refunded ${money(r.amount)} — payment fully refunded` : `Refunded ${money(r.amount)} — ${money(r.leftToRefund)} left`,
      );
      setAmounts((a) => ({ ...a, [p.id]: "" }));
      await qc.invalidateQueries({ queryKey: key });
      await qc.invalidateQueries({ queryKey: ["orders", "live"] });
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Refund failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-4 rounded-lg border border-zinc-200 p-3" aria-labelledby={`dojo-refund-${orderId}`}>
      <h3 id={`dojo-refund-${orderId}`} className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
        <Undo2 className="h-4 w-4" aria-hidden /> Dojo card refunds
      </h3>
      <ul className="mt-2 space-y-3">
        {rows.map((p) => {
          const taken = Number(p.amount);
          const refunded = Number(p.metadata?.refundedMinor ?? (p.status === "REFUNDED" ? taken * 100 : 0)) / 100;
          const left = Math.max(0, Math.round((taken - refunded) * 100) / 100);
          const owed = Number(p.metadata?.refundOwedMinor ?? 0) / 100;
          const running = live?.paymentId === p.id;
          return (
            <li key={p.id} className="text-sm">
              <p className="text-zinc-700">
                {money(taken)} on card
                {refunded > 0 && <span className="text-zinc-500"> · {money(refunded)} refunded</span>}
              </p>
              {owed > 0 && left > 0 && (
                <p className="mt-1 rounded-md bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-800">
                  {money(owed)} refund owed on the card machine
                  {p.metadata?.refundOwedReason ? ` — ${p.metadata.refundOwedReason}` : ""}. The customer needs to
                  present the card they paid with.
                </p>
              )}
              {left <= 0 ? (
                <p className="mt-1 text-xs font-medium text-amber-700">Fully refunded</p>
              ) : running ? (
                <p className="mt-2 flex items-center gap-2 text-sm text-zinc-700">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  {(session?.prompt && DOJO_PROMPTS[session.prompt]) ??
                    `Follow the prompts on ${activeTerminal?.label ?? "the card machine"}…`}
                </p>
              ) : (
                <div className="mt-2 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor={`refund-amt-${p.id}`}>
                      Amount to refund
                    </label>
                    <input
                      id={`refund-amt-${p.id}`}
                      inputMode="decimal"
                      placeholder={left.toFixed(2)}
                      value={amounts[p.id] ?? ""}
                      onChange={(e) => setAmounts((a) => ({ ...a, [p.id]: e.target.value }))}
                      className="w-24 rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
                    />
                    <Button
                      size="sm"
                      disabled={busy !== null || !activeTerminal}
                      onClick={() => refundOnMachine(p, false, left)}
                    >
                      {busy === p.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <>
                          <CreditCard className="mr-1.5 h-4 w-4" aria-hidden /> Refund on machine
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null || !activeTerminal}
                      onClick={() => refundOnMachine(p, true, left)}
                    >
                      Refund {money(left)} on machine
                    </Button>
                  </div>
                  {terminals.length > 1 && (
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-zinc-500" htmlFor={`refund-term-${p.id}`}>
                        Machine
                      </label>
                      <select
                        id={`refund-term-${p.id}`}
                        value={activeTerminal?.id ?? ""}
                        onChange={(e) => setTerminalId(e.target.value)}
                        className="rounded-md border border-zinc-200 px-2 py-1 text-xs"
                      >
                        {terminals.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label} {t.status === "Available" ? "" : `(${t.status})`}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {!activeTerminal && (
                    <p className="text-xs text-zinc-500">
                      No card machine found for this location — set one up on the Card readers page.
                    </p>
                  )}
                  {/* Only works once Dojo has settled the payment (usually the
                      next working day); before that Dojo refuses it outright. */}
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => refundRemotely(p, true, left)}
                    className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-700 disabled:opacity-50"
                  >
                    Customer gone? Try refunding {money(left)} without the card
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
