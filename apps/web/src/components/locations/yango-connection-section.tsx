"use client";

// Phase BK — per-location Yango Delivery setup (UAE shops only).
//
// Four things, in order:
//   1. the API token (Yango business cabinet → Integration → Get token), the
//      pickup contact email Yango requires, and the courier class;
//   2. the PICKUP POINT — Yango routes by coordinates and our locations have
//      none, so the shop address is geocoded on save and shown here to check;
//   3. "Check with Yango" — proves the token and that the shop is in a zone;
//   4. estimate-only vs LIVE. Yango has no sandbox, so live is a separate,
//      deliberate step with its own confirmation, not a dropdown default.
//
// Courier updates need no webhook registration: every claim carries its own
// callback URL and the server polls Yango every 15 seconds regardless.

import { useEffect, useId, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, MapPin, Truck } from "lucide-react";
import { yangoClient, type YangoConfig } from "@/lib/api/yango.client";

const inputCls =
  "w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600";
const labelCls = "text-[11px] font-medium text-zinc-600";
const focusCls =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600";

export function YangoConnectionSection({ locationId }: { locationId: string }) {
  const uid = useId();
  const [cfg, setCfg] = useState<YangoConfig | null>(null);
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [taxiClass, setTaxiClass] = useState<"courier" | "express">("courier");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [ack, setAck] = useState(false);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const c = await yangoClient.getConfig(locationId);
      setCfg(c);
      setEmail(c.contactEmail ?? "");
      setTaxiClass(c.taxiClass ?? "courier");
      setLat(c.pickupLat != null ? String(c.pickupLat) : "");
      setLng(c.pickupLng != null ? String(c.pickupLng) : "");
    } catch {
      setCfg(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    setCheck(null);
    setMsg(null);
    setAck(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);

  const fail = (e: any, fallback: string) =>
    setMsg({ kind: "err", text: e?.response?.data?.message ?? fallback });

  async function save() {
    if (!cfg?.configured && !token.trim()) {
      setMsg({ kind: "err", text: "Paste the API token from your Yango cabinet first." });
      return;
    }
    const pickupChanged =
      (lat.trim() || lng.trim()) &&
      (String(cfg?.pickupLat ?? "") !== lat.trim() || String(cfg?.pickupLng ?? "") !== lng.trim());
    setBusy("save");
    setMsg(null);
    try {
      const r = await yangoClient.saveConfig(locationId, {
        ...(token.trim() ? { token: token.trim() } : {}),
        ...(email.trim() ? { contactEmail: email.trim() } : {}),
        taxiClass,
        ...(pickupChanged ? { pickupLat: Number(lat), pickupLng: Number(lng) } : {}),
      });
      setToken("");
      setMsg({
        kind: "ok",
        text: r.pickupMissing
          ? "Saved — but we couldn't place the shop on the map. Enter the pickup latitude/longitude below."
          : r.geocodedPickup
            ? "Saved. We placed the pickup point from the shop address — check it on the map below."
            : "Yango settings saved.",
      });
      await load();
    } catch (e) {
      fail(e, "Couldn't save the Yango settings.");
    } finally {
      setBusy(null);
    }
  }

  async function verify() {
    setBusy("verify");
    setCheck(null);
    try {
      setCheck(await yangoClient.verify(locationId));
    } catch (e: any) {
      setCheck({ ok: false, message: e?.response?.data?.message ?? "Couldn't reach Yango." });
    } finally {
      setBusy(null);
    }
  }

  async function setMode(mode: "estimate_only" | "live") {
    setBusy("mode");
    setMsg(null);
    try {
      await yangoClient.saveConfig(locationId, {
        mode,
        ...(mode === "live" ? { acknowledgeLiveCouriers: true } : {}),
      });
      setAck(false);
      setMsg({
        kind: "ok",
        text:
          mode === "live"
            ? "Live. Dispatching to Yango now books real couriers."
            : "Back to estimate-only. Quotes still work; nothing will be booked.",
      });
      await load();
    } catch (e) {
      fail(e, "Couldn't change the mode.");
    } finally {
      setBusy(null);
    }
  }

  async function toggle() {
    if (!cfg?.configured) return;
    setBusy("toggle");
    setMsg(null);
    try {
      await yangoClient.toggle(locationId, !cfg.active);
      await load();
    } catch (e) {
      fail(e, "Couldn't update.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading Yango settings…
      </div>
    );
  }
  // Not a UAE shop and never set up: Yango isn't offered here at all.
  if (!cfg || (!cfg.countrySupported && !cfg.configured)) return null;

  const live = cfg.mode === "live";
  const hasPickup = cfg.pickupLat != null && cfg.pickupLng != null;
  const badge = !cfg.configured
    ? null
    : !cfg.active
      ? { text: "Inactive", cls: "bg-zinc-100 text-zinc-600" }
      : live
        ? { text: "Live", cls: "bg-emerald-50 text-emerald-700" }
        : { text: "Estimate only", cls: "bg-amber-50 text-amber-700" };

  return (
    <div className="space-y-4 rounded-lg border border-zinc-200 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Truck className="h-4 w-4 text-red-600" aria-hidden />
          <h4 className="text-sm font-semibold text-zinc-900">Yango Delivery courier dispatch</h4>
        </div>
        {badge && (
          <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}>{badge.text}</span>
        )}
      </div>

      <p className="text-[12px] leading-relaxed text-zinc-500">
        Book a <strong>Yango Delivery</strong> courier for this shop&apos;s delivery orders. Paste the API
        token from your Yango business cabinet (<strong>Integration → Get token</strong>). Yango bills your
        Yango account for each courier; OrderHub charges a flat fee per dispatch from your wallet.
      </p>

      {!cfg.countrySupported && (
        <p role="alert" className="rounded-md bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
          Yango is only offered for UAE shops, and this location isn&apos;t set to the UAE — dispatch is
          switched off here. You can still deactivate it.
        </p>
      )}

      {/* 1 — token, contact, class */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1 sm:col-span-2">
          <label htmlFor={`${uid}-token`} className={labelCls}>
            API token {cfg.tokenMasked && `(saved: ${cfg.tokenMasked})`}
          </label>
          <input
            id={`${uid}-token`}
            name="yangoApiToken"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={cfg.configured ? "•••••• (unchanged — paste to replace)" : "Paste your Yango API token…"}
            className={inputCls}
          />
          <p className="text-[10px] text-zinc-400">
            Changing your Yango cabinet password invalidates this token — paste the new one here.
          </p>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${uid}-email`} className={labelCls}>
            Pickup contact email
          </label>
          <input
            id={`${uid}-email`}
            name="yangoContactEmail"
            type="email"
            inputMode="email"
            autoComplete="email"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="kitchen@yourshop.ae"
            className={inputCls}
          />
          <p className="text-[10px] text-zinc-400">Yango requires one on the pickup point.</p>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${uid}-class`} className={labelCls}>
            Courier type
          </label>
          <select
            id={`${uid}-class`}
            value={taxiClass}
            onChange={(e) => setTaxiClass(e.target.value as "courier" | "express")}
            className={inputCls}
          >
            <option value="courier">Courier — bike or on foot (up to 10 kg)</option>
            <option value="express">Express — car (up to 20 kg)</option>
          </select>
        </div>
      </div>

      {/* 2 — pickup point */}
      {cfg.configured && (
        <div className="space-y-2 border-t border-zinc-100 pt-3">
          <p className={labelCls}>Pickup point</p>
          <p className="text-[11px] text-zinc-500">
            Yango sends the courier to these coordinates, not to the address text. Check the pin, and correct
            it if it&apos;s on the wrong side of the road or building.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor={`${uid}-lat`} className={labelCls}>
                Latitude
              </label>
              <input
                id={`${uid}-lat`}
                name="yangoPickupLat"
                inputMode="decimal"
                autoComplete="off"
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                placeholder="25.1972…"
                className={`${inputCls} tabular-nums`}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${uid}-lng`} className={labelCls}>
                Longitude
              </label>
              <input
                id={`${uid}-lng`}
                name="yangoPickupLng"
                inputMode="decimal"
                autoComplete="off"
                value={lng}
                onChange={(e) => setLng(e.target.value)}
                placeholder="55.2396…"
                className={`${inputCls} tabular-nums`}
              />
            </div>
          </div>
          {hasPickup ? (
            <a
              href={`https://www.google.com/maps?q=${cfg.pickupLat},${cfg.pickupLng}`}
              target="_blank"
              rel="noreferrer"
              className={`inline-flex items-center gap-1 rounded text-[11px] font-medium text-violet-700 hover:underline ${focusCls}`}
            >
              <MapPin className="h-3.5 w-3.5" aria-hidden /> Check the saved pin on Google Maps
            </a>
          ) : (
            <div className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>No pickup point yet — Yango can&apos;t quote or dispatch until there is one.</span>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy !== null}
          className={`rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 ${focusCls}`}
        >
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        {cfg.configured && (
          <>
            <button
              type="button"
              onClick={verify}
              disabled={busy !== null || !hasPickup}
              className={`rounded-md border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 ${focusCls}`}
            >
              {busy === "verify" ? "Checking…" : "Check with Yango"}
            </button>
            <button
              type="button"
              onClick={toggle}
              disabled={busy !== null}
              className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${focusCls} ${
                cfg.active
                  ? "border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                  : "bg-emerald-600 text-white hover:bg-emerald-700"
              }`}
            >
              {busy === "toggle" ? "…" : cfg.active ? "Deactivate" : "Activate"}
            </button>
          </>
        )}
      </div>

      <div aria-live="polite" className="space-y-1">
        {msg && (
          <p
            role={msg.kind === "err" ? "alert" : undefined}
            className={`text-[12px] ${msg.kind === "ok" ? "text-emerald-600" : "text-red-600"}`}
          >
            {msg.text}
          </p>
        )}
        {check && (
          <p className={`flex items-start gap-1.5 text-[12px] ${check.ok ? "text-emerald-700" : "text-red-600"}`}>
            {check.ok ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            ) : (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            )}
            <span>{check.message}</span>
          </p>
        )}
      </div>

      {/* 4 — estimate-only vs live */}
      {cfg.configured && (
        <div className="space-y-2 border-t border-zinc-100 pt-3">
          <p className={labelCls}>Mode</p>
          {live ? (
            <>
              <p className="text-[11px] leading-relaxed text-zinc-600">
                <strong className="text-emerald-700">Live.</strong> Dispatching to Yango books a real courier
                and bills your Yango account. A courier offer more than 25% above the quote you saw is refused
                automatically, and your OrderHub fee refunded.
              </p>
              <button
                type="button"
                onClick={() => setMode("estimate_only")}
                disabled={busy !== null}
                className={`rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 ${focusCls}`}
              >
                {busy === "mode" ? "Switching…" : "Switch back to estimate-only"}
              </button>
            </>
          ) : (
            <>
              <p className="text-[11px] leading-relaxed text-zinc-600">
                <strong className="text-amber-700">Estimate only.</strong> Yango has no test environment, so
                this shop starts here: the dispatch screen shows Yango&apos;s real price and ETA, but nothing
                is ever booked.
              </p>
              <label className="flex items-start gap-2 text-[11px] text-zinc-700">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-300 accent-red-600"
                />
                <span>
                  I understand that in live mode every Yango dispatch sends a real courier and is billed to
                  our Yango account.
                </span>
              </label>
              <button
                type="button"
                onClick={() => setMode("live")}
                disabled={busy !== null || !ack || !cfg.countrySupported}
                className={`rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-40 ${focusCls}`}
              >
                {busy === "mode" ? "Switching…" : "Go live"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
