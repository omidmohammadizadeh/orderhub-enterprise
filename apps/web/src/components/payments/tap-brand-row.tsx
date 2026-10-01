"use client";

// Payments page — the Gulf counterpart of a brand's Stripe Connect row.
//
// A Gulf brand's card payments go to its own Tap merchant account. The
// restaurant opens it on Tap's pages (KYC: trade licence, ID, bank) from a
// sign-up link generated here; Tap tells us the merchant id when it's done.
// Mirrors the Stripe row: status pills, one primary action, details inline.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  CreditCard,
  ExternalLink,
  Loader2,
  XCircle,
} from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { brandsClient } from "@/lib/api/locations.client";
import { useAuthStore } from "@/stores/auth.store";

export interface TapStatus {
  platforms: Array<{
    kind: "COMMERCE" | "BILLING" | "APP";
    configured: boolean;
    mode: "test" | "live" | null;
    problem: string | null;
  }>;
  commissionWallet: boolean;
  ready: boolean;
}

export interface TapBrandFields {
  brandId: string;
  name: string;
  logoUrl: string | null;
  country: string;
  tap: {
    merchantId: string | null;
    onboardingStatus: string;
    connectUrl: string | null;
  };
}

const ADMIN_ROLES = new Set(["PLATFORM_ADMIN", "TENANT_OWNER"]);

/** One strip above the Tap brands: is the platform itself set up? */
export function TapSetupStrip() {
  const q = useQuery({
    queryKey: ["tap-status"],
    queryFn: () => apiClient.get<TapStatus>("/v1/payments/tap/status").then((r) => r.data),
    staleTime: 60_000,
  });
  if (!q.data) return null;
  const s = q.data;
  const problems = s.platforms.filter((p) => p.problem);
  const live = s.platforms.some((p) => p.mode === "live");
  return (
    <div
      className={`mb-3 rounded-xl border px-3 py-2 text-xs ${
        problems.length || !s.ready
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-zinc-200 bg-zinc-50 text-zinc-600"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold text-zinc-800">Tap (Gulf)</span>
        {s.platforms.map((p) => (
          <span key={p.kind} className="inline-flex items-center gap-1">
            {p.configured ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            ) : (
              <XCircle className="h-3.5 w-3.5 text-zinc-400" />
            )}
            {p.kind.charAt(0) + p.kind.slice(1).toLowerCase()}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          {s.commissionWallet ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-zinc-400" />
          )}
          Commission wallet
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
            live ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
          }`}
        >
          {live ? "Live" : "Test mode"}
        </span>
      </div>
      {problems.map((p) => (
        <p key={p.kind} className="mt-1 flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          {p.problem}
        </p>
      ))}
      {!s.commissionWallet && !problems.length && (
        <p className="mt-1 text-zinc-500">
          No commission wallet yet — Gulf card payments go through, but no
          platform fee is taken until TAP_COMMISSION_DESTINATION_ID is set.
        </p>
      )}
    </div>
  );
}

export function TapBrandRow({
  row,
  onChanged,
}: {
  row: TapBrandFields;
  onChanged: () => void;
}) {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && ADMIN_ROLES.has(user.role as string);
  const [link, setLink] = useState(row.tap.connectUrl ?? "");
  const [copied, setCopied] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [manualId, setManualId] = useState(row.tap.merchantId ?? "");
  const [err, setErr] = useState<string | null>(null);

  const connected = !!row.tap.merchantId;
  const waiting = !connected && (row.tap.onboardingStatus === "link_sent" || !!link);

  const start = useMutation({
    mutationFn: () => brandsClient.startTapOnboarding(row.brandId),
    onSuccess: (r) => {
      setLink(r.connectUrl);
      setErr(null);
      onChanged();
    },
    onError: (e: any) =>
      setErr(e?.response?.data?.message ?? "Couldn't create the Tap sign-up link"),
  });

  const saveManual = useMutation({
    mutationFn: (id: string | null) => brandsClient.setTapMerchant(row.brandId, id),
    onSuccess: () => {
      setErr(null);
      setShowManual(false);
      onChanged();
    },
    onError: (e: any) =>
      setErr(e?.response?.data?.message ?? "Couldn't save the merchant id"),
  });

  return (
    <>
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center overflow-hidden rounded-lg border border-zinc-100 bg-zinc-50">
          {row.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={row.logoUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <CreditCard className="h-4 w-4 text-zinc-400" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-zinc-900">{row.name}</span>
            <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">
              Tap · {row.country}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                connected
                  ? "bg-emerald-100 text-emerald-700"
                  : waiting
                    ? "bg-amber-100 text-amber-700"
                    : "bg-zinc-100 text-zinc-500"
              }`}
            >
              {connected ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : (
                <XCircle className="h-3 w-3" />
              )}
              {connected ? "Connected" : waiting ? "Waiting for sign-up" : "Not started"}
            </span>
          </div>
          <div className="mt-0.5 truncate text-xs text-zinc-500">
            {connected
              ? `Merchant ${row.tap.merchantId}`
              : "No Tap merchant yet — the shop can take cash but not cards"}
          </div>
        </div>
        {!connected && (
          <button
            type="button"
            onClick={() => start.mutate()}
            disabled={start.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {start.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {link ? "New sign-up link" : "Start Tap onboarding"}
          </button>
        )}
        {isAdmin && (
          <button
            type="button"
            onClick={() => setShowManual((v) => !v)}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            {showManual ? "Close" : connected ? "Change" : "Enter id"}
          </button>
        )}
      </div>

      {!connected && link && (
        <div className="mt-3 space-y-1 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
          <p className="text-xs text-zinc-600">
            Send this link to the restaurant. They complete Tap&apos;s checks
            (trade licence, ID, bank details) on Tap&apos;s pages, and this row
            turns green by itself when the account is ready.
          </p>
          <div className="flex items-center gap-1.5">
            <code className="flex-1 truncate rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-[11px] text-zinc-700">
              {link}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(link);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="rounded-md border border-zinc-200 bg-white p-1.5 text-zinc-500 hover:text-zinc-900"
              aria-label="Copy sign-up link"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-zinc-200 bg-white p-1.5 text-zinc-500 hover:text-zinc-900"
              aria-label="Open sign-up link"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      )}

      {showManual && isAdmin && (
        <div className="mt-3 space-y-1 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
          <label className="text-xs font-medium text-zinc-700" htmlFor={`tap-mid-${row.brandId}`}>
            Tap merchant id (Tap OS → Merchants)
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id={`tap-mid-${row.brandId}`}
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              placeholder="merchant_…"
              className="flex-1 rounded-md border border-zinc-200 bg-white px-2 py-1.5 font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => saveManual.mutate(manualId.trim() || null)}
              disabled={saveManual.isPending}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {saveManual.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
            </button>
          </div>
          <p className="text-[11px] text-zinc-500">
            Leave empty and save to disconnect. Only set this to a merchant
            that belongs to this restaurant — it&apos;s where its card money goes.
          </p>
        </div>
      )}

      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
    </>
  );
}
