"use client";

// Phase AY (P6) — per-location WhatsApp activation panel. Self-contained:
// fetches + saves its own state so it can drop into the location edit modal
// without touching the modal's form plumbing. Platform-managed model — the
// operator only supplies the Phone Number ID + display number; the shared
// platform token/app-secret handle sending + webhook security.

import { useEffect, useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { whatsappClient, type WhatsAppConnection } from "@/lib/api/whatsapp.client";

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
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

export function WhatsAppConnectionSection({ locationId }: { locationId: string }) {
  const [conn, setConn] = useState<WhatsAppConnection | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [displayPhoneNumber, setDisplayPhoneNumber] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [menuId, setMenuId] = useState("");
  const [flowId, setFlowId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    whatsappClient
      .get(locationId)
      .then((c) => {
        if (!live) return;
        setConn(c);
        setEnabled(c.enabled);
        setPhoneNumberId(c.phoneNumberId);
        setDisplayPhoneNumber(c.displayPhoneNumber);
        setWabaId(c.wabaId);
        setMenuId(c.menuId);
        setFlowId(c.flowId ?? "");
      })
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [locationId]);

  const save = async () => {
    setMsg(null);
    setSaving(true);
    try {
      const c = await whatsappClient.save({ locationId, enabled, phoneNumberId, displayPhoneNumber, wabaId, menuId, flowId });
      setConn(c);
      setEnabled(c.enabled);
      setDisplayPhoneNumber(c.displayPhoneNumber);
      setMenuId(c.menuId);
      setFlowId(c.flowId ?? "");
      setMsg({ kind: "ok", text: "Saved." });
    } catch (err: any) {
      setMsg({ kind: "err", text: err?.response?.data?.message ?? err?.message ?? "Couldn't save." });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setMsg(null);
    setTesting(true);
    try {
      const r = await whatsappClient.test(locationId);
      if (r.displayPhoneNumber && !displayPhoneNumber) setDisplayPhoneNumber(r.displayPhoneNumber);
      setMsg({
        kind: "ok",
        text: `Connected${r.verifiedName ? ` as “${r.verifiedName}”` : ""}${r.displayPhoneNumber ? ` (${r.displayPhoneNumber})` : ""} ✓`,
      });
      const c = await whatsappClient.get(locationId);
      setConn(c);
    } catch (err: any) {
      setMsg({ kind: "err", text: err?.response?.data?.message ?? err?.message ?? "Test failed." });
    } finally {
      setTesting(false);
    }
  };

  const inputCls =
    "w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none";

  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          WhatsApp ordering
        </h3>
        {conn?.enabled ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
            ● Live
          </span>
        ) : conn?.configured ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
            ● Off
          </span>
        ) : null}
      </div>
      <p className="text-[11px] text-zinc-500">
        Take orders over WhatsApp on a dedicated number. Add the number in your
        Meta WhatsApp Business account, then paste its <b>Phone Number ID</b> here.
        Sending + webhook security use your platform credentials automatically.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-[11px] text-zinc-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-zinc-300"
            />
            Enable WhatsApp ordering for this location
          </label>

          <div className="space-y-1">
            <span className="text-[11px] font-medium text-zinc-600">Phone Number ID *</span>
            <input
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value)}
              placeholder="e.g. 105954xxxxxxxxx"
              className={inputCls}
            />
            <span className="text-[10px] text-zinc-400">
              Meta → WhatsApp → API setup → the number's <b>Phone number ID</b> (not the phone number itself).
            </span>
          </div>

          <div className="space-y-1">
            <span className="text-[11px] font-medium text-zinc-600">Display phone number</span>
            <input
              value={displayPhoneNumber}
              onChange={(e) => setDisplayPhoneNumber(e.target.value)}
              placeholder="+44 7700 900000"
              className={inputCls}
            />
            <span className="text-[10px] text-zinc-400">
              Used to send the customer back to this chat after payment. Auto-filled by Test connection.
            </span>
          </div>

          <div className="space-y-1">
            <span className="text-[11px] font-medium text-zinc-600">Menu</span>
            <select
              value={menuId}
              onChange={(e) => setMenuId(e.target.value)}
              className={inputCls}
            >
              <option value="">Auto (location menu, then brand menu)</option>
              {(conn?.menus ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <span className="text-[10px] text-zinc-400">
              Which menu WhatsApp serves. Leave on Auto to follow the storefront's menu.
            </span>
          </div>

          <details className="rounded-md border border-zinc-200 bg-white p-2">
            <summary className="cursor-pointer text-[11px] font-semibold text-zinc-700">
              Advanced
            </summary>
            <div className="mt-2 space-y-1">
              <span className="text-[11px] font-medium text-zinc-600">WhatsApp Business Account ID (optional)</span>
              <input
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                placeholder="WABA ID"
                className={inputCls}
              />
            </div>
            <div className="mt-2 space-y-1">
              <span className="text-[11px] font-medium text-zinc-600">Order form Flow ID (optional)</span>
              <input
                value={flowId}
                onChange={(e) => setFlowId(e.target.value)}
                placeholder="e.g. 1304115405074626"
                className={inputCls}
              />
              <p className="text-[10px] text-zinc-400">
                The published “Customise” Flow for THIS number's WhatsApp
                Business Account. Create + publish the Flow in WhatsApp Manager
                under this number's account, then paste its ID here. Leave blank
                to use the platform default. A Flow only works inside the account
                it was created in.
              </p>
            </div>
          </details>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={save}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              disabled={testing || !phoneNumberId}
              onClick={test}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              {testing ? "Testing…" : "Test connection"}
            </button>
          </div>

          {msg && (
            <p className={`text-[11px] ${msg.kind === "ok" ? "text-emerald-600" : "text-red-600"}`}>
              {msg.text}
            </p>
          )}

          {/* Values to paste into the Meta webhook config (one shared webhook serves every location). */}
          <div className="space-y-2 rounded-md border border-zinc-200 bg-white p-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
              Meta webhook setup (one-time, shared)
            </span>
            <CopyField label="Callback URL" value={conn?.webhookUrl ?? ""} />
            <CopyField label="Verify token" value={conn?.verifyToken ?? ""} />
          </div>
        </>
      )}
    </div>
  );
}
