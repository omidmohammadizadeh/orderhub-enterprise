"use client";

// Payments page — Mollie, as an opt-in alternative to Stripe per brand.
//
// A brand connects its own Mollie account (or signs up for one through a
// pre-filled link we generate), then the "Use Mollie" switch moves its online
// card payments and POS payment links off Stripe. Stripe is never touched:
// switching back is the same switch.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { useSelectedLocationStore } from "@/stores/selected-location.store";

interface MollieBrandRow {
  brandId: string;
  brandName: string;
  eligible: boolean;
  status: string;
  connected: boolean;
  enabled: boolean;
  organizationName: string | null;
  profileId: string | null;
  canReceivePayments: boolean;
  canReceiveSettlements: boolean;
  onboardingDashboardUrl: string | null;
  clientLinkUrl: string | null;
  lastError: string | null;
  methodStatuses: Record<string, string> | null;
}

interface TestResult {
  paymentId: string;
  status: string;
  method: string | null;
  amount: { value: string; currency: string };
  applicationFee: { value: string; currency: string } | null;
  amountRefunded: { value: string; currency: string } | null;
  refundStatus: string | null;
}

interface MollieStatus {
  configured: boolean;
  clientLinksAvailable: boolean;
  testmode: boolean;
  brands: MollieBrandRow[];
}

const STATUS_LABEL: Record<string, string> = {
  not_started: "Not connected",
  link_sent: "Sign-up link sent",
  connected: "Connected",
  "needs-data": "Mollie needs more details",
  "in-review": "Mollie is reviewing",
  completed: "Approved",
  revoked: "Access revoked — reconnect",
};

const errorText = (e: any) =>
  e?.response?.data?.message ?? e?.message ?? "Something went wrong";

export function MollieSection() {
  const qc = useQueryClient();
  // The location picked in the sidebar, same as the Brand payouts list above.
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const q = useQuery({
    queryKey: ["mollie-status", locationId],
    queryFn: () =>
      apiClient
        .get<MollieStatus>("/v1/payments/mollie/status", {
          params: locationId ? { locationId } : undefined,
        })
        .then((r) => r.data),
  });

  // Back from Mollie's consent screen: say what happened, once.
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const m = p.get("mollie");
    if (!m) return;
    setBanner(
      m === "connected"
        ? { ok: true, text: "Mollie account connected." }
        : { ok: false, text: `Mollie connection didn't complete (${p.get("reason") ?? "unknown"}).` },
    );
    p.delete("mollie");
    p.delete("reason");
    p.delete("brand");
    const qs = p.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, []);

  if (q.isLoading) return null;
  if (q.isError || !q.data) return null;
  const s = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ["mollie-status"] });

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold text-zinc-900">Mollie</h2>
          <p className="mt-0.5 text-sm text-zinc-500">
            Take a brand&apos;s online card payments and payment links through Mollie instead of
            Stripe. Brands you don&apos;t switch stay on Stripe.
          </p>
        </div>
        {s.configured && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              s.testmode ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800",
            )}
          >
            {s.testmode ? "Test mode" : "Live"}
          </span>
        )}
      </div>

      {banner && (
        <div
          className={cn(
            "mt-3 rounded-xl px-3 py-2 text-sm",
            banner.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800",
          )}
        >
          {banner.text}
        </div>
      )}

      {!s.configured ? (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Mollie isn&apos;t set up on the platform yet (MOLLIE_CLIENT_ID / MOLLIE_CLIENT_SECRET).
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-zinc-100">
          {s.brands.length === 0 && (
            <li className="py-3 text-sm text-zinc-500">No brands selling online at this location.</li>
          )}
          {s.brands.map((b) => (
            <MollieBrand key={b.brandId} row={b} clientLinks={s.clientLinksAvailable} onChange={refresh} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MollieBrand({
  row,
  clientLinks,
  onChange,
}: {
  row: MollieBrandRow;
  clientLinks: boolean;
  onChange: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const base = `/v1/payments/mollie/brands/${row.brandId}`;

  const connect = useMutation({
    mutationFn: () => apiClient.post<{ url: string }>(`${base}/connect`).then((r) => r.data),
    onSuccess: (d) => {
      window.location.href = d.url;
    },
    onError: (e) => setErr(errorText(e)),
  });
  const refresh = useMutation({
    mutationFn: () => apiClient.post(`${base}/refresh`),
    onSuccess: () => {
      setErr(null);
      onChange();
    },
    onError: (e) => setErr(errorText(e)),
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => apiClient.post(`${base}/enabled`, { enabled }),
    onSuccess: () => {
      setErr(null);
      onChange();
    },
    onError: (e) => setErr(errorText(e)),
  });
  const disconnect = useMutation({
    mutationFn: () => apiClient.post(`${base}/disconnect`),
    onSuccess: onChange,
    onError: (e) => setErr(errorText(e)),
  });

  const ready = row.connected && !!row.profileId;

  // £1 test-mode payment on this brand's Mollie account — no order, no switch,
  // so it is safe on a shop that is trading. Mollie sends the browser back
  // here with ?mollieTest=1&brand=<id>, which opens the result panel.
  const startTest = useMutation({
    mutationFn: () =>
      apiClient.post<{ checkoutUrl: string }>(`${base}/test-payment`).then((r) => r.data),
    onSuccess: (d) => {
      window.location.href = d.checkoutUrl;
    },
    onError: (e) => setErr(errorText(e)),
  });
  const [returnedFromTest] = useState(() => {
    if (typeof window === "undefined") return false;
    const p = new URLSearchParams(window.location.search);
    return p.get("mollieTest") === "1" && p.get("brand") === row.brandId;
  });
  const [test, setTest] = useState<TestResult | null>(null);
  const testStatus = useMutation({
    mutationFn: (refund: boolean) =>
      apiClient.post<TestResult>(`${base}/test-payment/status`, { refund }).then((r) => r.data),
    onSuccess: (d) => {
      setErr(null);
      setTest(d);
    },
    onError: (e) => setErr(errorText(e)),
  });
  useEffect(() => {
    if (returnedFromTest) testStatus.mutate(false);
    // Once, on landing back from Mollie's test checkout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnedFromTest]);

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-zinc-900">{row.brandName}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
            {!row.eligible ? (
              <span>Gulf shop — payments go through Tap</span>
            ) : (
              <>
                <span>{STATUS_LABEL[row.status] ?? row.status}</span>
                {row.organizationName && <span>{row.organizationName}</span>}
                {row.connected && (
                  <>
                    <Pill ok={row.canReceivePayments} label="Payments" />
                    <Pill ok={row.canReceiveSettlements} label="Payouts" />
                    <Pill ok={row.methodStatuses?.creditcard === "activated"} label="Card" />
                    <Pill ok={row.methodStatuses?.applepay === "activated"} label="Apple Pay" />
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {row.eligible && (
          <div className="flex flex-wrap items-center gap-2">
            {row.connected ? (
              <>
                <label
                  className={cn(
                    "inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm",
                    row.enabled ? "border-emerald-300 bg-emerald-50" : "border-zinc-200",
                    !ready && "opacity-50",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    disabled={!ready || toggle.isPending}
                    onChange={(e) => toggle.mutate(e.target.checked)}
                  />
                  Use Mollie
                </label>
                <button
                  type="button"
                  onClick={() => startTest.mutate()}
                  disabled={!ready || startTest.isPending}
                  className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-50"
                >
                  {startTest.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Test payment
                </button>
                <button
                  type="button"
                  onClick={() => refresh.mutate()}
                  disabled={refresh.isPending}
                  className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm hover:bg-zinc-50"
                >
                  {refresh.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  Refresh
                </button>
                {row.onboardingDashboardUrl && row.status === "needs-data" && (
                  <a
                    href={row.onboardingDashboardUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm hover:bg-zinc-50"
                  >
                    Finish in Mollie <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(`Disconnect ${row.brandName} from Mollie? Its payments go back to Stripe.`)) {
                      disconnect.mutate();
                    }
                  }}
                  className="rounded-lg px-2 py-1.5 text-sm text-zinc-500 hover:text-red-600"
                >
                  Disconnect
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => connect.mutate()}
                  disabled={connect.isPending}
                  className="inline-flex items-center gap-1 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
                >
                  {connect.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Connect existing Mollie
                </button>
                {clientLinks && (
                  <button
                    type="button"
                    onClick={() => setShowForm((v) => !v)}
                    className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm hover:bg-zinc-50"
                  >
                    Sign up a new restaurant
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {row.eligible && row.clientLinkUrl && !row.connected && <CopyLink url={row.clientLinkUrl} />}
      {row.eligible && showForm && !row.connected && (
        <ClientLinkForm
          brandId={row.brandId}
          brandName={row.brandName}
          onDone={() => {
            setShowForm(false);
            onChange();
          }}
        />
      )}
      {row.eligible && row.connected && (
        <p className="mt-1.5 text-xs text-zinc-500">
          Card and Apple Pay are switched on from here when you press Refresh. Google Pay
          the restaurant turns on itself in Mollie (Settings → Online payments → Google
          Pay), once card is approved.
        </p>
      )}
      {test && (
        <div className="mt-2 rounded-lg bg-zinc-50 px-2.5 py-2 text-xs text-zinc-700">
          <div>
            Test payment {test.paymentId}: <strong>{test.status}</strong>
            {test.method && <> · {test.method}</>} · {test.amount.value} {test.amount.currency}
            {test.applicationFee && (
              <> · our fee {test.applicationFee.value} {test.applicationFee.currency}</>
            )}
            {test.amountRefunded && Number(test.amountRefunded.value) > 0 && (
              <> · refunded {test.amountRefunded.value}</>
            )}
          </div>
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              onClick={() => testStatus.mutate(false)}
              className="rounded border border-zinc-200 bg-white px-2 py-1 hover:bg-zinc-100"
            >
              Check again
            </button>
            {test.status === "paid" && !(test.amountRefunded && Number(test.amountRefunded.value) > 0) && (
              <button
                type="button"
                onClick={() => testStatus.mutate(true)}
                className="rounded border border-zinc-200 bg-white px-2 py-1 hover:bg-zinc-100"
              >
                Refund test payment
              </button>
            )}
          </div>
        </div>
      )}
      {(err || row.lastError) && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-red-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {err ?? row.lastError}
        </div>
      )}
    </li>
  );
}

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {ok ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
      ) : (
        <XCircle className="h-3.5 w-3.5 text-zinc-400" />
      )}
      {label}
    </span>
  );
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-600">
      <span className="shrink-0">Sign-up link (valid 30 days):</span>
      <span className="min-w-0 truncate font-mono">{url}</span>
      <button
        type="button"
        className="ml-auto inline-flex shrink-0 items-center gap-1 text-zinc-800 hover:text-zinc-950"
        onClick={() => {
          void navigator.clipboard.writeText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const FIELDS: Array<{ key: string; label: string; required?: boolean; type?: string }> = [
  { key: "givenName", label: "Owner first name", required: true },
  { key: "familyName", label: "Owner last name", required: true },
  { key: "email", label: "Owner email", required: true, type: "email" },
  { key: "organizationName", label: "Business name (sole trader: trading name)" },
  { key: "streetAndNumber", label: "Street and number" },
  { key: "postalCode", label: "Postcode" },
  { key: "city", label: "City" },
  { key: "registrationNumber", label: "Companies House number (Ltd only)" },
  { key: "vatNumber", label: "VAT number (if registered)" },
];

function ClientLinkForm({
  brandId,
  brandName,
  onDone,
}: {
  brandId: string;
  brandName: string;
  onDone: () => void;
}) {
  const [form, setForm] = useState<Record<string, string>>({ organizationName: brandName });
  const create = useMutation({
    mutationFn: () =>
      apiClient
        .post<{ url: string }>(`/v1/payments/mollie/brands/${brandId}/client-link`, {
          ...form,
          country: "GB",
        })
        .then((r) => r.data),
    onSuccess: onDone,
  });
  return (
    <form
      className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <p className="mb-2 text-xs text-zinc-600">
        Mollie creates the restaurant&apos;s account with these details pre-filled. The owner gets
        an email to set a password, finishes the checks on Mollie&apos;s pages, and is brought back
        here connected. Sole traders leave the company and VAT numbers blank: Mollie asks
        what kind of business it is during sign-up.
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {FIELDS.map((f) => (
          <label key={f.key} className="text-xs text-zinc-600">
            {f.label}
            {f.required && " *"}
            <input
              type={f.type ?? "text"}
              required={f.required}
              value={form[f.key] ?? ""}
              onChange={(e) => setForm((v) => ({ ...v, [f.key]: e.target.value }))}
              className="mt-0.5 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-900"
            />
          </label>
        ))}
      </div>
      {create.isError && <div className="mt-2 text-xs text-red-700">{errorText(create.error)}</div>}
      <button
        type="submit"
        disabled={create.isPending}
        className="mt-3 inline-flex items-center gap-1 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
      >
        {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Create sign-up link
      </button>
    </form>
  );
}
