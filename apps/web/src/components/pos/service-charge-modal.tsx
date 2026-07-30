"use client";

// Service charge setup — lives on the POS top bar next to Delivery fee and
// Promos, because it is the same kind of thing: a money rule the manager
// sets once and the till then applies without being asked.
//
// The charge itself is calculated SERVER-SIDE on every order (see
// service-charge.ts). This screen only writes the rule.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Percent, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { locationsClient } from "@/lib/api/locations.client";
import { queryKeys } from "@/lib/api/query-keys";

export function ServiceChargeModal({
  locationId,
  onClose,
}: {
  locationId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const locationQuery = useQuery({
    queryKey: queryKeys.locationDetail(locationId),
    queryFn: () => locationsClient.get(locationId),
  });

  const settings = ((locationQuery.data as any)?.settings ?? {}) as Record<
    string,
    any
  >;
  const existing = settings.serviceCharge ?? {};

  const [enabled, setEnabled] = useState(false);
  const [percent, setPercent] = useState("10");
  const [dineInOnly, setDineInOnly] = useState(true);
  const [label, setLabel] = useState("Service charge");

  // Seed once the location lands.
  useEffect(() => {
    if (!locationQuery.data) return;
    setEnabled(!!existing.enabled);
    setPercent(String(existing.percent ?? 10));
    setDineInOnly(existing.dineInOnly !== false);
    setLabel(existing.label || "Service charge");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationQuery.data]);

  const save = useMutation({
    mutationFn: () =>
      // The locations PATCH shallow-merges only the TOP level, so the whole
      // settings object has to be spread or sibling keys (table service,
      // printers…) are wiped.
      locationsClient.update(locationId, {
        settings: {
          ...settings,
          serviceCharge: {
            enabled,
            percent: Math.max(0, Math.min(25, Number(percent) || 0)),
            dineInOnly,
            label: label.trim() || "Service charge",
          },
        },
      } as any),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.locationDetail(locationId) });
      toast.success("Service charge saved");
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't save"),
  });

  const pct = Math.max(0, Math.min(25, Number(percent) || 0));

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
            <Percent className="h-4 w-4" /> Service charge
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              <span className="block text-sm font-medium text-zinc-900">
                Add a service charge automatically
              </span>
              <span className="block text-[11px] text-zinc-500">
                Applied to every qualifying bill — staff don&rsquo;t have to
                remember.
              </span>
            </span>
          </label>

          {enabled && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-zinc-700">
                    Percentage
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={25}
                      step={0.5}
                      value={percent}
                      onChange={(e) => setPercent(e.target.value)}
                      className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    />
                    <span className="text-sm text-zinc-500">%</span>
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-400">
                    Capped at 25%.
                  </p>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-zinc-700">
                    Shown on the bill as
                  </label>
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    maxLength={30}
                    className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <label className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={dineInOnly}
                  onChange={(e) => setDineInOnly(e.target.checked)}
                  className="mt-0.5 h-4 w-4"
                />
                <span>
                  <span className="block text-sm font-medium text-zinc-900">
                    Dine-in only
                  </span>
                  <span className="block text-[11px] text-zinc-500">
                    Leave on unless you really want it on takeaway and
                    delivery too.
                  </span>
                </span>
              </label>

              <div className="rounded-md bg-zinc-50 p-3 text-[12px] text-zinc-600">
                On a £60.00 bill this adds{" "}
                <b>£{((60 * pct) / 100).toFixed(2)}</b> — total{" "}
                <b>£{(60 + (60 * pct) / 100).toFixed(2)}</b>.
                <span className="mt-1 block text-[11px] text-zinc-500">
                  Charged on the bill after any discount.
                </span>
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
