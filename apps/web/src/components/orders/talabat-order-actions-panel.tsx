"use client";

// Talabat order actions — what the kitchen can do to a live Talabat order:
//   • Rider waiting warning (AWT) — Talabat tell us their rider is waiting and
//     when a waiting fee starts; shown loudly until they clear it.
//   • Move the rider pickup time (AWT prep-time adjustment) — Talabat's own
//     suggested steps, within the window the order arrived with.
//   • Out-of-stock lines — remove a line, or reduce its quantity, where the
//     customer allowed it (itemUnavailabilityHandling).
//   • Re-send — anything Talabat haven't heard about yet (e.g. an accept that
//     failed while the network was down).

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Clock, Loader2, PackageX, RefreshCw } from "lucide-react";
import toast from "react-hot-toast";
import { talabatClient } from "@/lib/api/talabat.client";

interface TalabatMeta {
  kind?: "OWN_DELIVERY" | "VENDOR_DELIVERY" | "PICKUP";
  test?: boolean;
  riderPickupTime?: string | null;
  prepAdjustedTo?: string | null;
  expiresAt?: string | null;
  callbackUrls?: Record<string, string | null>;
  prepTime?: { preparationTimeChangeIntervalsInMinutes?: number[] } | null;
  riderWaiting?: { since?: string; feeFrom?: string | null } | null;
  sent?: Record<string, string>;
  modification?: { status?: string; code?: string | null } | null;
  lines?: Array<{ id: string | null; remoteCode: string | null; name: string | null; quantity: number; handling: string | null }>;
  promotions?: { total?: number; vendorFunded?: number; platformFunded?: number } | null;
}

const hhmm = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";

export function TalabatOrderActionsPanel({ orderId, metadata }: { orderId: string; metadata: unknown }) {
  const t = ((metadata ?? {}) as { talabat?: TalabatMeta }).talabat ?? {};
  const [open, setOpen] = useState(!!t.riderWaiting);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (label: string, call: () => Promise<unknown>, ok: string) => {
    setBusy(label);
    try {
      await call();
      toast.success(ok);
    } catch (e: any) {
      toast.error(`${label}: ${e?.response?.data?.message ?? e?.message ?? "failed"}`);
    } finally {
      setBusy(null);
    }
  };

  const steps = t.prepTime?.preparationTimeChangeIntervalsInMinutes?.length
    ? t.prepTime.preparationTimeChangeIntervalsInMinutes
    : [5, 10, 15];
  const canAdjust = !!t.callbackUrls?.orderPreparationTimeAdjustmentUrl;
  const canModify = !!t.callbackUrls?.orderProductModificationUrl && !!t.sent?.accept;

  return (
    <div className="border-t border-zinc-200 px-5 py-4">
      {t.riderWaiting && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <b>Talabat rider is waiting</b> since {hhmm(t.riderWaiting.since)}
            {t.riderWaiting.feeFrom ? <> — a waiting fee applies from {hhmm(t.riderWaiting.feeFrom)}</> : null}.
          </div>
        </div>
      )}
      {t.test && (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
          Talabat TEST order — do not prepare.
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-zinc-400"
      >
        <span>Talabat</span>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
      {open && (
        <div className="mt-3 space-y-3 text-xs">
          <div className="text-zinc-600">
            {t.kind === "OWN_DELIVERY" ? "Talabat rider collects" : t.kind === "PICKUP" ? "Customer collects" : "You deliver"}
            {t.riderPickupTime ? ` · rider pickup ${hhmm(t.prepAdjustedTo ?? t.riderPickupTime)}` : ""}
            {!t.sent?.accept && t.expiresAt ? ` · accept by ${hhmm(t.expiresAt)}` : ""}
            {t.promotions?.total ? ` · discount ${t.promotions.total.toFixed(2)} (you paid ${Number(t.promotions.vendorFunded ?? 0).toFixed(2)})` : ""}
          </div>

          {canAdjust && (
            <div>
              <div className="mb-1 flex items-center gap-1 font-medium text-zinc-700">
                <Clock className="h-3.5 w-3.5" /> Move rider pickup
              </div>
              <div className="flex flex-wrap gap-1.5">
                {steps.map((m) => (
                  <button
                    key={m}
                    type="button"
                    disabled={!!busy}
                    onClick={() =>
                      run(
                        "Prep time",
                        () => talabatClient.prepTime(orderId, { minutes: m }),
                        `Rider pickup moved ${m > 0 ? "later" : "earlier"} by ${Math.abs(m)} min`,
                      )
                    }
                    className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-50 disabled:opacity-40"
                  >
                    {m > 0 ? `+${m}` : m} min
                  </button>
                ))}
              </div>
            </div>
          )}

          {canModify && (t.lines?.length ?? 0) > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1 font-medium text-zinc-700">
                <PackageX className="h-3.5 w-3.5" /> Out of stock
                {t.modification?.status === "PENDING" && <span className="ml-1 text-amber-700">(waiting for Talabat)</span>}
                {t.modification?.status === "FAILED" && <span className="ml-1 text-red-700">(last change refused: {t.modification.code})</span>}
              </div>
              <ul className="space-y-1">
                {t.lines!.map((l) =>
                  l.id ? (
                    <li key={l.id} className="flex items-center justify-between gap-2">
                      <span className="truncate text-zinc-700">
                        {l.quantity}× {l.name}
                      </span>
                      <span className="flex gap-1">
                        {(!l.handling || l.handling === "REMOVE") && (
                          <button
                            type="button"
                            disabled={!!busy || t.modification?.status === "PENDING"}
                            onClick={() =>
                              confirm(`Remove "${l.name}" from this Talabat order?`) &&
                              run("Remove item", () => talabatClient.modify(orderId, [{ productId: l.id!, remove: true }]), "Asked Talabat to remove it")
                            }
                            className="rounded border border-red-200 px-2 py-0.5 text-red-700 hover:bg-red-50 disabled:opacity-40"
                          >
                            Remove
                          </button>
                        )}
                        {l.quantity > 1 && (!l.handling || l.handling === "REDUCE_QUANTITY") && (
                          <button
                            type="button"
                            disabled={!!busy || t.modification?.status === "PENDING"}
                            onClick={() =>
                              run(
                                "Reduce quantity",
                                () => talabatClient.modify(orderId, [{ productId: l.id!, quantity: l.quantity - 1 }]),
                                "Asked Talabat to reduce it",
                              )
                            }
                            className="rounded border border-zinc-300 px-2 py-0.5 hover:bg-zinc-50 disabled:opacity-40"
                          >
                            −1
                          </button>
                        )}
                        {l.handling && !["REMOVE", "REDUCE_QUANTITY"].includes(l.handling) && (
                          <span className="text-[10px] text-zinc-500">
                            {l.handling === "CALL_CUSTOMER_AND_REPLACE" ? "call the customer" : "cancel if unavailable"}
                          </span>
                        )}
                      </span>
                    </li>
                  ) : null,
                )}
              </ul>
            </div>
          )}

          <button
            type="button"
            disabled={!!busy}
            onClick={() => run("Re-send", () => talabatClient.resync(orderId), "Re-sent to Talabat")}
            className="inline-flex items-center gap-1 rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-50 disabled:opacity-40"
          >
            {busy === "Re-send" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Re-send status to Talabat
          </button>
        </div>
      )}
    </div>
  );
}
