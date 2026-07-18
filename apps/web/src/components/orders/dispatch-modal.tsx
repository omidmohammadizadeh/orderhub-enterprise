"use client";

// Phase BH — unified per-order dispatch chooser. Shows each courier option with
// a PRICE the operator sees before committing:
//   • Stuart      — live quote from Stuart + the OrderHub per-dispatch fee.
//   • Uber Direct — placeholder until the integration is activated.
//   • Own fleet   — the location's online drivers (no courier fee); pick one.

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Bike, Loader2, Truck, User, X } from "lucide-react";
import { stuartClient } from "@/lib/api/stuart.client";
import {
  assignOrders,
  getOnlineDrivers,
  type OnlineDriver,
} from "@/lib/api/dispatch.client";

interface Props {
  orderId: string;
  locationId: string | null;
  orderRef: string;
  onClose: () => void;
}

function money(currency: string, amount: number | string | null): string {
  if (amount === null || amount === undefined) return "—";
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  if (!Number.isFinite(n)) return "—";
  const sym = currency === "GBP" ? "£" : `${currency} `;
  return `${sym}${n.toFixed(2)}`;
}

export function DispatchModal({ orderId, locationId, orderRef, onClose }: Props) {
  const queryClient = useQueryClient();

  const [stuartAvailable, setStuartAvailable] = useState<boolean | null>(null);
  const [quote, setQuote] = useState<{
    currency: string;
    amount: number | string | null;
    dispatchFeeMinor: number;
  } | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [drivers, setDrivers] = useState<OnlineDriver[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // which action is running

  useEffect(() => {
    let alive = true;
    (async () => {
      // Stuart availability + quote
      try {
        const cfg = await stuartClient.getConfig(locationId ?? "");
        if (!alive) return;
        const ok = cfg.configured && cfg.active;
        setStuartAvailable(ok);
        if (ok) {
          try {
            const q = await stuartClient.quote(orderId);
            if (alive) setQuote(q);
          } catch (e: any) {
            if (alive)
              setQuoteErr(
                e?.response?.data?.message ?? "Couldn't get a Stuart quote.",
              );
          }
        }
      } catch {
        if (alive) setStuartAvailable(false);
      }
      // Own-fleet drivers
      try {
        const d = await getOnlineDrivers(locationId ?? undefined);
        if (alive) setDrivers(d);
      } catch {
        if (alive) setDrivers([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [orderId, locationId]);

  function done(msg: string) {
    toast.success(msg);
    queryClient.invalidateQueries({ queryKey: ["orders", "live"] });
    onClose();
  }

  async function dispatchStuart() {
    setBusy("stuart");
    try {
      const r = await stuartClient.dispatch(orderId);
      done(
        r.adminBypass
          ? "Dispatched to Stuart (admin — no wallet charge)"
          : "Dispatched to Stuart",
      );
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't dispatch to Stuart");
      setBusy(null);
    }
  }

  async function dispatchDriver(d: OnlineDriver) {
    setBusy(`driver:${d.driverId}`);
    try {
      await assignOrders(d.driverId, [orderId]);
      done(`Assigned to ${d.name}`);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't assign the driver");
      setBusy(null);
    }
  }

  const feeLabel = quote
    ? `+ ${quote.dispatchFeeMinor}p OrderHub fee`
    : "+ small OrderHub fee";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3.5">
          <h3 className="text-sm font-semibold text-zinc-900">
            Dispatch {orderRef}
          </h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-3 overflow-y-auto p-4">
          {/* Stuart */}
          <div className="rounded-xl border border-zinc-200 p-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bike className="h-4 w-4 text-violet-600" />
                <span className="text-sm font-semibold text-zinc-900">
                  Stuart
                </span>
              </div>
              <div className="text-right">
                {stuartAvailable === null ? (
                  <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                ) : !stuartAvailable ? (
                  <span className="text-[11px] text-zinc-400">Not set up</span>
                ) : quote ? (
                  <>
                    <div className="text-sm font-semibold text-zinc-900">
                      {money(quote.currency, quote.amount)}
                    </div>
                    <div className="text-[10px] text-zinc-400">{feeLabel}</div>
                  </>
                ) : quoteErr ? (
                  <span className="text-[11px] text-amber-600">
                    Quote unavailable
                  </span>
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                )}
              </div>
            </div>
            <button
              onClick={dispatchStuart}
              disabled={!stuartAvailable || busy !== null}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-40"
            >
              {busy === "stuart" && <Loader2 className="h-4 w-4 animate-spin" />}
              Dispatch to Stuart
            </button>
            {stuartAvailable === false && (
              <p className="mt-1.5 text-[11px] text-zinc-400">
                Add your Stuart credentials in Location settings to enable this.
              </p>
            )}
          </div>

          {/* Uber Direct — placeholder */}
          <div className="rounded-xl border border-dashed border-zinc-200 p-3.5 opacity-70">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Truck className="h-4 w-4 text-zinc-500" />
                <span className="text-sm font-semibold text-zinc-700">
                  Uber Direct
                </span>
              </div>
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500">
                Coming soon
              </span>
            </div>
            <p className="mt-1.5 text-[11px] text-zinc-400">
              Pending Uber Direct account approval.
            </p>
          </div>

          {/* Own fleet */}
          <div className="rounded-xl border border-zinc-200 p-3.5">
            <div className="mb-2 flex items-center gap-2">
              <User className="h-4 w-4 text-emerald-600" />
              <span className="text-sm font-semibold text-zinc-900">
                Own fleet
              </span>
              <span className="ml-auto text-[10px] text-zinc-400">
                No courier fee
              </span>
            </div>
            {drivers === null ? (
              <div className="flex items-center gap-2 py-2 text-xs text-zinc-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading drivers…
              </div>
            ) : drivers.length === 0 ? (
              <p className="py-2 text-[12px] text-zinc-400">
                No drivers online at this location.
              </p>
            ) : (
              <div className="space-y-1.5">
                {drivers.map((d) => (
                  <div
                    key={d.driverId}
                    className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2"
                  >
                    <div>
                      <div className="text-sm font-medium text-zinc-800">
                        {d.name}
                      </div>
                      <div className="text-[10px] text-zinc-400">
                        {d.status === "ON_JOB"
                          ? `On a job · ${d.activeJobs} active`
                          : "Online"}
                      </div>
                    </div>
                    <button
                      onClick={() => dispatchDriver(d)}
                      disabled={busy !== null}
                      className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-40"
                    >
                      {busy === `driver:${d.driverId}` && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                      Assign
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
