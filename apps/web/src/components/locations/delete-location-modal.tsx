"use client";

// Phase AN follow-up: two-step delete confirmation.
//
// Step 1: "Are you sure you want to delete <name>?" — Yes/No.
// Step 2: type "DELETE LOCATION" exactly, then Submit.
//
// Soft-deletes the location (sets deletedAt, isActive=false,
// status=closed). Related rows that belong to the location
// (deliveryZones, paymentConfig, brandPlatformConnections) cascade
// via Prisma onDelete: Cascade declarations. Orders and brands stay
// (they don't cascade) so historical data isn't wiped.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { locationsClient } from "@/lib/api/locations.client";

interface Props {
  locationId: string;
  locationName: string;
  onClose: () => void;
  onDeleted: () => void;
}

const CONFIRM_PHRASE = "DELETE LOCATION";

export function DeleteLocationModal({
  locationId,
  locationName,
  onClose,
  onDeleted,
}: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: () => locationsClient.remove(locationId),
    onSuccess: onDeleted,
    onError: (err: any) =>
      setError(err?.response?.data?.message ?? err.message ?? "Failed"),
  });

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="grid h-7 w-7 place-items-center rounded-full bg-red-50 text-red-600">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <h2 className="text-sm font-semibold text-zinc-900">
              Delete location
            </h2>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </header>

        {step === 1 && (
          <div className="space-y-4 p-4">
            <p className="text-sm text-zinc-700">
              Are you sure you want to delete <strong>{locationName}</strong>?
            </p>
            <p className="text-xs text-zinc-500">
              Brands, delivery zones, opening hours, channel connections and
              location settings will be removed. Historical orders are kept.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                onClick={() => setStep(2)}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
              >
                Yes, delete
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3 p-4">
            <p className="text-sm text-zinc-700">
              Type <strong className="font-mono">{CONFIRM_PHRASE}</strong> to confirm.
            </p>
            <input
              autoFocus
              value={phrase}
              onChange={(e) => setPhrase(e.target.value.toUpperCase())}
              placeholder={CONFIRM_PHRASE}
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm font-mono uppercase focus:border-red-500 focus:outline-none"
            />
            {error && (
              <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setStep(1)}
                className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm hover:bg-zinc-50"
              >
                Back
              </button>
              <button
                onClick={() => remove.mutate()}
                disabled={phrase !== CONFIRM_PHRASE || remove.isPending}
                className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {remove.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Submit
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
