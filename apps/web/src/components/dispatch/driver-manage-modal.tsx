"use client";

// Phase BG — per-driver Manage panel: set pay (start-up fee + per-postcode
// fees + home location) and run a cash-up (with handover math + date range).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2, X, Wallet, BadgePoundSterling } from "lucide-react";
import toast from "react-hot-toast";
import {
  getDriverCashUp,
  settleDriverCashUp,
  updateDriverEarnings,
  type OperatorDriverRow,
  type PostcodeFee,
} from "@/lib/api/dispatch.client";

interface Props {
  driver: OperatorDriverRow;
  locations: { id: string; name: string }[];
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function DriverManageModal({ driver, locations, open, onClose, onSaved }: Props) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"pay" | "cashup">("pay");

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">{driver.name}</h2>
            <p className="text-xs text-zinc-500">Pay & cash-up</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex gap-1 border-b border-zinc-100 px-5 pt-2">
          {[
            { id: "pay" as const, label: "Earnings", icon: BadgePoundSterling },
            { id: "cashup" as const, label: "Cash up", icon: Wallet },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium ${
                tab === t.id
                  ? "border-zinc-900 text-zinc-900"
                  : "border-transparent text-zinc-500 hover:text-zinc-800"
              }`}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {tab === "pay" ? (
            <PayTab driver={driver} locations={locations} onSaved={onSaved} qc={qc} />
          ) : (
            <CashUpTab driver={driver} onSettled={onSaved} qc={qc} />
          )}
        </div>
      </div>
    </div>
  );
}

function PayTab({
  driver,
  locations,
  onSaved,
  qc,
}: {
  driver: OperatorDriverRow;
  locations: { id: string; name: string }[];
  onSaved: () => void;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const [locationId, setLocationId] = useState(driver.homeLocationId ?? "");
  const [startupFee, setStartupFee] = useState(driver.startupFee ?? "0");
  const [fees, setFees] = useState<PostcodeFee[]>(driver.postcodeFees ?? []);

  const save = useMutation({
    mutationFn: () =>
      updateDriverEarnings(driver.id, {
        locationId: locationId || null,
        startupFee: Number(startupFee) || 0,
        postcodeFees: fees
          .map((f) => ({ postcode: f.postcode.trim(), fee: Number(f.fee) || 0 }))
          .filter((f) => f.postcode),
      }),
    onSuccess: () => {
      toast.success("Driver pay saved");
      qc.invalidateQueries({ queryKey: ["operator-dashboard"] });
      onSaved();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? e?.message ?? "Couldn't save"),
  });

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-zinc-700">Home location</span>
        <select
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
        >
          <option value="">Unassigned</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-zinc-700">
          Start-up fee (paid once per day worked)
        </span>
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-zinc-500">£</span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={startupFee}
            onChange={(e) => setStartupFee(e.target.value)}
            className="w-32 rounded-lg border border-zinc-300 px-3 py-2 text-sm tabular-nums"
          />
        </div>
      </label>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-700">Per-postcode delivery fee</span>
          <button
            type="button"
            onClick={() => setFees((f) => [...f, { postcode: "", fee: 0 }])}
            className="inline-flex items-center gap-1 text-xs font-medium text-violet-700 hover:underline"
          >
            <Plus className="h-3 w-3" /> Add postcode
          </button>
        </div>
        <p className="mb-2 text-[11px] text-zinc-500">
          Enter a full postcode or an area (e.g. <b>DH2</b> covers DH2&nbsp;1DD). The
          longest matching one wins.
        </p>
        {fees.length === 0 && (
          <p className="rounded-md border border-dashed border-zinc-200 px-3 py-4 text-center text-xs text-zinc-400">
            No postcode fees yet.
          </p>
        )}
        <div className="space-y-2">
          {fees.map((f, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={f.postcode}
                onChange={(e) =>
                  setFees((rows) =>
                    rows.map((r, idx) => (idx === i ? { ...r, postcode: e.target.value } : r)),
                  )
                }
                placeholder="DH2"
                className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm uppercase"
              />
              <div className="flex items-center gap-1">
                <span className="text-sm text-zinc-500">£</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={f.fee}
                  onChange={(e) =>
                    setFees((rows) =>
                      rows.map((r, idx) =>
                        idx === i ? { ...r, fee: Number(e.target.value) } : r,
                      ),
                    )
                  }
                  className="w-24 rounded-lg border border-zinc-300 px-3 py-2 text-sm tabular-nums"
                />
              </div>
              <button
                type="button"
                onClick={() => setFees((rows) => rows.filter((_, idx) => idx !== i))}
                className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <button
        onClick={() => save.mutate()}
        disabled={save.isPending}
        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        Save pay
      </button>
    </div>
  );
}

function CashUpTab({
  driver,
  onSettled,
  qc,
}: {
  driver: OperatorDriverRow;
  onSettled: () => void;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [range, setRange] = useState<{ from?: string; to?: string } | undefined>(undefined);

  const view = useQuery({
    queryKey: ["driver-cashup", driver.id, range],
    queryFn: () => getDriverCashUp(driver.id, range),
  });

  const settle = useMutation({
    mutationFn: () => settleDriverCashUp(driver.id),
    onSuccess: () => {
      toast.success("Cash-up recorded — balance cleared");
      setRange(undefined);
      view.refetch();
      qc.invalidateQueries({ queryKey: ["driver-cashup", driver.id] });
      onSettled();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? e?.message ?? "Couldn't cash up"),
  });

  const v = view.data;
  const money = (n: number) => `£${n.toFixed(2)}`;
  const owedToDriver = v ? v.cashHandover < 0 : false;

  return (
    <div className="space-y-4">
      {/* Date range */}
      <div className="rounded-lg border border-zinc-200 p-3">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Period
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-zinc-600">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-0.5 block rounded-md border border-zinc-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-zinc-600">
            To
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="mt-0.5 block rounded-md border border-zinc-300 px-2 py-1 text-sm"
            />
          </label>
          <button
            onClick={() =>
              setRange(
                from || to
                  ? { from: from || undefined, to: to ? `${to}T23:59:59` : undefined }
                  : undefined,
              )
            }
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50"
          >
            View period
          </button>
          {range && (
            <button
              onClick={() => {
                setFrom("");
                setTo("");
                setRange(undefined);
              }}
              className="text-xs text-zinc-500 hover:underline"
            >
              Back to outstanding
            </button>
          )}
        </div>
      </div>

      {view.isLoading || !v ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
        </div>
      ) : (
        <>
          <p className="text-xs text-zinc-500">
            {v.outstanding ? "Outstanding since last cash-up" : "Selected period"} ·{" "}
            {v.deliveries} deliver{v.deliveries === 1 ? "y" : "ies"} over {v.daysWorked} day
            {v.daysWorked === 1 ? "" : "s"}
          </p>

          <div className="grid grid-cols-2 gap-2 text-sm">
            <Stat label={`Cash orders (${v.cashOrders})`} value={money(v.cashCollected)} tone="green" />
            <Stat label={`Card orders (${v.cardOrders})`} value={money(v.cardCollected)} tone="blue" />
          </div>

          <div className="rounded-lg border border-zinc-200 p-3 text-sm">
            <Row label={`Start-up fee (${v.daysWorked}×£${v.startupFee.toFixed(2)})`} value={money(v.startupFeeTotal)} />
            <Row label="Delivery fees" value={money(v.deliveryFeeTotal)} />
            <div className="my-1.5 border-t border-zinc-100" />
            <Row label="Driver earning" value={money(v.driverEarning)} bold />
          </div>

          {/* Handover */}
          <div
            className={`rounded-lg p-3 text-sm ${
              owedToDriver ? "bg-amber-50 text-amber-900" : "bg-emerald-50 text-emerald-900"
            }`}
          >
            {owedToDriver ? (
              <>
                <p className="font-semibold">Restaurant owes driver {money(Math.abs(v.cashHandover))}</p>
                <p className="text-xs opacity-80">
                  Cash collected ({money(v.cashCollected)}) was less than the driver's earning.
                </p>
              </>
            ) : (
              <>
                <p className="font-semibold">Driver hands over {money(v.cashHandover)} cash</p>
                <p className="text-xs opacity-80">
                  Cash collected {money(v.cashCollected)} − earning {money(v.driverEarning)}.
                </p>
              </>
            )}
          </div>

          {v.outstanding && (
            <button
              onClick={() => settle.mutate()}
              disabled={settle.isPending || v.deliveries === 0}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {settle.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Cash up now — clears the balance
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "green" | "blue" }) {
  return (
    <div
      className={`rounded-lg p-3 ${tone === "green" ? "bg-green-50" : "bg-blue-50"}`}
    >
      <p className={`text-[11px] font-medium ${tone === "green" ? "text-green-700" : "text-blue-700"}`}>
        {label}
      </p>
      <p className="mt-0.5 text-lg font-bold text-zinc-900 tabular-nums">{value}</p>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className={bold ? "font-semibold text-zinc-900" : "text-zinc-600"}>{label}</span>
      <span className={`tabular-nums ${bold ? "font-bold" : "text-zinc-800"}`}>{value}</span>
    </div>
  );
}
