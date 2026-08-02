"use client";

// "Order together" — the host's way in.
//
// Two decisions, both of which have to be made before anyone else can join:
// what to call yourself (every line in the basket is labelled with a name, and
// the kitchen bags by it) and delivery or collection (it decides the fees the
// group is sharing, so it can't move once people have started adding).

import { useEffect, useState } from "react";
import { Loader2, Users, X } from "lucide-react";

export function StartGroupOrderModal({
  storeName,
  initialName,
  fulfillmentType,
  acceptDelivery,
  acceptCollection,
  isCreating,
  error,
  onStart,
  onClose,
}: {
  storeName: string;
  initialName: string;
  fulfillmentType: "DELIVERY" | "PICKUP";
  acceptDelivery: boolean;
  acceptCollection: boolean;
  isCreating: boolean;
  error: string | null;
  onStart: (name: string, fulfillmentType: "DELIVERY" | "PICKUP") => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [type, setType] = useState<"DELIVERY" | "PICKUP">(
    // Fall back to whichever type the shop actually offers, so a
    // collection-only shop never opens a delivery basket.
    fulfillmentType === "DELIVERY" && !acceptDelivery ? "PICKUP" : fulfillmentType,
  );

  useEffect(() => {
    if (initialName && !name) setName(initialName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialName]);

  const canStart = name.trim().length > 0 && !isCreating;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 px-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl bg-white p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-1.5 text-base font-bold text-zinc-900">
              <Users className="h-4 w-4 text-orange-500" /> Order together
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Everyone adds their own items to one basket at {storeName}. You
              get the link to share, and you place and pay for the order at the
              end.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Your name
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canStart) onStart(name, type);
              }}
              placeholder="e.g. Sarah"
              maxLength={40}
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-zinc-400">
              Shown next to the items you add, so the shop knows whose is
              whose.
            </p>
          </div>

          {acceptDelivery && acceptCollection && (
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                Delivery or collection
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setType("DELIVERY")}
                  className={`flex-1 rounded-md border px-3 py-2 text-xs font-medium ${
                    type === "DELIVERY"
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 text-zinc-600 hover:border-zinc-300"
                  }`}
                >
                  Delivery
                </button>
                <button
                  type="button"
                  onClick={() => setType("PICKUP")}
                  className={`flex-1 rounded-md border px-3 py-2 text-xs font-medium ${
                    type === "PICKUP"
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 text-zinc-600 hover:border-zinc-300"
                  }`}
                >
                  Collection
                </button>
              </div>
              <p className="mt-1 text-[11px] text-zinc-400">
                Fixed for the whole group — it decides the fees everyone is
                sharing.
              </p>
            </div>
          )}

          {error && <p className="text-[11px] text-red-600">{error}</p>}

          <button
            type="button"
            onClick={() => onStart(name, type)}
            disabled={!canStart}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
          >
            {isCreating && <Loader2 className="h-4 w-4 animate-spin" />}
            Start group order
          </button>
        </div>
      </div>
    </div>
  );
}
