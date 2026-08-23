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
  token?: { ok?: boolean; length?: number; error?: string } | string;
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

export default function CareemPage() {
  const [copied, setCopied] = useState<string | null>(null);

  const diag = useQuery<Diagnostics>({
    queryKey: ["careem-diagnostics"],
    queryFn: () =>
      apiClient
        .get("/v1/integrations/careem/diagnostics")
        .then((r) => r.data as Diagnostics),
    refetchInterval: 30_000,
  });

  const hooks = useQuery<{ events: WebhookEvent[] }>({
    queryKey: ["careem-webhooks"],
    queryFn: () =>
      apiClient
        .get("/v1/integrations/careem/webhooks", { params: { limit: 10 } })
        .then((r) => r.data as { events: WebhookEvent[] }),
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
  const tokenErr =
    typeof diag.data?.token === "object"
      ? diag.data.token?.error
      : typeof diag.data?.token === "string"
        ? diag.data.token
        : undefined;

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
              <p className="text-sm">{tokenErr ?? "No token."}</p>
            )}
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
              <Row label="Environment" value={diag.data?.environment} />
              <Row label="Gateway" value={diag.data?.baseUrl} mono />
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
