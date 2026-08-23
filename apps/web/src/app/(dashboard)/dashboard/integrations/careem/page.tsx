"use client";

// Phase CA-0 — Careem connection status.
//
// Exists because "I set four environment variables and redeployed" tells you
// nothing about whether Careem accepts them, and the alternative was pasting a
// fetch into the browser console — which fails silently in at least four ways
// (wrong origin, DevTools throttled offline, a console log-level filter, and an
// expired token that a raw fetch won't refresh). This page goes through the
// dashboard's own API client, so the token refreshes itself and the answer is
// just on screen.
//
// It is also where the raw ORDER_CREATED payloads are read while the order
// transformer is being written — from real shapes rather than the spec's
// examples, which is the step that never happened for JET.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { apiClient } from "@/lib/api/client";

interface Diagnostics {
  environment?: string;
  baseUrl?: string;
  clientIdSet?: boolean;
  clientSecretSet?: boolean;
  webhookKeySet?: boolean;
  webhookUrl?: string;
  tokenUrl?: string;
  retryInSeconds?: number;
  token?:
    | {
        ok?: boolean;
        length?: number;
        error?: string;
        status?: number;
        tokenUrl?: string;
        careemSaid?: string;
        hint?: string;
      }
    | string;
  brands?: unknown;
  branches?: unknown;
  webhooks?: {
    receivedSinceRestart?: number;
    everAuthenticated?: boolean;
    lastAt?: string | null;
    hint?: string;
  };
}

interface WebhookEvent {
  at: string;
  eventType: string | null;
  orderId: string | number | null;
  status: string | null;
  authenticated: boolean;
  payloadPreview: string;
}

interface AuthProbe {
  tokenUrl?: string;
  conclusion?: string;
  results?: Array<{ variant: string; status: number; ok: boolean; body: string }>;
}

export default function CareemPage() {
  const [copied, setCopied] = useState<string | null>(null);
  const [probe, setProbe] = useState<AuthProbe | null>(null);
  const [probing, setProbing] = useState(false);

  // Deliberately NOT polled. This call reaches out to Careem, and polling it
  // every thirty seconds is what got us rate-limited by Cloudflare — their docs
  // warn an IP block "might require manual intervention" to undo. Refresh is a
  // button now.
  const diag = useQuery<Diagnostics>({
    queryKey: ["careem-diagnostics"],
    queryFn: () =>
      apiClient
        .get("/v1/integrations/careem/diagnostics")
        .then((r) => r.data as Diagnostics),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  const hooks = useQuery<{ events: WebhookEvent[] }>({
    queryKey: ["careem-webhooks"],
    queryFn: () =>
      apiClient
        .get("/v1/integrations/careem/webhooks", { params: { limit: 10 } })
        .then((r) => r.data as { events: WebhookEvent[] }),
    // Safe to poll: this reads our own in-memory buffer, not Careem.
    refetchInterval: 15_000,
  });

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked — the text is on screen and selectable anyway */
    }
  };

  const tokenOk =
    typeof diag.data?.token === "object" && diag.data.token?.ok === true;
  const tokenObj =
    typeof diag.data?.token === "object" ? diag.data.token : undefined;
  const tokenErr =
    tokenObj?.error ??
    (typeof diag.data?.token === "string" ? diag.data.token : undefined);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Careem</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Connection status and the notifications Careem has sent us.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void diag.refetch();
            void hooks.refetch();
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${diag.isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </header>

      {diag.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking…
        </div>
      ) : diag.isError ? (
        <Panel tone="bad" title="Couldn't reach the API">
          <p className="text-sm">
            {(diag.error as { message?: string })?.message ?? "Unknown error"}
          </p>
        </Panel>
      ) : (
        <>
          {/* ── Credentials ─────────────────────────────────── */}
          <Panel
            tone={tokenOk ? "good" : "bad"}
            title={tokenOk ? "Credentials accepted" : "Credentials not working"}
          >
            {tokenOk ? (
              <p className="text-sm">
                Careem issued an access token. The{" "}
                <strong>{diag.data?.environment}</strong> gateway is answering.
              </p>
            ) : (
              <div className="space-y-2 text-sm">
                <p>
                  {tokenErr ??
                    `Careem rejected the token request${
                      tokenObj?.status ? ` (HTTP ${tokenObj.status})` : ""
                    }.`}
                </p>
                {tokenObj?.hint && (
                  <p className="rounded border border-red-200 bg-white/60 p-2 text-[13px] leading-relaxed">
                    {tokenObj.hint}
                  </p>
                )}
                {!!diag.data?.retryInSeconds && (
                  <p className="rounded border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900">
                    Not re-checking for another {diag.data.retryInSeconds}s. A
                    credential rejected a moment ago will be rejected again, and
                    repeated token requests are what trigger Careem&apos;s rate
                    limiting.
                  </p>
                )}
                <div>
                  <button
                    type="button"
                    disabled={probing}
                    onClick={async () => {
                      setProbing(true);
                      try {
                        const r = await apiClient.get(
                          "/v1/integrations/careem/auth-probe",
                        );
                        setProbe(r.data as AuthProbe);
                      } catch (e) {
                        setProbe({
                          conclusion: (e as { message?: string })?.message ?? "Probe failed",
                        });
                      } finally {
                        setProbing(false);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    {probing && <Loader2 className="h-3 w-3 animate-spin" />}
                    Run auth probe
                  </button>
                  <p className="mt-1 text-[11px] text-zinc-600">
                    Tries every style once and reports what Careem said to each.
                    Six requests — press it when something has changed, not
                    repeatedly.
                  </p>
                </div>
                {probe && (
                  <div className="rounded border border-red-200 bg-white/60 p-2">
                    <p className="text-[13px] leading-relaxed">{probe.conclusion}</p>
                    {probe.results?.length ? (
                      <table className="mt-2 w-full text-[10px]">
                        <tbody>
                          {probe.results.map((r) => (
                            <tr key={r.variant} className="border-b border-zinc-100 last:border-0">
                              <td className="py-1 pr-2 font-mono">{r.variant}</td>
                              <td className="py-1 pr-2 font-mono">{r.status}</td>
                              <td className="py-1 font-mono text-zinc-600">
                                {r.body.slice(0, 90)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : null}
                  </div>
                )}
                {tokenObj?.careemSaid && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-red-700">
                      Careem said
                    </p>
                    <pre className="mt-1 max-h-40 overflow-auto rounded bg-white/70 p-2 font-mono text-[10px] leading-relaxed text-zinc-800">
                      {pretty(tokenObj.careemSaid)}
                    </pre>
                  </div>
                )}
              </div>
            )}
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
              <Row label="Environment" value={diag.data?.environment} />
              <Row label="Gateway" value={diag.data?.baseUrl} mono />
              <Row label="Token URL" value={diag.data?.tokenUrl} mono />
              <Row
                label="CAREEM_CLIENT_ID"
                value={diag.data?.clientIdSet ? "set" : "missing"}
                bad={!diag.data?.clientIdSet}
              />
              <Row
                label="CAREEM_CLIENT_SECRET"
                value={diag.data?.clientSecretSet ? "set" : "missing"}
                bad={!diag.data?.clientSecretSet}
              />
            </dl>
          </Panel>

          {/* ── Webhook wiring ──────────────────────────────── */}
          <Panel
            tone={
              diag.data?.webhooks?.everAuthenticated
                ? "good"
                : diag.data?.webhooks?.receivedSinceRestart
                  ? "bad"
                  : "warn"
            }
            title="Webhooks"
          >
            <p className="text-sm">{diag.data?.webhooks?.hint}</p>
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
              <Row
                label="CAREEM_WEBHOOK_API_KEY"
                value={diag.data?.webhookKeySet ? "set" : "missing"}
                bad={!diag.data?.webhookKeySet}
              />
              <Row
                label="Received since restart"
                value={String(diag.data?.webhooks?.receivedSinceRestart ?? 0)}
              />
            </dl>
            {diag.data?.webhookUrl && (
              <div className="mt-3 flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded bg-zinc-100 px-2 py-1.5 font-mono text-[11px] text-zinc-700">
                  {diag.data.webhookUrl}
                </code>
                <button
                  type="button"
                  onClick={() => copy("url", diag.data!.webhookUrl!)}
                  className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1.5 text-[11px] hover:bg-zinc-50"
                >
                  <Copy className="h-3 w-3" />
                  {copied === "url" ? "Copied" : "Copy"}
                </button>
              </div>
            )}
            <p className="mt-2 text-[11px] text-zinc-500">
              This is the URL to save in Careem&apos;s partner portal, with the
              same key you set in <code>CAREEM_WEBHOOK_API_KEY</code>.
            </p>
          </Panel>

          {/* ── What the credentials can see ────────────────── */}
          {tokenOk && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Json title="Brands" value={diag.data?.brands} />
              <Json title="Branches" value={diag.data?.branches} />
            </div>
          )}
        </>
      )}

      {/* ── Recent notifications ──────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-zinc-900">
          Recent notifications
        </h2>
        <p className="text-xs text-zinc-500">
          In memory and per-instance — lost when the API restarts. Here to read
          real payload shapes while the integration is being built.
        </p>
        {hooks.data?.events?.length ? (
          <ul className="space-y-2">
            {hooks.data.events.map((e, i) => (
              <li
                key={`${e.at}-${i}`}
                className="rounded-lg border border-zinc-200 bg-white p-3"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono font-semibold text-zinc-900">
                    {e.eventType ?? "unknown"}
                  </span>
                  {e.orderId != null && (
                    <span className="text-zinc-500">order {String(e.orderId)}</span>
                  )}
                  {e.status && <span className="text-zinc-500">· {e.status}</span>}
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                      e.authenticated
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-red-100 text-red-700"
                    }`}
                  >
                    {e.authenticated ? "key ok" : "key rejected"}
                  </span>
                  <span className="flex-1" />
                  <span className="text-zinc-400">
                    {new Date(e.at).toLocaleTimeString("en-GB")}
                  </span>
                  <button
                    type="button"
                    onClick={() => copy(String(i), e.payloadPreview)}
                    className="inline-flex items-center gap-1 rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] hover:bg-zinc-50"
                  >
                    <Copy className="h-2.5 w-2.5" />
                    {copied === String(i) ? "Copied" : "Copy payload"}
                  </button>
                </div>
                <pre className="mt-2 max-h-56 overflow-auto rounded bg-zinc-50 p-2 font-mono text-[10px] leading-relaxed text-zinc-700">
                  {pretty(e.payloadPreview)}
                </pre>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500">
            Nothing received yet. Place a test order in Careem&apos;s sandbox and
            it will appear here.
          </p>
        )}
      </section>
    </div>
  );
}

/** Payloads are stored as a trimmed string, so a long one may not be valid
 *  JSON any more. Show it raw rather than throwing away the evidence. */
function pretty(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function Row({
  label,
  value,
  mono,
  bad,
}: {
  label: string;
  value?: string;
  mono?: boolean;
  bad?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-zinc-100 py-1 last:border-0">
      <dt className="text-zinc-500">{label}</dt>
      <dd
        className={`${mono ? "font-mono text-[10px]" : ""} ${
          bad ? "font-semibold text-red-600" : "text-zinc-800"
        } truncate`}
      >
        {value ?? "—"}
      </dd>
    </div>
  );
}

function Json({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </h3>
      <pre className="mt-2 max-h-60 overflow-auto rounded bg-zinc-50 p-2 font-mono text-[10px] leading-relaxed text-zinc-700">
        {JSON.stringify(value ?? null, null, 2)}
      </pre>
    </div>
  );
}

function Panel({
  tone,
  title,
  children,
}: {
  tone: "good" | "bad" | "warn";
  title: string;
  children: React.ReactNode;
}) {
  const Icon =
    tone === "good" ? CheckCircle2 : tone === "bad" ? XCircle : AlertTriangle;
  const ring =
    tone === "good"
      ? "border-emerald-200 bg-emerald-50"
      : tone === "bad"
        ? "border-red-200 bg-red-50"
        : "border-amber-200 bg-amber-50";
  const fg =
    tone === "good"
      ? "text-emerald-700"
      : tone === "bad"
        ? "text-red-700"
        : "text-amber-700";
  return (
    <section className={`rounded-lg border p-4 ${ring}`}>
      <div className={`flex items-center gap-2 ${fg}`}>
        <Icon className="h-4 w-4" />
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <div className="mt-2 text-zinc-800">{children}</div>
    </section>
  );
}
