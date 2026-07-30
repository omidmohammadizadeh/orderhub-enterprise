"use client";

// Manager PIN — the code that authorises voiding or comping a line.
//
// Per location, not per user: on a busy floor the manager types it on
// whichever tablet the waiter is holding, and it has to work on all of them.
// Stored bcrypt-hashed server-side; this screen can set it and can tell you
// whether one exists, but can never read it back. If it's forgotten, it gets
// replaced — that's the correct behaviour for a credential.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { KeyRound, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";

export function ManagerPinModal({
  locationId,
  onClose,
}: {
  locationId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  const statusQuery = useQuery<{ configured: boolean }>({
    queryKey: ["manager-pin", locationId],
    queryFn: () =>
      apiClient
        .get(`/v1/orders/locations/${locationId}/manager-pin`)
        .then((r) => r.data),
  });

  const save = useMutation({
    mutationFn: () =>
      apiClient.post(`/v1/orders/locations/${locationId}/manager-pin`, { pin }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["manager-pin", locationId] });
      toast.success("Manager PIN saved");
      onClose();
    },
    onError: (e: any) =>
      setError(e?.response?.data?.message ?? "Couldn't save the PIN"),
  });

  const valid = /^\d{4,8}$/.test(pin);
  const matches = pin === confirm;

  return (
    <div className="fixed inset-0 z-[75] grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
            <KeyRound className="h-4 w-4" /> Manager PIN
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3 p-5">
          <p className="text-[12px] text-zinc-600">
            Required to void or comp an item. Anyone with this PIN can remove a
            charge from a bill, so keep it to managers.
          </p>

          {statusQuery.data?.configured && (
            <p className="flex items-center gap-1.5 rounded-md bg-emerald-50 p-2.5 text-[12px] text-emerald-800">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
              A PIN is already set. Entering a new one replaces it — the old one
              can&rsquo;t be shown.
            </p>
          )}

          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700">
              New PIN
            </label>
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={8}
              placeholder="4–8 digits"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-lg tracking-[0.3em]"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700">
              Confirm
            </label>
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ""))}
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={8}
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-lg tracking-[0.3em]"
            />
            {confirm.length > 0 && !matches && (
              <p className="mt-1 text-[11px] text-red-600">
                The two PINs don&rsquo;t match.
              </p>
            )}
          </div>

          {error && <p className="text-[12px] text-red-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!valid || !matches}
            loading={save.isPending}
          >
            {statusQuery.data?.configured ? "Replace PIN" : "Set PIN"}
          </Button>
        </div>
      </div>
    </div>
  );
}
