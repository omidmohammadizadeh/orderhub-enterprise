"use client";

// Phase BJ — per-location JET Go setup.
//
// Three steps, in order, because each one needs the one before it:
//   1. credentials (market matters — UK keys don't work on the CA host)
//   2. the collect point JET has onboarded for this shop
//   3. register the webhook with JET, then activate
//
// The collect point is the step operators won't expect: JET Go has no pickup
// address field, so until one is chosen there is nothing to dispatch from. The
// Activate button stays disabled and says so rather than failing later at the
// till.

import { useEffect, useId, useState } from "react";
import { AlertTriangle, Check, Copy, Loader2, Truck } from "lucide-react";
import {
  jetGoClient,
  type JetGoCollectPoint,
  type JetGoConfig,
  type JetGoWebhookStatus,
} from "@/lib/api/jet-go.client";

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <span className="text-[11px] font-medium text-zinc-600">{label}</span>
      <div className="flex items-center gap-1.5">
        <code className="flex-1 truncate rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-[11px] text-zinc-700">
          {value || "—"}
        </code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded-md border border-zinc-200 bg-white p-1.5 text-zinc-500 hover:text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
          aria-label={`Copy ${label}`}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-600" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

export function JetGoConnectionSection({ locationId }: { locationId: string }) {
  // Several of these sections render on one page, so the label/input ids have to
  // be unique per instance or clicking a label focuses the wrong shop's field.
  const uid = useId();
  const [cfg, setCfg] = useState<JetGoConfig | null>(null);
  const [market, setMarket] = useState("UK");
  const [environment, setEnvironment] = useState("sandbox");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const [points, setPoints] = useState<JetGoCollectPoint[] | null>(null);
  const [pointsErr, setPointsErr] = useState<string | null>(null);
  const [hook, setHook] = useState<JetGoWebhookStatus | null>(null);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const c = await jetGoClient.getConfig(locationId);
      setCfg(c);
      setMarket(c.market || "UK");
      setEnvironment(c.environment || "sandbox");
    } catch {
      /* not configured yet */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    setPoints(null);
    setHook(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);

  function fail(e: any, fallback: string) {
    setMsg({ kind: "err", text: e?.response?.data?.message ?? fallback });
  }

  async function save() {
    if (!clientId.trim() || !clientSecret.trim()) {
      setMsg({ kind: "err", text: "Enter the Client ID and Client Secret." });
      return;
    }
    setBusy("save");
    setMsg(null);
    try {
      const r = await jetGoClient.saveConfig(locationId, {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        market,
        environment,
      });
      setClientSecret("");
      setMsg({
        kind: "ok",
        text: (r as any)?.sharedWebhook
          ? "Saved. Another location already uses these credentials, so both share one webhook URL."
          : "JET Go credentials saved. Now load your collect points.",
      });
      await load();
    } catch (e) {
      fail(e, "Couldn't save credentials.");
    } finally {
      setBusy(null);
    }
  }

  async function loadPoints() {
    setBusy("points");
    setPointsErr(null);
    setMsg(null);
    try {
      const r = await jetGoClient.collectPoints(locationId);
      setPoints(r.collectPoints ?? []);
      if (!r.ok) setPointsErr(r.message ?? "Couldn't load collect points.");
      else if ((r.collectPoints ?? []).length === 0) {
        setPointsErr(
          "JET Go returned no collect points for these credentials. Ask the JET Go team to onboard this shop as a collect point.",
        );
      }
    } catch (e: any) {
      setPointsErr(e?.response?.data?.message ?? "Couldn't load collect points.");
    } finally {
      setBusy(null);
    }
  }

  async function pick(p: JetGoCollectPoint) {
    setBusy(`pick:${p.id}`);
    setMsg(null);
    try {
      await jetGoClient.setCollectPoint(locationId, p.id, p.name);
      setMsg({ kind: "ok", text: `This location now collects from “${p.name}”.` });
      await load();
    } catch (e) {
      fail(e, "Couldn't save the collect point.");
    } finally {
      setBusy(null);
    }
  }

  async function registerWebhook() {
    setBusy("hook");
    setMsg(null);
    try {
      const r = await jetGoClient.registerWebhook(locationId);
      setMsg(
        r.ok
          ? { kind: "ok", text: "Webhook registered with JET Go." }
          : { kind: "err", text: r.message ?? "Couldn't register the webhook." },
      );
      if (r.ok) await checkWebhook();
    } catch (e) {
      fail(e, "Couldn't register the webhook.");
    } finally {
      setBusy(null);
    }
  }

  async function checkWebhook() {
    setBusy("hookcheck");
    try {
      setHook(await jetGoClient.webhookStatus(locationId));
    } catch (e: any) {
      setHook({ ok: false, registered: false, message: e?.response?.data?.message });
    } finally {
      setBusy(null);
    }
  }

  async function toggle() {
    if (!cfg?.configured) return;
    setBusy("toggle");
    setMsg(null);
    try {
      await jetGoClient.toggle(locationId, !cfg.active);
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
        <Loader2 className="h-4 w-4 animate-spin" /> Loading JET Go settings…
      </div>
    );
  }

  const needsCollectPoint = Boolean(cfg?.configured && !cfg.collectPointId);

  return (
    <div className="space-y-4 rounded-lg border border-zinc-200 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Truck className="h-4 w-4 text-orange-600" />
          <h4 className="text-sm font-semibold text-zinc-900">JET Go courier dispatch</h4>
        </div>
        {cfg?.configured && (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              cfg.readyToDispatch
                ? "bg-emerald-50 text-emerald-700"
                : "bg-amber-50 text-amber-700"
            }`}
          >
            {cfg.readyToDispatch ? "Active" : cfg.active ? "Needs a collect point" : "Inactive"}
          </span>
        )}
      </div>

      <p className="text-[12px] leading-relaxed text-zinc-500">
        Dispatch delivery orders to a <strong>JET Go</strong> courier — Just Eat&apos;s
        own last-mile network. Add the <strong>Client ID</strong> and{" "}
        <strong>Secret</strong> the JET Go team issued you. JET bills your account
        for the courier; OrderHub charges a flat fee per dispatch from your wallet.
      </p>

      {/* 1 — credentials. The two credential inputs turn off autofill, spellcheck
          and password-manager prompts: they are machine secrets pasted into a
          settings screen, not a person's saved login. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label
            htmlFor={`${uid}-market`}
            className="text-[11px] font-medium text-zinc-600"
          >
            Market
          </label>
          <select
            id={`${uid}-market`}
            value={market}
            onChange={(e) => setMarket(e.target.value)}
            className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
          >
            <option value="UK">United Kingdom</option>
            <option value="EU">Europe</option>
            <option value="CA">Canada</option>
            <option value="AU">Australia</option>
          </select>
          <p className="text-[10px] text-zinc-400">
            Must match the credentials — UK keys don&apos;t work on other markets.
          </p>
        </div>
        <div className="space-y-1">
          <label
            htmlFor={`${uid}-env`}
            className="text-[11px] font-medium text-zinc-600"
          >
            Environment
          </label>
          <select
            id={`${uid}-env`}
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
          >
            <option value="sandbox">Staging (test couriers)</option>
            <option value="production">Production (real couriers)</option>
          </select>
        </div>
        <div className="space-y-1">
          <label
            htmlFor={`${uid}-clientid`}
            className="text-[11px] font-medium text-zinc-600"
          >
            Client ID {cfg?.clientIdMasked && `(saved: ${cfg.clientIdMasked})`}
          </label>
          <input
            id={`${uid}-clientid`}
            name="jetGoClientId"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste your JET Go Client ID…"
            className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
          />
        </div>
        <div className="space-y-1">
          <label
            htmlFor={`${uid}-secret`}
            className="text-[11px] font-medium text-zinc-600"
          >
            Client secret
          </label>
          <input
            id={`${uid}-secret`}
            name="jetGoClientSecret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={cfg?.configured ? "•••••• (unchanged)" : "Paste your Client Secret…"}
            className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy !== null}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
        >
          {busy === "save" ? "Saving…" : "Save credentials"}
        </button>
        {cfg?.configured && (
          <button
            type="button"
            onClick={toggle}
            disabled={busy !== null}
            className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 ${
              cfg.active
                ? "border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                : "bg-emerald-600 text-white hover:bg-emerald-700"
            }`}
            title={
              needsCollectPoint && !cfg.active
                ? "Choose a collect point first — JET Go has nowhere to collect from."
                : undefined
            }
          >
            {cfg.active ? "Deactivate" : "Activate"}
          </button>
        )}
      </div>

      {/* Saving, registering and picking a collect point all report back here,
          so it has to be announced rather than only seen. */}
      <div aria-live="polite">
        {msg && (
          <p
            role={msg.kind === "err" ? "alert" : undefined}
            className={`text-[12px] ${msg.kind === "ok" ? "text-emerald-600" : "text-red-600"}`}
          >
            {msg.text}
          </p>
        )}
      </div>

      {/* 2 — collect point */}
      {cfg?.configured && (
        <div className="space-y-2 border-t border-zinc-100 pt-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-medium text-zinc-600">Collect point</p>
              <p className="text-[11px] text-zinc-500">
                {cfg.collectPointName ? (
                  <>
                    Collecting from <strong>{cfg.collectPointName}</strong>
                  </>
                ) : (
                  "JET Go collects from a point it has onboarded, not from an address — pick this shop's."
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={loadPoints}
              disabled={busy !== null}
              className="shrink-0 rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
            >
              {busy === "points" ? "Loading…" : cfg.collectPointId ? "Change" : "Load collect points"}
            </button>
          </div>

          {needsCollectPoint && (
            <div className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Dispatch is blocked until a collect point is chosen — JET Go would have
                nowhere to collect this shop&apos;s orders from.
              </span>
            </div>
          )}

          {pointsErr && (
            <p role="alert" className="text-[11px] text-red-600">
              {pointsErr}
            </p>
          )}

          {points && points.length > 0 && (
            <div className="max-h-48 space-y-1.5 overflow-y-auto">
              {points.map((p) => {
                const chosen = p.id === cfg.collectPointId;
                return (
                  <div
                    key={p.id}
                    className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 ${
                      chosen ? "border-emerald-200 bg-emerald-50" : "border-zinc-200 bg-white"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-zinc-800">{p.name}</div>
                      <div className="truncate text-[10px] text-zinc-400">
                        {p.address || p.id}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => pick(p)}
                      disabled={busy !== null || chosen}
                      className="shrink-0 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
                    >
                      {chosen ? "Chosen" : busy === `pick:${p.id}` ? "Saving…" : "Use this"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 3 — webhook */}
      {cfg?.configured && cfg.webhookUrl && (
        <div className="space-y-2 border-t border-zinc-100 pt-3">
          <p className="text-[11px] font-medium text-zinc-600">
            Courier updates. JET Go keeps one webhook per set of credentials, so
            registering here replaces whatever was there before.
          </p>
          <CopyField label="Webhook URL" value={cfg.webhookUrl} />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={registerWebhook}
              disabled={busy !== null}
              className="rounded-md bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
            >
              {busy === "hook" ? "Registering…" : "Register with JET Go"}
            </button>
            <button
              type="button"
              onClick={checkWebhook}
              disabled={busy !== null}
              className="rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
            >
              {busy === "hookcheck" ? "Checking…" : "Check"}
            </button>
          </div>
          {hook && (
            <p
              className={`text-[11px] ${
                hook.registered && hook.matchesOurs
                  ? "text-emerald-600"
                  : hook.registered
                    ? "text-amber-600"
                    : "text-red-600"
              }`}
            >
              {hook.registered && hook.matchesOurs
                ? "JET Go is sending courier updates to OrderHub."
                : hook.registered
                  ? `JET Go is posting to ${hook.endpoint} — not to OrderHub. Courier updates won't arrive until you re-register.`
                  : (hook.message ?? "No webhook registered with JET Go yet.")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
