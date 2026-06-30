"use client";

// Phase AW — connect a brand's own domain to its storefront via Cloudflare
// for SaaS. Self-contained: provisions the custom hostname, shows the one
// CNAME the brand must add, and polls until the SSL cert is live.

import { useEffect, useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { brandDomainsClient, type BrandDomain } from "@/lib/api/brand-domains.client";

function CopyRow({ label, value }: { label: string; value: string }) {
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

function StatusPill({ status }: { status: string }) {
  if (status === "verified")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
        ● Live
      </span>
    );
  if (status === "pending")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
        ● Pending DNS
      </span>
    );
  if (status === "failed")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700">
        ● Failed
      </span>
    );
  return null;
}

export function BrandCustomDomainPanel({
  brandId,
  disabled,
}: {
  brandId: string;
  disabled?: boolean;
}) {
  const [conn, setConn] = useState<BrandDomain | null>(null);
  const [domain, setDomain] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    brandDomainsClient
      .get(brandId)
      .then((c) => {
        if (!live) return;
        setConn(c);
        setDomain(c.domain);
      })
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [brandId]);

  const connect = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const c = await brandDomainsClient.connect(brandId, domain);
      setConn(c);
      setDomain(c.domain);
      setMsg({ kind: "ok", text: "Domain registered — add the DNS record below, then Check status." });
    } catch (err: any) {
      setMsg({ kind: "err", text: err?.response?.data?.message ?? err?.message ?? "Couldn't connect domain." });
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const c = await brandDomainsClient.get(brandId);
      setConn(c);
      setMsg(
        c.status === "verified"
          ? { kind: "ok", text: "Live! The domain is serving the storefront 🎉" }
          : { kind: "ok", text: "Still pending — DNS/SSL can take a few minutes after you add the record." },
      );
    } catch (err: any) {
      setMsg({ kind: "err", text: err?.response?.data?.message ?? err?.message ?? "Couldn't check status." });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const c = await brandDomainsClient.disconnect(brandId);
      setConn(c);
      setDomain("");
    } catch (err: any) {
      setMsg({ kind: "err", text: err?.response?.data?.message ?? err?.message ?? "Couldn't disconnect." });
    } finally {
      setBusy(false);
    }
  };

  const configured = conn?.configured;

  return (
    <div className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Custom domain
        </span>
        {conn && <StatusPill status={conn.status} />}
      </div>
      <p className="text-[11px] text-zinc-500">
        Serve this brand's storefront on its own domain (e.g. order.greekgyros.co.uk).
        Enter it, add the DNS record we show at the domain's registrar, and we
        auto-provision the SSL certificate. (Subdomains use a CNAME; a root domain
        uses an A record.)
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-[11px] text-zinc-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              disabled={disabled || busy || configured}
              placeholder="order.greekgyros.co.uk"
              className="input flex-1"
            />
            {!configured ? (
              <button
                type="button"
                onClick={connect}
                disabled={disabled || busy || !domain}
                className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
              >
                {busy ? "Connecting…" : "Connect"}
              </button>
            ) : (
              <button
                type="button"
                onClick={disconnect}
                disabled={disabled || busy}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              >
                Disconnect
              </button>
            )}
          </div>

          {configured && (conn?.dnsRecords?.length ?? 0) > 0 && (
            <div className="space-y-2 rounded-md border border-zinc-200 bg-white p-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                Add this DNS record at the domain's registrar
              </span>
              {conn!.dnsRecords.map((r, i) => (
                <div key={i} className="space-y-1.5">
                  <CopyRow label={`${r.type} — name`} value={r.name} />
                  <CopyRow label={`${r.type} — value (target)`} value={r.value} />
                </div>
              ))}
              <button
                type="button"
                onClick={check}
                disabled={busy}
                className="mt-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              >
                {busy ? "Checking…" : "Check status"}
              </button>
            </div>
          )}

          {msg && (
            <p className={`text-[11px] ${msg.kind === "ok" ? "text-emerald-600" : "text-red-600"}`}>
              {msg.text}
            </p>
          )}
        </>
      )}
    </div>
  );
}
