"use client";

// Refund a payment taken on a Dojo card machine — full or partial. Shown in
// the order drawer only when the order actually has a Dojo card payment.
// Dojo's go-live checklist requires at least one refund method, including a
// partial one; cancelling an order still refunds automatically on the server.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Undo2 } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "../ui/button";
import { apiClient } from "../../lib/api/client";
import { dojoClient } from "../../lib/api/dojo.client";
import { formatMoney } from "@orderhub/shared";

interface PaymentRow {
  id: string;
  provider: string;
  providerChargeId: string | null;
  amount: string | number;
  status: string;
  metadata?: { refundedMinor?: number; source?: string } | null;
}

// Money going back out: the same manager tier the API enforces.
const REFUND_ROLES = new Set(["MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "OWNER", "DARK_KITCHEN_MANAGER"]);

export function DojoRefundPanel({
  orderId,
  currency,
  role,
}: {
  orderId: string;
  currency?: string | null;
  role?: string | null;
}) {
  const qc = useQueryClient();
  const key = ["order-payments", orderId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => apiClient.get<PaymentRow[]>(`/v1/payments/orders/${orderId}`).then((r) => r.data),
    enabled: !!role && REFUND_ROLES.has(role),
  });
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const money = (n: number) => formatMoney(n, currency ?? "GBP");
  const rows = (q.data ?? []).filter(
    (p) => p.provider === "DOJO" && (p.status === "SUCCEEDED" || p.status === "REFUNDED") && p.providerChargeId,
  );
  if (!role || !REFUND_ROLES.has(role) || rows.length === 0) return null;

  const refund = async (p: PaymentRow, full: boolean) => {
    const raw = (amounts[p.id] ?? "").trim();
    const amount = full ? undefined : Number(raw);
    if (!full && (!Number.isFinite(amount) || (amount ?? 0) <= 0)) {
      toast.error("Enter the amount to refund");
      return;
    }
    const label = full ? "the full remaining amount" : money(amount!);
    if (!window.confirm(`Refund ${label} to the customer's card?`)) return;
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
          return (
            <li key={p.id} className="text-sm">
              <p className="text-zinc-700">
                {money(taken)} on card
                {refunded > 0 && <span className="text-zinc-500"> · {money(refunded)} refunded</span>}
              </p>
              {left > 0 ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
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
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => refund(p, false)}>
                    {busy === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Refund amount"}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => refund(p, true)}>
                    Refund {money(left)}
                  </Button>
                </div>
              ) : (
                <p className="mt-1 text-xs font-medium text-amber-700">Fully refunded</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
