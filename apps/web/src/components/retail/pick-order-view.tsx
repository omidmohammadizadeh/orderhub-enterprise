"use client";

// Retail R3 — picking one online order, aisle by aisle.
//
// Scan a product to tick it off (the scanner finds its line); tap − / + for
// things without a barcode; "Swap" puts a substitute in when the shopper
// allowed it. Finishing refunds whatever didn't make it into the bag and
// marks the order ready for the courier or for collection.

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Ban, Check, Minus, Plus, Repeat, ScanBarcode, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBarcodeScanner } from "@/lib/pos/barcode-scanner";
import { retailClient, type BarcodeEntry, type PickLine, type PickOrder, type PickSub } from "@/lib/api/retail.client";
import { DispatchModal } from "@/components/orders/dispatch-modal";
import { SubstitutePicker } from "./substitute-picker";

const errMsg = (e: any) => e?.response?.data?.message ?? e?.message ?? "Something went wrong";
const COURIER_FULFILMENT = new Set(["DELIVERY", "MERCHANT_DELIVERY", "PLATFORM_COURIER"]);

export function PickOrderView({
  order,
  locationId,
  index,
  money,
  onBack,
}: {
  order: PickOrder;
  locationId: string;
  index: BarcodeEntry[];
  money: (n: number) => string;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const [subFor, setSubFor] = useState<PickLine | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["retail-picking", locationId] });
  const done = !!order.picking?.completedAt;
  const ref = `#${order.orderNumber ?? order.displayId ?? order.id.slice(-6)}`;

  const setLine = useMutation({
    mutationFn: (v: { line: PickLine; picked: number; sub?: PickSub | null }) =>
      retailClient.pickLine(order.id, v.line.id, {
        picked: v.picked,
        sub: v.sub === undefined ? (v.line.pick?.sub ?? null) : v.sub,
      }),
    onSuccess: refresh,
    onError: (e) => toast.error(errMsg(e)),
  });

  const complete = useMutation({
    mutationFn: () => retailClient.completePicking(order.id),
    onSuccess: (r) => {
      setConfirming(false);
      toast.success(
        r.refund > 0
          ? r.settledBy === "CARD"
            ? `Picked — ${money(r.refund)} refunded to the customer's card`
            : r.settledBy === "CASH_COLLECT"
              ? `Picked — collect ${money(r.refund)} less`
              : `Picked — ${money(r.refund)} is owed to the customer: refund it by hand`
          : "Picked — everything was found",
      );
      refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const picked = (l: PickLine) => l.pick?.picked ?? 0;
  const subQty = (l: PickLine) => l.pick?.sub?.qty ?? 0;
  const left = (l: PickLine) => l.quantity - picked(l) - subQty(l);

  // A scan ticks the first line with that barcode that still needs one.
  useBarcodeScanner(!done && !subFor && !confirming && !dispatchOpen, (code) => {
    const line = order.lines.find((l) => l.barcodes.includes(code) && left(l) > 0);
    if (line) {
      setLine.mutate({ line, picked: picked(line) + 1 });
      toast.success(`${line.name} ✓`, { duration: 1200 });
    } else if (order.lines.some((l) => l.barcodes.includes(code))) {
      toast("Already got all of those", { icon: "ℹ️" });
    } else {
      toast.error(`${code} isn't on this order`);
    }
  });

  const aisles = useMemo(() => {
    const groups = new Map<string, PickLine[]>();
    for (const l of order.lines) groups.set(l.aisle, [...(groups.get(l.aisle) ?? []), l]);
    return [...groups.entries()];
  }, [order.lines]);

  const totals = order.lines.reduce(
    (t, l) => ({ units: t.units + l.quantity, found: t.found + picked(l) + subQty(l), missing: t.missing + left(l) }),
    { units: 0, found: 0, missing: 0 },
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 pb-3">
        <div>
          <button type="button" onClick={onBack} className="text-xs font-medium text-orange-600 lg:hidden">
            ← All orders
          </button>
          <h2 className="text-base font-semibold text-zinc-900">
            {ref} · {order.customerName || "Customer"}
          </h2>
          <p className="text-xs text-zinc-500">
            {order.fulfillmentType === "PICKUP" ? "Collection" : "Delivery"}
            {order.scheduledFor
              ? ` · for ${new Date(order.scheduledFor).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
              : " · ASAP"}
            {" · "}
            {totals.found}/{totals.units} items
          </p>
        </div>
        {!done && (
          <p className="flex items-center gap-1.5 rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-600">
            <ScanBarcode className="h-3.5 w-3.5" /> Scan items to tick them off
          </p>
        )}
      </header>

      {order.specialInstructions && (
        <p className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">Note: {order.specialInstructions}</p>
      )}

      <div className="mt-3 flex-1 space-y-4 overflow-y-auto pb-4">
        {aisles.map(([aisle, lines]) => (
          <section key={aisle}>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{aisle}</h3>
            <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white">
              {lines.map((l) => {
                const complete = left(l) === 0;
                return (
                  <li key={l.id} className={`flex flex-wrap items-center gap-3 px-3 py-2.5 ${complete ? "bg-emerald-50/60" : ""}`}>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-zinc-900">
                        <span className="mr-1 tabular-nums">{l.quantity}×</span>
                        {l.name}
                      </p>
                      <p className="text-[11px] text-zinc-500">
                        {money(l.unitPrice)}
                        {l.modifiers?.length ? ` · ${l.modifiers.map((m) => m.name).join(", ")}` : ""}
                        {l.notes ? ` · “${l.notes}”` : ""}
                      </p>
                      {l.substitution === "NONE" && (
                        <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-red-600">
                          <Ban className="h-3 w-3" /> No substitutes
                        </p>
                      )}
                      {l.pick?.sub && (
                        <p className="mt-0.5 text-[11px] font-medium text-sky-700">
                          Swapped {l.pick.sub.qty} for {l.pick.sub.name}
                          {!done && (
                            <button
                              type="button"
                              className="ml-2 text-zinc-500 underline"
                              onClick={() => setLine.mutate({ line: l, picked: picked(l), sub: null })}
                            >
                              undo
                            </button>
                          )}
                        </p>
                      )}
                      {left(l) > 0 && (picked(l) > 0 || l.pick) && (
                        <p className="mt-0.5 text-[11px] text-amber-700">{left(l)} not found</p>
                      )}
                    </div>
                    {done ? (
                      <span className="text-xs text-zinc-500">
                        {picked(l)} picked{subQty(l) ? `, ${subQty(l)} swapped` : ""}
                        {left(l) ? `, ${left(l)} missing` : ""}
                      </span>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon-sm"
                          variant="outline"
                          aria-label={`One fewer ${l.name}`}
                          disabled={picked(l) === 0 || setLine.isPending}
                          onClick={() => setLine.mutate({ line: l, picked: picked(l) - 1 })}
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </Button>
                        <span className="w-10 text-center text-sm font-semibold tabular-nums">
                          {picked(l)}/{l.quantity}
                        </span>
                        <Button
                          size="icon-sm"
                          variant="outline"
                          aria-label={`Picked one more ${l.name}`}
                          disabled={left(l) === 0 || setLine.isPending}
                          onClick={() => setLine.mutate({ line: l, picked: picked(l) + 1 })}
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </Button>
                        {l.substitution !== "NONE" && left(l) > 0 && (
                          <Button size="sm" variant="ghost" onClick={() => setSubFor(l)}>
                            <Repeat className="mr-1 h-3.5 w-3.5" /> Swap
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <footer className="border-t border-zinc-200 pt-3">
        {done ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-sm text-emerald-700">
              <Check className="h-4 w-4" /> Picked
              {order.picking!.refund > 0
                ? order.picking!.settledBy === "CASH_COLLECT"
                  ? ` · collect ${money(order.picking!.refund)} less`
                  : order.picking!.settledBy === "OWED"
                    ? ` · ${money(order.picking!.refund)} owed — refund by hand`
                    : ` · ${money(order.picking!.refund)} refunded to card`
                : ""}
            </p>
            {COURIER_FULFILMENT.has(order.fulfillmentType) && (
              <Button onClick={() => setDispatchOpen(true)}>
                <Truck className="mr-1.5 h-4 w-4" /> Hand to courier
              </Button>
            )}
          </div>
        ) : confirming ? (
          <div className="space-y-2">
            <p className="text-sm text-zinc-800">
              {totals.missing > 0
                ? `${totals.missing} item${totals.missing === 1 ? "" : "s"} not found — the customer won't be charged for ${totals.missing === 1 ? "it" : "them"}.`
                : "Everything found."}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setConfirming(false)}>
                Keep picking
              </Button>
              <Button className="flex-1" loading={complete.isPending} onClick={() => complete.mutate()}>
                Finish picking
              </Button>
            </div>
          </div>
        ) : (
          <Button className="w-full" size="lg" onClick={() => setConfirming(true)}>
            Done — {totals.found}/{totals.units} in the bag
          </Button>
        )}
      </footer>

      {subFor && (
        <SubstitutePicker
          lineName={subFor.name}
          maxQty={left(subFor) + subQty(subFor)}
          index={index}
          money={money}
          onClose={() => setSubFor(null)}
          onPick={(sub) => {
            setLine.mutate({ line: subFor, picked: picked(subFor), sub });
            setSubFor(null);
          }}
        />
      )}
      {dispatchOpen && (
        <DispatchModal
          orderId={order.id}
          locationId={locationId}
          orderRef={ref}
          onClose={() => {
            setDispatchOpen(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}
