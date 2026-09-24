"use client";

// Auto ready — the shop's own timer for marking orders preparing, then ready.
//
// Set per location, off by default. It exists because the marketplaces read
// those two steps: Deliveroo decides when to send a rider from them, and they
// were being sent on almost no orders because reaching "ready" took two taps
// after accepting and a kitchen on printed tickets never made them.
//
// The wording here is deliberately plain about what the timer is: an
// estimate, on the shop's own figures, that staff can always beat by tapping
// Ready themselves.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Timer, X } from "lucide-react";
import { locationsClient } from "@/lib/api/locations.client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Scope = "MARKETPLACE" | "ALL";

interface AutoReady {
  enabled?: boolean;
  preparingAfterMinutes?: number;
  readyAfterMinutes?: number;
  scope?: Scope;
}

export function AutoReadyModal({
  open,
  locationId,
  onClose,
}: {
  open: boolean;
  locationId: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const detailKey = ["locations", "detail", locationId];

  const { data: location, isLoading } = useQuery({
    queryKey: detailKey,
    queryFn: () => locationsClient.get(locationId!),
    enabled: open && !!locationId,
  });

  const saved: AutoReady =
    ((location as unknown as { settings?: { autoReady?: AutoReady } } | undefined)?.settings
      ?.autoReady as AutoReady) ?? {};

  const [enabled, setEnabled] = useState(false);
  const [preparing, setPreparing] = useState("2");
  const [ready, setReady] = useState("15");
  const [scope, setScope] = useState<Scope>("MARKETPLACE");

  // Reload whenever a different shop's settings arrive, so switching
  // location never shows the previous shop's timer.
  useEffect(() => {
    setEnabled(!!saved.enabled);
    setPreparing(String(saved.preparingAfterMinutes ?? 2));
    setReady(String(saved.readyAfterMinutes ?? 15));
    setScope(saved.scope === "ALL" ? "ALL" : "MARKETPLACE");
  }, [location?.id, saved.enabled, saved.preparingAfterMinutes, saved.readyAfterMinutes, saved.scope]);

  const readyNum = Number(ready);
  const preparingNum = Number(preparing);
  const invalid =
    !Number.isFinite(readyNum) ||
    readyNum <= 0 ||
    !Number.isFinite(preparingNum) ||
    preparingNum < 0 ||
    preparingNum > readyNum;

  const save = useMutation({
    mutationFn: () =>
      locationsClient.update(locationId!, {
        settings: {
          autoReady: {
            enabled,
            preparingAfterMinutes: preparingNum,
            readyAfterMinutes: readyNum,
            scope,
          },
        },
      } as any),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: detailKey });
      onClose();
    },
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auto-ready-title"
        className="w-full max-w-lg rounded-xl bg-white shadow-xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-zinc-100 px-5 py-4">
          <div>
            <h2 id="auto-ready-title" className="flex items-center gap-2 text-base font-semibold text-zinc-900">
              <Timer className="h-4 w-4" />
              Auto ready
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Mark orders preparing, then ready, on a timer — so staff don&rsquo;t
              have to tap both on every order.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-900"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-4 px-5 py-4">
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                <span className="block text-sm font-medium text-zinc-800">
                  Turn on for {location?.name ?? "this location"}
                </span>
                <span className="block text-xs text-zinc-500">
                  Off by default. Each shop sets its own times.
                </span>
              </span>
            </label>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs font-medium text-zinc-600">
                  Mark preparing after
                </span>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={240}
                    value={preparing}
                    onChange={(e) => setPreparing(e.target.value)}
                    disabled={!enabled}
                    className="h-9 w-24 text-sm tabular-nums"
                  />
                  <span className="text-sm text-zinc-500">minutes</span>
                </div>
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium text-zinc-600">Mark ready after</span>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={240}
                    value={ready}
                    onChange={(e) => setReady(e.target.value)}
                    disabled={!enabled}
                    className="h-9 w-24 text-sm tabular-nums"
                  />
                  <span className="text-sm text-zinc-500">minutes</span>
                </div>
              </label>
            </div>
            <p className="text-[11px] text-zinc-500">
              Counted from when the order is accepted. A scheduled order is timed from
              when the customer asked for it instead, so it is marked ready at that time.
            </p>

            <label className="space-y-1">
              <span className="text-xs font-medium text-zinc-600">Apply to</span>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as Scope)}
                disabled={!enabled}
                className="block h-9 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-sm text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-900 disabled:opacity-50"
              >
                <option value="MARKETPLACE">
                  Marketplace orders only (Deliveroo, Uber Eats, Just Eat…)
                </option>
                <option value="ALL">Every order, including till and online</option>
              </select>
              <span className="block text-[11px] text-zinc-500">
                Marketplace only is the safer choice: those platforms use the
                times to send a rider, while your own customers are told their
                food is ready.
              </span>
            </label>

            {invalid && (
              <p role="alert" className="text-xs text-red-600">
                Ready must be more than zero minutes, and preparing can&rsquo;t be later
                than ready.
              </p>
            )}

            <p className="rounded-md bg-zinc-50 px-3 py-2 text-[11px] text-zinc-600">
              These times are an estimate, not a check that the food is done. Staff can
              still tap Preparing or Ready early and that always wins — the timer only
              moves an order nobody has moved already. An open table tab is never touched — it stays accepted until staff settle it.
            </p>

            {save.isError && (
              <p role="alert" className="text-xs text-red-600">
                Couldn&rsquo;t save. Please try again.
              </p>
            )}
          </div>
        )}

        <footer className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => save.mutate()}
            disabled={!locationId || (enabled && invalid) || save.isPending}
            className="bg-zinc-900 text-white hover:bg-zinc-800"
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
