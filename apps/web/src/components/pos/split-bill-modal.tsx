"use client";

// Table Tabs — Split the bill.
//
// A tab can be settled in parts: "£20 cash from him, the rest on card",
// or "split 4 ways". Each part is recorded against the SAME order via
// POST /v1/orders/:id/payments; when the parts cover the total the server
// marks the order PAID, completes it and frees the table.
//
// Three ways to pick an amount, because that's how tables actually pay:
//   • Split evenly  — 2…6 ways, one share pre-filled
//   • Custom amount — someone pays a round number
//   • Remaining     — the last person settles the rest

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { tablesClient, type PaymentSummary } from "@/lib/api/tables.client";
import { apiClient } from "@/lib/api/client";
import { ChargeReaderModal } from "./charge-reader-modal";

interface Props {
  orderId: string;
  tableName?: string | null;
  onClose: () => void;
  /** Fired once the bill is fully settled (table freed server-side). */
  onSettled: () => void;
  /**
   * Needed to reach the location's card readers. When absent the Card
   * button falls back to recording an off-system card payment, which is
   * what shops with a standalone terminal actually do.
   */
  locationId?: string;
}

const money = (n: number) => `£${Number(n).toFixed(2)}`;

export function SplitBillModal({
  orderId,
  tableName,
  onClose,
  onSettled,
  locationId,
}: Props) {
  const qc = useQueryClient();
  // Card readers charge the PART amount; the order stays open until the
  // parts cover the total (see TerminalService.chargeOrder).
  const [readerFor, setReaderFor] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [ways, setWays] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "By item" — tick what this person is paying for; the amount is the sum.
  const [byItem, setByItem] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  const orderQuery = useQuery<any>({
    queryKey: ["tab-order-items", orderId],
    queryFn: () => apiClient.get(`/v1/orders/${orderId}`).then((r) => r.data),
    enabled: byItem,
  });
  const items: any[] = orderQuery.data?.items ?? [];

  const summaryQuery = useQuery<PaymentSummary>({
    queryKey: ["tab-payments", orderId],
    queryFn: () => tablesClient.paymentSummary(orderId),
    refetchInterval: 5000,
  });
  const s = summaryQuery.data;

  // Default the box to whatever is still owed.
  useEffect(() => {
    if (s && !amount && !ways) setAmount(s.remaining.toFixed(2));
  }, [s, amount, ways]);

  const pay = useMutation({
    mutationFn: (method: "CASH" | "CARD") =>
      tablesClient.addPayment(orderId, {
        amount: Number(amount),
        method,
        note: ways ? `Split ${ways} ways` : undefined,
      }),
    onSuccess: (res) => {
      setError(null);
      qc.setQueryData(["tab-payments", orderId], res);
      qc.invalidateQueries({ queryKey: ["tables"] });
      if (res.settled) {
        onSettled();
        return;
      }
      // Pre-fill the next share.
      setAmount(
        ways ? Math.min(res.remaining, res.total / ways).toFixed(2) : res.remaining.toFixed(2),
      );
    },
    onError: (e: any) =>
      setError(e?.response?.data?.message ?? "Couldn't record that payment"),
  });

  const remaining = s?.remaining ?? 0;
  const amountNum = Number(amount);
  const canPay =
    Number.isFinite(amountNum) &&
    amountNum > 0 &&
    amountNum <= remaining + 0.01 &&
    !pay.isPending;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-zinc-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              Split the bill{tableName ? ` · ${tableName}` : ""}
            </h2>
            <p className="text-[11px] text-zinc-500">
              Take payment in parts — the table closes itself when it's all in.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Running totals */}
        <div className="grid grid-cols-3 gap-px bg-zinc-100 text-center">
          <div className="bg-white px-2 py-3">
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">
              Total
            </div>
            <div className="text-sm font-semibold">{money(s?.total ?? 0)}</div>
          </div>
          <div className="bg-white px-2 py-3">
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">
              Paid
            </div>
            <div className="text-sm font-semibold text-emerald-700">
              {money(s?.paid ?? 0)}
            </div>
          </div>
          <div className="bg-white px-2 py-3">
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">
              Left
            </div>
            <div className="text-sm font-bold text-amber-700">
              {money(remaining)}
            </div>
          </div>
        </div>

        <div className="space-y-3 px-5 py-4">
          {/* Split evenly */}
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              Split evenly
            </p>
            <div className="flex gap-1.5">
              {[2, 3, 4, 5, 6].map((n) => (
                <button
                  key={n}
                  onClick={() => {
                    setWays(n);
                    setAmount(
                      Math.min((s?.total ?? 0) / n, remaining).toFixed(2),
                    );
                  }}
                  className={
                    ways === n
                      ? "flex-1 rounded-md bg-zinc-900 px-2 py-1.5 text-xs font-semibold text-white"
                      : "flex-1 rounded-md border border-zinc-200 px-2 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                  }
                >
                  {n}
                </button>
              ))}
              <button
                onClick={() => {
                  setWays(null);
                  setByItem(false);
                  setAmount(remaining.toFixed(2));
                }}
                className="flex-1 rounded-md border border-zinc-200 px-2 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              >
                All
              </button>
            </div>
          </div>

          {/* By item — tick what this person had; the amount is the sum. */}
          <div>
            <button
              onClick={() => {
                setByItem((v) => !v);
                setWays(null);
                setPicked({});
              }}
              className="text-[11px] font-semibold uppercase tracking-wide text-indigo-600 hover:text-indigo-800"
            >
              {byItem ? "− Hide items" : "+ Pay for specific items"}
            </button>
            {byItem && (
              <div className="mt-1.5 max-h-44 overflow-y-auto rounded-md border border-zinc-200 p-1.5">
                {orderQuery.isLoading ? (
                  <p className="py-3 text-center text-xs text-zinc-400">
                    Loading items…
                  </p>
                ) : (
                  items.map((it: any) => {
                    const on = !!picked[it.id];
                    return (
                      <button
                        key={it.id}
                        onClick={() => {
                          const next: Record<string, boolean> = {
                            ...picked,
                            [it.id]: !on,
                          };
                          setPicked(next);
                          const sum = items
                            .filter((x: any) => next[String(x.id)])
                            .reduce(
                              (s: number, x: any) => s + Number(x.totalPrice),
                              0,
                            );
                          setAmount(Math.min(sum, remaining).toFixed(2));
                        }}
                        className={
                          "mb-1 flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs " +
                          (on
                            ? "bg-indigo-50 text-indigo-900"
                            : "hover:bg-zinc-50 text-zinc-700")
                        }
                      >
                        <span>
                          <span className="mr-1.5">{on ? "☑" : "☐"}</span>
                          {it.quantity}× {it.name}
                        </span>
                        <span className="font-medium">
                          {money(Number(it.totalPrice))}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* Amount */}
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              This payment
            </label>
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold text-zinc-400">£</span>
              <input
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setWays(null);
                }}
                inputMode="decimal"
                type="number"
                step="0.01"
                min="0"
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-lg font-semibold focus:border-zinc-900 focus:outline-none"
              />
            </div>
          </div>

          {error && <p className="text-[12px] text-red-600">{error}</p>}

          {/* Take it */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => pay.mutate("CASH")}
              disabled={!canPay}
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {pay.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "💷 Cash"
              )}
            </button>
            <button
              onClick={() =>
                // With a location we can drive the reader for exactly
                // this share; without one, fall back to recording an
                // off-system card payment as before.
                locationId ? setReaderFor(amountNum) : pay.mutate("CARD")
              }
              disabled={!canPay}
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {pay.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "💳 Card"
              )}
            </button>
          </div>

          {/* What's been taken so far */}
          {!!s?.payments?.length && (
            <div className="border-t border-zinc-100 pt-2">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                Taken so far
              </p>
              <ul className="space-y-0.5">
                {s.payments.map((p) => (
                  <li
                    key={p.id}
                    className="flex justify-between text-xs text-zinc-600"
                  >
                    <span>
                      {p.method === "CASH" ? "💷 Cash" : "💳 Card"}{" "}
                      <span className="text-zinc-400">
                        {new Date(p.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </span>
                    <span className="font-medium">
                      {money(Number(p.amount))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Card reader for ONE share. The server records the part and only
          settles the order once the parts cover the total, so closing
          this modal mid-way leaves the tab correctly part-paid. */}
      {readerFor != null && locationId && (
        <ChargeReaderModal
          open
          orderId={orderId}
          locationId={locationId}
          amount={s?.total ?? readerFor}
          partAmount={readerFor}
          onPaid={() => {
            // The part is banked server-side; refetch to move Paid/Left
            // and let the server tell us whether that closed the bill.
            summaryQuery.refetch().then((r) => {
              if (r.data?.settled) onSettled();
              else setAmount((r.data?.remaining ?? 0).toFixed(2));
            });
            qc.invalidateQueries({ queryKey: ["tables"] });
          }}
          onClose={() => setReaderFor(null)}
        />
      )}
    </div>
  );
}
