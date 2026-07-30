"use client";

// Void or comp a line off an open bill.
//
// Two different acts, kept apart on purpose:
//   VOID — rung in by mistake, should never have been on the bill.
//   COMP — given away deliberately (a complaint, a regular, a birthday).
//
// They look identical to the customer and completely different in the
// books: voids point at training, comps at generosity. The reason is
// mandatory so a month of write-offs can actually be read later.
//
// A manager PIN is required because the person who wants a charge removed
// is often the person who took the money.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Ban, Loader2, X } from "lucide-react";
import { apiClient } from "@/lib/api/client";

const money = (n: number) => `£${Number(n).toFixed(2)}`;

export function VoidItemModal({
  orderId,
  locationId,
  onClose,
  onChanged,
}: {
  orderId: string;
  locationId: string;
  onClose: () => void;
  /** Fired after a successful write-off so the caller can refresh totals. */
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [type, setType] = useState<"VOID" | "COMP">("VOID");
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  const orderQuery = useQuery<any>({
    queryKey: ["void-order", orderId],
    queryFn: () => apiClient.get(`/v1/orders/${orderId}`).then((r) => r.data),
  });
  const items: any[] = orderQuery.data?.items ?? [];

  const pinQuery = useQuery<{ configured: boolean }>({
    queryKey: ["manager-pin", locationId],
    queryFn: () =>
      apiClient
        .get(`/v1/orders/locations/${locationId}/manager-pin`)
        .then((r) => r.data),
  });

  const submit = useMutation({
    mutationFn: () =>
      apiClient.post(`/v1/orders/${orderId}/items/${selected}/void`, {
        pin,
        reason: reason.trim(),
        type,
      }),
    onSuccess: () => {
      toast.success(type === "COMP" ? "Item comped" : "Item voided");
      setSelected(null);
      setReason("");
      setPin("");
      setError(null);
      // Refresh the line list in place — staff often void two things at once.
      qc.invalidateQueries({ queryKey: ["void-order", orderId] });
      onChanged();
    },
    onError: (e: any) =>
      setError(e?.response?.data?.message ?? "Couldn't remove that line"),
  });

  const alreadyVoided = (it: any) => !!it?.metadata?.void;
  const canSubmit =
    !!selected && reason.trim().length >= 3 && pin.length >= 4 && !submit.isPending;

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
              <Ban className="h-4 w-4" /> Void or comp an item
            </h2>
            <p className="text-[11px] text-zinc-500">
              Needs a manager PIN. The line stays on record.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3 p-5">
          {pinQuery.data && !pinQuery.data.configured && (
            <p className="rounded-md bg-amber-50 p-3 text-[12px] text-amber-800">
              No manager PIN is set for this location yet. Set one in the
              location&rsquo;s settings before you can void a line.
            </p>
          )}

          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              Which line?
            </p>
            <div className="max-h-40 overflow-y-auto rounded-md border border-zinc-200 p-1.5">
              {orderQuery.isLoading ? (
                <p className="py-3 text-center text-xs text-zinc-400">
                  Loading…
                </p>
              ) : (
                items.map((it: any) => {
                  const dead = alreadyVoided(it);
                  const on = selected === it.id;
                  return (
                    <button
                      key={it.id}
                      disabled={dead}
                      onClick={() => setSelected(it.id)}
                      className={
                        "mb-1 flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs " +
                        (dead
                          ? "cursor-not-allowed text-zinc-400 line-through"
                          : on
                            ? "bg-red-50 text-red-900"
                            : "text-zinc-700 hover:bg-zinc-50")
                      }
                    >
                      <span>
                        {it.quantity}× {it.name}
                        {dead && (
                          <span className="ml-1.5 text-[9px] font-semibold uppercase tracking-wide no-underline">
                            {String(it.metadata.void.type).toLowerCase()}
                          </span>
                        )}
                      </span>
                      <span className="font-medium">
                        {money(
                          dead
                            ? Number(it.metadata.void.originalTotal ?? 0)
                            : Number(it.totalPrice),
                        )}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              Why?
            </p>
            <div className="mb-2 flex gap-1.5">
              <button
                onClick={() => setType("VOID")}
                className={
                  type === "VOID"
                    ? "flex-1 rounded-md bg-zinc-900 px-2 py-2 text-xs font-semibold text-white"
                    : "flex-1 rounded-md border border-zinc-200 px-2 py-2 text-xs font-medium text-zinc-700"
                }
              >
                Void
                <span className="mt-0.5 block text-[10px] font-normal opacity-70">
                  Rung in by mistake
                </span>
              </button>
              <button
                onClick={() => setType("COMP")}
                className={
                  type === "COMP"
                    ? "flex-1 rounded-md bg-zinc-900 px-2 py-2 text-xs font-semibold text-white"
                    : "flex-1 rounded-md border border-zinc-200 px-2 py-2 text-xs font-medium text-zinc-700"
                }
              >
                Comp
                <span className="mt-0.5 block text-[10px] font-normal opacity-70">
                  Given away on purpose
                </span>
              </button>
            </div>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                type === "COMP"
                  ? "e.g. cold on arrival, comped by manager"
                  : "e.g. wrong table, keyed twice"
              }
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              Manager PIN
            </label>
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              placeholder="••••"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-lg tracking-[0.3em]"
            />
          </div>

          {error && <p className="text-[12px] text-red-600">{error}</p>}

          <button
            onClick={() => submit.mutate()}
            disabled={!canSubmit}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-red-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          >
            {submit.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : type === "COMP" ? (
              "Comp this item"
            ) : (
              "Void this item"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
