"use client";

// Admin Dashboard → Dispatch charging.
//
// One row per location, with the waived ones pulled to the top and badged,
// because leaving this on by accident is the failure mode: the shop keeps
// dispatching couriers and stops paying for them, and nothing else on any
// screen would say so.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Wallet } from "lucide-react";
import toast from "react-hot-toast";
import {
  dispatchChargingClient,
  type DispatchChargingRow,
} from "@/lib/api/dispatch-charging.client";

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 ${
        checked ? "bg-amber-500" : "bg-zinc-200"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

export function DispatchChargingPanel() {
  const [rows, setRows] = useState<DispatchChargingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await dispatchChargingClient.list());
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Couldn't load locations.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(row: DispatchChargingRow, next: boolean) {
    setBusy(row.locationId);
    try {
      const saved = await dispatchChargingClient.set(
        row.locationId,
        next,
        next ? "Sandbox testing" : undefined,
      );
      setRows((prev) =>
        (prev ?? []).map((r) => (r.locationId === saved.locationId ? saved : r)),
      );
      toast.success(
        next
          ? `${row.locationName}: dispatch fee waived — testing only`
          : `${row.locationName}: dispatch fee back on`,
      );
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't save.");
    } finally {
      setBusy(null);
    }
  }

  if (!rows && !error) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading locations…
      </div>
    );
  }

  const loaded = rows !== null;
  const waived = (rows ?? []).filter((r) => r.waiveWalletCharge);
  const charged = (rows ?? []).filter((r) => !r.waiveWalletCharge);

  return (
    <div className="mx-auto max-w-3xl space-y-6 py-2">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Wallet className="h-5 w-5 text-zinc-700" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-zinc-900">Dispatch charging</h1>
        </div>
        <p className="text-sm leading-relaxed text-zinc-500">
          Every courier dispatch — Stuart, Uber Direct and JET Go — takes the
          OrderHub fee from the location&apos;s wallet before the job is created.
          A shop whose wallet can&apos;t cover it cannot dispatch at all.
        </p>
        <p className="text-sm leading-relaxed text-zinc-500">
          Waiving the fee lets a location dispatch for free so a sandbox flow can
          be tested end to end. It is not a discount — leave it on and that shop
          stops paying for couriers.
        </p>
      </header>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {/* A failed load must not fall through to the table below: "Charged
          normally (0)" over "Every location is currently waived" reads as a
          statement about the estate, when in fact we know nothing about it. */}

      {waived.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="mb-3 flex items-start gap-2">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
              aria-hidden="true"
            />
            <p className="text-[13px] leading-snug text-amber-900">
              <strong>
                {waived.length} location{waived.length === 1 ? "" : "s"} dispatching
                free.
              </strong>{" "}
              Switch this back on once testing is done.
            </p>
          </div>
          <ul className="space-y-2">
            {waived.map((r) => (
              <Row key={r.locationId} row={r} busy={busy} onToggle={toggle} />
            ))}
          </ul>
        </div>
      )}

      {loaded && (
      <div className="rounded-xl border border-zinc-200">
        <div className="border-b border-zinc-100 px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-zinc-700">
            Charged normally ({charged.length})
          </h2>
        </div>
        {rows!.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-400">
            No locations on this tenant.
          </p>
        ) : charged.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-400">
            Every location is currently waived.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {charged.map((r) => (
              <Row key={r.locationId} row={r} busy={busy} onToggle={toggle} padded />
            ))}
          </ul>
        )}
      </div>
      )}
    </div>
  );
}

function Row({
  row,
  busy,
  onToggle,
  padded,
}: {
  row: DispatchChargingRow;
  busy: string | null;
  onToggle: (row: DispatchChargingRow, next: boolean) => void;
  padded?: boolean;
}) {
  return (
    <li
      className={`flex items-center justify-between gap-3 ${
        padded ? "px-4 py-3" : "rounded-lg bg-white px-3 py-2"
      }`}
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-zinc-800">
          {row.locationName}
        </div>
        <div className="truncate text-[11px] text-zinc-400">
          {row.brandName ?? "—"}
          {row.waiveWalletCharge && row.note ? ` · ${row.note}` : ""}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {busy === row.locationId && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" aria-hidden="true" />
        )}
        <span className="text-[11px] text-zinc-500">
          {row.waiveWalletCharge ? "Free" : "Charged"}
        </span>
        <Toggle
          checked={row.waiveWalletCharge}
          disabled={busy !== null}
          onChange={(v) => onToggle(row, v)}
          label={`Waive the dispatch fee for ${row.locationName}`}
        />
      </div>
    </li>
  );
}
