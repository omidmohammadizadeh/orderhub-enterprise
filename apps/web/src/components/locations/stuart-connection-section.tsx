"use client";

// Phase BH — per-location Stuart courier setup. Self-contained (fetches + saves
// its own state) so it drops into the location edit modal. The operator pastes
// their own Stuart client ID/secret + picks the environment; we show the webhook
// URL + auth key to paste back into Stuart's dashboard. Dispatch charges the
// location wallet a flat fee (default 50p) per job.

import { useEffect, useState } from "react";
import { Check, Copy, Loader2, Truck } from "lucide-react";
import { stuartClient, type StuartConfig } from "@/lib/api/stuart.client";

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
          className="rounded-md border border-zinc-200 bg-white p-1.5 text-zinc-500 hover:text-zinc-900"
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

export function StuartConnectionSection({ locationId }: { locationId: string }) {
  const [cfg, setCfg] = useState<StuartConfig | null>(null);
  const [environment, setEnvironment] = useState("sandbox");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  async function load() {
    setLoading(true);
    try {
      const c = await stuartClient.getConfig(locationId);
      setCfg(c);
      setEnvironment(c.environment || "sandbox");
    } catch {
      /* no config yet */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);

  async function save() {
    if (!clientId.trim() || !clientSecret.trim()) {
      setMsg({ kind: "err", text: "Enter both the client ID and secret." });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      await stuartClient.saveConfig(locationId, {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        environment,
      });
      setClientSecret("");
      setMsg({ kind: "ok", text: "Stuart credentials saved." });
      await load();
    } catch (e: any) {
      setMsg({
        kind: "err",
        text: e?.response?.data?.message ?? "Couldn't save credentials.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function toggle() {
    if (!cfg?.configured) return;
    setToggling(true);
    setMsg(null);
    try {
      await stuartClient.toggle(locationId, !cfg.active);
      await load();
    } catch (e: any) {
      setMsg({
        kind: "err",
        text: e?.response?.data?.message ?? "Couldn't update.",
      });
    } finally {
      setToggling(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading Stuart settings…
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border border-zinc-200 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Truck className="h-4 w-4 text-zinc-700" />
          <h4 className="text-sm font-semibold text-zinc-900">
            Stuart courier dispatch
          </h4>
        </div>
        {cfg?.configured && (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              cfg.active
                ? "bg-emerald-50 text-emerald-700"
                : "bg-zinc-100 text-zinc-500"
            }`}
          >
            {cfg.active ? "Active" : "Inactive"}
          </span>
        )}
      </div>

      <p className="text-[12px] leading-relaxed text-zinc-500">
        Dispatch delivery orders to a Stuart courier. Add your own Stuart{" "}
        <strong>client ID</strong> and <strong>secret</strong> — Stuart bills
        your account for the courier; OrderHub charges a flat fee per dispatch
        from your wallet.
      </p>

      <div className="space-y-1">
        <label className="text-[11px] font-medium text-zinc-600">
          Environment
        </label>
        <select
          value={environment}
          onChange={(e) => setEnvironment(e.target.value)}
          className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-800"
        >
          <option value="sandbox">Sandbox (test — bot couriers)</option>
          <option value="production">Production (real couriers)</option>
        </select>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-zinc-600">
            Client ID {cfg?.clientIdMasked && `(saved: ${cfg.clientIdMasked})`}
          </label>
          <input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="Stuart client ID"
            className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-zinc-600">
            Client secret
          </label>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={cfg?.configured ? "•••••• (unchanged)" : "Stuart client secret"}
            className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save credentials"}
        </button>
        {cfg?.configured && (
          <button
            type="button"
            onClick={toggle}
            disabled={toggling}
            className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
              cfg.active
                ? "border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                : "bg-emerald-600 text-white hover:bg-emerald-700"
            }`}
          >
            {cfg.active ? "Deactivate" : "Activate"}
          </button>
        )}
      </div>

      {msg && (
        <p
          className={`text-[12px] ${
            msg.kind === "ok" ? "text-emerald-600" : "text-red-600"
          }`}
        >
          {msg.text}
        </p>
      )}

      {cfg?.configured && (
        <div className="space-y-2 border-t border-zinc-100 pt-3">
          <p className="text-[11px] font-medium text-zinc-600">
            Add this webhook in your Stuart dashboard (Settings → Webhooks) so
            driver updates reach OrderHub:
          </p>
          <CopyField label="Webhook URL" value={cfg.webhookUrl} />
          <CopyField label="Auth header name" value={cfg.webhookAuthHeader} />
          <CopyField label="Auth header value" value={cfg.webhookAuthKey ?? ""} />
        </div>
      )}
    </div>
  );
}
