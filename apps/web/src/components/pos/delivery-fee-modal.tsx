"use client";

// Phase AM — Delivery Fee setup modal.
//
// Opened from the POS top bar. Lets a manager configure the delivery-zone
// list for THIS location: each row = a postcode prefix OR a named area, plus a
// fee and an optional minimum order value. The cart panel's lookup hits the
// same zones.
//
// Which of the two the till offers follows the shop's country, because it has
// to: a Dubai manager typing into a postcode box is filling in a field their
// customers have no answer to. Area zones name the community — Dubai Marina,
// JLT, Business Bay — and the customer picks from exactly this list.
//
// A zone key can be any length: a broad outward prefix (NE10), a 4-char
// outward+area code (NE108 → NE108... wait: outward "NE10" or district
// "NE108"), or a FULL postcode (NE10 8YH → NE108YH). We store it exactly as
// typed (uppercased, no spaces) — the same normalisation online ordering uses
// — and the cart's longest-prefix matcher picks the most specific zone the
// customer's postcode starts with. This mirrors the storefront so POS and
// online price delivery identically.

import { listZonesCached } from "@/lib/pos/offline-cache";
import { useState, useEffect } from "react";
import { useCurrency } from "@/hooks/use-currency";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { deliveryZonesClient, type DeliveryZone } from "@/lib/api/pos.client";
import { zoneMode, defaultZoneModeForCountry } from "@orderhub/shared";

interface Props {
  locationId: string;
  onClose: () => void;
}

/** Uppercase, strip all whitespace — no truncation. Mirrors the backend
 *  `normalisePostcode` so a partial prefix ("NE10"), a district ("NE108") and
 *  a full postcode ("NE10 8YH" → "NE108YH") are all stored and matched the
 *  same way online ordering does. */
function normalisePrefix(raw: string): string {
  return (raw ?? "").toUpperCase().replace(/\s+/g, "");
}

export function DeliveryFeeModal({ locationId, onClose }: Props) {
  // Prices follow the selected location's currency, not a hardcoded pound.
  const { money, symbol, country } = useCurrency(locationId);
  const qc = useQueryClient();

  const zonesQuery = useQuery<DeliveryZone[]>({
    queryKey: ["delivery-zones", locationId],
    queryFn: () => listZonesCached(locationId),
  });

  const [newPrefix, setNewPrefix] = useState("");
  const [newFee, setNewFee] = useState("");
  const [newMin, setNewMin] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** The row being edited, as typed. One at a time, so Save is never ambiguous. */
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    fee: string;
    min: string;
  } | null>(null);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["delivery-zones", locationId] });

  const create = useMutation({
    mutationFn: () => {
      const fee = Number(newFee);
      if (!Number.isFinite(fee) || fee < 0) throw new Error("Fee must be ≥ 0");
      if (byArea) {
        const area = newPrefix.trim();
        if (!area) throw new Error("Area name required");
        return deliveryZonesClient.create({
          locationId,
          areaName: area,
          fee,
          minOrderValue: newMin ? Number(newMin) : undefined,
        });
      }
      const prefix = normalisePrefix(newPrefix);
      if (!prefix) throw new Error("Postcode prefix required");
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

  const startEdit = (z: DeliveryZone) => {
    setError(null);
    setEditing({
      id: z.id,
      name: z.areaName ?? z.postcodePrefix ?? "",
      fee: String(Number(z.fee)),
      min: z.minOrderValue ? String(Number(z.minOrderValue)) : "",
    });
  };

  const save = useMutation({
    mutationFn: (z: DeliveryZone) => {
      if (!editing) throw new Error("Nothing to save");
      // Number("") is 0, so a cleared box would otherwise save free delivery.
      const fee = editing.fee.trim() === "" ? NaN : Number(editing.fee);
      if (!Number.isFinite(fee) || fee < 0) throw new Error("Fee must be ≥ 0");
      const min = editing.min.trim() === "" ? null : Number(editing.min);
      if (min !== null && (!Number.isFinite(min) || min < 0)) {
        throw new Error("Min order must be ≥ 0");
      }
      const body: Parameters<typeof deliveryZonesClient.update>[1] = {
        fee,
        minOrderValue: min,
      };
      // A distance zone has no name to change; it's defined by its miles.
      if (z.areaName || z.postcodePrefix) {
        const key = (v: string) =>
          z.areaName ? v.trim().toLowerCase() : normalisePrefix(v);
        const name = key(editing.name);
        if (!name) {
          throw new Error(z.areaName ? "Area name required" : "Postcode prefix required");
        }
        const taken = (zonesQuery.data ?? []).some(
          (other) =>
            other.id !== z.id &&
            key((z.areaName ? other.areaName : other.postcodePrefix) ?? "") === name,
        );
        if (taken) throw new Error(`${editing.name.trim()} is already on the list`);
        if (z.areaName) body.areaName = editing.name.trim();
        else body.postcodePrefix = name;
      }
      return deliveryZonesClient.update(z.id, body);
    },
    onSuccess: () => {
      setEditing(null);
      setError(null);
      invalidate();
    },
    onError: (err: any) => {
      setError(err?.response?.data?.message ?? err.message ?? "Failed");
    },
  });

  // Auto-clear error after a few seconds so it doesn't linger.
  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 4000);
    return () => window.clearTimeout(t);
  }, [error]);

  const zones = zonesQuery.data ?? [];
  // Saved rows win over the country default, so a shop that has deliberately
  // set up the other kind keeps editing what it actually uses.
  const saved = zoneMode(zones as any);
  const byArea =
    saved === "AREA" ||
    (saved === "NONE" && defaultZoneModeForCountry(country) === "AREA");

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
              {byArea
                ? "Name the areas you deliver to — e.g. Dubai Marina, JLT"
                : "Postcode prefix or full postcode — e.g. NE10, NE108, NE10 8YH"}
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
                  <th className="px-3 py-1.5 text-left">
                    {byArea ? "Area" : "Postcode"}
                  </th>
                  <th className="px-3 py-1.5 text-right">Fee ({symbol.trim()})</th>
                  <th className="px-3 py-1.5 text-right">Min order ({symbol.trim()})</th>
                  <th className="px-3 py-1.5 text-center">Active</th>
                  <th className="px-3 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {zones.map((z) =>
                  editing?.id === z.id ? (
                    <tr
                      key={z.id}
                      className="border-b border-zinc-50 bg-zinc-50 last:border-0"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") save.mutate(z);
                        if (e.key === "Escape") setEditing(null);
                      }}
                    >
                      <td className="px-3 py-1.5">
                        {z.areaName || z.postcodePrefix ? (
                          <input
                            value={editing.name}
                            onChange={(e) =>
                              setEditing({
                                ...editing,
                                name: z.areaName
                                  ? e.target.value
                                  : e.target.value.toUpperCase(),
                              })
                            }
                            aria-label={z.areaName ? "Area" : "Postcode"}
                            maxLength={z.areaName ? 60 : 8}
                            className={`w-full min-w-20 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs font-semibold focus:border-zinc-900 focus:outline-none ${
                              z.areaName ? "" : "font-mono uppercase"
                            }`}
                          />
                        ) : (
                          <span className="font-mono font-semibold">
                            {Number(z.maxDistanceMiles)} mi
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <input
                          value={editing.fee}
                          onChange={(e) => setEditing({ ...editing, fee: e.target.value })}
                          aria-label={`Fee (${symbol.trim()})`}
                          autoFocus
                          onFocus={(e) => e.target.select()}
                          type="number"
                          step="0.01"
                          min="0"
                          className="w-20 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-right text-xs focus:border-zinc-900 focus:outline-none"
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <input
                          value={editing.min}
                          onChange={(e) => setEditing({ ...editing, min: e.target.value })}
                          aria-label={`Min order (${symbol.trim()})`}
                          placeholder="None"
                          type="number"
                          step="0.01"
                          min="0"
                          className="w-20 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-right text-xs focus:border-zinc-900 focus:outline-none"
                        />
                      </td>
                      {/* Pinned: on a phone the table scrolls sideways, and the
                          row's buttons must stay in reach. */}
                      <td colSpan={2} className="sticky right-0 bg-zinc-50 px-2 py-1.5">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => save.mutate(z)}
                            disabled={save.isPending}
                            aria-label="Save"
                            title="Save"
                            className="grid h-8 w-8 place-items-center rounded-md bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50"
                          >
                            {save.isPending ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Check className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditing(null)}
                            disabled={save.isPending}
                            aria-label="Cancel"
                            title="Cancel"
                            className="grid h-8 w-8 place-items-center rounded-md border border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-100"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                  <tr key={z.id} className="border-b border-zinc-50 last:border-0">
                    <td
                      className={
                        z.areaName
                          ? "px-3 py-1.5 font-semibold"
                          : "px-3 py-1.5 font-mono font-semibold"
                      }
                    >
                      {z.areaName ??
                        z.postcodePrefix ??
                        (z.maxDistanceMiles != null
                          ? `${Number(z.maxDistanceMiles)} mi`
                          : "—")}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {money(Number(z.fee))}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {z.minOrderValue ? `${money(Number(z.minOrderValue))}` : "—"}
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
                    <td className="sticky right-0 whitespace-nowrap bg-white px-2 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => startEdit(z)}
                        aria-label={`Edit ${z.areaName ?? z.postcodePrefix ?? "zone"}`}
                        title="Edit"
                        className="rounded p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const label = z.areaName ?? z.postcodePrefix ?? "this zone";
                          if (confirm(`Delete ${label}?`)) remove.mutate(z.id);
                        }}
                        aria-label={`Delete ${z.areaName ?? z.postcodePrefix ?? "zone"}`}
                        title="Delete"
                        className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                  ),
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Add row */}
        <div className="border-t border-zinc-200 px-4 py-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Add zone
          </p>
          <div className="grid grid-cols-[minmax(0,1fr),auto,auto,auto] items-center gap-2">
            <input
              value={newPrefix}
              onChange={(e) =>
                setNewPrefix(byArea ? e.target.value : e.target.value.toUpperCase())
              }
              placeholder={byArea ? "Dubai Marina" : "NE10 or NE10 8YH"}
              maxLength={byArea ? 60 : 8}
              className={
                byArea
                  ? "w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
                  : "w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs font-mono uppercase focus:border-zinc-900 focus:outline-none"
              }
            />
            <input
              value={newFee}
              onChange={(e) => setNewFee(e.target.value)}
              placeholder="Fee"
              type="number"
              step="0.01"
              min="0"
              className="w-14 rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none sm:w-20"
            />
            <input
              value={newMin}
              onChange={(e) => setNewMin(e.target.value)}
              placeholder="Min"
              type="number"
              step="0.01"
              min="0"
              className="w-14 rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none sm:w-20"
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
            {byArea
              ? "This list is also what online customers choose from, so an area you don't add is one they'll be told you don't deliver to. Spelling is forgiving — \u201cAl Barsha\u201d matches \u201cBarsha\u201d."
              : 'Tip: when the cart matches multiple zones, the longest match wins — so a broad "NE10" zone, a narrower "NE108" district and a single full postcode "NE10 8YH" can all coexist.'}
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
