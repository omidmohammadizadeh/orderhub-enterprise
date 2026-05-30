"use client";

// Phase AM — Delivery Fee setup modal.
//
// Opened from the POS top bar. Lets a manager configure the delivery-zone
// list for THIS location: each row = a postcode prefix + fee + optional
// minimum order value. The cart panel's lookup hits the same zones.
//
// Postcode prefix is normalised to its first 4 chars (e.g. user types
// "NE10 8YH" → stored as "NE10"). 4 chars covers the UK "outward+area"
// granularity that POS operators commonly use to price delivery.

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { deliveryZonesClient, type DeliveryZone } from "@/lib/api/pos.client";

interface Props {
  locationId: string;
  onClose: () => void;
}

/** Take the first 4 characters of a UK postcode, uppercase, no whitespace.
 *  "ne10 8yh" → "NE10". "SW1A" stays "SW1A". Single-letter areas like
 *  "M1 1AA" still yield 4 chars ("M11A") — slightly odd, but the cart's
 *  longest-prefix matcher still does the right thing. */
function normalisePrefix(raw: string): string {
  return (raw ?? "").toUpperCase().replace(/\s+/g, "").slice(0, 4);
}

export function DeliveryFeeModal({ locationId, onClose }: Props) {
  const qc = useQueryClient();

  const zonesQuery = useQuery<DeliveryZone[]>({
    queryKey: ["delivery-zones", locationId],
    queryFn: () => deliveryZonesClient.list(locationId),
  });

  const [newPrefix, setNewPrefix] = useState("");
  const [newFee, setNewFee] = useState("");
  const [newMin, setNewMin] = useState("");
  const [error, setError] = useState<string | null>(null);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["delivery-zones", locationId] });

  const create = useMutation({
    mutationFn: () => {
      const prefix = normalisePrefix(newPrefix);
      const fee = Number(newFee);
      if (!prefix) throw new Error("Postcode prefix required");
      if (!Number.isFinite(fee) || fee < 0) throw new Error("Fee must be ≥ 0");
      return deliveryZonesClient.create({
        locationId,
        postcodePrefix: prefix,
        fee,
        minOrderValue: newMin ? Number(newMin) : undefined,
      });
    },
    onSuccess: () => {
      setNewPrefix("");
      setNewFee("");
      setNewMin("");
      setError(null);
      invalidate();
    },
    onError: (err: any) => {
      setError(err?.response?.data?.message ?? err.message ?? "Failed");
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deliveryZonesClient.remove(id),
    onSuccess: invalidate,
  });

  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      deliveryZonesClient.update(id, { isActive }),
    onSuccess: invalidate,
  });

  // Auto-clear error after a few seconds so it doesn't linger.
  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 4000);
    return () => window.clearTimeout(t);
  }, [error]);

  const zones = zonesQuery.data ?? [];

  return (
    <Backdrop onClose={onClose}>
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">Delivery fees</h2>
            <p className="text-xs text-zinc-500">
              First 4 characters of the postcode — e.g. NE10, NE11, SW1A
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Existing zones */}
        <div className="max-h-72 overflow-y-auto">
          {zonesQuery.isLoading ? (
            <p className="py-6 text-center text-xs text-zinc-400">Loading…</p>
          ) : zones.length === 0 ? (
            <p className="py-6 text-center text-xs text-zinc-400">
              No zones yet. Add one below.
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead className="border-b border-zinc-100 bg-zinc-50 text-[10px] uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="px-3 py-1.5 text-left">Postcode</th>
                  <th className="px-3 py-1.5 text-right">Fee (£)</th>
                  <th className="px-3 py-1.5 text-right">Min order (£)</th>
                  <th className="px-3 py-1.5 text-center">Active</th>
                  <th className="px-3 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {zones.map((z) => (
                  <tr key={z.id} className="border-b border-zinc-50 last:border-0">
                    <td className="px-3 py-1.5 font-mono font-semibold">
                      {z.postcodePrefix}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      £{Number(z.fee).toFixed(2)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {z.minOrderValue ? `£${Number(z.minOrderValue).toFixed(2)}` : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={z.isActive}
                        onChange={() =>
                          toggle.mutate({ id: z.id, isActive: !z.isActive })
                        }
                        className="h-3 w-3"
                      />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm(`Delete ${z.postcodePrefix}?`)) remove.mutate(z.id);
                        }}
                        className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Add row */}
        <div className="border-t border-zinc-200 px-4 py-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Add zone
          </p>
          <div className="grid grid-cols-[1fr,auto,auto,auto] items-center gap-2">
            <input
              value={newPrefix}
              onChange={(e) => setNewPrefix(e.target.value.toUpperCase())}
              placeholder="NE10"
              maxLength={4}
              className="rounded-md border border-zinc-200 px-2 py-1.5 text-xs font-mono uppercase focus:border-zinc-900 focus:outline-none"
            />
            <input
              value={newFee}
              onChange={(e) => setNewFee(e.target.value)}
              placeholder="Fee"
              type="number"
              step="0.01"
              min="0"
              className="w-20 rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
            />
            <input
              value={newMin}
              onChange={(e) => setNewMin(e.target.value)}
              placeholder="Min"
              type="number"
              step="0.01"
              min="0"
              className="w-20 rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => create.mutate()}
              disabled={create.isPending}
              className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {create.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              Add
            </button>
          </div>
          {error && (
            <p className="mt-1.5 text-[11px] text-red-600">{error}</p>
          )}
          <p className="mt-1.5 text-[10px] text-zinc-400">
            Tip: when the cart matches multiple zones, the longest postcode
            prefix wins. So a broad "NE10" zone (£3) and a narrow "NE108"
            override (£5) coexist.
          </p>
        </div>
      </div>
    </Backdrop>
  );
}

function Backdrop({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      {children}
    </div>
  );
}
