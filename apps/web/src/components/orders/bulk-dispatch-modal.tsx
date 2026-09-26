"use client";

// Bulk dispatch — send several delivery orders in one go.
//
// The couriers are genuinely different shapes, and the modal says so rather than
// pretending they are one button:
//   • Own fleet  — ONE driver takes every order as a run, stops in the order
//                  they were picked. No courier fee.
//   • Stuart     — ONE courier for the lot (multi-drop, up to 8, one shop).
//                  Stuart prices the run as one job and picks the route itself.
//   • Uber Direct — Uber has no multi-drop, so it is one courier PER order:
//                  N separate deliveries, N prices, shown as a total.
//   • JET Go     — same as Uber: no multi-drop, one courier per order. Its quote
//                  also carries warnings (a cash order, a slot it will treat as
//                  ASAP), shown per order before the operator commits.
//
// Sibling of DispatchModal (single order) — same chrome and the same colour per
// courier, so it reads as the same tool doing more at once.

import { useEffect, useMemo, useRef, useState } from "react";
import { formatMoney } from "@orderhub/shared";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Bike, Loader2, Truck, User, X } from "lucide-react";
import {
  STUART_MAX_DROPOFFS,
  stuartClient,
  type StuartBulkQuote,
} from "@/lib/api/stuart.client";
import { uberDirectClient } from "@/lib/api/uber-direct.client";
import { jetGoClient } from "@/lib/api/jet-go.client";
import {
  assignOrders,
  getOnlineDrivers,
  type OnlineDriver,
} from "@/lib/api/dispatch.client";
import type { Order } from "@/lib/api/orders.client";

interface Props {
  /** In pick order — for own fleet that is the stop order. */
  orders: Order[];
  onClose: () => void;
  /** Called after anything was dispatched, so the board can clear the pick.
   *  allSent is false when only some went (Uber refused others). */
  onDispatched: (orderIds: string[], allSent: boolean) => void;
}

const refOf = (o: Order) =>
  `#${o.displayId ?? (o as any).orderNumber ?? o.id.slice(-6)}`;

function money(currency: string, amount: number | string | null): string {
  if (amount === null || amount === undefined) return "—";
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  if (!Number.isFinite(n)) return "—";
  return formatMoney(n, currency, { compact: true });
}

const errMsg = (e: any, fallback: string) =>
  e?.response?.data?.message ?? e?.message ?? fallback;

/** "1 order" / "3 orders". A partial Uber send can leave exactly one. */
const nOrders = (n: number) => `${n} ${n === 1 ? "order" : "orders"}`;

type Busy = null | "stuart" | "uber" | "jetgo" | `driver:${string}`;

export function BulkDispatchModal({ orders, onClose, onDispatched }: Props) {
  const queryClient = useQueryClient();
  const ids = useMemo(() => orders.map((o) => o.id), [orders]);
  const locationIds = useMemo(
    () => [...new Set(orders.map((o) => o.locationId).filter(Boolean))],
    [orders],
  );
  const oneShop = locationIds.length === 1;
  const shopId = oneShop ? locationIds[0]! : undefined;
  const tooManyForStuart = orders.length > STUART_MAX_DROPOFFS;

  const [busy, setBusy] = useState<Busy>(null);
  const [drivers, setDrivers] = useState<OnlineDriver[] | null>(null);

  const [stuartAvailable, setStuartAvailable] = useState<boolean | null>(null);
  const [stuartQuote, setStuartQuote] = useState<StuartBulkQuote | null>(null);
  const [stuartErr, setStuartErr] = useState<string | null>(null);

  const [uberAvailable, setUberAvailable] = useState<boolean | null>(null);
  const [uberTotal, setUberTotal] = useState<{
    currency: string;
    amount: number;
    feeMinor: number;
  } | null>(null);
  const [uberErr, setUberErr] = useState<string | null>(null);
  /** Orders Uber refused on the last attempt, with why. */
  const [uberFailures, setUberFailures] = useState<
    Array<{ ref: string; message: string }>
  >([]);

  const [jetAvailable, setJetAvailable] = useState<boolean | null>(null);
  const [jetTotal, setJetTotal] = useState<{
    currency: string;
    amount: number;
    feeMinor: number;
  } | null>(null);
  const [jetErr, setJetErr] = useState<string | null>(null);
  /** Deduped across the pick — the same cash warning on six orders is one line. */
  const [jetWarnings, setJetWarnings] = useState<string[]>([]);
  const [jetFailures, setJetFailures] = useState<
    Array<{ ref: string; message: string }>
  >([]);

  // Escape closes; focus moves in and goes back to the opener on close.
  //
  // Mount-only on purpose. The parent passes an inline onClose and the live
  // board re-renders it constantly; keyed on those, this re-ran mid-session and
  // recorded the PANEL as the opener, so closing sent focus nowhere. The latest
  // onClose/busy are read through refs instead.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  useEffect(() => {
    onCloseRef.current = onClose;
    busyRef.current = busy;
  });
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && busyRef.current === null) onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, []);

  // Load all three couriers' availability + prices together — they don't
  // depend on each other, so no one waits on another's network call. Re-runs
  // when the pick changes (an Uber send that half-succeeded drops the orders
  // that went), so a price on screen always describes the orders still here.
  const idsKey = ids.join(",");
  const locationsKey = locationIds.join(",");
  useEffect(() => {
    let alive = true;
    setStuartQuote(null);
    setStuartErr(null);
    setStuartAvailable(null);
    setUberTotal(null);
    setUberErr(null);
    setUberAvailable(null);
    setJetTotal(null);
    setJetErr(null);
    setJetAvailable(null);
    setJetWarnings([]);

    getOnlineDrivers(shopId)
      .then((d) => alive && setDrivers(d))
      .catch(() => alive && setDrivers([]));

    // Stuart: one shop, at most 8. Anything else can't be one run, so it is
    // not even quoted — the card says why instead.
    if (!oneShop || tooManyForStuart) {
      setStuartAvailable(false);
    } else {
      stuartClient
        .getConfig(shopId!)
        .then(async (cfg) => {
          if (!alive) return;
          const ok = cfg.configured && cfg.active;
          setStuartAvailable(ok);
          if (!ok) return;
          try {
            const q = await stuartClient.quoteBulk(ids);
            if (alive) setStuartQuote(q);
          } catch (e) {
            if (alive) setStuartErr(errMsg(e, "Couldn't get a Stuart quote."));
          }
        })
        .catch(() => alive && setStuartAvailable(false));
    }

    // Uber Direct: every shop in the pick must have it switched on; then one
    // quote per order, summed.
    Promise.all(locationIds.map((l) => uberDirectClient.getConfig(l!)))
      .then(async (cfgs) => {
        if (!alive) return;
        const ok = cfgs.length > 0 && cfgs.every((c) => c.configured && c.active);
        setUberAvailable(ok);
        if (!ok) return;
        try {
          const quotes = await Promise.all(ids.map((id) => uberDirectClient.quote(id)));
          if (!alive) return;
          setUberTotal({
            currency: quotes[0]?.currency ?? "GBP",
            amount: quotes.reduce((sum, q) => sum + (Number(q?.amount) || 0), 0),
            feeMinor: quotes.reduce((sum, q) => sum + (Number(q?.dispatchFeeMinor) || 0), 0),
          });
        } catch (e) {
          if (alive) setUberErr(errMsg(e, "Couldn't get an Uber quote."));
        }
      })
      .catch(() => alive && setUberAvailable(false));

    // JET Go: readyToDispatch at EVERY shop in the pick (credentials AND a
    // collect point AND active), then one quote per order, summed.
    Promise.all(locationIds.map((l) => jetGoClient.getConfig(l!)))
      .then(async (cfgs) => {
        if (!alive) return;
        const ok = cfgs.length > 0 && cfgs.every((c) => c.configured && c.readyToDispatch);
        setJetAvailable(ok);
        if (!ok) return;
        try {
          const quotes = await Promise.all(ids.map((id) => jetGoClient.quote(id)));
          if (!alive) return;
          setJetTotal({
            currency: quotes[0]?.currency ?? "GBP",
            amount: quotes.reduce((sum, q) => sum + (Number(q?.amount) || 0), 0),
            feeMinor: quotes.reduce((sum, q) => sum + (Number(q?.dispatchFeeMinor) || 0), 0),
          });
          setJetWarnings([...new Set(quotes.flatMap((q) => q?.warnings ?? []))]);
        } catch (e) {
          if (alive) setJetErr(errMsg(e, "Couldn't get a JET Go quote."));
        }
      })
      .catch(() => alive && setJetAvailable(false));

    return () => {
      alive = false;
    };
    // Keyed on the pick's contents, not the array identities, which change on
    // every live board update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, locationsKey, shopId, oneShop, tooManyForStuart]);

  function finish(sentIds: string[], message: string) {
    toast.success(message);
    queryClient.invalidateQueries({ queryKey: ["orders", "live"] });
    onDispatched(sentIds, true);
    onClose();
  }

  async function sendToDriver(d: OnlineDriver) {
    setBusy(`driver:${d.driverId}`);
    try {
      await assignOrders(d.driverId, ids);
      finish(ids, `${nOrders(orders.length)} assigned to ${d.name}`);
    } catch (e) {
      toast.error(errMsg(e, "Couldn't assign the run"));
      setBusy(null);
    }
  }

  async function sendToStuart() {
    setBusy("stuart");
    try {
      const r = await stuartClient.dispatchBulk(ids);
      finish(
        ids,
        r.adminBypass
          ? `${nOrders(orders.length)} on one Stuart courier (admin — no wallet charge)`
          : `${nOrders(orders.length)} on one Stuart courier`,
      );
    } catch (e) {
      toast.error(errMsg(e, "Couldn't dispatch to Stuart"));
      setBusy(null);
    }
  }

  // Separate deliveries, so one refusal must not stop the rest — and the
  // operator has to see exactly which ones did not go.
  async function sendToUber() {
    setBusy("uber");
    setUberFailures([]);
    const sent: string[] = [];
    const failed: Array<{ ref: string; message: string }> = [];
    for (const o of orders) {
      try {
        await uberDirectClient.dispatch(o.id);
        sent.push(o.id);
      } catch (e) {
        failed.push({ ref: refOf(o), message: errMsg(e, "Uber refused it") });
      }
    }
    if (failed.length === 0) {
      finish(
        sent,
        sent.length === 1
          ? "Sent to Uber Direct"
          : `${sent.length} orders sent to Uber Direct — one courier each`,
      );
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["orders", "live"] });
    if (sent.length > 0) {
      onDispatched(sent, false);
      toast.success(`${sent.length} of ${orders.length} sent to Uber Direct`);
    }
    setUberFailures(failed);
    setBusy(null);
  }

  // One delivery per order, so one refusal must not stop the rest — and the
  // operator has to see exactly which ones stayed behind.
  async function sendToJetGo() {
    setBusy("jetgo");
    setJetFailures([]);
    const sent: string[] = [];
    const failed: Array<{ ref: string; message: string }> = [];
    for (const o of orders) {
      try {
        await jetGoClient.dispatch(o.id);
        sent.push(o.id);
      } catch (e) {
        failed.push({ ref: refOf(o), message: errMsg(e, "JET Go refused it") });
      }
    }
    if (failed.length === 0) {
      finish(
        sent,
        sent.length === 1
          ? "Sent to JET Go"
          : `${sent.length} orders sent to JET Go — one courier each`,
      );
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["orders", "live"] });
    if (sent.length > 0) {
      onDispatched(sent, false);
      toast.success(`${sent.length} of ${orders.length} sent to JET Go`);
    }
    setJetFailures(failed);
    setBusy(null);
  }

  const stuartBlockedReason = !oneShop
    ? "One Stuart courier collects from one shop — these orders are from different locations."
    : tooManyForStuart
      ? `Stuart takes up to ${STUART_MAX_DROPOFFS} orders on one courier — you picked ${orders.length}.`
      : null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={() => busy === null && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Dispatch ${nOrders(orders.length)}`}
        tabIndex={-1}
        className="w-full max-w-md overflow-hidden overscroll-contain rounded-2xl bg-white shadow-xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-zinc-100 px-5 py-3.5">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-900">
              Dispatch {nOrders(orders.length)}
            </h3>
            {/* The pick, numbered: for own fleet this IS the stop order. */}
            <ol className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-xs text-zinc-500">
              {orders.map((o, i) => (
                <li key={o.id} className="tabular-nums">
                  <span className="text-zinc-400">{i + 1}</span>{" "}
                  <span className="font-medium text-zinc-700">{refOf(o)}</span>
                </li>
              ))}
            </ol>
          </div>
          <button
            onClick={onClose}
            disabled={busy !== null}
            aria-label="Close"
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-3 overflow-y-auto p-4">
          {/* Own fleet — one driver, the whole run. */}
          <div className="rounded-xl border border-zinc-200 p-3.5">
            <div className="mb-1 flex items-center gap-2">
              <User className="h-4 w-4 text-emerald-600" />
              <span className="text-sm font-semibold text-zinc-900">Own fleet</span>
              <span className="ml-auto text-[10px] text-zinc-400">No courier fee</span>
            </div>
            <p className="mb-2 text-[11px] text-zinc-500">
              One driver takes the run, stops in the order above.
              {!oneShop && " These orders are from different shops."}
            </p>
            {drivers === null ? (
              <div className="flex items-center gap-2 py-2 text-xs text-zinc-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading drivers…
              </div>
            ) : drivers.length === 0 ? (
              <p className="py-2 text-[12px] text-zinc-400">
                No drivers online{oneShop ? " at this location" : ""}.
              </p>
            ) : (
              <div className="space-y-1.5">
                {drivers.map((d) => (
                  <div
                    key={d.driverId}
                    className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2"
                  >
                    <div>
                      <div className="text-sm font-medium text-zinc-800">{d.name}</div>
                      <div className="text-[10px] text-zinc-400">
                        {d.status === "ON_JOB"
                          ? `On a job · ${d.activeJobs} active`
                          : "Online"}
                      </div>
                    </div>
                    <button
                      onClick={() => sendToDriver(d)}
                      disabled={busy !== null}
                      className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-40"
                    >
                      {busy === `driver:${d.driverId}` && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                      Assign {orders.length}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Stuart — one courier, multi-drop. */}
          <div className="rounded-xl border border-zinc-200 p-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bike className="h-4 w-4 text-violet-600" />
                <span className="text-sm font-semibold text-zinc-900">Stuart</span>
              </div>
              <div className="text-right">
                {stuartBlockedReason ? (
                  <span className="text-[11px] text-zinc-400">Can't be one run</span>
                ) : stuartAvailable === null ? (
                  <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                ) : !stuartAvailable ? (
                  <span className="text-[11px] text-zinc-400">Not set up</span>
                ) : stuartQuote ? (
                  <>
                    <div className="text-sm font-semibold text-zinc-900">
                      {money(stuartQuote.currency, stuartQuote.amount)}
                    </div>
                    <div className="text-[10px] text-zinc-400">
                      + {stuartQuote.dispatchFeeEachMinor}p OrderHub fee per order
                    </div>
                  </>
                ) : stuartErr ? (
                  <span className="text-[11px] text-amber-600">Quote unavailable</span>
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                )}
              </div>
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">
              {orders.length === 1
                ? "One courier."
                : `One courier for all ${orders.length} — Stuart plans the route.`}
            </p>
            <button
              onClick={sendToStuart}
              disabled={!stuartAvailable || !!stuartBlockedReason || busy !== null}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-40"
            >
              {busy === "stuart" && <Loader2 className="h-4 w-4 animate-spin" />}
              {orders.length === 1
                ? "Send to Stuart"
                : `Send ${orders.length} on one Stuart courier`}
            </button>
            {stuartBlockedReason ? (
              <p className="mt-1.5 text-[11px] text-zinc-500">{stuartBlockedReason}</p>
            ) : stuartAvailable === false ? (
              <p className="mt-1.5 text-[11px] text-zinc-400">
                Add your Stuart credentials in Location settings to enable this.
              </p>
            ) : stuartErr ? (
              <p className="mt-1.5 text-[11px] text-amber-700">{stuartErr}</p>
            ) : null}
          </div>

          {/* Uber Direct — no multi-drop, so one courier per order. */}
          <div className="rounded-xl border border-zinc-200 p-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Truck className="h-4 w-4 text-zinc-900" />
                <span className="text-sm font-semibold text-zinc-900">Uber Direct</span>
              </div>
              <div className="text-right">
                {uberAvailable === null ? (
                  <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                ) : !uberAvailable ? (
                  <span className="text-[11px] text-zinc-400">Not set up</span>
                ) : uberTotal ? (
                  <>
                    <div className="text-sm font-semibold text-zinc-900">
                      {money(uberTotal.currency, uberTotal.amount)}
                    </div>
                    <div className="text-[10px] text-zinc-400">
                      {orders.length === 1
                        ? `+ ${uberTotal.feeMinor}p OrderHub fee`
                        : `total, + ${uberTotal.feeMinor}p OrderHub fees`}
                    </div>
                  </>
                ) : uberErr ? (
                  <span className="text-[11px] text-amber-600">Quote unavailable</span>
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                )}
              </div>
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">
              Uber sends a separate courier for each order.
            </p>
            <button
              onClick={sendToUber}
              disabled={!uberAvailable || busy !== null}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-900 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-40"
            >
              {busy === "uber" && <Loader2 className="h-4 w-4 animate-spin" />}
              {orders.length === 1
                ? "Send to Uber Direct"
                : `Send ${orders.length} Uber couriers`}
            </button>
            {uberAvailable === false && (
              <p className="mt-1.5 text-[11px] text-zinc-400">
                {locationIds.length > 1
                  ? "Uber Direct needs to be set up at every shop in this pick."
                  : "Add your Uber Direct credentials in Location settings to enable this."}
              </p>
            )}
            {uberFailures.length > 0 && (
              <div
                role="alert"
                className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800"
              >
                <p className="font-semibold">
                  {uberFailures.length === 1
                    ? "1 didn't go — it's still on the board:"
                    : `${uberFailures.length} didn't go — they're still on the board:`}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {uberFailures.map((f) => (
                    <li key={f.ref}>
                      {f.ref}: {f.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* JET Go — no multi-drop either, so one courier per order. */}
          <div className="rounded-xl border border-zinc-200 p-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bike className="h-4 w-4 text-orange-600" />
                <span className="text-sm font-semibold text-zinc-900">JET Go</span>
              </div>
              <div className="text-right">
                {jetAvailable === null ? (
                  <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                ) : !jetAvailable ? (
                  <span className="text-[11px] text-zinc-400">Not set up</span>
                ) : jetTotal ? (
                  <>
                    <div className="text-sm font-semibold text-zinc-900">
                      {money(jetTotal.currency, jetTotal.amount)}
                    </div>
                    <div className="text-[10px] text-zinc-400">
                      {orders.length === 1
                        ? `+ ${jetTotal.feeMinor}p OrderHub fee`
                        : `total, + ${jetTotal.feeMinor}p OrderHub fees`}
                    </div>
                  </>
                ) : jetErr ? (
                  <span className="text-[11px] text-amber-600">Quote unavailable</span>
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                )}
              </div>
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">
              JET Go sends a separate courier for each order.
            </p>
            {jetWarnings.length > 0 && (
              <ul className="mt-2 space-y-1">
                {jetWarnings.map((w) => (
                  <li
                    key={w}
                    className="rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-800"
                  >
                    {w}
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={sendToJetGo}
              disabled={!jetAvailable || busy !== null}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-orange-600 py-2 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600"
            >
              {busy === "jetgo" && <Loader2 className="h-4 w-4 animate-spin" />}
              {orders.length === 1
                ? "Send to JET Go"
                : `Send ${orders.length} JET Go couriers`}
            </button>
            {jetAvailable === false && (
              <p className="mt-1.5 text-[11px] text-zinc-400">
                {locationIds.length > 1
                  ? "JET Go needs to be set up, with a collect point, at every shop in this pick."
                  : "Add your JET Go credentials and pick a collect point in Location settings to enable this."}
              </p>
            )}
            {jetFailures.length > 0 && (
              <div
                role="alert"
                className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800"
              >
                <p className="font-semibold">
                  {jetFailures.length === 1
                    ? "1 didn't go — it's still on the board:"
                    : `${jetFailures.length} didn't go — they're still on the board:`}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {jetFailures.map((f) => (
                    <li key={f.ref}>
                      {f.ref}: {f.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
