"use client";

// Phase AM — POS Promos modal.
//
// Manager-facing list + add UI for quick-discount promos used by the cart
// panel. Three types supported:
//
//   • PERCENTAGE     — % off subtotal (e.g. "10% off", "20% off")
//   • FIXED_AMOUNT   — £ off subtotal (e.g. "£5 off")
//   • FREE_DELIVERY  — zeros the delivery fee
//
// Promos can be:
//   • Tenant-wide   (locationIds = []) — visible everywhere
//   • Per-location  (locationIds = [thisLocationId]) — only here
//
// When a promo is created here, the POS cart panel renders it as a
// quick-tap button under "Discounts". When the list is empty, the cart
// shows nothing in that section — so a quiet location can opt out of
// quick discounts entirely.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { promoCodesClient, type PromoCode } from "@/lib/api/pos.client";

interface Props {
  locationId: string;
  onClose: () => void;
}

type PromoType = "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_DELIVERY";

export function PromosModal({ locationId, onClose }: Props) {
  const qc = useQueryClient();

  const promosQuery = useQuery<PromoCode[]>({
    queryKey: ["promo-codes", locationId],
    queryFn: () => promoCodesClient.list(locationId),
  });

  const [code, setCode] = useState("");
  const [type, setType] = useState<PromoType>("PERCENTAGE");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<"location" | "tenant">("location");
  const [error, setError] = useState<string | null>(null);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["promo-codes", locationId] });

  const create = useMutation({
    mutationFn: () => {
      const trimmedCode = code.trim().toUpperCase();
      if (!trimmedCode) throw new Error("Code required");
      const numericValue = type === "FREE_DELIVERY" ? 0 : Number(value);
      if (type !== "FREE_DELIVERY") {
        if (!Number.isFinite(numericValue) || numericValue < 0) {
          throw new Error("Value must be ≥ 0");
        }
        if (type === "PERCENTAGE" && numericValue > 100) {
          throw new Error("Percentage cannot exceed 100");
        }
      }
      return promoCodesClient.create({
        code: trimmedCode,
        type,
        value: numericValue,
        isActive: true,
        locationIds: scope === "location" ? [locationId] : [],
      });
    },
    onSuccess: () => {
      setCode("");
      setValue("");
      setType("PERCENTAGE");
      setError(null);
      invalidate();
    },
    onError: (err: any) => {
      setError(err?.response?.data?.message ?? err.message ?? "Failed");
    },
  });

  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      promoCodesClient.update(id, { isActive }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => promoCodesClient.remove(id),
    onSuccess: invalidate,
  });

  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 4000);
    return () => window.clearTimeout(t);
  }, [error]);

  const promos = promosQuery.data ?? [];

  return (
    <Backdrop onClose={onClose}>
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">POS promos</h2>
            <p className="text-xs text-zinc-500">
              Quick-tap discounts shown on the cart for this location.
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

        {/* Existing promos */}
        <div className="max-h-72 overflow-y-auto">
          {promosQuery.isLoading ? (
            <p className="py-6 text-center text-xs text-zinc-400">Loading…</p>
          ) : promos.length === 0 ? (
            <p className="py-6 text-center text-xs text-zinc-400">
              No promos yet. Cart will show no discount buttons.
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead className="border-b border-zinc-100 bg-zinc-50 text-[10px] uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="px-3 py-1.5 text-left">Code / type</th>
                  <th className="px-3 py-1.5 text-right">Value</th>
                  <th className="px-3 py-1.5 text-center">Scope</th>
                  <th className="px-3 py-1.5 text-center">Active</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {promos.map((p) => (
                  <tr key={p.id} className="border-b border-zinc-50 last:border-0">
                    <td className="px-3 py-1.5">
                      <div className="font-mono font-semibold">{p.code}</div>
                      <div className="text-[10px] text-zinc-400">{typeLabel(p.type)}</div>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {p.type === "PERCENTAGE"
                        ? `${Number(p.value)}%`
                        : p.type === "FIXED_AMOUNT"
                          ? `£${Number(p.value).toFixed(2)}`
                          : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-center text-[10px] text-zinc-500">
                      {p.locationIds.length === 0 ? "All" : "This loc"}
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={p.isActive}
                        onChange={() =>
                          toggle.mutate({ id: p.id, isActive: !p.isActive })
                        }
                        className="h-3 w-3"
                      />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm(`Delete ${p.code}?`)) remove.mutate(p.id);
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
            Add promo
          </p>
          <div className="grid grid-cols-[1fr,auto,auto] gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="Label / code"
              maxLength={32}
              className="rounded-md border border-zinc-200 px-2 py-1.5 text-xs uppercase focus:border-zinc-900 focus:outline-none"
            />
            <select
              value={type}
              onChange={(e) => setType(e.target.value as PromoType)}
              className="rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
            >
              <option value="PERCENTAGE">% off</option>
              <option value="FIXED_AMOUNT">£ off</option>
              <option value="FREE_DELIVERY">Free delivery</option>
            </select>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={type === "PERCENTAGE" ? "10" : type === "FIXED_AMOUNT" ? "5" : "—"}
              type="number"
              step="0.01"
              min="0"
              disabled={type === "FREE_DELIVERY"}
              className="w-20 rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none disabled:bg-zinc-50"
            />
          </div>
          <div className="mt-2 flex items-center gap-3">
            <label className="flex items-center gap-1 text-[11px] text-zinc-600">
              <input
                type="radio"
                checked={scope === "location"}
                onChange={() => setScope("location")}
              />
              Only this location
            </label>
            <label className="flex items-center gap-1 text-[11px] text-zinc-600">
              <input
                type="radio"
                checked={scope === "tenant"}
                onChange={() => setScope("tenant")}
              />
              All locations
            </label>
            <button
              type="button"
              onClick={() => create.mutate()}
              disabled={create.isPending}
              className="ml-auto inline-flex items-center gap-1 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
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
        </div>
      </div>
    </Backdrop>
  );
}

function typeLabel(t: PromoType): string {
  return t === "PERCENTAGE"
    ? "% off subtotal"
    : t === "FIXED_AMOUNT"
      ? "£ off subtotal"
      : "Free delivery";
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
