"use client";

// Retail R1 — returns at the till.
//
// Scan the receipt's QR (or type the number printed on it), tick what came
// back, choose whether each item goes back on the shelf, refund. The server
// prices everything — the figure shown here is a preview — and refuses
// anything already returned, so two tills can't refund the same item twice.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Camera, CreditCard, Loader2, Minus, Plus, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/use-currency";
import { useBarcodeScanner } from "@/lib/pos/barcode-scanner";
import { retailClient, type SaleForReturn } from "@/lib/api/retail.client";
import { dojoClient } from "@/lib/api/dojo.client";
import { DOJO_PROMPTS } from "@/lib/dojo-prompts";
import { chooseCardMachine, useDeviceStore } from "@/stores/device.store";
import { CameraScanModal, isCameraScanSupported } from "./camera-scan-modal";

const REASONS = ["Changed mind", "Faulty", "Wrong size", "Damaged", "Out of date", "Other"];

/** Who may return without the PIN — mirrors RETURN_MANAGER_ROLES on the API. */
const MANAGER_ROLES = ["PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "MANAGER", "DARK_KITCHEN_MANAGER"];

const errMsg = (e: any) => e?.response?.data?.message ?? e?.message ?? "Something went wrong";

export function RetailReturnsModal({
  locationId,
  role,
  initialCode,
  onClose,
  onCashRefunded,
}: {
  locationId: string;
  role: string | undefined;
  /** A receipt already scanned at the till — look it up straight away. */
  initialCode?: string;
  onClose: () => void;
  /** Cash is going back over the counter — pop the drawer. */
  onCashRefunded?: (amount: number) => void;
}) {
  const { money } = useCurrency();
  const [code, setCode] = useState(initialCode ?? "");
  const [sale, setSale] = useState<SaleForReturn | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [damaged, setDamaged] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState(REASONS[0]!);
  const [cash, setCash] = useState(false);
  const [pin, setPin] = useState("");
  const [camera, setCamera] = useState(false);
  const [done, setDone] = useState<{ amount: number; method: "CASH" | "CARD" } | null>(null);
  const needsPin = !MANAGER_ROLES.includes(String(role));
  // Card-present (Dojo) refunds happen ON the machine: while one is running
  // this holds its amount, and the screen shows the machine's prompt.
  const [machine, setMachine] = useState<{ amount: number } | null>(null);
  const [machinePrompt, setMachinePrompt] = useState<string | null>(null);
  const [machineError, setMachineError] = useState<string | null>(null);
  const [chosenTerminal, setChosenTerminal] = useState<string | null>(null);
  const pinnedMachine = useDeviceStore((st) => st.cardMachineByLocation[locationId] ?? null);
  const onMachine = sale?.original.method === "CARD" && sale.original.provider === "DOJO" && !cash;
  const dojoQuery = useQuery({
    queryKey: ["dojo-status", locationId],
    queryFn: () => dojoClient.status(locationId),
    enabled: !!onMachine,
    retry: false,
  });
  const dojoTerminals = dojoQuery.data?.connected ? (dojoQuery.data.terminals ?? []) : [];
  // Same rule as taking a payment: this till's own machine, or the only one
  // — never a guess between several, which is how money reaches the wrong counter.
  const activeTerminal = chooseCardMachine(dojoTerminals, chosenTerminal ?? pinnedMachine);

  const find = useMutation({
    mutationFn: (c: string) => retailClient.findSale(locationId, c),
    onSuccess: (s) => {
      setSale(s);
      setQty({});
      setDamaged({});
      setDone(null);
      setCash(!s.original.supported);
      setMachineError(null);
      // Closed mid-refund last time? Pick the waiting card machine back up.
      if (s.pendingOnMachine) setMachine({ amount: s.pendingOnMachine.amount });
    },
  });

  // Poll the card machine until the customer has tapped (or it gives up).
  useEffect(() => {
    if (!machine || !sale) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await retailClient.pollDojoReturn(sale.order.id);
        if (stop) return;
        if (!r.active || r.done) {
          if (r.active && r.done) setDone({ amount: r.amount, method: "CARD" });
          if (r.sale) setSale(r.sale);
          setMachine(null);
          setMachinePrompt(null);
          setQty({});
          setDamaged({});
          setPin("");
          return;
        }
        if (r.failed) {
          setMachineError(r.message ?? "The card machine didn't complete the refund.");
          if (r.sale) setSale(r.sale);
          setMachine(null);
          setMachinePrompt(null);
          return;
        }
        setMachinePrompt(r.prompt);
      } catch {
        /* a blip — keep polling */
      }
      if (!stop) timer = setTimeout(tick, 2000);
    };
    let timer = setTimeout(tick, 1500);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [machine, sale?.order.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (initialCode) find.mutate(initialCode);
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A scanner at the returns screen reads the receipt, not a product.
  useBarcodeScanner(!sale && !camera && !machine, (c) => {
    setCode(c);
    find.mutate(c);
  });

  const lines = useMemo(
    () =>
      (sale?.items ?? [])
        .filter((i) => (qty[i.id] ?? 0) > 0)
        .map((i) => ({ orderItemId: i.id, quantity: qty[i.id]!, restock: !damaged[i.id] })),
    [sale, qty, damaged],
  );

  // Preview only — the server does the real sum (same formula).
  const preview = useMemo(() => {
    if (!sale) return 0;
    const factor =
      sale.order.subtotal > 0 && sale.order.discount > 0
        ? Math.max(0, sale.order.subtotal - sale.order.discount) / sale.order.subtotal
        : 1;
    const pence = lines.reduce((s, l) => {
      const it = sale.items.find((i) => i.id === l.orderItemId)!;
      return s + Math.round(((it.totalPrice * 100) / it.quantity) * l.quantity * factor);
    }, 0);
    return Math.min(pence, Math.round(sale.refundable * 100)) / 100;
  }, [sale, lines]);

  const submit = useMutation({
    mutationFn: () =>
      retailClient.createReturn({
        orderId: sale!.order.id,
        lines,
        refundMethod: cash ? "CASH" : "ORIGINAL",
        reason,
        ...(needsPin ? { managerPin: pin } : {}),
        ...(onMachine && activeTerminal ? { terminalId: activeTerminal.id } : {}),
      }),
    onSuccess: (r) => {
      if (r.pending) {
        setMachineError(null);
        setMachine({ amount: r.amount });
        return;
      }
      setDone({ amount: r.amount, method: r.method });
      setSale(r.sale);
      setQty({});
      setDamaged({});
      setPin("");
      if (r.method === "CASH") onCashRefunded?.(r.amount);
    },
  });

  const saleLabel = sale
    ? `#${sale.order.orderNumber ?? sale.order.displayId ?? sale.order.id.slice(-6)}`
    : "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <RotateCcw className="h-4 w-4" /> Return items {sale && <span className="text-zinc-500">{saleLabel}</span>}
          </h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
          {/* Find the sale */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) find.mutate(code.trim());
            }}
            className="flex gap-2"
          >
            <input
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Scan the receipt, or type its number"
              className="flex-1 rounded-lg border border-zinc-200 px-3 py-2 focus:border-zinc-900 focus:outline-none"
            />
            {isCameraScanSupported() && (
              <Button type="button" variant="outline" size="icon" onClick={() => setCamera(true)} aria-label="Scan with camera">
                <Camera className="h-4 w-4" />
              </Button>
            )}
            <Button type="submit" variant="secondary" disabled={!code.trim() || find.isPending}>
              {find.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Find"}
            </Button>
          </form>
          {find.isError && <p className="text-xs text-red-600">{errMsg(find.error)}</p>}

          {done && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
              <p className="font-semibold">
                {done.method === "CASH"
                  ? `Give the customer ${money(done.amount)} in cash.`
                  : `${money(done.amount)} refunded to their card.`}
              </p>
              {done.method === "CARD" && (
                <p className="text-xs">Card refunds take 5–10 days to reach the customer&apos;s account.</p>
              )}
            </div>
          )}

          {machine && (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-3 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sky-900"
            >
              <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin" aria-hidden />
              <div>
                <p className="font-semibold">Refunding {money(machine.amount)} on the card machine</p>
                <p className="text-xs">
                  {(machinePrompt && DOJO_PROMPTS[machinePrompt]) ??
                    "Ask the customer to tap or insert the card they paid with."}
                </p>
              </div>
            </div>
          )}
          {machineError && <p className="rounded-lg bg-red-50 p-3 text-xs text-red-700">{machineError}</p>}

          {sale && (
            <>
              <div className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                <span>
                  {new Date(sale.order.createdAt).toLocaleString()} · paid {money(sale.order.total)}
                  {sale.order.paymentMethod ? ` by ${sale.order.paymentMethod.toLowerCase().replace(/_/g, " ")}` : ""}
                </span>
                {sale.refunded > 0 && <span>Refunded so far {money(sale.refunded)}</span>}
              </div>

              {!sale.canReturn ? (
                <p className="rounded-lg bg-amber-50 p-3 text-amber-900">
                  {sale.order.paymentStatus === "REFUNDED"
                    ? "Everything on this receipt has already been refunded."
                    : "This sale hasn't been paid, so there's nothing to refund."}
                </p>
              ) : (
                <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
                  {sale.items.map((it) => {
                    const n = qty[it.id] ?? 0;
                    return (
                      <li key={it.id} className="flex items-center gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-zinc-900">{it.name}</p>
                          <p className="text-xs text-zinc-500">
                            {it.quantity} × {money(it.unitPrice)}
                            {it.returnable < it.quantity &&
                              ` · ${it.quantity - it.returnable} already returned`}
                          </p>
                          {n > 0 && (
                            <label className="mt-1 flex items-center gap-1.5 text-xs text-zinc-600">
                              <input
                                type="checkbox"
                                checked={!!damaged[it.id]}
                                onChange={(e) => setDamaged((d) => ({ ...d, [it.id]: e.target.checked }))}
                              />
                              Damaged — don't put back in stock
                            </label>
                          )}
                        </div>
                        {it.returnable > 0 ? (
                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              variant="outline"
                              size="icon-sm"
                              disabled={n <= 0}
                              aria-label={`One fewer ${it.name}`}
                              onClick={() => setQty((q) => ({ ...q, [it.id]: n - 1 }))}
                            >
                              <Minus className="h-3 w-3" />
                            </Button>
                            <span className="w-6 text-center tabular-nums">{n}</span>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon-sm"
                              disabled={n >= it.returnable}
                              aria-label={`One more ${it.name}`}
                              onClick={() => setQty((q) => ({ ...q, [it.id]: n + 1 }))}
                            >
                              <Plus className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-zinc-400">Returned</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              {sale.canReturn && lines.length > 0 && (
                <div className="space-y-3">
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      Reason
                    </span>
                    <select
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      className="w-full rounded-lg border border-zinc-200 px-3 py-2"
                    >
                      {REASONS.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  </label>

                  {/* A cash sale only ever goes back as cash — no choice to make. */}
                  {sale.original.method === "CARD" && (
                  <div>
                    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      Refund to
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={!sale.original.supported}
                        onClick={() => setCash(false)}
                        className={`rounded-lg border px-3 py-2 text-left text-xs ${
                          !cash ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200"
                        } disabled:opacity-40`}
                      >
                        Their card
                      </button>
                      <button
                        type="button"
                        onClick={() => setCash(true)}
                        className={`rounded-lg border px-3 py-2 text-left text-xs ${
                          cash ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200"
                        }`}
                      >
                        Cash from the till
                      </button>
                    </div>
                    {!sale.original.supported && "note" in sale.original && sale.original.note && (
                      <p className="mt-1 text-xs text-amber-700">{sale.original.note}</p>
                    )}
                  </div>
                  )}

                  {onMachine && !machine && (
                    <div>
                      {dojoQuery.isLoading ? null : dojoTerminals.length === 0 ? (
                        <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
                          No Dojo card machine is connected here — refund it as cash instead.
                        </p>
                      ) : activeTerminal ? (
                        <p className="flex items-center gap-1.5 text-xs text-zinc-600">
                          <CreditCard className="h-3.5 w-3.5" aria-hidden /> On {activeTerminal.label}
                          {dojoTerminals.length > 1 && (
                            <button
                              type="button"
                              onClick={() => setChosenTerminal(null)}
                              className="ml-1 font-medium text-orange-600 hover:underline"
                            >
                              change
                            </button>
                          )}
                        </p>
                      ) : (
                        <div>
                          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                            Which card machine?
                          </span>
                          <div className="flex flex-wrap gap-2">
                            {dojoTerminals.map((t) => (
                              <Button
                                key={t.id}
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => setChosenTerminal(t.id)}
                              >
                                {t.label}
                              </Button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {needsPin && (
                    <label className="block">
                      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                        Manager PIN
                      </span>
                      <input
                        type="password"
                        inputMode="numeric"
                        autoComplete="off"
                        value={pin}
                        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
                        className="w-full rounded-lg border border-zinc-200 px-3 py-2"
                      />
                    </label>
                  )}
                  {submit.isError && <p className="text-xs text-red-600">{errMsg(submit.error)}</p>}
                </div>
              )}
            </>
          )}
        </div>

        {sale?.canReturn && lines.length > 0 && !machine && (
          <footer className="border-t border-zinc-200 p-4">
            <Button
              className="w-full"
              size="lg"
              loading={submit.isPending}
              disabled={submit.isPending || (needsPin && pin.length < 4) || (onMachine && !activeTerminal)}
              onClick={() => submit.mutate()}
            >
              Refund {money(preview)}{" "}
              {cash || sale.original.method === "CASH"
                ? "in cash"
                : onMachine
                  ? "on the card machine"
                  : "to card"}
            </Button>
          </footer>
        )}
      </div>

      {camera && (
        <CameraScanModal
          title="Scan the receipt"
          onClose={() => setCamera(false)}
          onDetected={(c) => {
            setCamera(false);
            setCode(c);
            find.mutate(c);
          }}
        />
      )}
    </div>
  );
}
