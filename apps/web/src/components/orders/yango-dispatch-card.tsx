"use client";

// Yango Delivery card for the dispatch choosers (single order AND bulk).
//
// One component rather than a fourth copy-pasted card in each modal, because
// Yango has states the others don't:
//   • it only exists for UAE shops — for anyone else the card renders nothing,
//     so a UK shop's chooser is unchanged;
//   • ESTIMATE-ONLY mode (the default, since Yango has no sandbox): the price is
//     real and shown, the button is disabled and says why;
//   • a booked claim can come back "pending" while Yango finishes pricing.
// No multi-drop in our integration, so bulk = one courier per order, like Uber.

import { useEffect, useState } from "react";
import { formatMoney } from "@orderhub/shared";
import { Loader2, Truck } from "lucide-react";
import { yangoClient, type YangoQuote } from "@/lib/api/yango.client";

interface Props {
  orders: Array<{ id: string; ref: string }>;
  locationIds: string[];
  /** Another courier is mid-dispatch — don't start a second one. */
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  /** After anything was sent. allSent=false when some orders were refused. */
  onSent: (sentIds: string[], allSent: boolean, message: string) => void;
}

const errMsg = (e: any, fallback: string) => e?.response?.data?.message ?? e?.message ?? fallback;

function money(currency: string, amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return "—";
  return formatMoney(amount, currency, { compact: true });
}

type State =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "not_set_up" }
  | { kind: "ready"; live: boolean };

export function YangoDispatchCard({ orders, locationIds, disabled, onBusyChange, onSent }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [total, setTotal] = useState<{ currency: string; amount: number; feeMinor: number; eta: number | null } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<Array<{ ref: string; message: string }>>([]);

  const idsKey = orders.map((o) => o.id).join(",");
  const locKey = locationIds.join(",");

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    setTotal(null);
    setWarnings([]);
    setQuoteErr(null);
    (async () => {
      let cfgs;
      try {
        cfgs = await Promise.all(locationIds.map((l) => yangoClient.getConfig(l)));
      } catch {
        if (alive) setState({ kind: "hidden" });
        return;
      }
      if (!alive) return;
      // Not a UAE shop and never configured → Yango is not an option here at all.
      if (!cfgs.length || !cfgs.some((c) => c.countrySupported || c.configured)) {
        setState({ kind: "hidden" });
        return;
      }
      if (!cfgs.every((c) => c.canQuote)) {
        setState({ kind: "not_set_up" });
        return;
      }
      setState({ kind: "ready", live: cfgs.every((c) => c.readyToDispatch) });
      try {
        const quotes: YangoQuote[] = await Promise.all(orders.map((o) => yangoClient.quote(o.id)));
        if (!alive) return;
        const etas = quotes.map((q) => q.etaMinutes).filter((n): n is number => typeof n === "number");
        setTotal({
          currency: quotes[0]?.currency ?? "AED",
          amount: quotes.reduce((s, q) => s + (Number(q.amount) || 0), 0),
          feeMinor: quotes.reduce((s, q) => s + (Number(q.dispatchFeeMinor) || 0), 0),
          eta: etas.length ? Math.max(...etas) : null,
        });
        setWarnings([...new Set(quotes.flatMap((q) => q.warnings ?? []))]);
      } catch (e) {
        if (alive) setQuoteErr(errMsg(e, "Couldn't get a Yango quote."));
      }
    })();
    return () => {
      alive = false;
    };
    // Keyed on contents, not array identity (the live board re-renders often).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, locKey]);

  if (state.kind === "hidden") return null;

  async function send() {
    setBusy(true);
    onBusyChange(true);
    setFailures([]);
    const sent: string[] = [];
    let pending = 0;
    let admin = false;
    const failed: Array<{ ref: string; message: string }> = [];
    // One claim per order; one refusal must not stop the rest.
    for (const o of orders) {
      try {
        const r = await yangoClient.dispatch(o.id);
        sent.push(o.id);
        if (r.pending) pending++;
        admin = admin || r.adminBypass;
      } catch (e) {
        failed.push({ ref: o.ref, message: errMsg(e, "Yango refused it") });
      }
    }
    setBusy(false);
    onBusyChange(false);
    if (sent.length) {
      const base = sent.length === 1 ? "Sent to Yango" : `${sent.length} orders sent to Yango — one courier each`;
      const tail = pending
        ? " — Yango is confirming the price; the courier is booked in a few seconds."
        : admin
          ? " (admin — no wallet charge)"
          : "";
      onSent(sent, failed.length === 0, base + tail);
    }
    setFailures(failed);
  }

  // The wallet fee is in the shop's own currency, so it is formatted as money —
  // not the "50p" the UK cards print, which would read as nonsense in dirhams.
  const feeText = total
    ? `${orders.length === 1 ? "+" : "total, +"} ${money(total.currency, total.feeMinor / 100)} OrderHub fee${orders.length === 1 ? "" : "s"}`
    : null;
  const live = state.kind === "ready" && state.live;

  return (
    <div className="rounded-xl border border-zinc-200 p-3.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Truck className="h-4 w-4 text-red-600" aria-hidden />
          <span className="whitespace-nowrap text-sm font-semibold text-zinc-900">Yango Delivery</span>
          {state.kind === "ready" && !state.live && (
            <span className="whitespace-nowrap rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
              Estimate only
            </span>
          )}
        </div>
        <div className="text-right" aria-live="polite">
          {state.kind === "loading" ? (
            <Loader2 className="h-4 w-4 animate-spin text-zinc-400" aria-label="Loading Yango" />
          ) : state.kind === "not_set_up" ? (
            <span className="text-[11px] text-zinc-400">Not set up</span>
          ) : total ? (
            <>
              <div className="text-sm font-semibold tabular-nums text-zinc-900">
                {money(total.currency, total.amount)}
              </div>
              <div className="text-[10px] text-zinc-400">
                {feeText}
                {total.eta != null ? ` · ~${total.eta} min` : ""}
              </div>
            </>
          ) : quoteErr ? (
            <span className="text-[11px] text-amber-600">Quote unavailable</span>
          ) : (
            <Loader2 className="h-4 w-4 animate-spin text-zinc-400" aria-label="Getting a Yango quote" />
          )}
        </div>
      </div>

      {orders.length > 1 && (
        <p className="mt-1 text-[11px] text-zinc-500">Yango sends a separate courier for each order.</p>
      )}

      {warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {warnings.map((w) => (
            <li key={w} className="rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-800">
              {w}
            </li>
          ))}
        </ul>
      )}
      {quoteErr && !total && <p className="mt-2 text-[11px] leading-snug text-amber-700">{quoteErr}</p>}

      <button
        type="button"
        onClick={send}
        disabled={!live || disabled || busy}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        {orders.length === 1 ? "Dispatch to Yango" : `Send ${orders.length} Yango couriers`}
      </button>

      {state.kind === "ready" && !state.live && (
        <p className="mt-1.5 text-[11px] text-zinc-500">
          Yango is in estimate-only mode for {locationIds.length > 1 ? "a shop in this pick" : "this shop"} — the
          price is real, but nothing is booked. Switch it to live in Location settings → Yango.
        </p>
      )}
      {state.kind === "not_set_up" && (
        <p className="mt-1.5 text-[11px] text-zinc-400">
          {locationIds.length > 1
            ? "Yango needs to be set up and active at every shop in this pick."
            : "Add your Yango API token and pickup point in Location settings to enable this."}
        </p>
      )}
      {failures.length > 0 && (
        <div role="alert" className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          <p className="font-semibold">
            {failures.length === 1
              ? "1 didn't go — it's still on the board:"
              : `${failures.length} didn't go — they're still on the board:`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {failures.map((f) => (
              <li key={f.ref}>
                {f.ref}: {f.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
